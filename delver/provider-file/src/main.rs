//! Command-line entry point for the Delver file provider.
//!
//! The mapping exemption lives in the library crate; this binary only wires up
//! transports, so it forbids `unsafe` outright.

#![forbid(unsafe_code)]

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use clap::Parser;
use delver_protocol::{ListSpacesResult, ReadMemoryParams, Request, Response, RpcError};
use delver_rpc::{Listener, Server};
use provider_file::FileProvider;

#[derive(Parser, Debug)]
#[command(name = "provider-file")]
#[command(about = "Delver file provider for PE images")]
struct Args {
	/// PE file to serve.
	file: PathBuf,
	/// Listen on a local endpoint instead of using stdio. On Windows this is a
	/// named pipe; on Unix it is a Unix domain socket in a private directory.
	#[arg(long)]
	listen: Option<String>,
}

struct HandledRequest {
	response: Response,
	frame: Option<(u64, Vec<u8>)>,
	shutdown: bool,
}

fn main() -> Result<()> {
	let args = Args::parse();
	let provider = Arc::new(FileProvider::open(&args.file)?);

	if let Some(endpoint) = args.listen {
		run_listener(provider, &endpoint)
	} else {
		run_stdio(provider)
	}
}

fn run_stdio(provider: Arc<FileProvider>) -> Result<()> {
	let stdin = io::stdin();
	let stdout = io::stdout();
	let mut server = Server::new(stdin.lock(), stdout.lock());
	serve_connection(&mut server, provider)
}

fn run_listener(provider: Arc<FileProvider>, endpoint: &str) -> Result<()> {
	let listener = Listener::bind(endpoint)?;
	eprintln!(
		"provider-file listening on {}",
		listener.endpoint().client_string()
	);

	loop {
		let (reader, writer) = listener.accept()?;
		let provider = Arc::clone(&provider);
		std::thread::spawn(move || {
			let mut server = Server::new(reader, writer);
			if let Err(e) = serve_connection(&mut server, provider) {
				eprintln!("client handler error: {e}");
			}
		});
	}
}

fn serve_connection<R, W>(server: &mut Server<R, W>, provider: Arc<FileProvider>) -> Result<()>
where
	R: io::Read,
	W: io::Write,
{
	loop {
		let request = match server.read_request() {
			Ok(req) => req,
			Err(e) => {
				// EOF on the transport is a graceful shutdown; anything else is logged.
				if is_eof(&e) {
					break;
				}
				eprintln!("failed to read request: {e}");
				continue;
			}
		};

		let handled = handle_request(&provider, &request);
		server.send_response(&handled.response)?;

		if let Some((frame_id, bytes)) = handled.frame {
			server.send_frame(frame_id, &bytes)?;
		}

		if handled.shutdown {
			break;
		}
	}

	Ok(())
}

fn is_eof(err: &delver_rpc::TransportError) -> bool {
	matches!(
		err,
		delver_rpc::TransportError::Io(io_err) if io_err.kind() == io::ErrorKind::UnexpectedEof
	)
}

fn handle_request(provider: &FileProvider, request: &Request) -> HandledRequest {
	let (result, frame) = match request.method.as_str() {
		"initialize" => (serde_json::to_value(provider.initialize()), None),
		"listSpaces" => (
			serde_json::to_value(ListSpacesResult {
				spaces: provider.list_spaces(),
			}),
			None,
		),
		"getImageInfo" => (serde_json::to_value(provider.get_image_info()), None),
		"getImports" => (serde_json::to_value(provider.get_imports()), None),
		"getExports" => (serde_json::to_value(provider.get_exports()), None),
		"getFunctionSeeds" => (serde_json::to_value(provider.get_function_seeds()), None),
		"readMemory" => match serde_json::from_value::<ReadMemoryParams>(request.params.clone()) {
			Ok(params) => match provider.read_memory(params) {
				Ok((result, bytes)) => {
					let frame_id = result.data.frame_id;
					(serde_json::to_value(result), Some((frame_id, bytes)))
				}
				// The provider chose the error kind: a bad space and a moment it
				// cannot serve are different refusals and must not be flattened
				// into one.
				Err(error) => {
					return HandledRequest {
						response: Response {
							id: request.id,
							result: None,
							error: Some(error),
						},
						frame: None,
						shutdown: false,
					}
				}
			},
			Err(e) => (Err(e), None),
		},
		"shutdown" => (Ok(serde_json::Value::Null), None),
		_ => {
			return HandledRequest {
				response: Response {
					id: request.id,
					result: None,
					error: Some(RpcError::domain(
						delver_protocol::ErrorKind::UnsupportedCapability,
						format!("method {} is not supported", request.method),
					)),
				},
				frame: None,
				shutdown: false,
			}
		}
	};

	let response = match result {
		Ok(value) => Response {
			id: request.id,
			result: Some(value),
			error: None,
		},
		Err(e) => Response {
			id: request.id,
			result: None,
			error: Some(RpcError::protocol(-32700, e.to_string())),
		},
	};

	HandledRequest {
		response,
		frame,
		shutdown: request.method == "shutdown",
	}
}
