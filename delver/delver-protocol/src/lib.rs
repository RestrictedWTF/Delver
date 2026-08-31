//! Delver wire protocol.
//!
//! Stable, versioned types for JSON-RPC-style communication between the IDE and
//! a Delver provider. The version both sides declare is [`PROTOCOL_VERSION`].
//! Address-like values are serialized as `"0x..."` strings to
//! avoid IEEE 754 truncation.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod hex;
pub mod message;

/// The DTP protocol version every Delver process in a build declares.
///
/// One constant, imported by both responders, because a provider and the
/// analysis server ship from the same build and must agree. Two literals in two
/// crates is what let `provider-file` say `"0"` while `server-analysis` said
/// `"1"` with nothing noticing. Bump it when a change to the types in
/// [`message`] is not backwards compatible; the client refuses anything else.
pub const PROTOCOL_VERSION: &str = "1";

pub use message::*;
