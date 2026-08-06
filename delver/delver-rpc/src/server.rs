//! Server half of the RPC transport.

use std::io::{Read, Write};

use delver_protocol::{Request, Response};

use crate::framed::{Message, Transport};
use crate::TransportError;

/// Server that reads requests and sends responses over a framed transport.
pub struct Server<R: Read, W: Write> {
	transport: Transport<R, W>,
}

impl<R: Read, W: Write> Server<R, W> {
	/// Creates a server over the supplied reader and writer.
	pub fn new(reader: R, writer: W) -> Self {
		Self {
			transport: Transport::new(reader, writer),
		}
	}

	/// Reads the next request.
	pub fn read_request(&mut self) -> Result<Request, TransportError> {
		match self.transport.read_message()? {
			Message::Json(text) => Ok(serde_json::from_str(&text)?),
			Message::Binary { frame_id, .. } => Err(TransportError::MalformedHeader(format!(
				"expected JSON request, got binary frame {frame_id}"
			))),
		}
	}

	/// Sends a response.
	pub fn send_response(&mut self, response: &Response) -> Result<(), TransportError> {
		let payload = serde_json::to_vec(response)?;
		self.transport.write_json(&payload)
	}

	/// Sends a binary frame that immediately follows a response.
	pub fn send_frame(&mut self, frame_id: u64, data: &[u8]) -> Result<(), TransportError> {
		self.transport.write_binary(frame_id, data)
	}
}
