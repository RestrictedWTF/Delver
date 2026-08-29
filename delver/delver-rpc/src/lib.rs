//! Delver RPC transport.
//!
//! Provides LSP-style framed reading/writing plus thin client and server halves
//! built on top of the framing layer.

#![deny(unsafe_code)]
#![warn(missing_docs)]

pub mod client;
pub mod framed;
pub mod listener;
mod private_directory;
pub mod server;

#[cfg(unix)]
mod listener_unix;
#[cfg(windows)]
mod listener_windows;

pub use client::Client;
pub use framed::{Message, Transport, TransportLimits};
pub use listener::{
	connect, connect_shutdownable, Endpoint, Listener, ListenerError, PeerIdentity,
};
pub use private_directory::{ensure_private_directory, PrivateDirectoryError};
pub use server::Server;

use std::io;

/// Errors that can occur at the transport layer.
#[derive(Debug, thiserror::Error)]
pub enum TransportError {
	/// An underlying I/O error.
	#[error("io error: {0}")]
	Io(#[from] io::Error),

	/// A header was malformed or missing a required field.
	#[error("malformed header: {0}")]
	MalformedHeader(String),

	/// A declared or outgoing frame exceeded the transport limit.
	#[error("{kind} frame is too large: {size} bytes exceeds the {limit} byte limit")]
	MessageTooLarge {
		/// Frame kind used for diagnostics.
		kind: &'static str,
		/// Declared or outgoing payload size.
		size: usize,
		/// Maximum accepted payload size.
		limit: usize,
	},

	/// A JSON frame contained invalid UTF-8.
	#[error("invalid utf-8 in json frame")]
	InvalidUtf8(#[from] std::string::FromUtf8Error),

	/// A JSON payload could not be parsed.
	#[error("json error: {0}")]
	Json(#[from] serde_json::Error),
}
