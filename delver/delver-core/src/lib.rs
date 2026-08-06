//! Delver domain types.
//!
//! These are ergonomic, in-process Rust types. They deliberately carry no serde
//! metadata; wire serialization lives in `delver-protocol`.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::fmt;

/// Identifies an address space within a target.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SpaceId(pub String);

impl SpaceId {
	/// Creates a new space id from any string-like value.
	pub fn new(id: impl Into<String>) -> Self {
		Self(id.into())
	}

	/// Returns the underlying string slice.
	pub fn as_str(&self) -> &str {
		&self.0
	}
}

impl fmt::Display for SpaceId {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}", self.0)
	}
}

/// Classification of an address space.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AddressSpaceKind {
	/// Raw file offsets.
	File,
	/// Loaded image view with sections applied (RVA).
	Image,
}

/// A named address space exposed by a target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddressSpace {
	/// Unique identifier for this space.
	pub id: SpaceId,
	/// What kind of space this is.
	pub kind: AddressSpaceKind,
	/// Pointer width in bits for this space (e.g. 32 or 64).
	pub pointer_width: u8,
	/// Extent of the space in bytes.
	pub size: u64,
	/// If present, addresses in this space translate to the target space.
	pub translates_to: Option<SpaceId>,
}

impl AddressSpace {
	/// Creates a new address space description.
	pub fn new(
		id: impl Into<String>,
		kind: AddressSpaceKind,
		pointer_width: u8,
		size: u64,
		translates_to: Option<impl Into<String>>,
	) -> Self {
		Self {
			id: SpaceId::new(id),
			kind,
			pointer_width,
			size,
			translates_to: translates_to.map(Into::into).map(SpaceId::new),
		}
	}
}

/// The kind of moment represented by a target read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MomentKind {
	/// Unchanging content, such as a file on disk.
	Static,
	/// A captured snapshot of a live target.
	Snapshot,
	/// A live, possibly changing target.
	Live,
}

/// A point in time at which target data was observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Moment {
	/// What kind of moment this is.
	pub kind: MomentKind,
	/// Provider-defined epoch counter. For static targets this is always zero.
	pub epoch: u64,
}

impl Moment {
	/// The constant moment used by static providers.
	pub const STATIC: Self = Self {
		kind: MomentKind::Static,
		epoch: 0,
	};
}

/// A concrete location in a target: an address within an address space.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Location {
	/// The address space to read from.
	pub space: SpaceId,
	/// The byte offset or virtual address.
	pub address: u64,
}

impl Location {
	/// Creates a new location.
	pub fn new(space: impl Into<String>, address: u64) -> Self {
		Self {
			space: SpaceId::new(space),
			address,
		}
	}
}

/// An anchor for authored interpretation.
///
/// Annotations attach to `(content_hash, rva)` rather than absolute addresses so
/// they survive rebasing.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Anchor {
	/// Hash of the module/content being annotated.
	pub content_hash: Vec<u8>,
	/// Relative virtual address within that content.
	pub rva: u64,
}

impl Anchor {
	/// Creates a new anchor.
	pub fn new(content_hash: impl Into<Vec<u8>>, rva: u64) -> Self {
		Self {
			content_hash: content_hash.into(),
			rva,
		}
	}
}

/// Capabilities a target may expose. UI and analysis code branch on these,
/// never on target kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TargetCapability {
	/// The target can list its address spaces.
	ListSpaces,
	/// The target can return image metadata (arch, entry, sections).
	GetImageInfo,
	/// The target can read memory at a location and moment.
	ReadMemory,
	/// The target can enumerate imported modules and symbols.
	GetImports,
	/// The target can enumerate exported symbols.
	GetExports,
	/// The target can supply candidate function starts.
	GetFunctionSeeds,
	/// The target can analyse an image and serve listing rows, functions, and xrefs.
	Analyze,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn static_moment_is_constant() {
		assert_eq!(Moment::STATIC.kind, MomentKind::Static);
		assert_eq!(Moment::STATIC.epoch, 0);
	}

	#[test]
	fn location_carries_u64_address() {
		let loc = Location::new("Image", 0x140001000);
		assert_eq!(loc.space.as_str(), "Image");
		assert_eq!(loc.address, 0x140001000);
	}
}
