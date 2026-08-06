//! LSP-style framed transport for JSON and binary payloads.
//!
//! JSON frames:
//! ```text
//! Content-Length: <n>\r\n
//! \r\n
//! <n bytes UTF-8 JSON>
//! ```
//!
//! Binary frames:
//! ```text
//! Delver-Frame: <id>\r\n
//! Content-Length: <n>\r\n
//! \r\n
//! <n bytes raw>
//! ```
//!
//! Binary frames always immediately follow the JSON message that references
//! them, before the next JSON message.

use std::io::{Read, Write};

use crate::TransportError;

/// A single message read from the transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
	/// A UTF-8 JSON payload.
	Json(String),
	/// A raw binary frame.
	Binary {
		/// Frame id from the `Delver-Frame` header.
		frame_id: u64,
		/// Raw bytes.
		data: Vec<u8>,
	},
}

#[derive(Debug, Default)]
struct Headers {
	content_length: Option<usize>,
	frame_id: Option<u64>,
}

/// Low-level framed transport reader and writer.
pub struct Transport<R, W> {
	reader: R,
	writer: W,
}

impl<R: Read, W: Write> Transport<R, W> {
	/// Creates a new transport over the supplied reader and writer.
	pub fn new(reader: R, writer: W) -> Self {
		Self { reader, writer }
	}

	/// Reads the next message from the wire.
	pub fn read_message(&mut self) -> Result<Message, TransportError> {
		let header = read_header_bytes(&mut self.reader)?;
		let headers = parse_headers(&header)?;

		let content_length = headers
			.content_length
			.ok_or_else(|| TransportError::MalformedHeader("missing Content-Length".into()))?;

		let mut body = vec![0u8; content_length];
		self.reader.read_exact(&mut body)?;

		match headers.frame_id {
			Some(frame_id) => Ok(Message::Binary {
				frame_id,
				data: body,
			}),
			None => {
				let text = String::from_utf8(body)?;
				Ok(Message::Json(text))
			}
		}
	}

	/// Writes a JSON frame.
	pub fn write_json(&mut self, payload: &[u8]) -> Result<(), TransportError> {
		write!(self.writer, "Content-Length: {}\r\n\r\n", payload.len())?;
		self.writer.write_all(payload)?;
		self.writer.flush()?;
		Ok(())
	}

	/// Writes a binary frame that follows a JSON message.
	pub fn write_binary(&mut self, frame_id: u64, payload: &[u8]) -> Result<(), TransportError> {
		write!(
			self.writer,
			"Delver-Frame: {}\r\nContent-Length: {}\r\n\r\n",
			frame_id,
			payload.len()
		)?;
		self.writer.write_all(payload)?;
		self.writer.flush()?;
		Ok(())
	}

	/// Splits the transport into its reader and writer halves.
	pub fn into_parts(self) -> (R, W) {
		(self.reader, self.writer)
	}
}

fn read_header_bytes<R: Read>(reader: &mut R) -> Result<Vec<u8>, TransportError> {
	let mut header = Vec::new();
	loop {
		let mut byte = [0u8; 1];
		reader.read_exact(&mut byte)?;
		header.push(byte[0]);
		if header.ends_with(b"\r\n\r\n") {
			header.truncate(header.len() - 4);
			return Ok(header);
		}
	}
}

fn parse_headers(header: &[u8]) -> Result<Headers, TransportError> {
	let text = std::str::from_utf8(header)
		.map_err(|e| TransportError::MalformedHeader(format!("header is not valid utf-8: {e}")))?;

	let mut headers = Headers::default();
	for line in text.split("\r\n") {
		if line.is_empty() {
			continue;
		}
		let (key, value) = line.split_once(':').ok_or_else(|| {
			TransportError::MalformedHeader(format!("header line missing colon: {line}"))
		})?;
		let key = key.trim();
		let value = value.trim();
		match key {
			"Content-Length" => {
				headers.content_length = Some(value.parse().map_err(|e| {
					TransportError::MalformedHeader(format!(
						"invalid Content-Length '{value}': {e}"
					))
				})?);
			}
			"Delver-Frame" => {
				headers.frame_id = Some(value.parse().map_err(|e| {
					TransportError::MalformedHeader(format!("invalid Delver-Frame '{value}': {e}"))
				})?);
			}
			_ => {}
		}
	}
	Ok(headers)
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io;

	#[test]
	fn reads_json_message() {
		let input = b"Content-Length: 11\r\n\r\n{\"ok\":true}";
		let mut transport = Transport::new(&input[..], Vec::new());
		let msg = transport.read_message().unwrap();
		assert_eq!(msg, Message::Json(r#"{"ok":true}"#.into()));
	}

	#[test]
	fn reads_json_then_trailing_binary_frame() {
		let input = b"Content-Length: 2\r\n\r\n{}Delver-Frame: 7\r\nContent-Length: 4\r\n\r\nABCD";
		let mut transport = Transport::new(&input[..], Vec::new());

		assert_eq!(
			transport.read_message().unwrap(),
			Message::Json("{}".into())
		);
		assert_eq!(
			transport.read_message().unwrap(),
			Message::Binary {
				frame_id: 7,
				data: b"ABCD".to_vec(),
			}
		);
	}

	#[test]
	fn split_read_across_buffer_boundaries() {
		// A reader that yields one byte per call to exercise the byte-by-byte
		// header parser and partial body reads.
		struct SlowReader(&'static [u8]);
		impl Read for SlowReader {
			fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
				if self.0.is_empty() {
					return Ok(0);
				}
				let n = buf.len().min(1).min(self.0.len());
				buf[..n].copy_from_slice(&self.0[..n]);
				self.0 = &self.0[n..];
				Ok(n)
			}
		}

		let input = b"Content-Length: 11\r\n\r\n{\"ok\":true}";
		let mut transport = Transport::new(SlowReader(input), Vec::new());
		let msg = transport.read_message().unwrap();
		assert_eq!(msg, Message::Json(r#"{"ok":true}"#.into()));
	}

	#[test]
	fn malformed_header_is_rejected() {
		let input = b"Bad-Header\r\n\r\n";
		let mut transport = Transport::new(&input[..], Vec::new());
		let err = transport.read_message().unwrap_err();
		assert!(matches!(err, TransportError::MalformedHeader(_)));
	}

	#[test]
	fn writes_json_frame() {
		let mut transport = Transport::new(io::empty(), Vec::new());
		transport.write_json(br#"{"ok":true}"#).unwrap();
		assert_eq!(
			String::from_utf8(transport.into_parts().1).unwrap(),
			"Content-Length: 11\r\n\r\n{\"ok\":true}"
		);
	}

	#[test]
	fn writes_binary_frame() {
		let mut transport = Transport::new(io::empty(), Vec::new());
		transport.write_binary(3, b"xyz").unwrap();
		assert_eq!(
			String::from_utf8(transport.into_parts().1).unwrap(),
			"Delver-Frame: 3\r\nContent-Length: 3\r\n\r\nxyz"
		);
	}
}
