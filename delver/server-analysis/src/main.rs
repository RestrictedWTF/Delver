//! Delver analysis server.
//!
//! Owns the fact store for one target and serves the `analysis/*` methods.
//! Connects to a provider as a client (P1 decision E1) rather than opening any
//! file itself — a provider serves bytes and target state, the analysis server
//! interprets them, and the two never link each other's crates.

mod image;

use std::io;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use clap::Parser;
use delver_analysis::FunctionSource;
use delver_disasm::FlowKind;
use delver_protocol::{
	AddressForRowParams, AddressForRowResult, ErrorKind, FlowKindWire, FunctionSourceWire,
	FunctionWire, FunctionsResult, ImageQueryParams, InitializeResult, ListingRowWire,
	ListingWindowParams, ListingWindowResult, OpenImageParams, OpenImageResult, Request, Response,
	RowForAddressParams, RowForAddressResult, RpcError, StringEncodingWire, StringWire,
	StringsResult, TargetCapabilityWire, TargetDescriptorWire, XrefKindWire, XrefWire, XrefsParams,
	XrefsResult,
};
use delver_rpc::{Listener, Server};

use crate::image::{load, LoadedImage, ProviderConnection};

/// Hard cap on rows per `listingWindow` response.
///
/// Bounded output is a protocol rule, not a nicety: an unbounded request must
/// fail usefully rather than serialise a million rows into one message.
const MAX_ROWS: u64 = 4096;

#[derive(Parser, Debug)]
#[command(name = "server-analysis")]
#[command(about = "Delver analysis server")]
struct Args {
	/// Provider endpoint to pull bytes from.
	#[arg(long)]
	provider: String,
	/// Listen on a local endpoint instead of using stdio.
	#[arg(long)]
	listen: Option<String>,
}

/// Server state shared across connections.
struct State {
	provider: ProviderConnection,
	image: Option<LoadedImage>,
}

fn main() -> Result<()> {
	let args = Args::parse();
	let provider = ProviderConnection::connect(&args.provider)?;
	let state = Arc::new(Mutex::new(State {
		provider,
		image: None,
	}));

	if let Some(endpoint) = args.listen {
		let listener = Listener::bind(&endpoint)?;
		eprintln!(
			"server-analysis listening on {}",
			listener.endpoint().client_string()
		);
		loop {
			let (reader, writer) = listener.accept()?;
			let state = Arc::clone(&state);
			std::thread::spawn(move || {
				let mut server = Server::new(reader, writer);
				if let Err(e) = serve(&mut server, state) {
					eprintln!("client handler error: {e}");
				}
			});
		}
	} else {
		let stdin = io::stdin();
		let stdout = io::stdout();
		let mut server = Server::new(stdin.lock(), stdout.lock());
		serve(&mut server, state)
	}
}

fn serve<R: io::Read, W: io::Write>(
	server: &mut Server<R, W>,
	state: Arc<Mutex<State>>,
) -> Result<()> {
	loop {
		let request = match server.read_request() {
			Ok(request) => request,
			// EOF on the transport is a graceful disconnect, not an error.
			Err(delver_rpc::TransportError::Io(e)) if e.kind() == io::ErrorKind::UnexpectedEof => {
				return Ok(());
			}
			Err(e) => {
				eprintln!("read error: {e}");
				return Ok(());
			}
		};

		let shutdown = request.method == "shutdown";
		let response = handle(&request, &state);
		server.send_response(&response)?;

		if shutdown {
			let mut state = state.lock().expect("state lock");
			let _ = state.provider.shutdown();
			return Ok(());
		}
	}
}

fn handle(request: &Request, state: &Arc<Mutex<State>>) -> Response {
	let result = match request.method.as_str() {
		"initialize" => Ok(serde_json::to_value(initialize()).unwrap_or_default()),
		"shutdown" => Ok(serde_json::Value::Null),
		"analysis/openImage" => open_image(request, state),
		"analysis/listingWindow" => listing_window(request, state),
		"analysis/rowForAddress" => row_for_address(request, state),
		"analysis/addressForRow" => address_for_row(request, state),
		"analysis/functions" => functions(request, state),
		"analysis/xrefsTo" => xrefs(request, state, true),
		"analysis/xrefsFrom" => xrefs(request, state, false),
		"analysis/strings" => strings(request, state),
		other => Err(RpcError::domain(
			ErrorKind::UnsupportedCapability,
			format!("method {other} is not supported"),
		)),
	};

	match result {
		Ok(value) => Response {
			id: request.id,
			result: Some(value),
			error: None,
		},
		Err(error) => Response {
			id: request.id,
			result: None,
			error: Some(error),
		},
	}
}

fn initialize() -> InitializeResult {
	InitializeResult {
		protocol_version: "1".to_string(),
		capabilities: vec![TargetCapabilityWire::Analyze],
		spaces: Vec::new(),
		target: TargetDescriptorWire {
			name: "analysis".to_string(),
			kind: "analysis".to_string(),
		},
	}
}

/// Runs `f` against the loaded image, or reports `NotAttached`.
fn with_image<T>(
	request: &Request,
	state: &Arc<Mutex<State>>,
	f: impl FnOnce(&LoadedImage) -> Result<T, RpcError>,
) -> Result<T, RpcError> {
	let params: ImageQueryParams = parse_params(request)?;
	let state = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;

	let image = state.image.as_ref().ok_or_else(|| {
		RpcError::domain(
			ErrorKind::NotAttached,
			"no image is open; call analysis/openImage first",
		)
	})?;
	if image.id != params.image_id {
		return Err(RpcError::domain(
			ErrorKind::InvalidAddress,
			format!("unknown image id {}", params.image_id),
		));
	}
	f(image)
}

fn parse_params<T: serde::de::DeserializeOwned>(request: &Request) -> Result<T, RpcError> {
	serde_json::from_value(request.params.clone()).map_err(|e| {
		RpcError::protocol(
			-32602,
			format!("invalid params for {}: {e}", request.method),
		)
	})
}

fn open_image(request: &Request, state: &Arc<Mutex<State>>) -> Result<serde_json::Value, RpcError> {
	let params: OpenImageParams = if request.params.is_null() {
		OpenImageParams { space: None }
	} else {
		parse_params(request)?
	};

	let mut state = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;
	let State { provider, image } = &mut *state;

	let loaded = load(provider, params.space.as_deref()).map_err(|e| {
		RpcError::domain(ErrorKind::UnreadableMemory, format!("opening image: {e}"))
	})?;

	let result = OpenImageResult {
		image_id: loaded.id.clone(),
		arch: loaded.parsed.arch.clone(),
		instruction_count: loaded.analysis.instructions.len() as u64,
		function_count: loaded.analysis.functions.len() as u64,
		xref_count: loaded.analysis.xrefs.len() as u64,
		string_count: loaded.analysis.strings.len() as u64,
	};
	*image = Some(loaded);

	serde_json::to_value(result)
		.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
}

fn listing_window(
	request: &Request,
	state: &Arc<Mutex<State>>,
) -> Result<serde_json::Value, RpcError> {
	let params: ListingWindowParams = parse_params(request)?;
	let state_guard = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;
	let image = state_guard.image.as_ref().ok_or_else(|| {
		RpcError::domain(
			ErrorKind::NotAttached,
			"no image is open; call analysis/openImage first",
		)
	})?;
	if image.id != params.image_id {
		return Err(RpcError::domain(
			ErrorKind::InvalidAddress,
			format!("unknown image id {}", params.image_id),
		));
	}

	let count = params.count.min(MAX_ROWS) as usize;
	let start = params.start_row as usize;
	let index = &image.analysis.instructions;

	let mut rows = Vec::with_capacity(count);
	for (row, rva, len) in index.rows(start, count) {
		// The bytes are gone once analysis is done, so re-decode from the
		// parsed image to format the row. The index guarantees `rva` is a real
		// boundary, which is the anchor `decode_count` requires.
		let text = decode_row(image, rva);
		rows.push(ListingRowWire {
			row: row as u64,
			rva,
			len,
			mnemonic: text.0,
			operands: text.1,
			flow: text.2,
			branch_target: text.3,
		});
	}

	serde_json::to_value(ListingWindowResult {
		rows,
		total_rows: index.len() as u64,
	})
	.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
}

/// Formats one row by re-decoding at a known instruction boundary.
fn decode_row(image: &LoadedImage, rva: u64) -> (String, String, FlowKindWire, Option<u64>) {
	let Some(bitness) = delver_disasm::Bitness::from_arch(&image.parsed.arch) else {
		return (String::new(), String::new(), FlowKindWire::Invalid, None);
	};
	let Some(bytes) = image.parsed.bytes_at(&image.bytes, rva) else {
		return (String::new(), String::new(), FlowKindWire::Invalid, None);
	};

	let disasm = delver_disasm::Disassembler::new(bitness);
	match disasm.decode_count(rva, bytes, 1).into_iter().next() {
		Some(instruction) => (
			instruction.mnemonic,
			instruction.operands,
			flow_wire(instruction.flow),
			instruction.branch_target,
		),
		None => (String::new(), String::new(), FlowKindWire::Invalid, None),
	}
}

fn row_for_address(
	request: &Request,
	state: &Arc<Mutex<State>>,
) -> Result<serde_json::Value, RpcError> {
	let params: RowForAddressParams = parse_params(request)?;
	let state = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;
	let image = state
		.image
		.as_ref()
		.ok_or_else(|| RpcError::domain(ErrorKind::NotAttached, "no image is open"))?;

	let index = &image.analysis.instructions;
	let row = if params.containing {
		index.row_containing(params.rva)
	} else {
		index.row_for_address(params.rva)
	};

	serde_json::to_value(RowForAddressResult {
		row: row.map(|r| r as u64),
	})
	.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
}

fn address_for_row(
	request: &Request,
	state: &Arc<Mutex<State>>,
) -> Result<serde_json::Value, RpcError> {
	let params: AddressForRowParams = parse_params(request)?;
	let state = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;
	let image = state
		.image
		.as_ref()
		.ok_or_else(|| RpcError::domain(ErrorKind::NotAttached, "no image is open"))?;

	serde_json::to_value(AddressForRowResult {
		rva: image
			.analysis
			.instructions
			.address_for_row(params.row as usize),
	})
	.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
}

fn functions(request: &Request, state: &Arc<Mutex<State>>) -> Result<serde_json::Value, RpcError> {
	with_image(request, state, |image| {
		let functions = image
			.analysis
			.functions
			.iter()
			.map(|f| FunctionWire {
				rva: f.rva,
				end_rva: f.end_rva,
				source: function_source_wire(f.source),
				authoritative: f.source.is_authoritative(),
			})
			.collect();

		serde_json::to_value(FunctionsResult { functions })
			.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
	})
}

fn xrefs(
	request: &Request,
	state: &Arc<Mutex<State>>,
	incoming: bool,
) -> Result<serde_json::Value, RpcError> {
	let params: XrefsParams = parse_params(request)?;
	let state = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;
	let image = state
		.image
		.as_ref()
		.ok_or_else(|| RpcError::domain(ErrorKind::NotAttached, "no image is open"))?;

	let table = &image.analysis.xrefs;
	let matches = if incoming {
		table.to(params.rva)
	} else {
		table.from(params.rva)
	};

	let xrefs = matches
		.iter()
		.map(|x| XrefWire {
			from: x.from,
			to: x.to,
			kind: xref_kind_wire(x.kind),
		})
		.collect();

	serde_json::to_value(XrefsResult { xrefs })
		.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
}

fn strings(request: &Request, state: &Arc<Mutex<State>>) -> Result<serde_json::Value, RpcError> {
	with_image(request, state, |image| {
		let strings = image
			.analysis
			.strings
			.iter()
			.map(|s| StringWire {
				rva: s.rva,
				text: s.text.clone(),
				encoding: match s.encoding {
					delver_analysis::StringEncoding::Ascii => StringEncodingWire::Ascii,
					delver_analysis::StringEncoding::Utf16Le => StringEncodingWire::Utf16Le,
				},
			})
			.collect();

		serde_json::to_value(StringsResult { strings })
			.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
	})
}

fn flow_wire(flow: FlowKind) -> FlowKindWire {
	match flow {
		FlowKind::Sequential => FlowKindWire::Sequential,
		FlowKind::Jump => FlowKindWire::Jump,
		FlowKind::ConditionalJump => FlowKindWire::ConditionalJump,
		FlowKind::Call => FlowKindWire::Call,
		FlowKind::Indirect => FlowKindWire::Indirect,
		FlowKind::Return => FlowKindWire::Return,
		FlowKind::Interrupt => FlowKindWire::Interrupt,
		FlowKind::Invalid => FlowKindWire::Invalid,
	}
}

fn function_source_wire(source: FunctionSource) -> FunctionSourceWire {
	match source {
		FunctionSource::ExceptionDirectory => FunctionSourceWire::ExceptionDirectory,
		FunctionSource::EntryPoint => FunctionSourceWire::EntryPoint,
		FunctionSource::Export => FunctionSourceWire::Export,
		FunctionSource::TlsCallback => FunctionSourceWire::TlsCallback,
		FunctionSource::CallTarget => FunctionSourceWire::CallTarget,
		FunctionSource::LinearSweep => FunctionSourceWire::LinearSweep,
	}
}

fn xref_kind_wire(kind: delver_analysis::XrefKind) -> XrefKindWire {
	match kind {
		delver_analysis::XrefKind::Call => XrefKindWire::Call,
		delver_analysis::XrefKind::Jump => XrefKindWire::Jump,
		delver_analysis::XrefKind::ConditionalJump => XrefKindWire::ConditionalJump,
		delver_analysis::XrefKind::Data => XrefKindWire::Data,
	}
}
