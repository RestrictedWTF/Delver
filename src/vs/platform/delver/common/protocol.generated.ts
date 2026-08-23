/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GENERATED — DO NOT EDIT
// Generated from delver/schema/protocol.schema.json by `npm run delver:protocol`.
// Edit the delver-protocol crate and regenerate.
//
// Addresses cross the wire as "0x..." strings, never JSON numbers, because JSON
// numbers are IEEE 754 doubles and truncate above 2^53 (ADR 0001). Parse them
// to bigint before use — never to number.

/**
 * Parameters for `analysis/addressForRow`.
 */
export interface IAddressForRowParams {
	/**
	 * Image handle.
	 */
	image_id: string;
	/**
	 * Row ordinal.
	 */
	row: number;
}

/**
 * Response payload for `analysis/addressForRow`.
 */
export interface IAddressForRowResult {
	/**
	 * Address of the row, absent when the row is out of range.
	 */
	rva?: string;
}

/**
 * Address space kind on the wire.
 */
export const enum AddressSpaceKindWire {
	/**
	 * Raw file offsets.
	 */
	File = 'file',
	/**
	 * Loaded image view.
	 */
	Image = 'image',
}

/**
 * Address space on the wire.
 */
export interface IAddressSpaceWire {
	/**
	 * Space id, e.g. "File" or "Image".
	 */
	id: string;
	/**
	 * Kind of address space.
	 */
	kind: AddressSpaceKindWire;
	/**
	 * Pointer width in bits.
	 */
	pointer_width: number;
	/**
	 * Extent of the space in bytes.
	 * 
	 * A client that needs the whole space — the analysis server pulling an image through the provider, or a hex view sizing its scrollbar — would otherwise have to probe for the end by reading until it gets a short answer.
	 */
	size: string;
	/**
	 * Id of the space this translates to, if any.
	 */
	translates_to?: string;
}

/**
 * Structured detail carried by a domain error.
 */
export interface IErrorData {
	/**
	 * Provider-specific detail.
	 */
	detail: string;
	/**
	 * Error kind.
	 */
	kind: ErrorKind;
}

/**
 * Domain-level error kinds.
 */
export const enum ErrorKind {
	/**
	 * `initialize` reported an incompatible protocol version.
	 */
	ProtocolVersionMismatch = 'ProtocolVersionMismatch',
	/**
	 * A method that requires an attached target was called before attachment.
	 */
	NotAttached = 'NotAttached',
	/**
	 * The supplied address is not valid in the requested space.
	 */
	InvalidAddress = 'InvalidAddress',
	/**
	 * No bytes were readable at the requested location.
	 */
	UnreadableMemory = 'UnreadableMemory',
	/**
	 * The target does not support the requested capability.
	 */
	UnsupportedCapability = 'UnsupportedCapability',
	/**
	 * The target is temporarily busy and the request should be retried.
	 */
	TargetBusy = 'TargetBusy',
}

/**
 * An exported symbol on the wire.
 */
export interface IExportWire {
	/**
	 * Forward target, e.g. "NTDLL.RtlAllocateHeap".
	 */
	forwarded_to?: string;
	/**
	 * Symbol name, absent for exports by ordinal only.
	 */
	name?: string;
	/**
	 * Export ordinal.
	 */
	ordinal: number;
	/**
	 * RVA of the export target, absent when forwarded.
	 */
	rva?: string;
}

/**
 * Control-flow classification on the wire.
 */
export const enum FlowKindWire {
	/**
	 * Falls through to the next instruction.
	 */
	Sequential = 'sequential',
	/**
	 * Unconditional direct branch.
	 */
	Jump = 'jump',
	/**
	 * Conditional branch.
	 */
	ConditionalJump = 'conditionalJump',
	/**
	 * Direct call.
	 */
	Call = 'call',
	/**
	 * Branch or call through a register or memory operand.
	 */
	Indirect = 'indirect',
	/**
	 * Returns from the current function.
	 */
	Return = 'return',
	/**
	 * Interrupt or syscall.
	 */
	Interrupt = 'interrupt',
	/**
	 * Not a valid instruction.
	 */
	Invalid = 'invalid',
}

/**
 * Reference to a binary frame delivered inline after a JSON response.
 */
export interface IFrameRef {
	/**
	 * Frame id matching the `Delver-Frame` header.
	 */
	$frame: number;
	/**
	 * Length of the binary payload in bytes.
	 */
	len: number;
}

/**
 * Versioned digest used to associate unchanged functions across binaries.
 */
export interface IFunctionFingerprintWire {
	/**
	 * Digest algorithm.
	 */
	algorithm: string;
	/**
	 * Lowercase hexadecimal digest.
	 */
	digest: string;
	/**
	 * Versioned normalization profile.
	 */
	normalization: string;
}

/**
 * A candidate function start on the wire.
 */
export interface IFunctionSeedWire {
	/**
	 * Exclusive end as an RVA, when the source records one.
	 */
	end_rva?: string;
	/**
	 * Function start as an RVA.
	 */
	rva: string;
	/**
	 * Where the seed came from. Consumers must render inferred boundaries differently from compiler-emitted ones.
	 */
	source: SeedSourceWire;
}

/**
 * Origin of a detected function, most authoritative first.
 */
export const enum FunctionSourceWire {
	/**
	 * From the exception directory. Compiler-emitted.
	 */
	ExceptionDirectory = 'exceptionDirectory',
	/**
	 * The image entry point.
	 */
	EntryPoint = 'entryPoint',
	/**
	 * An exported symbol.
	 */
	Export = 'export',
	/**
	 * A TLS callback.
	 */
	TlsCallback = 'tlsCallback',
	/**
	 * Reached by a direct call during recursive descent.
	 */
	CallTarget = 'callTarget',
	/**
	 * Found by linear sweep. Nothing references it — a guess.
	 */
	LinearSweep = 'linearSweep',
}

/**
 * A detected function on the wire.
 */
export interface IFunctionWire {
	/**
	 * Whether the image itself vouches for this boundary. Consumers must render an inferred boundary differently from a confirmed one.
	 */
	authoritative: boolean;
	/**
	 * Exclusive end, when known.
	 */
	end_rva?: string;
	/**
	 * Relocation-insensitive identity of the function's normalized listing.
	 */
	fingerprint?: IFunctionFingerprintWire;
	/**
	 * Entry RVA.
	 */
	rva: string;
	/**
	 * Where the boundary came from.
	 */
	source: FunctionSourceWire;
}

/**
 * Response payload for `analysis/functions`.
 */
export interface IFunctionsResult {
	/**
	 * Detected functions, sorted by address.
	 */
	functions: IFunctionWire[];
}

/**
 * Response payload for `getExports`.
 */
export interface IGetExportsResult {
	/**
	 * Exported symbols.
	 */
	exports: IExportWire[];
}

/**
 * Response payload for `getFunctionSeeds`.
 */
export interface IGetFunctionSeedsResult {
	/**
	 * Candidate function starts, sorted by address.
	 */
	seeds: IFunctionSeedWire[];
}

/**
 * Response payload for `getImageInfo`.
 * 
 * Deliberately a summary. Imports, exports, and function seeds are unbounded in principle — a large system DLL exports thousands of symbols — so they are fetched through their own methods rather than inflating every image open.
 */
export interface IGetImageInfoResult {
	/**
	 * Architecture string, e.g. "x86_64".
	 */
	arch: string;
	/**
	 * SHA-256 of the image's file bytes, lowercase hex.
	 * 
	 * This is the image's **identity**, and what interpretation anchors to (`Docs/architecture/data-model.md` section 4). An absolute address is not an identity — ASLR, a re-dump, or another process loading the same module moves it — so an authored name must be keyed to the bytes it describes, never to where they happened to sit.
	 */
	content_hash: string;
	/**
	 * Image entry point virtual address.
	 */
	entry: string;
	/**
	 * Number of exported symbols.
	 */
	export_count: number;
	/**
	 * Number of candidate function starts.
	 */
	function_seed_count: number;
	/**
	 * Preferred or actual image base.
	 */
	image_base: string;
	/**
	 * Number of imported modules.
	 */
	import_module_count: number;
	/**
	 * Total number of imported symbols across all modules.
	 */
	import_symbol_count: number;
	/**
	 * Number of base relocation targets.
	 */
	relocation_count: number;
	/**
	 * Loadable sections.
	 */
	sections: ISectionWire[];
	/**
	 * TLS directory, when the image has one.
	 */
	tls?: ITlsWire;
}

/**
 * Response payload for `getImports`.
 */
export interface IGetImportsResult {
	/**
	 * Imported modules.
	 */
	modules: IImportedModuleWire[];
}

/**
 * Parameters for an image-scoped query with no other arguments.
 */
export interface IImageQueryParams {
	/**
	 * Image handle.
	 */
	image_id: string;
}

/**
 * An imported module on the wire.
 */
export interface IImportedModuleWire {
	/**
	 * Module name as written in the import descriptor.
	 */
	name: string;
	/**
	 * Symbols imported from this module.
	 */
	symbols: IImportedSymbolWire[];
}

/**
 * An imported symbol on the wire.
 */
export interface IImportedSymbolWire {
	/**
	 * RVA of the import address table slot a call site indirects through.
	 */
	iat_rva: string;
	/**
	 * Symbol name, absent for imports by ordinal.
	 */
	name?: string;
	/**
	 * Ordinal, present for imports by ordinal.
	 */
	ordinal?: number;
}

/**
 * Response payload for `initialize`.
 */
export interface IInitializeResult {
	/**
	 * Capabilities this provider exposes.
	 */
	capabilities: TargetCapabilityWire[];
	/**
	 * Protocol version supported by the provider.
	 */
	protocol_version: string;
	/**
	 * Address spaces exposed by the target.
	 */
	spaces: IAddressSpaceWire[];
	/**
	 * High-level target descriptor.
	 */
	target: ITargetDescriptorWire;
}

/**
 * Response payload for `listSpaces`.
 */
export interface IListSpacesResult {
	/**
	 * Address spaces exposed by the target.
	 */
	spaces: IAddressSpaceWire[];
}

/**
 * One listing row on the wire.
 */
export interface IListingRowWire {
	/**
	 * Statically known branch target, when there is one.
	 */
	branch_target?: string;
	/**
	 * Exact encoded instruction bytes, when the analysis server retained the source image.
	 */
	bytes_hex?: string;
	/**
	 * How execution proceeds after this instruction.
	 */
	flow: FlowKindWire;
	/**
	 * Encoded length in bytes.
	 */
	len: number;
	/**
	 * Formatted mnemonic.
	 */
	mnemonic: string;
	/**
	 * Formatted operands. Empty when there are none.
	 */
	operands: string;
	/**
	 * Row ordinal.
	 */
	row: number;
	/**
	 * Instruction address.
	 */
	rva: string;
	/**
	 * Address-bearing encoded fields that a relocation-stable byte signature should wildcard.
	 */
	signature_fields?: ISignatureFieldWire[];
}

/**
 * Parameters for `analysis/listingWindow`.
 */
export interface IListingWindowParams {
	/**
	 * Maximum rows to return. Bounded server-side.
	 */
	count: number;
	/**
	 * Image handle.
	 */
	image_id: string;
	/**
	 * First row to return.
	 */
	start_row: number;
}

/**
 * Response payload for `analysis/listingWindow`.
 */
export interface IListingWindowResult {
	/**
	 * Rows in the requested range.
	 */
	rows: IListingRowWire[];
	/**
	 * Total rows available, so a client can size its scrollbar.
	 */
	total_rows: number;
}

/**
 * Moment kind on the wire.
 */
export const enum MomentKindWire {
	/**
	 * Unchanging content.
	 */
	Static = 'static',
	/**
	 * Captured snapshot.
	 */
	Snapshot = 'snapshot',
	/**
	 * Live target.
	 */
	Live = 'live',
}

/**
 * A moment on the wire.
 */
export interface IMomentWire {
	/**
	 * Provider-defined epoch.
	 */
	epoch: number;
	/**
	 * Kind of moment.
	 */
	kind: MomentKindWire;
}

/**
 * Parameters for `analysis/openImage`.
 */
export interface IOpenImageParams {
	/**
	 * Address space to analyse. Defaults to the provider's file space.
	 */
	space?: string;
}

/**
 * Response payload for `analysis/openImage`.
 */
export interface IOpenImageResult {
	/**
	 * Architecture the image was decoded as.
	 */
	arch: string;
	/**
	 * Number of detected functions.
	 */
	function_count: number;
	/**
	 * Handle for subsequent analysis calls.
	 */
	image_id: string;
	/**
	 * Total decoded instructions — the listing's exact row count.
	 */
	instruction_count: number;
	/**
	 * Number of strings located.
	 */
	string_count: number;
	/**
	 * Number of cross-references.
	 */
	xref_count: number;
}

/**
 * A readable byte range.
 */
export interface IRangeWire {
	/**
	 * Exclusive end.
	 */
	end: string;
	/**
	 * Inclusive start.
	 */
	start: string;
}

/**
 * Parameters for `readMemory`.
 */
export interface IReadMemoryParams {
	/**
	 * Start address.
	 */
	address: string;
	/**
	 * Number of bytes to read.
	 */
	len: number;
	/**
	 * Optional moment; omit for the current moment.
	 */
	moment?: IMomentWire;
	/**
	 * Address space id.
	 */
	space: string;
}

/**
 * Response payload for `readMemory`.
 */
export interface IReadMemoryResult {
	/**
	 * Reference to the binary frame that immediately follows this response.
	 */
	data: IFrameRef;
	/**
	 * Moment that the data was captured at.
	 */
	served_moment: IMomentWire;
	/**
	 * Ranges within the request that were actually readable.
	 */
	valid: IRangeWire[];
}

/**
 * A JSON-RPC style request.
 */
export interface IRequest {
	/**
	 * Opaque identifier used to correlate the response.
	 */
	id: number;
	/**
	 * Method name.
	 */
	method: string;
	/**
	 * Method-specific parameters.
	 */
	params?: unknown;
}

/**
 * A JSON-RPC style response.
 */
export interface IResponse {
	/**
	 * Error payload, present only on failure.
	 */
	error?: IRpcError;
	/**
	 * Identifier matching the request.
	 */
	id: number;
	/**
	 * Result payload, present only on success.
	 */
	result?: unknown;
}

/**
 * Parameters for `analysis/rowForAddress`.
 */
export interface IRowForAddressParams {
	/**
	 * When true, return the row *containing* the address rather than requiring an exact instruction boundary.
	 */
	containing?: boolean;
	/**
	 * Image handle.
	 */
	image_id: string;
	/**
	 * Address to locate.
	 */
	rva: string;
}

/**
 * Response payload for `analysis/rowForAddress`.
 */
export interface IRowForAddressResult {
	/**
	 * Row ordinal, absent when the address is not in the index.
	 */
	row?: number;
}

/**
 * JSON-RPC error object extended with Delver-specific error data.
 */
export interface IRpcError {
	/**
	 * JSON-RPC error code.
	 */
	code: number;
	/**
	 * Delver error kind and detail.
	 */
	data?: IErrorData;
	/**
	 * Human-readable message.
	 */
	message: string;
}

/**
 * Image section on the wire.
 */
export interface ISectionWire {
	/**
	 * Shannon entropy of the raw bytes, in bits per byte (0..=8).
	 * 
	 * The cheapest signal available for compressed or encrypted content: machine code sits near 6, packed or ciphered data crowds 8.
	 */
	entropy: number;
	/**
	 * Marked executable (`IMAGE_SCN_MEM_EXECUTE`).
	 */
	executable: boolean;
	/**
	 * Section name.
	 */
	name: string;
	/**
	 * Raw file offset.
	 */
	raw_offset: string;
	/**
	 * Raw file size.
	 */
	raw_size: number;
	/**
	 * Marked readable (`IMAGE_SCN_MEM_READ`).
	 */
	readable: boolean;
	/**
	 * Virtual address.
	 */
	virtual_address: string;
	/**
	 * Virtual size.
	 */
	virtual_size: number;
	/**
	 * Marked writable (`IMAGE_SCN_MEM_WRITE`).
	 */
	writable: boolean;
}

/**
 * Origin of a function seed, most authoritative first.
 */
export const enum SeedSourceWire {
	/**
	 * From the exception directory. Compiler-emitted.
	 */
	ExceptionDirectory = 'exceptionDirectory',
	/**
	 * The image entry point.
	 */
	EntryPoint = 'entryPoint',
	/**
	 * An exported symbol.
	 */
	Export = 'export',
	/**
	 * A TLS callback, which runs before the entry point.
	 */
	TlsCallback = 'tlsCallback',
}

/**
 * Why an encoded field is wildcarded in a reusable signature.
 */
export const enum SignatureFieldReasonWire {
	/**
	 * Relative immediate used by a direct branch or call.
	 */
	RelativeBranch = 'relativeBranch',
	/**
	 * Displacement used by RIP/EIP-relative memory addressing.
	 */
	IpRelativeMemory = 'ipRelativeMemory',
	/**
	 * Pointer-sized field named by the PE base-relocation table.
	 */
	BaseRelocation = 'baseRelocation',
}

/**
 * One exact unstable field inside an encoded instruction.
 */
export interface ISignatureFieldWire {
	/**
	 * Zero-based byte offset from the instruction start.
	 */
	index: number;
	/**
	 * Number of bytes occupied by the field.
	 */
	length: number;
	/**
	 * Why the field is unsafe to retain literally.
	 */
	reason: SignatureFieldReasonWire;
}

/**
 * String encoding on the wire.
 */
export const enum StringEncodingWire {
	/**
	 * Printable single-byte characters.
	 */
	Ascii = 'ascii',
	/**
	 * UTF-16, little-endian.
	 */
	Utf16Le = 'utf16Le',
}

/**
 * A located string on the wire.
 * 
 * `text` is **attacker-controlled**. Consumers must escape it before display and must never treat it as markup or as instructions to a model.
 */
export interface IStringWire {
	/**
	 * How it was encoded.
	 */
	encoding: StringEncodingWire;
	/**
	 * RVA of the first character.
	 */
	rva: string;
	/**
	 * Decoded text. Untrusted.
	 */
	text: string;
}

/**
 * Response payload for `analysis/strings`.
 */
export interface IStringsResult {
	/**
	 * Strings located in the image.
	 */
	strings: IStringWire[];
	/**
	 * Whether the scan hit its cap and dropped results.
	 * 
	 * The cap stops a hostile file turning string extraction into an allocation attack, but a truncated list that does not say so is worse than none: a client cannot otherwise tell a complete answer from a partial one, and would present a partial one as complete.
	 */
	truncated: boolean;
}

/**
 * Target capability on the wire.
 */
export const enum TargetCapabilityWire {
	/**
	 * Can list address spaces.
	 */
	ListSpaces = 'listSpaces',
	/**
	 * Can return image metadata.
	 */
	GetImageInfo = 'getImageInfo',
	/**
	 * Can read memory.
	 */
	ReadMemory = 'readMemory',
	/**
	 * Can enumerate imported modules and symbols.
	 */
	GetImports = 'getImports',
	/**
	 * Can enumerate exported symbols.
	 */
	GetExports = 'getExports',
	/**
	 * Can supply candidate function starts.
	 */
	GetFunctionSeeds = 'getFunctionSeeds',
	/**
	 * Can analyse an image and serve listing rows, functions, and xrefs.
	 */
	Analyze = 'analyze',
}

/**
 * High-level target descriptor on the wire.
 */
export interface ITargetDescriptorWire {
	/**
	 * Target kind string, e.g. "file".
	 */
	kind: string;
	/**
	 * Human-readable target name.
	 */
	name: string;
}

/**
 * TLS directory on the wire.
 */
export interface ITlsWire {
	/**
	 * TLS callback RVAs, in loader invocation order.
	 */
	callbacks: string[];
	/**
	 * RVA of the TLS index variable.
	 */
	index_rva: string;
	/**
	 * RVA of the raw TLS template data.
	 */
	raw_data_rva: string;
	/**
	 * Size of the raw TLS template data.
	 */
	raw_data_size: number;
}

/**
 * Kind of cross-reference on the wire.
 */
export const enum XrefKindWire {
	/**
	 * A direct call.
	 */
	Call = 'call',
	/**
	 * An unconditional direct branch.
	 */
	Jump = 'jump',
	/**
	 * A conditional branch.
	 */
	ConditionalJump = 'conditionalJump',
	/**
	 * A RIP-relative memory operand.
	 */
	Data = 'data',
}

/**
 * A cross-reference on the wire.
 */
export interface IXrefWire {
	/**
	 * Referencing address.
	 */
	from: string;
	/**
	 * Kind of reference.
	 */
	kind: XrefKindWire;
	/**
	 * Referenced address.
	 */
	to: string;
}

/**
 * Parameters for `analysis/xrefsTo` and `analysis/xrefsFrom`.
 */
export interface IXrefsParams {
	/**
	 * Image handle.
	 */
	image_id: string;
	/**
	 * Address to look up.
	 */
	rva: string;
}

/**
 * Response payload for the xref queries.
 */
export interface IXrefsResult {
	/**
	 * Matching references.
	 */
	xrefs: IXrefWire[];
}
