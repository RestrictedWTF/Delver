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

/// Maximum accepted header size before the terminating blank line.
pub const MAX_HEADER_BYTES: usize = 8 * 1024;
/// Maximum JSON payload size. Protocol inventories must paginate above this.
pub const MAX_JSON_FRAME_BYTES: usize = 16 * 1024 * 1024;
/// Maximum binary payload size, preserving the documented tens-of-megabytes use case.
pub const MAX_BINARY_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// Per-transport frame bounds applied before payload allocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransportLimits {
	/// Maximum accepted header size before the terminating blank line.
	pub max_header_bytes: usize,
	/// Maximum JSON payload size.
	pub max_json_frame_bytes: usize,
	/// Maximum binary payload size.
	pub max_binary_frame_bytes: usize,
}

impl Default for TransportLimits {
	fn default() -> Self {
		Self {
			max_header_bytes: MAX_HEADER_BYTES,
			max_json_frame_bytes: MAX_JSON_FRAME_BYTES,
			max_binary_frame_bytes: MAX_BINARY_FRAME_BYTES,
		}
	}
}

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
	limits: TransportLimits,
}

impl<R: Read, W: Write> Transport<R, W> {
	/// Creates a new transport over the supplied reader and writer.
	pub fn new(reader: R, writer: W) -> Self {
		Self {
			reader,
			writer,
			limits: TransportLimits::default(),
		}
	}

	/// Creates a transport with protocol-specific bounds.
	pub fn with_limits(reader: R, writer: W, limits: TransportLimits) -> Self {
		Self {
			reader,
			writer,
			limits,
		}
	}

	/// Reads the next message from the wire.
	pub fn read_message(&mut self) -> Result<Message, TransportError> {
		let header = read_header_bytes(&mut self.reader, self.limits.max_header_bytes)?;
		let headers = parse_headers(&header)?;

		let content_length = headers
			.content_length
			.ok_or_else(|| TransportError::MalformedHeader("missing Content-Length".into()))?;
		let (kind, limit) = if headers.frame_id.is_some() {
			("binary", self.limits.max_binary_frame_bytes)
		} else {
			("JSON", self.limits.max_json_frame_bytes)
		};
		if content_length > limit {
			return Err(TransportError::MessageTooLarge {
				kind,
				size: content_length,
				limit,
			});
		}

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
		ensure_payload_limit("JSON", payload.len(), self.limits.max_json_frame_bytes)?;
		write!(self.writer, "Content-Length: {}\r\n\r\n", payload.len())?;
		self.writer.write_all(payload)?;
		self.writer.flush()?;
		Ok(())
	}

	/// Writes a binary frame that follows a JSON message.
	pub fn write_binary(&mut self, frame_id: u64, payload: &[u8]) -> Result<(), TransportError> {
		ensure_payload_limit("binary", payload.len(), self.limits.max_binary_frame_bytes)?;
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

fn read_header_bytes<R: Read>(
	reader: &mut R,
	max_header_bytes: usize,
) -> Result<Vec<u8>, TransportError> {
	let mut header = Vec::new();
	loop {
		let mut byte = [0u8; 1];
		reader.read_exact(&mut byte)?;
		header.push(byte[0]);
		if header.len() > max_header_bytes.saturating_add(4) {
			return Err(TransportError::MessageTooLarge {
				kind: "header",
				size: header.len() - 4,
				limit: max_header_bytes,
			});
		}
		if header.ends_with(b"\r\n\r\n") {
			header.truncate(header.len() - 4);
			if header.len() > max_header_bytes {
				return Err(TransportError::MessageTooLarge {
					kind: "header",
					size: header.len(),
					limit: max_header_bytes,
				});
			}
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
				if headers.content_length.is_some()
					|| value.is_empty()
					|| !value.bytes().all(|byte| byte.is_ascii_digit())
				{
					return Err(TransportError::MalformedHeader(
						"Content-Length must appear exactly once as decimal digits".into(),
					));
				}
				headers.content_length = Some(value.parse().map_err(|e| {
					TransportError::MalformedHeader(format!(
						"invalid Content-Length '{value}': {e}"
					))
				})?);
			}
			"Delver-Frame" => {
				if headers.frame_id.is_some()
					|| value.is_empty()
					|| !value.bytes().all(|byte| byte.is_ascii_digit())
				{
					return Err(TransportError::MalformedHeader(
						"Delver-Frame must appear at most once as decimal digits".into(),
					));
				}
				headers.frame_id = Some(value.parse().map_err(|e| {
					TransportError::MalformedHeader(format!("invalid Delver-Frame '{value}': {e}"))
				})?);
			}
			_ => {}
		}
	}
	Ok(headers)
}

fn ensure_payload_limit(
	kind: &'static str,
	size: usize,
	limit: usize,
) -> Result<(), TransportError> {
	if size > limit {
		return Err(TransportError::MessageTooLarge { kind, size, limit });
	}
	Ok(())
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
	fn protocol_specific_limit_rejects_declared_body_before_reading_it() {
		let input = b"Content-Length: 5\r\n\r\n";
		let limits = TransportLimits {
			max_header_bytes: 64,
			max_json_frame_bytes: 4,
			max_binary_frame_bytes: 0,
		};
		let mut transport = Transport::with_limits(&input[..], Vec::new(), limits);

		assert!(matches!(
			transport.read_message(),
			Err(TransportError::MessageTooLarge {
				kind: "JSON",
				size: 5,
				limit: 4,
			})
		));
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
	fn oversized_header_is_rejected_before_unbounded_growth() {
		let mut input = vec![b'x'; MAX_HEADER_BYTES + 1];
		input.extend_from_slice(b"\r\n\r\n");
		let mut transport = Transport::new(&input[..], Vec::new());
		let err = transport.read_message().unwrap_err();
		assert!(matches!(
			err,
			TransportError::MessageTooLarge {
				kind: "header",
				limit: MAX_HEADER_BYTES,
				..
			}
		));
	}

	#[test]
	fn oversized_payload_is_rejected_before_allocation() {
		let input = format!("Content-Length: {}\r\n\r\n", MAX_JSON_FRAME_BYTES + 1);
		let mut transport = Transport::new(input.as_bytes(), Vec::new());
		let err = transport.read_message().unwrap_err();
		assert!(matches!(
			err,
			TransportError::MessageTooLarge {
				kind: "JSON",
				limit: MAX_JSON_FRAME_BYTES,
				..
			}
		));
	}

	#[test]
	fn duplicate_and_non_decimal_lengths_are_rejected() {
		for input in [
			b"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}".as_slice(),
			b"Content-Length: +2\r\n\r\n{}".as_slice(),
		] {
			let mut transport = Transport::new(input, Vec::new());
			assert!(matches!(
				transport.read_message().unwrap_err(),
				TransportError::MalformedHeader(_)
			));
		}
	}

	#[test]
	fn outgoing_payload_limits_are_enforced() {
		assert!(matches!(
			ensure_payload_limit("JSON", MAX_JSON_FRAME_BYTES + 1, MAX_JSON_FRAME_BYTES),
			Err(TransportError::MessageTooLarge {
				kind: "JSON",
				limit: MAX_JSON_FRAME_BYTES,
				..
			})
		));
		assert!(matches!(
			ensure_payload_limit("binary", MAX_BINARY_FRAME_BYTES + 1, MAX_BINARY_FRAME_BYTES),
			Err(TransportError::MessageTooLarge {
				kind: "binary",
				limit: MAX_BINARY_FRAME_BYTES,
				..
			})
		));
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
