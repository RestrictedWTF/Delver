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
	/// An index or cursor was taken against a derivation that no longer exists.
	///
	/// Distinct from `InvalidAddress`, which says the caller named something
	/// that was never valid. This says the opposite: it *was* valid, the facts
	/// were derived again underneath it, and continuing would answer from a
	/// different table. A caller that can restart its walk should; one that
	/// cannot must record what it has as incomplete rather than as whole.
	StaleDerivation,
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
///
/// Every count here counts what the parse *delivered*, which is not the same as
/// what the image *has*. The completeness block at the bottom separates the
/// two, and `fully_parsed` is the single field a client needs when all it wants
/// answered is "may I present these numbers as the whole truth?". A zero count
/// with a `_failed` flag set beside it is a parse that gave up, not a claim
/// about the sample — and reporting the second as the first tells an analyst
/// that a packed binary calls no APIs.
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
	///
	/// For a linked executable this is the C runtime's startup stub, not the
	/// `main` an analyst is looking for; naming which is which is the analysis
	/// server's job and is not yet on the wire.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub entry: u64,
	/// Windows subsystem the image declares.
	pub subsystem: SubsystemWire,
	/// Preferred or actual image base.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub image_base: u64,
	/// Loadable sections.
	pub sections: Vec<SectionWire>,
	/// Number of imported modules.
	pub import_module_count: u64,
	/// Total number of imported symbols across all modules, when known.
	///
	/// Absent when a module or thunk walk was truncated or failed. The recovered
	/// prefix remains available from `getImports`, but it is not an image total.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub import_symbol_count: Option<u64>,
	/// Number of exported symbols.
	pub export_count: u64,
	/// Number of candidate function starts.
	pub function_seed_count: u64,
	/// Number of base relocation targets.
	pub relocation_count: u64,
	/// TLS directory, when the image has one. Absent either because the image
	/// has none or because `tls_failed` is set; those are different facts.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub tls: Option<TlsWire>,
	/// Whether every directory parsed to the end with no cap applied.
	///
	/// Folds in the per-module and per-callback signals as well as every flag
	/// below, so one field answers "may I present these lists as the whole
	/// truth?". False means at least one flag below — or one on an
	/// `ImportedModuleWire`, an `ImportedSymbolWire`, or the `TlsWire` — is set.
	pub fully_parsed: bool,
	/// The import directory is present but could not be parsed to the end.
	///
	/// What `getImports` returns is then only what was recovered first. It is
	/// not the image's import list and must never be presented as one.
	pub imports_failed: bool,
	/// Whether modules were dropped at the parser's module cap.
	pub imports_truncated: bool,
	/// The export directory is present but could not be parsed.
	pub exports_failed: bool,
	/// Whether exports were dropped at the parser's export cap.
	pub exports_truncated: bool,
	/// The exception directory is present but could not be read whole.
	///
	/// Function starts are missing whenever this is set, and on x64 those are
	/// the compiler-emitted ones — the most authoritative source the image has.
	pub exception_directory_failed: bool,
	/// Whether exception-directory seeds were dropped at the seed cap.
	///
	/// Names its source rather than the merged seed list, which draws on
	/// several sources and so cannot carry one total.
	pub function_seeds_truncated: bool,
	/// The relocation directory is present but could not be parsed to the end.
	///
	/// An empty relocation list reads as "this image cannot be rebased", so a
	/// swallowed failure here is a claim about the sample's behaviour under
	/// ASLR.
	pub relocations_failed: bool,
	/// Whether relocation targets were dropped at the relocation cap.
	pub relocations_truncated: bool,
	/// The TLS directory is present but could not be parsed, so `tls` is absent
	/// for a reason that is not "the image has no TLS directory". Callbacks run
	/// before the entry point, which is exactly why anti-analysis code hides
	/// there.
	pub tls_failed: bool,
	/// At least one section header carries a name that could not be decoded.
	/// Those sections report an empty name, which is not the name they have.
	pub section_names_unreadable: bool,
}

/// Response payload for `getImports`.
///
/// An empty `modules` is two incompatible claims — "this sample imports
/// nothing", which is a strong and rare thing to say about a binary, and "the
/// import directory is malformed and the parse gave up". `failed` is what tells
/// them apart.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GetImportsResult {
	/// Imported modules.
	pub modules: Vec<ImportedModuleWire>,
	/// The import directory is present but could not be parsed to the end.
	/// `modules` then holds only what was recovered first.
	pub failed: bool,
	/// Whether modules were dropped at the parser's module cap.
	pub truncated: bool,
	/// Import descriptors present before the cap was applied.
	pub module_total: u64,
}

/// Response payload for `getExports`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GetExportsResult {
	/// Exported symbols.
	pub exports: Vec<ExportWire>,
	/// The export directory is present but could not be parsed. `exports` then
	/// holds only what was recovered first, and an empty list is not a claim
	/// that the image exports nothing.
	pub failed: bool,
	/// Whether exports were dropped at the parser's export cap.
	pub truncated: bool,
	/// Exports present before the cap was applied.
	pub total: u64,
}

/// Response payload for `getFunctionSeeds`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GetFunctionSeedsResult {
	/// Candidate function starts, sorted by address.
	pub seeds: Vec<FunctionSeedWire>,
	/// The exception directory is present but could not be read whole, so
	/// compiler-emitted function starts are missing. On x64 those are the most
	/// authoritative starts the image has, and everything downstream — detected
	/// functions, recorded extents — is poorer without them.
	pub exception_directory_failed: bool,
	/// Whether exception-directory seeds were dropped at the seed cap.
	pub truncated: bool,
}

// ---------------------------------------------------------------------------
// Analysis server (v1).
//
// Served by `server-analysis`, not by providers. A provider serves bytes and
// target state; the analysis server interprets them.
// ---------------------------------------------------------------------------

/// One authored correction to function detection.
///
/// A correction is a change to the *seed set* analysis derives from, not an
/// edit to its output: the server re-derives everything from the bytes plus the
/// corrected seeds. That is what keeps facts recomputable and keeps the
/// correction itself in the authored log where `CLAUDE.md` invariant 3 wants it.
/// Nothing here modifies the target's bytes.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FunctionCorrectionWire {
	/// Image-relative address the correction is about.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub rva: u64,
	/// What the analyst asserts about that address.
	pub kind: FunctionCorrectionKindWire,
	/// Exclusive end of the defined function.
	///
	/// `define` only, and optional: absent means the extent is inferred exactly
	/// as a detected function's is, rather than guessed at here.
	#[serde(
		default,
		skip_serializing_if = "Option::is_none",
		with = "crate::hex::option"
	)]
	#[schemars(with = "Option<String>")]
	pub end_rva: Option<u64>,
}

/// One authored assertion that a range of the image is data, not code.
///
/// The counterpart to a function correction, and the same kind of thing: a
/// change to what analysis derives from, never an edit to the bytes. Excluded
/// bytes are not decoded, get no function start from any source, and originate
/// no cross-reference — but a reference *into* the range survives, because a
/// pointer to a table is exactly the evidence that made the range data.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DataRangeCorrectionWire {
	/// Image-relative start of the excluded range.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub rva: u64,
	/// Exclusive end of the excluded range.
	///
	/// Required, unlike a function's: an unbounded "data starts here" has no
	/// reading that is safe to guess at, and the analysis crate refuses an
	/// empty or overlapping range rather than picking one.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub end_rva: u64,
}

/// What an authored correction asserts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum FunctionCorrectionKindWire {
	/// A function starts at this address, whatever detection concluded.
	Define,
	/// No function starts at this address, whatever detection concluded.
	///
	/// It must survive re-derivation: removing a seed is not enough when
	/// recursive descent would rediscover the address as a call target.
	Undefine,
}

/// Parameters for `analysis/openImage`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OpenImageParams {
	/// Address space to analyse. Defaults to the provider's file space.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub space: Option<String>,
	/// Authored corrections to apply before deriving any fact.
	///
	/// Ascending by `rva` and at most one per address; the server refuses a set
	/// that is neither rather than applying part of it, because a partly applied
	/// correction set is a fact store nobody can reason about.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub corrections: Vec<FunctionCorrectionWire>,
	/// Authored data ranges to exclude from decoding before deriving any fact.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub data_ranges: Vec<DataRangeCorrectionWire>,
}

/// Response payload for `analysis/setCorrections`.
///
/// The before and after counts are the disclosure S5 requires: an analyst
/// approving a correction has to be able to see its exact effect, and "one more
/// function than a moment ago" is that effect stated in the only terms the
/// server can state it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SetCorrectionsResult {
	/// Image handle the corrections were applied to.
	pub image_id: String,
	/// Detected functions before the new set was applied.
	pub function_count_before: u64,
	/// Detected functions now.
	pub function_count: u64,
	/// Decoded instructions now.
	pub instruction_count: u64,
	/// Whether the code passes ran at all.
	///
	/// Every count above is a count of decoded code, so all of them are zero
	/// when this is not `decoded` — for an architecture the decoder does not
	/// support, that reads as "your correction applied and the image has no
	/// functions", which is a confident false claim about a binary that plainly
	/// has code.
	pub decoding: CodeDecodingWire,
	/// Function corrections now in effect.
	pub corrections_applied: u64,
	/// Data ranges now excluded from decoding.
	///
	/// Counted apart from `corrections_applied` rather than summed into it: one
	/// data range can silence a great many detected functions, and a caller
	/// reading a single total could not tell which kind of assertion did it.
	pub data_ranges_applied: u64,
	/// The derivation these facts belong to.
	///
	/// Every re-derivation gets a new one, so a caller holding an index into the
	/// previous table can be told rather than silently answered from this one.
	pub generation: u64,
}

/// Parameters for `analysis/setCorrections`.
///
/// Re-derives every fact for an open image against a new correction set. This
/// exists because corrections arrive mid-session — a human accepts a proposal —
/// and the alternative, closing and reopening the image, would discard the
/// provider connection and every cached listing row with it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SetCorrectionsParams {
	/// Image handle.
	pub image_id: String,
	/// The complete correction set, replacing whatever was in effect.
	#[serde(default)]
	pub corrections: Vec<FunctionCorrectionWire>,
	/// The complete data-range set, replacing whatever was in effect.
	///
	/// Absent means none, exactly as for `corrections`: this call states what is
	/// in effect, and a partial update would leave nobody able to say what the
	/// facts were derived against.
	#[serde(default)]
	pub data_ranges: Vec<DataRangeCorrectionWire>,
}

/// Response payload for `analysis/openImage`.
///
/// Every count below is a count over the bytes the provider actually served,
/// which is not always the whole space. `coverage_complete` is what separates
/// the two readings: when it is false the analysis never saw
/// `unreadable_ranges`, so a zero count over them is an absence of evidence and
/// not evidence of absence. A client that renders these numbers without
/// checking it is presenting a partial image as a complete one.
///
/// `strings_truncated` qualifies `string_count` the same way, and for the same
/// reason: the scan has a cap, and a count that silently equals it is a false
/// claim about the sample rather than a small one.
///
/// `decoding` is the second such qualifier, and it governs the three code
/// counts absolutely: unless it is `decoded`, `instruction_count`,
/// `function_count` and `xref_count` are zero because no pass ran, not because
/// the sample has no code.
///
/// `fully_parsed` is the third. It describes the analysis server's **own** parse
/// of the bytes it read, which can be less complete than the provider's parse of
/// the same file: a partial read truncates directories that were intact on
/// disk. The detail behind it belongs to `getImageInfo`, which owns the parse;
/// this is the one bit the analysis server has to pass on so that no count here
/// reads as a whole-image answer over a partial parse.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OpenImageResult {
	/// Handle for subsequent analysis calls.
	pub image_id: String,
	/// Architecture the image was decoded as.
	pub arch: String,
	/// Whether the code passes ran at all, and why not when they did not.
	pub decoding: CodeDecodingWire,
	/// Whether the analysis server's parse of the bytes it read delivered every
	/// directory in full. False means seeds, imports or relocations are missing,
	/// so the counts below understate the image by an unknown amount; ask
	/// `getImageInfo` which directory it was.
	pub fully_parsed: bool,
	/// Total decoded instructions — the listing's exact row count. Zero and
	/// meaningless unless `decoding` is `decoded`.
	pub instruction_count: u64,
	/// Number of detected functions.
	pub function_count: u64,
	/// Number of cross-references.
	pub xref_count: u64,
	/// Number of strings located.
	///
	/// Qualified by `strings_truncated`, and meaningless without it: the scanner
	/// stops at a cap real binaries reach, so an unqualified count of exactly
	/// the cap reads as a fact about the sample and is one of the few numbers
	/// here that can be wrong by tens of thousands.
	pub string_count: u64,
	/// Whether the string scan stopped at its cap rather than at the image.
	///
	/// When true, `string_count` is the cap and not the sample's string count.
	/// `analysis/scanStrings` reaches the rest.
	pub strings_truncated: bool,
	/// Whether every byte of the analysed space was readable.
	pub coverage_complete: bool,
	/// Bytes the provider actually served for the analysed space.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub bytes_read: u64,
	/// Ranges of the analysed space that were never read, and which no count
	/// above therefore covers.
	///
	/// The read stops at the first byte the provider will not serve, so this is
	/// one range running from that byte to the end of the space. Bytes past a
	/// hole go unanalysed even where a later read would have succeeded: nothing
	/// is fabricated to fill the hole, because decoding a zero-fill would
	/// manufacture instructions the sample does not contain.
	pub unreadable_ranges: Vec<RangeWire>,
}

/// Whether an image's code passes ran, and why not when they did not.
///
/// Empty instruction, function and xref lists have two incompatible meanings,
/// and only one of them is a fact about the sample. An image Delver has no
/// disassembler for reports zero of each, and presenting that as a finding is a
/// confident false claim about the binary — the failure this codebase ranks
/// worst. Tagged rather than a boolean plus an optional string: a client that
/// has not been taught about a reason must fail to parse it rather than read an
/// unknown state as "fine".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CodeDecodingWire {
	/// Every code pass ran. Empty lists here are a fact about the image.
	Decoded,
	/// Delver has no disassembler for the image's architecture, so recursive
	/// descent, the linear sweep and xref building were all skipped. Strings and
	/// the parsed headers are still valid; only the code facts are absent.
	UnsupportedArchitecture {
		/// The architecture the image declared, so a caller can name it.
		arch: String,
	},
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
	pub rows: Vec<ListingWindowRowWire>,
	/// Total rows available, so a client can size its scrollbar.
	pub total_rows: u64,
}

/// One row of the unified listing.
///
/// A listing is one address-ordered sequence over the whole image, so a row is
/// not always an instruction. Tagged rather than a struct with optional fields:
/// a client that has not been taught about a row kind must fail to parse it,
/// not render a string as an instruction with an empty mnemonic.
///
/// `ListingRowWire` stays the instruction shape and keeps its own consumers —
/// signature generation and the agent bridge both want instructions and nothing
/// else.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ListingWindowRowWire {
	/// A decoded instruction.
	Instruction(ListingRowWire),
	/// A string found by the scanner, at its own address.
	String(ListingStringRowWire),
}

/// A string occupying a listing row.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ListingStringRowWire {
	/// Row ordinal.
	pub row: u64,
	/// RVA of the first character.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub rva: u64,
	/// Decoded text. Untrusted — escape before display.
	pub text: String,
	/// How it was encoded.
	pub encoding: StringEncodingWire,
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
	/// Exact encoded instruction bytes, when the analysis server retained the
	/// source image.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub bytes_hex: Option<String>,
	/// Address-bearing encoded fields that a relocation-stable byte signature
	/// should wildcard.
	#[serde(default)]
	pub signature_fields: Vec<SignatureFieldWire>,
}

/// One exact unstable field inside an encoded instruction.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SignatureFieldWire {
	/// Zero-based byte offset from the instruction start.
	pub index: u32,
	/// Number of bytes occupied by the field.
	pub length: u32,
	/// Why the field is unsafe to retain literally.
	pub reason: SignatureFieldReasonWire,
}

/// Why an encoded field is wildcarded in a reusable signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SignatureFieldReasonWire {
	/// Relative immediate used by a direct branch or call.
	RelativeBranch,
	/// Displacement used by RIP/EIP-relative memory addressing.
	IpRelativeMemory,
	/// Pointer-sized field named by the PE base-relocation table.
	BaseRelocation,
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
	/// Call through a register or memory operand. The callee is not statically
	/// known, but control returns to the following address.
	IndirectCall,
	/// Branch through a register or memory operand — a jump-table dispatch or a
	/// tail call through a thunk.
	IndirectBranch,
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

/// Parameters for an image-scoped list query.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ImageQueryParams {
	/// Image handle.
	pub image_id: String,
	/// Maximum entries returned. Zero — or an omitted field, which is how an
	/// older client asks — requests the server's own cap rather than an
	/// unbounded list.
	#[serde(default)]
	pub max_results: u32,
}

/// Response payload for `analysis/functions`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FunctionsResult {
	/// Detected functions, sorted by address.
	pub functions: Vec<FunctionWire>,
	/// Detected functions before the response bound was applied.
	pub total: u64,
	/// Whether functions were omitted because of the response bound.
	pub list_truncated: bool,
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
	/// Further ranges of this function that do not adjoin `end_rva`.
	///
	/// A compiler may split one function across several ranges; the pieces after
	/// the first are discontiguous and cannot be folded into `end_rva` without
	/// swallowing whatever lies between. Empty for the overwhelming majority of
	/// functions, and omitted from the wire when it is.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub fragments: Vec<RangeWire>,
	/// Relocation-insensitive identity of the function's normalized listing.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub fingerprint: Option<FunctionFingerprintWire>,
}

/// Parameters for `analysis/basicBlocks`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BasicBlocksParams {
	/// Image handle.
	pub image_id: String,
	/// Exact detected function entry RVA.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub function_rva: u64,
	/// Maximum number of blocks returned.
	pub max_blocks: u32,
}

/// Response payload for `analysis/basicBlocks`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BasicBlocksResult {
	/// Function entry RVA.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub function_rva: u64,
	/// Basic blocks ordered by start RVA.
	pub blocks: Vec<BasicBlockWire>,
	/// Direct intra-function edges whose endpoints are both returned.
	pub edges: Vec<BasicBlockEdgeWire>,
	/// Whether blocks were omitted because of the requested bound.
	pub truncated: bool,
	/// Blocks inside the extent before the bound was applied.
	pub block_total: u64,
	/// Direct intra-function edges inside the extent before the bound was
	/// applied. Larger than `edges` when a bounded block list left an edge with
	/// no returned endpoint to attach to.
	pub edge_total: u64,
	/// Whether the function's extent came from a recorded end rather than being
	/// inferred — from the next detected function, or from the run of decoded
	/// instructions leaving the entry. Every block and edge above is derived
	/// from that extent and inherits its uncertainty, which is why
	/// `analysis/functionProfile` has reported the same flag from the start.
	pub bounded: bool,
}

/// One maximal straight-line instruction sequence.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BasicBlockWire {
	/// First instruction RVA.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub start_rva: u64,
	/// Exclusive end RVA.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub end_rva: u64,
	/// Number of instructions.
	pub instruction_count: u64,
}

/// One direct intra-function CFG edge.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BasicBlockEdgeWire {
	/// Source block start RVA.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub from: u64,
	/// Destination block start RVA.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub to: u64,
	/// Edge classification.
	pub kind: BasicBlockEdgeKindWire,
}

/// Why control moves between two basic blocks.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BasicBlockEdgeKindWire {
	/// Natural continuation into the next block.
	Fallthrough,
	/// An unconditional direct branch.
	Jump,
	/// The taken side of a conditional direct branch.
	ConditionalTaken,
}

/// Parameters for `analysis/callGraph`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CallGraphParams {
	/// Image handle.
	pub image_id: String,
	/// Exact detected function entry RVA.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub function_rva: u64,
	/// Maximum number of edges returned in each of the three lists.
	pub max_edges: u32,
}

/// Response payload for `analysis/callGraph`.
///
/// The three lists are bounded independently, so a function with thousands of
/// callers still reports its handful of callees in full.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CallGraphResult {
	/// Function entry RVA.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub function_rva: u64,
	/// Edges arriving at the function entry, ordered by site RVA.
	pub callers: Vec<CallGraphEdgeWire>,
	/// Edges leaving the function, ordered by site RVA.
	pub callees: Vec<CallGraphEdgeWire>,
	/// Call sites inside the function whose callee the decoder cannot name,
	/// ordered by RVA. Each carries the import it indirects through when one is
	/// named for it. A caller that ignores the unresolved ones is reading an
	/// incomplete graph.
	pub indirect_call_sites: Vec<IndirectCallSiteWire>,
	/// Total caller edges before the bound was applied.
	pub caller_total: u64,
	/// Total callee edges before the bound was applied.
	pub callee_total: u64,
	/// Total indirect call sites before the bound was applied, resolved or not.
	pub indirect_call_site_total: u64,
	/// Indirect call sites before the bound was applied that could **not** be
	/// resolved.
	///
	/// A total over every site, never over the returned page: this is the number
	/// a completeness claim rests on, and a claim computed from a page would be
	/// a claim about the page.
	pub unresolved_indirect_call_site_total: u64,
	/// Whether caller edges were omitted because of the requested bound.
	pub callers_truncated: bool,
	/// Whether callee edges were omitted because of the requested bound.
	pub callees_truncated: bool,
	/// Whether unresolved call sites were omitted because of the requested bound.
	pub indirect_truncated: bool,
	/// Whether import parsing was incomplete, so an unresolved indirect call may
	/// have lost an IAT identity that exists in the sample.
	pub import_resolution_incomplete: bool,
	/// Whether the function's extent came from a recorded end rather than being
	/// inferred. The callee and indirect lists are derived from that extent, so
	/// an inferred one can both miss edges and claim edges past the real end.
	pub bounded: bool,
}

/// One direct inter-function edge.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CallGraphEdgeWire {
	/// RVA of the referencing instruction.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub site: u64,
	/// RVA referred to.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub target: u64,
	/// Kind of reference the site makes.
	pub kind: XrefKindWire,
	/// Entry of the detected function containing the site, when one owns it.
	/// Absent for a site in padding or unclaimed bytes.
	#[serde(
		default,
		skip_serializing_if = "Option::is_none",
		with = "crate::hex::option"
	)]
	#[schemars(with = "Option<String>")]
	pub site_function_rva: Option<u64>,
	/// Entry of the detected function containing the target, when one owns it.
	#[serde(
		default,
		skip_serializing_if = "Option::is_none",
		with = "crate::hex::option"
	)]
	#[schemars(with = "Option<String>")]
	pub target_function_rva: Option<u64>,
	/// Whether this is a branch that leaves its own function — a tail call
	/// rather than intra-function control flow.
	pub tail_call: bool,
	/// The import this edge really reaches, when its target is nothing but a
	/// one-instruction thunk into the IAT. The edge still names the thunk; this
	/// names what the thunk is for.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub resolved_import: Option<ResolvedImportWire>,
}

/// One call site whose callee the decoder could not name, and what — if
/// anything — the import table names for it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct IndirectCallSiteWire {
	/// RVA of the calling instruction.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub site: u64,
	/// The import the site indirects through, when exactly one is named for it.
	/// Absent means unresolved, never "probably nothing".
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub resolved: Option<ResolvedImportWire>,
}

/// One import a call site or thunk resolves to.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ResolvedImportWire {
	/// RVA of the import address table slot the call indirects through.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub iat_rva: u64,
	/// Module name as written in the import descriptor, e.g. "KERNEL32.dll".
	pub module: String,
	/// Symbol name, absent for an import by ordinal.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub symbol: Option<String>,
	/// Ordinal, present for an import by ordinal.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub ordinal: Option<u32>,
	/// Which shape named this import.
	pub method: IndirectResolutionMethodWire,
	/// How much weight the resolution carries.
	pub confidence: ResolutionConfidenceWire,
}

/// How an indirect target was named.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum IndirectResolutionMethodWire {
	/// The call's own memory operand names an IAT slot — `call [rip+X]`.
	IatOperand,
	/// The call targets a one-instruction thunk that branches through an IAT
	/// slot — `call sub_1234` where `sub_1234` is `jmp [rip+X]`.
	ImportThunk,
}

/// How much weight a resolution carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ResolutionConfidenceWire {
	/// The operand names one slot and the import table names one symbol for it.
	/// There is nothing left to guess.
	Exact,
	/// Derived from evidence that narrows the target without proving it.
	///
	/// Nothing produces this yet. It exists so that the first resolution which
	/// *is* a narrowing — a vtable slot, a value recovered by dataflow — has a
	/// place to land, and so a caller switching on this enum today already
	/// handles the shape it will arrive in. Do not delete it as dead.
	Probable,
}

/// Parameters for `analysis/callPaths`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CallPathsParams {
	/// Image handle.
	pub image_id: String,
	/// Exact detected function entry RVA to search from.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub from_rva: u64,
	/// The sink: either an exact detected function entry RVA, or the RVA of an
	/// import address table slot. An import sink is what a malware question
	/// usually is — "what reaches `VirtualAlloc`?" — and the resolved-import
	/// edges make it answerable. Anything else is rejected.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub to_rva: u64,
	/// Maximum steps in one returned path. Clamped to 1..=16.
	pub max_depth: u32,
	/// Maximum paths returned. Clamped to 1..=64.
	pub max_paths: u32,
	/// Maximum frontier expansions the search may perform. Clamped to
	/// 1..=100000.
	pub max_visited: u32,
}

/// Response payload for `analysis/callPaths`.
///
/// **An empty `paths` is not a proof of absence.** The search is bounded, and
/// every bound marks a place a path could have been and was not looked at. A
/// negative result is a claim that no path *exists* only when the search was
/// genuinely complete — that is, only when `search_exhausted` is true,
/// `depth_limit_reached` and `visit_limit_reached` are both false, and
/// `unresolved_indirect_sites_on_frontier` is zero.
///
/// Any unresolved indirect call site on the frontier could hide an edge — a
/// call through a register or a vtable is exactly where a real sample hides the
/// path being looked for — which is why it is counted and reported rather than
/// passed over. A caller that renders an empty result as "no path exists"
/// without checking all four is presenting a bounded search as a proof.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CallPathsResult {
	/// Entry of the function the search started from.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub from_rva: u64,
	/// The requested sink: a function entry or an IAT slot.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub to_rva: u64,
	/// Distinct simple paths found, shortest first. No function repeats within
	/// a single path, so recursion cannot spin one out forever.
	pub paths: Vec<CallPathWire>,
	/// Whether at least one further path was reached beyond the requested
	/// bound. Set only when an extra path was genuinely found, never merely
	/// because the bound was met.
	pub paths_truncated: bool,
	/// Whether the whole reachable set within the limits was explored.
	///
	/// False when the visit budget or the path bound stopped the walk, and
	/// false when a function on the frontier had no derivable extent and so
	/// could not have its edges enumerated at all. A depth cut does *not* clear
	/// this — depth is one of the limits, and `depth_limit_reached` reports it
	/// on its own.
	pub search_exhausted: bool,
	/// Whether some edge was dropped because following it would have exceeded
	/// the depth bound. The frontier below that edge is unexplored.
	pub depth_limit_reached: bool,
	/// Whether the visit budget ran out with work still queued.
	pub visit_limit_reached: bool,
	/// Distinct functions whose outgoing edges were expanded. A count of
	/// functions, not of work: a function is expanded once per distinct path
	/// prefix that reaches it, and `max_visited` bounds those expansions rather
	/// than this number.
	pub visited_function_count: u64,
	/// Call sites with no nameable callee, found in the functions this search
	/// actually expanded.
	///
	/// **Not an image-wide total.** It counts only the frontier the search
	/// touched, which is exactly the set where a hidden edge would have changed
	/// this answer. A non-zero count forbids reading an empty `paths` as "no
	/// path exists".
	pub unresolved_indirect_sites_on_frontier: u64,
	/// Frontier functions whose extents were inferred rather than recorded.
	/// Any one can hide or over-include an outgoing edge.
	pub unbounded_functions_on_frontier: u64,
	/// Whether import parsing was incomplete, so unresolved frontier calls may
	/// have lost nameable IAT targets.
	pub import_resolution_incomplete: bool,
	/// Whether the *source* function's extent came from a recorded end rather
	/// than being inferred. The first step of every path is enumerated from that
	/// extent, so an inferred one can hide the edge the search was looking for.
	/// Frontier functions carry no such flag: an extent that could not be derived
	/// at all already clears `search_exhausted`.
	pub bounded: bool,
}

/// One ordered source-to-sink path.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CallPathWire {
	/// Steps in call order, the first leaving the source function and the last
	/// arriving at the sink. Empty only when source and sink are the same
	/// function, which is reached in no steps at all.
	pub steps: Vec<CallPathStepWire>,
}

/// One call in an ordered path, with the exact instruction that makes it.
///
/// The call site is not decoration. A path of function entries is a claim a
/// human has to take on trust; a path of call sites is one they can go and look
/// at, which is the whole reason for returning evidence rather than a summary.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CallPathStepWire {
	/// Entry of the function the step leaves.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub from_function_rva: u64,
	/// RVA of the calling instruction.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub call_site: u64,
	/// Entry of the detected function the step lands in. Absent when the step
	/// lands straight on an import through an IAT slot, which no function owns.
	#[serde(
		default,
		skip_serializing_if = "Option::is_none",
		with = "crate::hex::option"
	)]
	#[schemars(with = "Option<String>")]
	pub to_function_rva: Option<u64>,
	/// The import this step really reaches, when the target is an IAT slot or a
	/// one-instruction thunk into one. A thunk step still names the thunk in
	/// `to_function_rva`; this names what the thunk is for.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub resolved_import: Option<ResolvedImportWire>,
	/// Kind of reference the site makes.
	pub kind: XrefKindWire,
	/// Whether the step is a branch that leaves its own function — a tail call
	/// rather than intra-function control flow.
	pub tail_call: bool,
}

/// Parameters for `analysis/functionProfile`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FunctionProfileParams {
	/// Image handle.
	pub image_id: String,
	/// Exact detected function entry RVA.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub function_rva: u64,
}

/// Response payload for `analysis/functionProfile`.
///
/// Aggregate counts only. Every one of them is derived from the same facts the
/// bounded `analysis/basicBlocks` and `analysis/callGraph` results expose, so a
/// caller can use this to decide whether fetching the detail is worthwhile
/// without first paging through it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FunctionProfileResult {
	/// Function entry RVA.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub function_rva: u64,
	/// The function's own recorded end, absent when no source recorded one.
	#[serde(
		default,
		skip_serializing_if = "Option::is_none",
		with = "crate::hex::option"
	)]
	#[schemars(with = "Option<String>")]
	pub end_rva: Option<u64>,
	/// Whether the extent came from a recorded end rather than being inferred —
	/// from the next detected function, or from the run of decoded instructions
	/// leaving the entry. An inferred extent is a guess and every count below
	/// inherits that uncertainty.
	pub bounded: bool,
	/// Decoded instructions inside the extent.
	pub instruction_count: u64,
	/// Bytes inside the extent actually covered by decoded instructions. Less
	/// than the extent when the function contains data or undecoded gaps.
	pub decoded_extent_bytes: u64,
	/// Basic blocks inside the extent.
	pub block_count: u64,
	/// Direct intra-function control-flow edges inside the extent.
	pub edge_count: u64,
	/// Sites elsewhere that reference the entry.
	pub incoming_call_site_count: u64,
	/// Distinct detected functions containing those sites.
	pub incoming_caller_function_count: u64,
	/// Sites inside the extent that reference code outside it.
	pub outgoing_call_site_count: u64,
	/// Distinct detected functions those sites resolve to.
	pub outgoing_target_function_count: u64,
	/// Call sites inside the extent whose callee is not statically known.
	pub indirect_call_site_count: u64,
	/// How many of those the import table names a target for. The difference
	/// between the two is what the graph genuinely cannot see.
	pub resolved_indirect_call_site_count: u64,
	/// Instructions inside the extent that return from the function.
	pub return_count: u64,
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
	/// An analyst said so. Outranks anything derived.
	Authored,
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

/// Parameters for `analysis/globals`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GlobalsParams {
	/// Image handle.
	pub image_id: String,
	/// Zero-based candidate index at which to start the page.
	#[serde(default)]
	pub start: u64,
	/// Maximum number of candidates returned.
	#[serde(default)]
	pub max_globals: u32,
}

/// Response payload for `analysis/globals`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GlobalsResult {
	/// Observed global-data addresses ordered by RVA.
	pub globals: Vec<GlobalWire>,
	/// Total observed candidates before paging.
	pub total: u64,
	/// Index of the next candidate, absent exactly when the walk has ended.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub next_start: Option<u64>,
}

/// One address in a non-executable section named by a retained data reference.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GlobalWire {
	/// Referenced image RVA.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub rva: u64,
	/// Section name as written in the image.
	pub section: String,
	/// Whether the containing image section is writable.
	pub writable: bool,
	/// Number of retained data references to this exact address.
	pub reference_count: u64,
}

/// Parameters for `analysis/globalAccesses`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GlobalAccessesParams {
	/// Image handle.
	pub image_id: String,
	/// Global-data RVA to query. An address with no retained data references
	/// returns an empty list; that is not proof that no runtime access exists.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub rva: u64,
	/// Maximum number of accesses returned.
	#[serde(default)]
	pub max_accesses: u32,
}

/// Response payload for `analysis/globalAccesses`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GlobalAccessesResult {
	/// Queried global-data RVA.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub rva: u64,
	/// Referencing instructions ordered by RVA.
	pub accesses: Vec<GlobalAccessWire>,
	/// Total retained data references before the response bound.
	pub total: u64,
	/// Whether accesses were omitted by the response bound.
	pub truncated: bool,
}

/// One decoded instruction that names a global-data address.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GlobalAccessWire {
	/// RVA of the referencing instruction.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub site: u64,
	/// Entry RVA of the detected function containing the site, when known.
	#[serde(
		default,
		skip_serializing_if = "Option::is_none",
		with = "crate::hex::option"
	)]
	#[schemars(with = "Option<String>")]
	pub function_rva: Option<u64>,
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
	/// Maximum references returned. Zero — or an omitted field, which is how an
	/// older client asks — requests the server's own cap. A hot address in a
	/// large image has tens of thousands of references, and serialising all of
	/// them into one message kills the connection instead of answering.
	#[serde(default)]
	pub max_xrefs: u32,
}

/// Response payload for the xref queries.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct XrefsResult {
	/// Matching references, in the order the xref table holds them.
	pub xrefs: Vec<XrefWire>,
	/// Matching references before the bound was applied.
	pub total: u64,
	/// Whether references were omitted because of the bound.
	pub truncated: bool,
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

/// Windows subsystem an image declares, on the wire.
///
/// Tagged rather than a bare string, so an unrecognized value arrives as
/// `other` carrying the number it actually held. A client deciding what the user
/// entry point should look like has to be able to tell "this is a console
/// program" from "this is something neither side was taught about"; collapsing
/// the second into a named variant would erase exactly that difference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SubsystemWire {
	/// `IMAGE_SUBSYSTEM_WINDOWS_CUI` — entered through `main` or `wmain`.
	Console,
	/// `IMAGE_SUBSYSTEM_WINDOWS_GUI` — entered through `WinMain` or `wWinMain`.
	Gui,
	/// A native or driver image, with no C runtime entry of either family.
	Native,
	/// Anything else, carrying the declared value rather than a guess.
	Other {
		/// The raw optional-header value.
		value: u16,
	},
}

/// Parameters for `analysis/xrefIndex`.
///
/// The whole-table export, as distinct from [`XrefsParams`], which answers one
/// address. It exists so a project can *retain* the xref table: a `.delverdb`
/// opened without its sample still has to answer "who references this", and
/// walking every address to rebuild the table from per-address queries would be
/// millions of round trips for a table the server already holds in one piece.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct XrefIndexParams {
	/// Image handle.
	pub image_id: String,
	/// Index of the first reference to return, in the table's source ordering.
	///
	/// A plain offset rather than an opaque cursor, valid for one derivation of
	/// the table. `analysis/setCorrections` re-derives every fact, so an index
	/// taken before a correction indexes a different table afterwards — pass
	/// `generation` to have that refused rather than silently answered from the
	/// new one.
	#[serde(default)]
	pub start: u64,
	/// Derivation the `start` index was taken against.
	///
	/// Omitted by a caller that does not page. Supplied, a mismatch is refused:
	/// a walk that spanned a re-derivation would skip or duplicate rows and end
	/// early, and a table retained from it would answer a later "who references
	/// this" with a confident and wrong zero — which is the failure this export
	/// exists to prevent.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub generation: Option<u64>,
	/// Maximum references returned. Zero — or an omitted field — requests the
	/// server's own cap.
	#[serde(default)]
	pub max_xrefs: u32,
}

/// Response payload for `analysis/xrefIndex`.
///
/// `next_start` is the completeness signal. A caller retaining the table must
/// be able to tell "this is the end" from "this page was bounded", because a
/// partial table stored as if it were whole is a source of exactly the false
/// negative — a confident `total: 0` — that the per-address query already has
/// to avoid.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct XrefIndexResult {
	/// References in the requested range, ordered by source address.
	pub xrefs: Vec<XrefWire>,
	/// Total references in the table, independent of this page.
	pub total: u64,
	/// Index to pass as the next `start`, absent once the walk is complete.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub next_start: Option<u64>,
	/// Derivation these rows came from. Pass it back to continue safely.
	pub generation: u64,
}

/// Parameters for `analysis/scanStrings`.
///
/// The resumable counterpart to `analysis/strings`. That one serves the list
/// retained when the image was analysed, which stops at the scanner's cap — a
/// bound nine of the thirty-five largest binaries in a stock `System32` reach,
/// `mshtml.dll` and a 228 MB `MRT.exe` among them. Everything past it used to be
/// unreachable by any call. This re-scans a bounded window instead, so the cap
/// bounds one *response* rather than the image.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ScanStringsParams {
	/// Image handle.
	pub image_id: String,
	/// Address to resume from. Zero starts at the beginning of the image.
	#[serde(default, with = "crate::hex")]
	#[schemars(with = "String")]
	pub from_rva: u64,
	/// Maximum strings returned. Zero requests the server's own cap.
	#[serde(default)]
	pub max_strings: u32,
}

/// Response payload for `analysis/scanStrings`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ScanStringsResult {
	/// Strings found in this window, in ascending address order.
	pub strings: Vec<StringWire>,
	/// Address a continuation resumes at.
	///
	/// Absent when the scan reached the end of the image rather than its bound,
	/// which is the only thing that makes an empty result a claim about the
	/// image rather than about the window.
	#[serde(
		default,
		skip_serializing_if = "Option::is_none",
		with = "crate::hex::option"
	)]
	#[schemars(with = "Option<String>")]
	pub next_rva: Option<u64>,
}

/// Request payload for `analysis/searchImmediates`.
///
/// Structured, unlike an operand-text search: `0x1f4`, `500` and `1F4h` are one
/// constant written three ways, and matching the formatted text finds whichever
/// the formatter chose. This matches the value the bytes encode.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SearchImmediatesParams {
	/// Image handle.
	pub image_id: String,
	/// The constant to find, as a canonical `"0x..."` string.
	///
	/// Read as unsigned. A negative constant is written as the bits it
	/// assembles to — `0xffffffff` finds `cmp eax, -1`, and so does
	/// `0xffffffffffffffff`, because a field is matched by both its unsigned
	/// and its sign-extended reading.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub value: u64,
	/// Restrict to one encoded field width in bits — 8, 16, 32 or 64.
	///
	/// Absent matches any width. The same number reached through a byte field
	/// and a dword field are different encodings, and separating them is what
	/// this narrows.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub width: Option<u32>,
	/// Maximum matches returned. Zero requests the server's own cap.
	#[serde(default)]
	pub max_matches: u32,
}

/// One instruction encoding the requested constant.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ImmediateMatchWire {
	/// RVA of the matching instruction.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub rva: u64,
	/// The immediate as encoded, zero-extended.
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub value: u64,
	/// Encoded width of the field in bits.
	pub width: u32,
}

/// Response payload for `analysis/searchImmediates`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SearchImmediatesResult {
	/// Matches in ascending address order.
	pub matches: Vec<ImmediateMatchWire>,
	/// Matches found before the response bound was applied.
	pub total: u64,
	/// Whether the bound dropped matches.
	///
	/// A bounded search has not shown that no further use exists, which is the
	/// part a caller must not read as absence.
	pub list_truncated: bool,
}

/// Response payload for `analysis/strings`.
///
/// Two independent bounds, reported separately because only one of them can be
/// worked around by asking again: `truncated` is the scanner's cap, applied
/// once when the image was analysed, and `list_truncated` is this response's
/// own bound.
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
	/// Strings the scan retained, before this response's own bound was applied.
	pub total: u64,
	/// Whether strings were omitted because of the response bound.
	pub list_truncated: bool,
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
///
/// The signals below are per module on purpose: the symbol cap is applied per
/// module, and one unreadable thunk array must not cast doubt on the other four
/// thousand modules that parsed cleanly.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ImportedModuleWire {
	/// Module name as written in the import descriptor. Empty when
	/// `name_unreadable` is set — check that before showing it, because a
	/// module rendered as an empty string is not a module named one.
	pub name: String,
	/// Symbols imported from this module.
	pub symbols: Vec<ImportedSymbolWire>,
	/// Total symbols before the per-module return cap, when the thunk walk
	/// reached its terminator. Absent after a failed walk.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub symbol_total: Option<u64>,
	/// Whether the descriptor's name string could not be read.
	pub name_unreadable: bool,
	/// Whether the symbol list is incomplete because reading it failed. An
	/// empty `symbols` with this set is emphatically not a module the image
	/// imports nothing from.
	pub symbols_failed: bool,
	/// Whether symbols were dropped at the per-module symbol cap.
	pub symbols_truncated: bool,
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
	/// Whether the hint/name entry this thunk points at could not be read.
	///
	/// `name` and `ordinal` are then both absent, which no real import is. The
	/// slot exists and the call site indirecting through it is real; only the
	/// symbol's identity is unknown.
	pub name_unreadable: bool,
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
	///
	/// A header field, so it is whatever the sample says it is — up to
	/// `u64::MAX` — and a JSON number would truncate it above 2^53 without
	/// erroring (ADR 0001).
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
	pub raw_data_size: u64,
	/// TLS callback RVAs, in loader invocation order.
	#[serde(with = "crate::hex::vec")]
	#[schemars(with = "Vec<String>")]
	pub callbacks: Vec<u64>,
	/// The directory names a callback array that could not be read, so
	/// `callbacks` is empty for a reason that is not "this image has no TLS
	/// callbacks". Callbacks run before the entry point.
	pub callbacks_failed: bool,
	/// Whether callbacks were dropped at the callback cap.
	pub callbacks_truncated: bool,
	/// Callbacks present before the cap was applied.
	pub callback_total: u64,
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
	/// When the read is observed.
	///
	/// Required, not optional. Invariant 1 says every read of target data takes
	/// a location **and** a moment, "no exceptions, including the file provider
	/// where the Moment is constant" — and an optional field is how that
	/// invariant was satisfied in the type and in no byte on the wire for as
	/// long as this existed: every caller sent `None` and the provider dropped
	/// it. Making it required means the compiler asks, rather than each caller
	/// remembering.
	pub moment: MomentWire,
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
	///
	/// A full `u64`: a live provider is free to stamp moments with a tick count
	/// or a nanosecond clock, both of which pass 2^53 while a process is still
	/// running. A JSON number would silently truncate it (ADR 0001).
	#[serde(with = "crate::hex")]
	#[schemars(with = "String")]
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
	/// Unchanging content. Cacheable forever.
	Static,
	/// A live target, halted. Reads within the epoch are coherent.
	Frozen,
	/// A captured, immutable state of a live target.
	Snapshot,
	/// Running. Reads may observe change between calls, and may tear.
	Live,
	/// A position within a recorded execution trace. `epoch` carries the
	/// position; see [ADR 0018].
	///
	/// [ADR 0018]: ../../../Docs/history/adr/0018-one-moment-taxonomy.md
	Replay,
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
			MomentKindWire::Frozen => MomentKind::Frozen,
			MomentKindWire::Snapshot => MomentKind::Snapshot,
			MomentKindWire::Live => MomentKind::Live,
			MomentKindWire::Replay => MomentKind::Replay,
		}
	}
}

impl From<MomentKind> for MomentKindWire {
	fn from(k: MomentKind) -> Self {
		match k {
			MomentKind::Static => MomentKindWire::Static,
			MomentKind::Frozen => MomentKindWire::Frozen,
			MomentKind::Snapshot => MomentKindWire::Snapshot,
			MomentKind::Live => MomentKindWire::Live,
			MomentKind::Replay => MomentKindWire::Replay,
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
	fn every_moment_kind_survives_the_wire_and_both_conversions() {
		// The two enums drifted apart once and nothing noticed, because only
		// `Static` is ever produced. This fails the moment one gains a variant
		// the other lacks, or a conversion arm is wired to the wrong neighbour —
		// a moment mapped to a neighbouring kind is a read cached under the
		// wrong rules (ADR 0018).
		let kinds = [
			MomentKind::Static,
			MomentKind::Frozen,
			MomentKind::Snapshot,
			MomentKind::Live,
			MomentKind::Replay,
		];

		let round_tripped: Vec<MomentKind> = kinds
			.iter()
			.map(|kind| {
				let wire = MomentWire {
					kind: MomentKindWire::from(*kind),
					epoch: u64::MAX,
				};
				let json = serde_json::to_string(&wire).expect("serialise");
				let back: MomentWire = serde_json::from_str(&json).expect("deserialise");
				assert_eq!(back.epoch, u64::MAX, "epoch must survive as a full u64");
				MomentKind::from(back.kind)
			})
			.collect();

		assert_eq!(round_tripped, kinds);
	}

	#[test]
	fn max_u64_round_trips_through_json() {
		let original = InitializeResult {
			protocol_version: crate::PROTOCOL_VERSION.to_string(),
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

	#[test]
	fn listing_rows_serialize_an_empty_signature_field_list() {
		let row = ListingRowWire {
			row: 0,
			rva: 0x1000,
			len: 1,
			mnemonic: "push".to_string(),
			operands: "edi".to_string(),
			flow: FlowKindWire::Sequential,
			branch_target: None,
			bytes_hex: Some("57".to_string()),
			signature_fields: Vec::new(),
		};

		let json = serde_json::to_value(row).unwrap();
		assert_eq!(json.get("signature_fields"), Some(&serde_json::json!([])));
	}

	#[test]
	fn moment_epoch_crosses_the_wire_as_a_hex_string() {
		// 2^53 + 1: the first value a JSON number cannot represent exactly.
		let moment = MomentWire {
			kind: MomentKindWire::Live,
			epoch: 0x0020_0000_0000_0001,
		};

		let json = serde_json::to_value(moment).unwrap();
		assert_eq!(
			json,
			serde_json::json!({ "kind": "live", "epoch": "0x20000000000001" })
		);

		let back: MomentWire = serde_json::from_value(json).unwrap();
		assert_eq!(back.epoch, moment.epoch);
	}

	#[test]
	fn tls_raw_data_size_crosses_the_wire_as_a_hex_string() {
		// Every field here is attacker-controlled, `raw_data_size` included.
		let tls = TlsWire {
			index_rva: 0x1000,
			raw_data_rva: 0x2000,
			raw_data_size: u64::MAX,
			callbacks: vec![0x3000],
			callbacks_failed: false,
			callbacks_truncated: false,
			callback_total: 1,
		};

		let json = serde_json::to_value(tls).unwrap();
		assert_eq!(
			json,
			serde_json::json!({
				"index_rva": "0x1000",
				"raw_data_rva": "0x2000",
				"raw_data_size": "0xFFFFFFFFFFFFFFFF",
				"callbacks": ["0x3000"],
				"callbacks_failed": false,
				"callbacks_truncated": false,
				"callback_total": 1
			})
		);
	}

	#[test]
	fn a_client_that_asks_for_no_bound_gets_the_server_cap() {
		let xrefs: XrefsParams =
			serde_json::from_value(serde_json::json!({ "image_id": "image-0", "rva": "0x1000" }))
				.unwrap();
		let list: ImageQueryParams =
			serde_json::from_value(serde_json::json!({ "image_id": "image-0" })).unwrap();

		assert_eq!((xrefs.max_xrefs, list.max_results), (0, 0));
	}

	#[test]
	fn a_partial_image_says_which_ranges_it_never_read() {
		let result = OpenImageResult {
			image_id: "image-0".to_string(),
			arch: "x86_64".to_string(),
			decoding: CodeDecodingWire::Decoded,
			fully_parsed: true,
			instruction_count: 12,
			function_count: 1,
			xref_count: 0,
			string_count: 0,
			strings_truncated: false,
			coverage_complete: false,
			bytes_read: 0x1000,
			unreadable_ranges: vec![RangeWire {
				start: 0x1000,
				end: 0x4000,
			}],
		};

		let json = serde_json::to_value(result).unwrap();
		assert_eq!(
			json,
			serde_json::json!({
				"image_id": "image-0",
				"arch": "x86_64",
				"decoding": { "kind": "decoded" },
				"fully_parsed": true,
				"instruction_count": 12,
				"function_count": 1,
				"xref_count": 0,
				"string_count": 0,
				"strings_truncated": false,
				"coverage_complete": false,
				"bytes_read": "0x1000",
				"unreadable_ranges": [{ "start": "0x1000", "end": "0x4000" }]
			})
		);
	}

	#[test]
	fn an_undecodable_architecture_is_named_rather_than_counted_as_zero() {
		let decoded = serde_json::to_value(CodeDecodingWire::Decoded).unwrap();
		let unsupported = serde_json::to_value(CodeDecodingWire::UnsupportedArchitecture {
			arch: "Aarch64".to_string(),
		})
		.unwrap();

		assert_eq!(
			(&decoded, &unsupported),
			(
				&serde_json::json!({ "kind": "decoded" }),
				&serde_json::json!({ "kind": "unsupportedArchitecture", "arch": "Aarch64" })
			)
		);

		let back: CodeDecodingWire = serde_json::from_value(unsupported).unwrap();
		assert_eq!(
			back,
			CodeDecodingWire::UnsupportedArchitecture {
				arch: "Aarch64".to_string()
			}
		);
	}

	#[test]
	fn an_empty_import_list_says_whether_the_parse_gave_up() {
		// The two claims an empty list can make, which must never look alike.
		let gave_up = serde_json::to_value(GetImportsResult {
			modules: Vec::new(),
			failed: true,
			truncated: false,
			module_total: 0,
		})
		.unwrap();
		let imports_nothing = serde_json::to_value(GetImportsResult {
			modules: Vec::new(),
			failed: false,
			truncated: false,
			module_total: 0,
		})
		.unwrap();

		assert_ne!(gave_up, imports_nothing);
		assert_eq!(
			gave_up,
			serde_json::json!({
				"modules": [],
				"failed": true,
				"truncated": false,
				"module_total": 0
			})
		);
	}

	#[test]
	fn an_unreadable_module_name_is_flagged_rather_than_served_as_empty() {
		let module = ImportedModuleWire {
			name: String::new(),
			symbols: vec![ImportedSymbolWire {
				name: None,
				ordinal: None,
				iat_rva: 0x4000,
				name_unreadable: true,
			}],
			symbol_total: Some(2),
			name_unreadable: true,
			symbols_failed: false,
			symbols_truncated: true,
		};

		assert_eq!(
			serde_json::to_value(module).unwrap(),
			serde_json::json!({
				"name": "",
				"symbols": [{ "iat_rva": "0x4000", "name_unreadable": true }],
				"symbol_total": 2,
				"name_unreadable": true,
				"symbols_failed": false,
				"symbols_truncated": true
			})
		);
	}
}
