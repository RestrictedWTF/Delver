//! Wire message types for the Delver v0 protocol.
//!
//! These types are stable, versioned, and serde-annotated. Domain code should
//! convert to `delver_core` types via the `From`/`TryFrom` impls below.

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

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
///
/// Deliberately a summary. Imports, exports, and function seeds are unbounded
/// in principle — a large system DLL exports thousands of symbols — so they are
/// fetched through their own methods rather than inflating every image open.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GetImageInfoResult {
	/// Architecture string, e.g. "x86_64".
	pub arch: String,
	/// SHA-256 of the image's file bytes, lowercase hex.
	///
	/// This is the image's **identity**, and what interpretation anchors to
	/// (`Docs/architecture/data-model.md` section 4). An absolute address is not
	/// an identity — ASLR, a re-dump, or another process loading the same module
	/// moves it — so an authored name must be keyed to the bytes it describes,
	/// never to where they happened to sit.
	pub content_hash: String,
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
	/// Number of imported modules.
	pub import_module_count: u64,
	/// Total number of imported symbols across all modules.
	pub import_symbol_count: u64,
	/// Number of exported symbols.
	pub export_count: u64,
	/// Number of candidate function starts.
	pub function_seed_count: u64,
	/// Number of base relocation targets.
	pub relocation_count: u64,
	/// TLS directory, when the image has one.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub tls: Option<TlsWire>,
}

/// Response payload for `getImports`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GetImportsResult {
	/// Imported modules.
	pub modules: Vec<ImportedModuleWire>,
}

/// Response payload for `getExports`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GetExportsResult {
	/// Exported symbols.
	pub exports: Vec<ExportWire>,
}

/// Response payload for `getFunctionSeeds`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GetFunctionSeedsResult {
	/// Candidate function starts, sorted by address.
	pub seeds: Vec<FunctionSeedWire>,
}

// ---------------------------------------------------------------------------
// Analysis server (v1).
//
// Served by `server-analysis`, not by providers. A provider serves bytes and
// target state; the analysis server interprets them.
// ---------------------------------------------------------------------------

/// Parameters for `analysis/openImage`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OpenImageParams {
	/// Address space to analyse. Defaults to the provider's file space.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub space: Option<String>,
}

/// Response payload for `analysis/openImage`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OpenImageResult {
	/// Handle for subsequent analysis calls.
	pub image_id: String,
	/// Architecture the image was decoded as.
	pub arch: String,
	/// Total decoded instructions — the listing's exact row count.
	pub instruction_count: u64,
	/// Number of detected functions.
	pub function_count: u64,
	/// Number of cross-references.
	pub xref_count: u64,
	/// Number of strings located.
	pub string_count: u64,
}

/// Parameters for `analysis/listingWindow`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ListingWindowParams {
	/// Image handle.
	pub image_id: String,
	/// First row to return.
	pub start_row: u64,
	/// Maximum rows to return. Bounded server-side.
	pub count: u64,
}

/// Response payload for `analysis/listingWindow`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ListingWindowResult {
	/// Rows in the requested range.
	pub rows: Vec<ListingRowWire>,
	/// Total rows available, so a client can size its scrollbar.
	pub total_rows: u64,
}

/// One listing row on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ListingRowWire {
	/// Row ordinal.
	pub row: u64,
	/// Instruction address.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub rva: u64,
	/// Encoded length in bytes.
	pub len: u32,
	/// Formatted mnemonic.
	pub mnemonic: String,
	/// Formatted operands. Empty when there are none.
	pub operands: String,
	/// How execution proceeds after this instruction.
	pub flow: FlowKindWire,
	/// Statically known branch target, when there is one.
	#[serde(
		default,
		skip_serializing_if = "Option::is_none",
		with = "crate::hex::option"
	)]
	#[schemars(with = "Option<String>")]
	pub branch_target: Option<u64>,
}

/// Control-flow classification on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum FlowKindWire {
	/// Falls through to the next instruction.
	Sequential,
	/// Unconditional direct branch.
	Jump,
	/// Conditional branch.
	ConditionalJump,
	/// Direct call.
	Call,
	/// Branch or call through a register or memory operand.
	Indirect,
	/// Returns from the current function.
	Return,
	/// Interrupt or syscall.
	Interrupt,
	/// Not a valid instruction.
	Invalid,
}

/// Parameters for `analysis/rowForAddress`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RowForAddressParams {
	/// Image handle.
	pub image_id: String,
	/// Address to locate.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub rva: u64,
	/// When true, return the row *containing* the address rather than
	/// requiring an exact instruction boundary.
	#[serde(default)]
	pub containing: bool,
}

/// Response payload for `analysis/rowForAddress`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RowForAddressResult {
	/// Row ordinal, absent when the address is not in the index.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub row: Option<u64>,
}

/// Parameters for `analysis/addressForRow`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AddressForRowParams {
	/// Image handle.
	pub image_id: String,
	/// Row ordinal.
	pub row: u64,
}

/// Response payload for `analysis/addressForRow`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AddressForRowResult {
	/// Address of the row, absent when the row is out of range.
	#[serde(
		default,
		skip_serializing_if = "Option::is_none",
		with = "crate::hex::option"
	)]
	#[schemars(with = "Option<String>")]
	pub rva: Option<u64>,
}

/// Parameters for an image-scoped query with no other arguments.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ImageQueryParams {
	/// Image handle.
	pub image_id: String,
}

/// Response payload for `analysis/functions`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FunctionsResult {
	/// Detected functions, sorted by address.
	pub functions: Vec<FunctionWire>,
}

/// A detected function on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FunctionWire {
	/// Entry RVA.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub rva: u64,
	/// Exclusive end, when known.
	#[serde(
		default,
		skip_serializing_if = "Option::is_none",
		with = "crate::hex::option"
	)]
	#[schemars(with = "Option<String>")]
	pub end_rva: Option<u64>,
	/// Where the boundary came from.
	pub source: FunctionSourceWire,
	/// Whether the image itself vouches for this boundary. Consumers must
	/// render an inferred boundary differently from a confirmed one.
	pub authoritative: bool,
	/// Relocation-insensitive identity of the function's normalized listing.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub fingerprint: Option<FunctionFingerprintWire>,
}

/// Versioned digest used to associate unchanged functions across binaries.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FunctionFingerprintWire {
	/// Digest algorithm.
	pub algorithm: String,
	/// Versioned normalization profile.
	pub normalization: String,
	/// Lowercase hexadecimal digest.
	pub digest: String,
}

/// Origin of a detected function, most authoritative first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum FunctionSourceWire {
	/// From the exception directory. Compiler-emitted.
	ExceptionDirectory,
	/// The image entry point.
	EntryPoint,
	/// An exported symbol.
	Export,
	/// A TLS callback.
	TlsCallback,
	/// Reached by a direct call during recursive descent.
	CallTarget,
	/// Found by linear sweep. Nothing references it — a guess.
	LinearSweep,
}

/// Parameters for `analysis/xrefsTo` and `analysis/xrefsFrom`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct XrefsParams {
	/// Image handle.
	pub image_id: String,
	/// Address to look up.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub rva: u64,
}

/// Response payload for the xref queries.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct XrefsResult {
	/// Matching references.
	pub xrefs: Vec<XrefWire>,
}

/// A cross-reference on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct XrefWire {
	/// Referencing address.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub from: u64,
	/// Referenced address.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub to: u64,
	/// Kind of reference.
	pub kind: XrefKindWire,
}

/// Kind of cross-reference on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum XrefKindWire {
	/// A direct call.
	Call,
	/// An unconditional direct branch.
	Jump,
	/// A conditional branch.
	ConditionalJump,
	/// A RIP-relative memory operand.
	Data,
}

/// Response payload for `analysis/strings`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StringsResult {
	/// Strings located in the image.
	pub strings: Vec<StringWire>,
	/// Whether the scan hit its cap and dropped results.
	///
	/// The cap stops a hostile file turning string extraction into an
	/// allocation attack, but a truncated list that does not say so is worse
	/// than none: a client cannot otherwise tell a complete answer from a
	/// partial one, and would present a partial one as complete.
	pub truncated: bool,
}

/// A located string on the wire.
///
/// `text` is **attacker-controlled**. Consumers must escape it before display
/// and must never treat it as markup or as instructions to a model.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StringWire {
	/// RVA of the first character.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub rva: u64,
	/// Decoded text. Untrusted.
	pub text: String,
	/// How it was encoded.
	pub encoding: StringEncodingWire,
}

/// String encoding on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum StringEncodingWire {
	/// Printable single-byte characters.
	Ascii,
	/// UTF-16, little-endian.
	Utf16Le,
}

/// An imported module on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ImportedModuleWire {
	/// Module name as written in the import descriptor.
	pub name: String,
	/// Symbols imported from this module.
	pub symbols: Vec<ImportedSymbolWire>,
}

/// An imported symbol on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ImportedSymbolWire {
	/// Symbol name, absent for imports by ordinal.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub name: Option<String>,
	/// Ordinal, present for imports by ordinal.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub ordinal: Option<u16>,
	/// RVA of the import address table slot a call site indirects through.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub iat_rva: u64,
}

/// An exported symbol on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ExportWire {
	/// Symbol name, absent for exports by ordinal only.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub name: Option<String>,
	/// Export ordinal.
	pub ordinal: u32,
	/// RVA of the export target, absent when forwarded.
	#[serde(
		default,
		skip_serializing_if = "Option::is_none",
		with = "crate::hex::option"
	)]
	#[schemars(with = "Option<String>")]
	pub rva: Option<u64>,
	/// Forward target, e.g. "NTDLL.RtlAllocateHeap".
	#[serde(skip_serializing_if = "Option::is_none")]
	pub forwarded_to: Option<String>,
}

/// A candidate function start on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FunctionSeedWire {
	/// Function start as an RVA.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub rva: u64,
	/// Exclusive end as an RVA, when the source records one.
	#[serde(
		default,
		skip_serializing_if = "Option::is_none",
		with = "crate::hex::option"
	)]
	#[schemars(with = "Option<String>")]
	pub end_rva: Option<u64>,
	/// Where the seed came from. Consumers must render inferred boundaries
	/// differently from compiler-emitted ones.
	pub source: SeedSourceWire,
}

/// Origin of a function seed, most authoritative first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SeedSourceWire {
	/// From the exception directory. Compiler-emitted.
	ExceptionDirectory,
	/// The image entry point.
	EntryPoint,
	/// An exported symbol.
	Export,
	/// A TLS callback, which runs before the entry point.
	TlsCallback,
}

/// TLS directory on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TlsWire {
	/// RVA of the TLS index variable.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub index_rva: u64,
	/// RVA of the raw TLS template data.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub raw_data_rva: u64,
	/// Size of the raw TLS template data.
	pub raw_data_size: u64,
	/// TLS callback RVAs, in loader invocation order.
	#[serde(with = "crate::hex::vec")]
	#[schemars(with = "Vec<String>")]
	pub callbacks: Vec<u64>,
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
	/// Can enumerate imported modules and symbols.
	GetImports,
	/// Can enumerate exported symbols.
	GetExports,
	/// Can supply candidate function starts.
	GetFunctionSeeds,
	/// Can analyse an image and serve listing rows, functions, and xrefs.
	Analyze,
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
	/// Extent of the space in bytes.
	///
	/// A client that needs the whole space — the analysis server pulling an
	/// image through the provider, or a hex view sizing its scrollbar — would
	/// otherwise have to probe for the end by reading until it gets a short
	/// answer.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub size: u64,
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
	/// Marked readable (`IMAGE_SCN_MEM_READ`).
	pub readable: bool,
	/// Marked writable (`IMAGE_SCN_MEM_WRITE`).
	pub writable: bool,
	/// Marked executable (`IMAGE_SCN_MEM_EXECUTE`).
	pub executable: bool,
	/// Shannon entropy of the raw bytes, in bits per byte (0..=8).
	///
	/// The cheapest signal available for compressed or encrypted content:
	/// machine code sits near 6, packed or ciphered data crowds 8.
	pub entropy: f64,
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
			TargetCapabilityWire::GetImports => TargetCapability::GetImports,
			TargetCapabilityWire::GetExports => TargetCapability::GetExports,
			TargetCapabilityWire::GetFunctionSeeds => TargetCapability::GetFunctionSeeds,
			TargetCapabilityWire::Analyze => TargetCapability::Analyze,
		}
	}
}

impl From<TargetCapability> for TargetCapabilityWire {
	fn from(c: TargetCapability) -> Self {
		match c {
			TargetCapability::ListSpaces => TargetCapabilityWire::ListSpaces,
			TargetCapability::GetImageInfo => TargetCapabilityWire::GetImageInfo,
			TargetCapability::ReadMemory => TargetCapabilityWire::ReadMemory,
			TargetCapability::GetImports => TargetCapabilityWire::GetImports,
			TargetCapability::GetExports => TargetCapabilityWire::GetExports,
			TargetCapability::GetFunctionSeeds => TargetCapabilityWire::GetFunctionSeeds,
			TargetCapability::Analyze => TargetCapabilityWire::Analyze,
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
			size: w.size,
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
			size: s.size,
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
				size: 0x1000,
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
