use std::io;
use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use delver_protocol::{ListSpacesResult, ReadMemoryParams, Request, Response, RpcError};
use delver_rpc::Server;
use provider_file::FileProvider;

#[derive(Parser, Debug)]
#[command(name = "provider-file")]
#[command(about = "Delver file provider for PE images")]
struct Args {
	/// PE file to serve.
	file: PathBuf,
}

struct HandledRequest {
	response: Response,
	frame: Option<(u64, Vec<u8>)>,
	shutdown: bool,
}

fn main() -> Result<()> {
	let args = Args::parse();
	let mut provider = FileProvider::open(&args.file)?;

	let stdin = io::stdin();
	let stdout = io::stdout();
	let mut server = Server::new(stdin.lock(), stdout.lock());

	loop {
		let request = match server.read_request() {
			Ok(req) => req,
			Err(e) => {
				// EOF on stdin is a graceful shutdown; anything else is logged.
				if is_eof(&e) {
					break;
				}
				eprintln!("failed to read request: {e}");
				continue;
			}
		};

		let handled = handle_request(&mut provider, &request);
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

fn handle_request(provider: &mut FileProvider, request: &Request) -> HandledRequest {
	let (result, frame) = match request.method.as_str() {
		"initialize" => (serde_json::to_value(provider.initialize()), None),
		"listSpaces" => (
			serde_json::to_value(ListSpacesResult {
				spaces: provider.list_spaces(),
			}),
			None,
		),
		"getImageInfo" => (serde_json::to_value(provider.get_image_info()), None),
		"readMemory" => match serde_json::from_value::<ReadMemoryParams>(request.params.clone()) {
			Ok(params) => match provider.read_memory(params) {
				Ok((result, bytes)) => {
					let frame_id = result.data.frame_id;
					(serde_json::to_value(result), Some((frame_id, bytes)))
				}
				Err(e) => {
					return HandledRequest {
						response: Response {
							id: request.id,
							result: None,
							error: Some(RpcError::domain(
								delver_protocol::ErrorKind::InvalidAddress,
								e.to_string(),
							)),
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
