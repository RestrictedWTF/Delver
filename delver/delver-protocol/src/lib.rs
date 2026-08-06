//! Delver wire protocol v0.
//!
//! Stable, versioned types for JSON-RPC-style communication between the IDE and
//! a Delver provider. Address-like values are serialized as `"0x..."` strings to
//! avoid IEEE 754 truncation.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod hex;
pub mod message;

pub use message::*;
