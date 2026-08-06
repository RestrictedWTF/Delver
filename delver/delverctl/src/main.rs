use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use delver_protocol::{GetImageInfoResult, ReadMemoryParams, Request, Response};
use delver_rpc::Client;

#[derive(Parser, Debug)]
#[command(name = "delverctl")]
#[command(about = "Delver command-line control utility")]
struct Args {
	#[command(subcommand)]
	command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
	/// Print image architecture, entry point, and sections.
	Info { file: PathBuf },
	/// Print address spaces exposed by the file provider.
	Spaces { file: PathBuf },
	/// Read bytes from the file and print a hex dump.
	Read {
		file: PathBuf,
		address: String,
		length: String,
		#[arg(short, long, default_value = "Image")]
		space: String,
	},
}

fn main() -> Result<()> {
	let args = Args::parse();
	match args.command {
		Commands::Info { file } => cmd_info(&file),
		Commands::Spaces { file } => cmd_spaces(&file),
		Commands::Read {
			file,
			address,
			length,
			space,
		} => cmd_read(&file, &space, &address, &length),
	}
}

struct Session {
	client: Client<io::BufReader<ChildStdout>, ChildStdin>,
	child: Child,
}

impl Session {
	fn open(file: &Path) -> Result<Self> {
		let mut child = Command::new("provider-file")
			.arg(file)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.spawn()
			.context("failed to spawn provider-file; is it on PATH?")?;

		let stdin = child.stdin.take().expect("piped stdin");
		let stdout = child.stdout.take().expect("piped stdout");
		let mut client = Client::new(io::BufReader::new(stdout), stdin);

		client.send_request(&Request {
			id: 0,
			method: "initialize".to_string(),
			params: serde_json::Value::Null,
		})?;
		let init = client.read_response()?;
		if init.error.is_some() {
			bail!("initialize failed: {:?}", init.error);
		}

		Ok(Self { client, child })
	}

	/// Sends a graceful shutdown request and waits for the provider to exit.
	fn shutdown(mut self) -> Result<()> {
		self.client.send_request(&Request {
			id: 2,
			method: "shutdown".to_string(),
			params: serde_json::Value::Null,
		})?;
		let _ = self.client.read_response();
		self.child.wait().context("waiting for provider-file to exit")?;
		Ok(())
	}

	fn call(&mut self, method: &str, params: serde_json::Value) -> Result<Response> {
		self.client.send_request(&Request {
			id: 1,
			method: method.to_string(),
			params,
		})?;
		let resp = self.client.read_response()?;
		if let Some(err) = resp.error {
			bail!("{} failed: {}", method, err.message);
		}
		Ok(resp)
	}

	fn read_frame(&mut self) -> Result<(u64, Vec<u8>)> {
		self.client.read_frame().context("reading binary frame")
	}
}

fn cmd_info(file: &Path) -> Result<()> {
	let mut session = Session::open(file)?;
	let resp = session.call("getImageInfo", serde_json::Value::Null)?;
	let info: GetImageInfoResult = serde_json::from_value(resp.result.unwrap())?;

	println!("arch:       {}", info.arch);
	println!("entry:      0x{:X}", info.entry);
	println!("image_base: 0x{:X}", info.image_base);
	println!("sections:");
	for s in &info.sections {
		println!(
			"  {:<8} va=0x{:08X} vs=0x{:08X} raw=0x{:08X} rs=0x{:08X}",
			s.name, s.virtual_address, s.virtual_size, s.raw_offset, s.raw_size
		);
	}
	session.shutdown()
}

fn cmd_spaces(file: &Path) -> Result<()> {
	let mut session = Session::open(file)?;
	let resp = session.call("listSpaces", serde_json::Value::Null)?;
	let spaces: delver_protocol::ListSpacesResult = serde_json::from_value(resp.result.unwrap())?;

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

fn cmd_read(file: &Path, space: &str, address: &str, length: &str) -> Result<()> {
	let address = parse_hex(address).with_context(|| format!("invalid address: {address}"))?;
	let length = parse_hex(length).with_context(|| format!("invalid length: {length}"))?;

	let mut session = Session::open(file)?;
	let params = ReadMemoryParams {
		space: space.to_string(),
		address,
		len: length,
		moment: None,
	};
	let resp = session.call("readMemory", serde_json::to_value(params)?)?;
	let read_result: delver_protocol::ReadMemoryResult = serde_json::from_value(resp.result.unwrap())?;

	let (frame_id, bytes) = session.read_frame()?;
	if frame_id != read_result.data.frame_id {
		bail!("frame id mismatch: expected {}, got {}", read_result.data.frame_id, frame_id);
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
		bytes.len(), address, space, frame_id
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
