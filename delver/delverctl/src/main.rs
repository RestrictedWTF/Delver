use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use delver_protocol::{
	FunctionsResult, GetExportsResult, GetFunctionSeedsResult, GetImageInfoResult,
	GetImportsResult, ListingWindowResult, ListingWindowRowWire, OpenImageResult, ReadMemoryParams,
	Request,
};
use delver_rpc::Client;

/// How many entries of a long list `info` prints before summarising the rest.
const LIST_PREVIEW: usize = 10;

#[derive(Parser, Debug)]
#[command(name = "delverctl")]
#[command(about = "Delver command-line control utility")]
struct Args {
	#[command(subcommand)]
	command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
	/// Print image architecture, entry point, and sections from a spawned provider.
	Info { file: PathBuf },
	/// Print address spaces exposed by a spawned file provider.
	Spaces { file: PathBuf },
	/// Read bytes from a spawned provider and print a hex dump.
	Read {
		file: PathBuf,
		address: String,
		length: String,
		#[arg(short, long, default_value = "Image")]
		space: String,
	},
	/// Print image info from a listening provider.
	ConnectInfo { endpoint: String },
	/// Print address spaces from a listening provider.
	ConnectSpaces { endpoint: String },
	/// Read bytes from a listening provider and print a hex dump.
	ConnectRead {
		endpoint: String,
		address: String,
		length: String,
		#[arg(short, long, default_value = "Image")]
		space: String,
	},
	/// Run the full pipeline: provider -> analysis server -> listing.
	///
	/// Spawns `provider-file` and `server-analysis` as separate processes and
	/// drives them over local endpoints, which is the topology the workbench
	/// uses.
	Analyze {
		file: PathBuf,
		/// Listing rows to print.
		#[arg(long, default_value_t = 16)]
		rows: u64,
	},
}

fn main() -> Result<()> {
	let args = Args::parse();
	match args.command {
		Commands::Info { file } => {
			let mut session = Session::spawn(&file)?;
			cmd_info(&mut session)
		}
		Commands::Spaces { file } => {
			let mut session = Session::spawn(&file)?;
			cmd_spaces(&mut session)
		}
		Commands::Read {
			file,
			address,
			length,
			space,
		} => {
			let mut session = Session::spawn(&file)?;
			cmd_read(&mut session, &space, &address, &length)
		}
		Commands::ConnectInfo { endpoint } => {
			let mut session = Session::connect(&endpoint)?;
			cmd_info(&mut session)
		}
		Commands::ConnectSpaces { endpoint } => {
			let mut session = Session::connect(&endpoint)?;
			cmd_spaces(&mut session)
		}
		Commands::ConnectRead {
			endpoint,
			address,
			length,
			space,
		} => {
			let mut session = Session::connect(&endpoint)?;
			cmd_read(&mut session, &space, &address, &length)
		}
		Commands::Analyze { file, rows } => cmd_analyze(&file, rows),
	}
}

struct Session {
	client: Client<io::BufReader<Box<dyn io::Read + Send>>, Box<dyn io::Write + Send>>,
	child: Option<Child>,
}

impl Session {
	fn open(reader: Box<dyn io::Read + Send>, writer: Box<dyn io::Write + Send>) -> Result<Self> {
		let mut client = Client::new(io::BufReader::new(reader), writer);

		client.send_request(&Request {
			id: 0,
			method: "initialize".to_string(),
			params: serde_json::Value::Null,
		})?;
		let init = client.read_response()?;
		if init.error.is_some() {
			bail!("initialize failed: {:?}", init.error);
		}

		Ok(Self {
			client,
			child: None,
		})
	}

	fn spawn(file: &Path) -> Result<Self> {
		let mut child = Command::new("provider-file")
			.arg(file)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.spawn()
			.context("failed to spawn provider-file; is it on PATH?")?;

		let stdin = child.stdin.take().expect("piped stdin");
		let stdout = child.stdout.take().expect("piped stdout");

		match Self::open(Box::new(stdout), Box::new(stdin)) {
			Ok(mut session) => {
				session.child = Some(child);
				Ok(session)
			}
			Err(err) => {
				// A provider that cannot open its target exits immediately, so
				// the handshake read hits EOF. Reporting that raw io error on
				// top of the provider's own message is pure noise — prefer the
				// reason the provider already printed to stderr.
				match child.wait() {
					Ok(_) => bail!(
						"provider-file exited before completing initialize; \
                         see the error it reported above"
					),
					Err(wait_err) => Err(err).context(format!(
						"provider-file handshake failed and could not be reaped: {wait_err}"
					)),
				}
			}
		}
	}

	fn connect(endpoint: &str) -> Result<Self> {
		let (reader, writer) = delver_rpc::connect(endpoint)
			.with_context(|| format!("failed to connect to {endpoint}"))?;
		Self::open(reader, writer)
	}

	/// Sends a graceful shutdown request and waits for the provider to exit.
	fn shutdown(&mut self) -> Result<()> {
		self.client.send_request(&Request {
			id: 2,
			method: "shutdown".to_string(),
			params: serde_json::Value::Null,
		})?;
		let _ = self.client.read_response();
		if let Some(ref mut child) = self.child {
			child.wait().context("waiting for provider-file to exit")?;
		}
		Ok(())
	}

	/// Sends one request and returns its result payload.
	///
	/// A response carrying neither an error nor a result is a peer that broke
	/// the protocol, which is a reason to report and exit — never a reason to
	/// panic in a tool the acceptance path runs.
	fn call(&mut self, method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
		self.client.send_request(&Request {
			id: 1,
			method: method.to_string(),
			params,
		})?;
		let resp = self.client.read_response()?;
		if let Some(err) = resp.error {
			bail!("{} failed: {}", method, err.message);
		}
		resp.result
			.with_context(|| format!("{method} returned neither an error nor a result"))
	}

	fn read_frame(&mut self) -> Result<(u64, Vec<u8>)> {
		self.client.read_frame().context("reading binary frame")
	}
}

fn cmd_info(session: &mut Session) -> Result<()> {
	let resp = session.call("getImageInfo", serde_json::Value::Null)?;
	let info: GetImageInfoResult = serde_json::from_value(resp)?;

	println!("arch:       {}", info.arch);
	println!("entry:      0x{:X}", info.entry);
	println!("image_base: 0x{:X}", info.image_base);
	let import_symbol_count = info
		.import_symbol_count
		.map(|count| count.to_string())
		.unwrap_or_else(|| "unknown".to_owned());
	println!(
		"counts:     {} modules, {} imports, {} exports, {} seeds, {} relocs",
		info.import_module_count,
		import_symbol_count,
		info.export_count,
		info.function_seed_count,
		info.relocation_count
	);

	// Printed before the lists it qualifies: an empty import list from a failed
	// parse looks exactly like a sample that imports nothing.
	if !info.fully_parsed {
		println!("parse:      PARTIAL — {}", parse_gaps(&info).join(", "));
	}

	println!("sections:");
	for s in &info.sections {
		println!(
			"  {:<8} va=0x{:08X} vs=0x{:08X} raw=0x{:08X} rs=0x{:08X}",
			s.name, s.virtual_address, s.virtual_size, s.raw_offset, s.raw_size
		);
	}

	if let Some(tls) = &info.tls {
		println!(
			"tls:        index=0x{:X} data=0x{:X}+0x{:X} callbacks={}",
			tls.index_rva,
			tls.raw_data_rva,
			tls.raw_data_size,
			tls.callbacks.len()
		);
		for cb in &tls.callbacks {
			println!("  callback  0x{:X}", cb);
		}
	}

	let resp = session.call("getImports", serde_json::Value::Null)?;
	let imports: GetImportsResult = serde_json::from_value(resp)?;
	if !imports.modules.is_empty() {
		println!("imports:");
		for m in &imports.modules {
			println!("  {} ({} symbols)", m.name, m.symbols.len());
			for s in m.symbols.iter().take(LIST_PREVIEW) {
				let label = match (&s.name, s.ordinal) {
					(Some(name), _) => name.clone(),
					(None, Some(ordinal)) => format!("#{ordinal}"),
					(None, None) => "<unnamed>".to_string(),
				};
				println!("    iat=0x{:08X}  {}", s.iat_rva, label);
			}
			if m.symbols.len() > LIST_PREVIEW {
				println!("    ... {} more", m.symbols.len() - LIST_PREVIEW);
			}
		}
	}

	let resp = session.call("getExports", serde_json::Value::Null)?;
	let exports: GetExportsResult = serde_json::from_value(resp)?;
	if !exports.exports.is_empty() {
		println!("exports: {}", exports.exports.len());
		for e in exports.exports.iter().take(LIST_PREVIEW) {
			let name = e.name.as_deref().unwrap_or("<by ordinal>");
			match (&e.forwarded_to, e.rva) {
				(Some(target), _) => println!("  #{:<5} {} -> {}", e.ordinal, name, target),
				(None, Some(rva)) => println!("  #{:<5} 0x{:08X}  {}", e.ordinal, rva, name),
				(None, None) => println!("  #{:<5} <no target> {}", e.ordinal, name),
			}
		}
		if exports.exports.len() > LIST_PREVIEW {
			println!("  ... {} more", exports.exports.len() - LIST_PREVIEW);
		}
	}

	let resp = session.call("getFunctionSeeds", serde_json::Value::Null)?;
	let seeds: GetFunctionSeedsResult = serde_json::from_value(resp)?;
	if !seeds.seeds.is_empty() {
		let mut by_source: BTreeMap<String, usize> = BTreeMap::new();
		for s in &seeds.seeds {
			*by_source.entry(format!("{:?}", s.source)).or_default() += 1;
		}
		let summary = by_source
			.iter()
			.map(|(k, v)| format!("{k}={v}"))
			.collect::<Vec<_>>()
			.join(" ");
		println!("seeds:      {} ({})", seeds.seeds.len(), summary);
		for s in seeds.seeds.iter().take(LIST_PREVIEW) {
			match s.end_rva {
				Some(end) => println!("  0x{:08X}..0x{:08X}  {:?}", s.rva, end, s.source),
				None => println!("  0x{:08X}              {:?}", s.rva, s.source),
			}
		}
		if seeds.seeds.len() > LIST_PREVIEW {
			println!("  ... {} more", seeds.seeds.len() - LIST_PREVIEW);
		}
	}

	session.shutdown()
}

/// Names the directories a parse could not deliver in full.
///
/// One line rather than thirteen fields: the harness exists to make a partial
/// parse visible, and the detail is on the wire for anyone who needs it.
fn parse_gaps(info: &GetImageInfoResult) -> Vec<&'static str> {
	let flags = [
		(info.imports_failed, "imports failed"),
		(info.imports_truncated, "imports truncated"),
		(info.exports_failed, "exports failed"),
		(info.exports_truncated, "exports truncated"),
		(
			info.exception_directory_failed,
			"exception directory failed",
		),
		(info.function_seeds_truncated, "seeds truncated"),
		(info.relocations_failed, "relocations failed"),
		(info.relocations_truncated, "relocations truncated"),
		(info.tls_failed, "TLS failed"),
		(info.section_names_unreadable, "section names unreadable"),
	];
	let named: Vec<_> = flags
		.into_iter()
		.filter_map(|(set, label)| set.then_some(label))
		.collect();
	if named.is_empty() {
		// `fully_parsed` also folds in the per-module and per-callback signals,
		// which have no image-level flag to name.
		vec!["a module, symbol, or TLS callback list is incomplete"]
	} else {
		named
	}
}

fn cmd_spaces(session: &mut Session) -> Result<()> {
	let resp = session.call("listSpaces", serde_json::Value::Null)?;
	let spaces: delver_protocol::ListSpacesResult = serde_json::from_value(resp)?;

	for s in &spaces.spaces {
		let translates = s
			.translates_to
			.as_deref()
			.map(|t| format!(" -> {t}"))
			.unwrap_or_default();
		println!(
			"{} ({:?}, {}-bit){}",
			s.id, s.kind, s.pointer_width, translates
		);
	}
	session.shutdown()
}

fn cmd_read(session: &mut Session, space: &str, address: &str, length: &str) -> Result<()> {
	let address = parse_hex(address).with_context(|| format!("invalid address: {address}"))?;
	let length = parse_hex(length).with_context(|| format!("invalid length: {length}"))?;

	let params = ReadMemoryParams {
		space: space.to_string(),
		address,
		len: length,
		// Invariant 1: a read names its moment. Everything reachable
		// today is a static target, so this is the static moment
		// rather than an omission the provider has to interpret.
		moment: delver_core::Moment::STATIC.into(),
	};
	let resp = session.call("readMemory", serde_json::to_value(params)?)?;
	let read_result: delver_protocol::ReadMemoryResult = serde_json::from_value(resp)?;

	let (frame_id, bytes) = session.read_frame()?;
	if frame_id != read_result.data.frame_id {
		bail!(
			"frame id mismatch: expected {}, got {}",
			read_result.data.frame_id,
			frame_id
		);
	}
	if bytes.len() as u64 != read_result.data.len {
		bail!(
			"frame length mismatch: expected {}, got {}",
			read_result.data.len,
			bytes.len()
		);
	}

	println!(
		"read {} bytes at 0x{:X} from space '{}' (frame {})",
		bytes.len(),
		address,
		space,
		frame_id
	);
	if !read_result.valid.is_empty() {
		print!("valid ranges:");
		for r in &read_result.valid {
			print!(" [0x{:X}, 0x{:X})", r.start, r.end);
		}
		println!();
	}
	println!();
	hex_dump(address, &bytes);
	session.shutdown()
}

fn parse_hex(s: &str) -> Result<u64> {
	let s = s.strip_prefix("0x").unwrap_or(s);
	u64::from_str_radix(s, 16).context("expected a hex integer")
}

fn hex_dump(base: u64, bytes: &[u8]) {
	const ROW: usize = 16;
	for (i, chunk) in bytes.chunks(ROW).enumerate() {
		let offset = base + (i * ROW) as u64;
		print!("{:016X}  ", offset);
		for b in chunk {
			print!("{:02X} ", b);
		}
		for _ in chunk.len()..ROW {
			print!("   ");
		}
		print!(" |");
		for b in chunk {
			let c = if b.is_ascii_graphic() || *b == b' ' {
				*b as char
			} else {
				'.'
			};
			print!("{}", c);
		}
		println!("|");
	}
}

/// Drives the full pipeline with provider and analysis as separate processes.
///
/// This is the Stage D acceptance path: nothing here opens the file directly,
/// and the analysis server reaches the bytes only through the provider.
fn cmd_analyze(file: &Path, rows: u64) -> Result<()> {
	let unique = std::process::id();
	let provider_endpoint = format!("pipe://delver-provider-{unique}");
	let analysis_endpoint = format!("pipe://delver-analysis-{unique}");

	let mut provider = Command::new("provider-file")
		.arg("--listen")
		.arg(&provider_endpoint)
		.arg(file)
		.spawn()
		.context("spawning provider-file; is it on PATH?")?;

	// Both servers bind before accepting, so a short wait avoids a connect race.
	// A readiness handshake would be better; this is a harness, not the IDE.
	std::thread::sleep(std::time::Duration::from_millis(300));

	let mut analysis = Command::new("server-analysis")
		.arg("--provider")
		.arg(&provider_endpoint)
		.arg("--listen")
		.arg(&analysis_endpoint)
		.spawn()
		.context("spawning server-analysis; is it on PATH?")?;

	std::thread::sleep(std::time::Duration::from_millis(300));

	let result = run_analysis(&analysis_endpoint, rows);

	let _ = analysis.kill();
	let _ = analysis.wait();
	let _ = provider.kill();
	let _ = provider.wait();
	result
}

fn run_analysis(endpoint: &str, rows: u64) -> Result<()> {
	let mut session = Session::connect(endpoint)?;

	let response = session.call("analysis/openImage", serde_json::Value::Null)?;
	let opened: OpenImageResult = serde_json::from_value(response)?;

	println!("arch:         {}", opened.arch);
	println!("instructions: {}", opened.instruction_count);
	println!("functions:    {}", opened.function_count);
	println!("xrefs:        {}", opened.xref_count);
	println!("strings:      {}", opened.string_count);
	// Printed before anything derived from those counts: they are counts over
	// the bytes that were read, and an unreadable range is a range none of them
	// says anything about.
	if !opened.coverage_complete {
		println!(
			"coverage:     PARTIAL — read 0x{:X} bytes",
			opened.bytes_read
		);
		for range in &opened.unreadable_ranges {
			println!("  unreadable  [0x{:X}, 0x{:X})", range.start, range.end);
		}
	}

	let params = serde_json::json!({ "image_id": opened.image_id });
	let response = session.call("analysis/functions", params.clone())?;
	let functions: FunctionsResult = serde_json::from_value(response)?;

	println!();
	println!("functions (first {LIST_PREVIEW}):");
	for function in functions.functions.iter().take(LIST_PREVIEW) {
		let mark = if function.authoritative { ' ' } else { '?' };
		println!("  {mark} 0x{:08X}  {:?}", function.rva, function.source);
	}
	// Counted against the untruncated total, not against the page: the server
	// bounds this list, and "N more" measured from a bounded page would under-
	// report the image.
	if functions.total > LIST_PREVIEW as u64 {
		println!("  ... {} more", functions.total - LIST_PREVIEW as u64);
	}
	if functions.list_truncated {
		println!(
			"  (server returned {} of {} functions)",
			functions.functions.len(),
			functions.total
		);
	}

	let window = serde_json::json!({
		"image_id": opened.image_id,
		"start_row": 0,
		"count": rows,
	});
	let response = session.call("analysis/listingWindow", window)?;
	let listing: ListingWindowResult = serde_json::from_value(response)?;

	println!();
	println!(
		"listing (rows 0..{} of {}):",
		listing.rows.len(),
		listing.total_rows
	);
	for row in &listing.rows {
		match row {
			ListingWindowRowWire::Instruction(row) => {
				let operands = if row.operands.is_empty() {
					String::new()
				} else {
					format!(" {}", row.operands)
				};
				let target = match row.branch_target {
					Some(target) => format!("   -> 0x{target:X}"),
					None => String::new(),
				};
				println!(
					"  {:>5}  0x{:08X}  {}{}{}",
					row.row, row.rva, row.mnemonic, operands, target
				);
			}
			ListingWindowRowWire::String(row) => {
				// Escaped: this text came from the image and is attacker-controlled.
				println!("  {:>5}  0x{:08X}  {:?}", row.row, row.rva, row.text);
			}
		}
	}

	session.shutdown()
}
