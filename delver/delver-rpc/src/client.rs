//! Client half of the RPC transport.

use std::io::{Read, Write};

use delver_protocol::{Request, Response};

use crate::TransportError;
use crate::framed::{Message, Transport};

/// Client that sends requests and reads responses over a framed transport.
pub struct Client<R: Read, W: Write> {
	transport: Transport<R, W>,
}

impl<R: Read, W: Write> Client<R, W> {
	/// Creates a client over the supplied reader and writer.
	pub fn new(reader: R, writer: W) -> Self {
		Self {
			transport: Transport::new(reader, writer),
		}
	}

	/// Sends a request.
	pub fn send_request(&mut self, request: &Request) -> Result<(), TransportError> {
		let payload = serde_json::to_vec(request)?;
		self.transport.write_json(&payload)
	}

	/// Reads the next response. Binary frames that follow the response are not
	/// consumed by this call; callers should read them with [`read_frame`](Self::read_frame).
	pub fn read_response(&mut self) -> Result<Response, TransportError> {
		match self.transport.read_message()? {
			Message::Json(text) => Ok(serde_json::from_str(&text)?),
			Message::Binary { frame_id, .. } => Err(TransportError::MalformedHeader(format!(
				"expected JSON response, got binary frame {frame_id}"
			))),
		}
	}

	/// Reads the next binary frame from the transport.
	pub fn read_frame(&mut self) -> Result<(u64, Vec<u8>), TransportError> {
		match self.transport.read_message()? {
			Message::Binary { frame_id, data } => Ok((frame_id, data)),
			Message::Json(_) => Err(TransportError::MalformedHeader(
				"expected binary frame, got JSON".into(),
			)),
		}
	}
}
