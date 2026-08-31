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
	/// Unchanging content, such as a file on disk. Cacheable forever.
	Static,
	/// A live target, halted. Reads within the epoch are coherent.
	///
	/// Nothing emits this yet; the debugger provider does, at P4. Reserved
	/// rather than added later because the distinction from [`Self::Live`] is
	/// what decides whether a read may be cached aggressively or must be
	/// labelled best-effort — see `Docs/architecture/debugger-provider.md` — and
	/// widening this enum once P4 is under way changes every `match` over a
	/// moment and every cache key derived from one ([ADR 0018]). Do not delete
	/// it as dead.
	///
	/// [ADR 0018]: ../../../Docs/history/adr/0018-one-moment-taxonomy.md
	Frozen,
	/// A captured, immutable state of a live target.
	///
	/// Distinct from [`Self::Static`]: a snapshot can be stale relative to the
	/// process it came from, and a file has nothing to be stale against.
	/// Reserved on the same terms as [`Self::Frozen`].
	Snapshot,
	/// Running. Reads may observe change between calls, and may tear.
	/// Reserved on the same terms as [`Self::Frozen`].
	Live,
	/// A position within a recorded execution trace.
	///
	/// [`Moment::epoch`] carries the position: it is already a `u64` a provider
	/// may stamp with a tick count, and a second monotonic counter would be null
	/// for every provider but this one. Reserved so time travel activates by
	/// producing a kind that exists rather than by a data-model change, which is
	/// what the P7 exit criterion has always claimed.
	Replay,
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

/// Capabilities a target may expose.
///
/// The rule is that consumers branch on a capability and never on target kind
/// (`CLAUDE.md` invariant 6). Today that branching happens on the TypeScript
/// side against `TargetCapabilityWire`; nothing in Rust reads this enum except
/// the `From` impl that converts it, so it is the shared vocabulary rather than
/// a live discriminator. Said plainly because the previous wording claimed the
/// opposite and would send a reader looking for Rust callers that do not exist.
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
