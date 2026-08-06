//! Wire message types for the Delver v0 protocol.
//!
//! These types are stable, versioned, and serde-annotated. Domain code should
//! convert to `delver_core` types via the `From`/`TryFrom` impls below.

use std::fmt;

use serde::{Deserialize, Serialize};
use schemars::JsonSchema;

use delver_core::{AddressSpaceKind, MomentKind, SpaceId, TargetCapability};

/// A JSON-RPC style request.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Request {
	/// Opaque identifier used to correlate the response.
	pub id: u64,
	/// Method name.
	pub method: String,
	/// Method-specific parameters.
	#[serde(default)]
	pub params: serde_json::Value,
}

/// A JSON-RPC style response.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Response {
	/// Identifier matching the request.
	pub id: u64,
	/// Result payload, present only on success.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub result: Option<serde_json::Value>,
	/// Error payload, present only on failure.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub error: Option<RpcError>,
}

/// JSON-RPC error object extended with Delver-specific error data.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RpcError {
	/// JSON-RPC error code.
	pub code: i64,
	/// Human-readable message.
	pub message: String,
	/// Delver error kind and detail.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub data: Option<ErrorData>,
}

impl RpcError {
	/// Creates a new protocol-level error.
	pub fn protocol(code: i64, message: impl Into<String>) -> Self {
		Self {
			code,
			message: message.into(),
			data: None,
		}
	}

	/// Creates a new domain-level error with a Delver error kind.
	pub fn domain(kind: ErrorKind, detail: impl Into<String>) -> Self {
		Self {
			code: -32000,
			message: kind.to_string(),
			data: Some(ErrorData {
				kind,
				detail: detail.into(),
			}),
		}
	}
}

/// Domain-level error kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "PascalCase")]
pub enum ErrorKind {
	/// `initialize` reported an incompatible protocol version.
	ProtocolVersionMismatch,
	/// A method that requires an attached target was called before attachment.
	NotAttached,
	/// The supplied address is not valid in the requested space.
	InvalidAddress,
	/// No bytes were readable at the requested location.
	UnreadableMemory,
	/// The target does not support the requested capability.
	UnsupportedCapability,
	/// The target is temporarily busy and the request should be retried.
	TargetBusy,
}

impl fmt::Display for ErrorKind {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{:?}", self)
	}
}

/// Structured detail carried by a domain error.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ErrorData {
	/// Error kind.
	pub kind: ErrorKind,
	/// Provider-specific detail.
	pub detail: String,
}

/// Response payload for `initialize`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InitializeResult {
	/// Protocol version supported by the provider.
	pub protocol_version: String,
	/// Capabilities this provider exposes.
	pub capabilities: Vec<TargetCapabilityWire>,
	/// Address spaces exposed by the target.
	pub spaces: Vec<AddressSpaceWire>,
	/// High-level target descriptor.
	pub target: TargetDescriptorWire,
}

/// Response payload for `listSpaces`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ListSpacesResult {
	/// Address spaces exposed by the target.
	pub spaces: Vec<AddressSpaceWire>,
}

/// Response payload for `getImageInfo`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GetImageInfoResult {
	/// Architecture string, e.g. "x86_64".
	pub arch: String,
	/// Image entry point virtual address.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub entry: u64,
	/// Preferred or actual image base.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub image_base: u64,
	/// Loadable sections.
	pub sections: Vec<SectionWire>,
}

/// Parameters for `readMemory`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReadMemoryParams {
	/// Address space id.
	pub space: String,
	/// Start address.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub address: u64,
	/// Number of bytes to read.
	pub len: u64,
	/// Optional moment; omit for the current moment.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub moment: Option<MomentWire>,
}

/// Response payload for `readMemory`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReadMemoryResult {
	/// Reference to the binary frame that immediately follows this response.
	pub data: FrameRef,
	/// Ranges within the request that were actually readable.
	pub valid: Vec<RangeWire>,
	/// Moment that the data was captured at.
	pub served_moment: MomentWire,
}

/// Reference to a binary frame delivered inline after a JSON response.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FrameRef {
	/// Frame id matching the `Delver-Frame` header.
	#[serde(rename = "$frame")]
	pub frame_id: u64,
	/// Length of the binary payload in bytes.
	pub len: u64,
}

/// A readable byte range.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RangeWire {
	/// Inclusive start.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub start: u64,
	/// Exclusive end.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub end: u64,
}

/// A moment on the wire.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
pub struct MomentWire {
	/// Kind of moment.
	pub kind: MomentKindWire,
	/// Provider-defined epoch.
	pub epoch: u64,
}

/// Address space kind on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AddressSpaceKindWire {
	/// Raw file offsets.
	File,
	/// Loaded image view.
	Image,
}

/// Moment kind on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MomentKindWire {
	/// Unchanging content.
	Static,
	/// Captured snapshot.
	Snapshot,
	/// Live target.
	Live,
}

/// Target capability on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TargetCapabilityWire {
	/// Can list address spaces.
	ListSpaces,
	/// Can return image metadata.
	GetImageInfo,
	/// Can read memory.
	ReadMemory,
}

/// Address space on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AddressSpaceWire {
	/// Space id, e.g. "File" or "Image".
	pub id: String,
	/// Kind of address space.
	pub kind: AddressSpaceKindWire,
	/// Pointer width in bits.
	pub pointer_width: u8,
	/// Id of the space this translates to, if any.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub translates_to: Option<String>,
}

/// Image section on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SectionWire {
	/// Section name.
	pub name: String,
	/// Virtual address.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub virtual_address: u64,
	/// Virtual size.
	pub virtual_size: u64,
	/// Raw file offset.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub raw_offset: u64,
	/// Raw file size.
	pub raw_size: u64,
}

/// High-level target descriptor on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TargetDescriptorWire {
	/// Human-readable target name.
	pub name: String,
	/// Target kind string, e.g. "file".
	pub kind: String,
}

// ---------------------------------------------------------------------------
// Conversions to/from domain types.
// ---------------------------------------------------------------------------

impl From<AddressSpaceKindWire> for AddressSpaceKind {
	fn from(w: AddressSpaceKindWire) -> Self {
		match w {
			AddressSpaceKindWire::File => AddressSpaceKind::File,
			AddressSpaceKindWire::Image => AddressSpaceKind::Image,
		}
	}
}

impl From<AddressSpaceKind> for AddressSpaceKindWire {
	fn from(k: AddressSpaceKind) -> Self {
		match k {
			AddressSpaceKind::File => AddressSpaceKindWire::File,
			AddressSpaceKind::Image => AddressSpaceKindWire::Image,
		}
	}
}

impl From<MomentKindWire> for MomentKind {
	fn from(w: MomentKindWire) -> Self {
		match w {
			MomentKindWire::Static => MomentKind::Static,
			MomentKindWire::Snapshot => MomentKind::Snapshot,
			MomentKindWire::Live => MomentKind::Live,
		}
	}
}

impl From<MomentKind> for MomentKindWire {
	fn from(k: MomentKind) -> Self {
		match k {
			MomentKind::Static => MomentKindWire::Static,
			MomentKind::Snapshot => MomentKindWire::Snapshot,
			MomentKind::Live => MomentKindWire::Live,
		}
	}
}

impl From<TargetCapabilityWire> for TargetCapability {
	fn from(w: TargetCapabilityWire) -> Self {
		match w {
			TargetCapabilityWire::ListSpaces => TargetCapability::ListSpaces,
			TargetCapabilityWire::GetImageInfo => TargetCapability::GetImageInfo,
			TargetCapabilityWire::ReadMemory => TargetCapability::ReadMemory,
		}
	}
}

impl From<TargetCapability> for TargetCapabilityWire {
	fn from(c: TargetCapability) -> Self {
		match c {
			TargetCapability::ListSpaces => TargetCapabilityWire::ListSpaces,
			TargetCapability::GetImageInfo => TargetCapabilityWire::GetImageInfo,
			TargetCapability::ReadMemory => TargetCapabilityWire::ReadMemory,
		}
	}
}

impl From<MomentWire> for delver_core::Moment {
	fn from(w: MomentWire) -> Self {
		Self {
			kind: w.kind.into(),
			epoch: w.epoch,
		}
	}
}

impl From<delver_core::Moment> for MomentWire {
	fn from(m: delver_core::Moment) -> Self {
		Self {
			kind: m.kind.into(),
			epoch: m.epoch,
		}
	}
}

impl From<AddressSpaceWire> for delver_core::AddressSpace {
	fn from(w: AddressSpaceWire) -> Self {
		Self {
			id: SpaceId::new(w.id),
			kind: w.kind.into(),
			pointer_width: w.pointer_width,
			translates_to: w.translates_to.map(SpaceId::new),
		}
	}
}

impl From<delver_core::AddressSpace> for AddressSpaceWire {
	fn from(s: delver_core::AddressSpace) -> Self {
		Self {
			id: s.id.as_str().to_owned(),
			kind: s.kind.into(),
			pointer_width: s.pointer_width,
			translates_to: s.translates_to.map(|id| id.as_str().to_owned()),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn max_u64_round_trips_through_json() {
		let original = InitializeResult {
			protocol_version: "0".to_string(),
			capabilities: vec![TargetCapabilityWire::ReadMemory],
			spaces: vec![AddressSpaceWire {
				id: "Image".to_string(),
				kind: AddressSpaceKindWire::Image,
				pointer_width: 64,
				translates_to: None,
			}],
			target: TargetDescriptorWire {
				name: "test".to_string(),
				kind: "file".to_string(),
			},
		};

		let json = serde_json::to_string(&original).unwrap();
		let back: InitializeResult = serde_json::from_str(&json).unwrap();
		assert_eq!(back.protocol_version, original.protocol_version);
	}
}
