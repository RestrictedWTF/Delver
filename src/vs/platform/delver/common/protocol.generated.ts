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
 * Why control moves between two basic blocks.
 */
export const enum BasicBlockEdgeKindWire {
	/**
	 * Natural continuation into the next block.
	 */
	Fallthrough = 'fallthrough',
	/**
	 * An unconditional direct branch.
	 */
	Jump = 'jump',
	/**
	 * The taken side of a conditional direct branch.
	 */
	ConditionalTaken = 'conditionalTaken',
}

/**
 * One direct intra-function CFG edge.
 */
export interface IBasicBlockEdgeWire {
	/**
	 * Source block start RVA.
	 */
	from: string;
	/**
	 * Edge classification.
	 */
	kind: BasicBlockEdgeKindWire;
	/**
	 * Destination block start RVA.
	 */
	to: string;
}

/**
 * One maximal straight-line instruction sequence.
 */
export interface IBasicBlockWire {
	/**
	 * Exclusive end RVA.
	 */
	end_rva: string;
	/**
	 * Number of instructions.
	 */
	instruction_count: number;
	/**
	 * First instruction RVA.
	 */
	start_rva: string;
}

/**
 * Parameters for `analysis/basicBlocks`.
 */
export interface IBasicBlocksParams {
	/**
	 * Exact detected function entry RVA.
	 */
	function_rva: string;
	/**
	 * Image handle.
	 */
	image_id: string;
	/**
	 * Maximum number of blocks returned.
	 */
	max_blocks: number;
}

/**
 * Response payload for `analysis/basicBlocks`.
 */
export interface IBasicBlocksResult {
	/**
	 * Blocks inside the extent before the bound was applied.
	 */
	block_total: number;
	/**
	 * Basic blocks ordered by start RVA.
	 */
	blocks: IBasicBlockWire[];
	/**
	 * Whether the function's extent came from a recorded end rather than being inferred — from the next detected function, or from the run of decoded instructions leaving the entry. Every block and edge above is derived from that extent and inherits its uncertainty, which is why `analysis/functionProfile` has reported the same flag from the start.
	 */
	bounded: boolean;
	/**
	 * Direct intra-function edges inside the extent before the bound was applied. Larger than `edges` when a bounded block list left an edge with no returned endpoint to attach to.
	 */
	edge_total: number;
	/**
	 * Direct intra-function edges whose endpoints are both returned.
	 */
	edges: IBasicBlockEdgeWire[];
	/**
	 * Function entry RVA.
	 */
	function_rva: string;
	/**
	 * Whether blocks were omitted because of the requested bound.
	 */
	truncated: boolean;
}

/**
 * One direct inter-function edge.
 */
export interface ICallGraphEdgeWire {
	/**
	 * Kind of reference the site makes.
	 */
	kind: XrefKindWire;
	/**
	 * The import this edge really reaches, when its target is nothing but a one-instruction thunk into the IAT. The edge still names the thunk; this names what the thunk is for.
	 */
	resolved_import?: IResolvedImportWire;
	/**
	 * RVA of the referencing instruction.
	 */
	site: string;
	/**
	 * Entry of the detected function containing the site, when one owns it. Absent for a site in padding or unclaimed bytes.
	 */
	site_function_rva?: string;
	/**
	 * Whether this is a branch that leaves its own function — a tail call rather than intra-function control flow.
	 */
	tail_call: boolean;
	/**
	 * RVA referred to.
	 */
	target: string;
	/**
	 * Entry of the detected function containing the target, when one owns it.
	 */
	target_function_rva?: string;
}

/**
 * Parameters for `analysis/callGraph`.
 */
export interface ICallGraphParams {
	/**
	 * Exact detected function entry RVA.
	 */
	function_rva: string;
	/**
	 * Image handle.
	 */
	image_id: string;
	/**
	 * Maximum number of edges returned in each of the three lists.
	 */
	max_edges: number;
}

/**
 * Response payload for `analysis/callGraph`.
 *
 * The three lists are bounded independently, so a function with thousands of callers still reports its handful of callees in full.
 */
export interface ICallGraphResult {
	/**
	 * Whether the function's extent came from a recorded end rather than being inferred. The callee and indirect lists are derived from that extent, so an inferred one can both miss edges and claim edges past the real end.
	 */
	bounded: boolean;
	/**
	 * Total callee edges before the bound was applied.
	 */
	callee_total: number;
	/**
	 * Edges leaving the function, ordered by site RVA.
	 */
	callees: ICallGraphEdgeWire[];
	/**
	 * Whether callee edges were omitted because of the requested bound.
	 */
	callees_truncated: boolean;
	/**
	 * Total caller edges before the bound was applied.
	 */
	caller_total: number;
	/**
	 * Edges arriving at the function entry, ordered by site RVA.
	 */
	callers: ICallGraphEdgeWire[];
	/**
	 * Whether caller edges were omitted because of the requested bound.
	 */
	callers_truncated: boolean;
	/**
	 * Function entry RVA.
	 */
	function_rva: string;
	/**
	 * Whether import parsing was incomplete, so an unresolved indirect call may have lost an IAT identity that exists in the sample.
	 */
	import_resolution_incomplete: boolean;
	/**
	 * Total indirect call sites before the bound was applied, resolved or not.
	 */
	indirect_call_site_total: number;
	/**
	 * Call sites inside the function whose callee the decoder cannot name, ordered by RVA. Each carries the import it indirects through when one is named for it. A caller that ignores the unresolved ones is reading an incomplete graph.
	 */
	indirect_call_sites: IIndirectCallSiteWire[];
	/**
	 * Whether unresolved call sites were omitted because of the requested bound.
	 */
	indirect_truncated: boolean;
	/**
	 * Indirect call sites before the bound was applied that could **not** be resolved.
	 *
	 * A total over every site, never over the returned page: this is the number a completeness claim rests on, and a claim computed from a page would be a claim about the page.
	 */
	unresolved_indirect_call_site_total: number;
}

/**
 * One call in an ordered path, with the exact instruction that makes it.
 *
 * The call site is not decoration. A path of function entries is a claim a human has to take on trust; a path of call sites is one they can go and look at, which is the whole reason for returning evidence rather than a summary.
 */
export interface ICallPathStepWire {
	/**
	 * RVA of the calling instruction.
	 */
	call_site: string;
	/**
	 * Entry of the function the step leaves.
	 */
	from_function_rva: string;
	/**
	 * Kind of reference the site makes.
	 */
	kind: XrefKindWire;
	/**
	 * The import this step really reaches, when the target is an IAT slot or a one-instruction thunk into one. A thunk step still names the thunk in `to_function_rva`; this names what the thunk is for.
	 */
	resolved_import?: IResolvedImportWire;
	/**
	 * Whether the step is a branch that leaves its own function — a tail call rather than intra-function control flow.
	 */
	tail_call: boolean;
	/**
	 * Entry of the detected function the step lands in. Absent when the step lands straight on an import through an IAT slot, which no function owns.
	 */
	to_function_rva?: string;
}

/**
 * One ordered source-to-sink path.
 */
export interface ICallPathWire {
	/**
	 * Steps in call order, the first leaving the source function and the last arriving at the sink. Empty only when source and sink are the same function, which is reached in no steps at all.
	 */
	steps: ICallPathStepWire[];
}

/**
 * Parameters for `analysis/callPaths`.
 */
export interface ICallPathsParams {
	/**
	 * Exact detected function entry RVA to search from.
	 */
	from_rva: string;
	/**
	 * Image handle.
	 */
	image_id: string;
	/**
	 * Maximum steps in one returned path. Clamped to 1..=16.
	 */
	max_depth: number;
	/**
	 * Maximum paths returned. Clamped to 1..=64.
	 */
	max_paths: number;
	/**
	 * Maximum frontier expansions the search may perform. Clamped to 1..=100000.
	 */
	max_visited: number;
	/**
	 * The sink: either an exact detected function entry RVA, or the RVA of an import address table slot. An import sink is what a malware question usually is — "what reaches `VirtualAlloc`?" — and the resolved-import edges make it answerable. Anything else is rejected.
	 */
	to_rva: string;
}

/**
 * Response payload for `analysis/callPaths`.
 *
 * **An empty `paths` is not a proof of absence.** The search is bounded, and every bound marks a place a path could have been and was not looked at. A negative result is a claim that no path *exists* only when the search was genuinely complete — that is, only when `search_exhausted` is true, `depth_limit_reached` and `visit_limit_reached` are both false, and `unresolved_indirect_sites_on_frontier` is zero.
 *
 * Any unresolved indirect call site on the frontier could hide an edge — a call through a register or a vtable is exactly where a real sample hides the path being looked for — which is why it is counted and reported rather than passed over. A caller that renders an empty result as "no path exists" without checking all four is presenting a bounded search as a proof.
 */
export interface ICallPathsResult {
	/**
	 * Whether the *source* function's extent came from a recorded end rather than being inferred. The first step of every path is enumerated from that extent, so an inferred one can hide the edge the search was looking for. Frontier functions carry no such flag: an extent that could not be derived at all already clears `search_exhausted`.
	 */
	bounded: boolean;
	/**
	 * Whether some edge was dropped because following it would have exceeded the depth bound. The frontier below that edge is unexplored.
	 */
	depth_limit_reached: boolean;
	/**
	 * Entry of the function the search started from.
	 */
	from_rva: string;
	/**
	 * Whether import parsing was incomplete, so unresolved frontier calls may have lost nameable IAT targets.
	 */
	import_resolution_incomplete: boolean;
	/**
	 * Distinct simple paths found, shortest first. No function repeats within a single path, so recursion cannot spin one out forever.
	 */
	paths: ICallPathWire[];
	/**
	 * Whether at least one further path was reached beyond the requested bound. Set only when an extra path was genuinely found, never merely because the bound was met.
	 */
	paths_truncated: boolean;
	/**
	 * Whether the whole reachable set within the limits was explored.
	 *
	 * False when the visit budget or the path bound stopped the walk, and false when a function on the frontier had no derivable extent and so could not have its edges enumerated at all. A depth cut does *not* clear this — depth is one of the limits, and `depth_limit_reached` reports it on its own.
	 */
	search_exhausted: boolean;
	/**
	 * The requested sink: a function entry or an IAT slot.
	 */
	to_rva: string;
	/**
	 * Frontier functions whose extents were inferred rather than recorded. Any one can hide or over-include an outgoing edge.
	 */
	unbounded_functions_on_frontier: number;
	/**
	 * Call sites with no nameable callee, found in the functions this search actually expanded.
	 *
	 * **Not an image-wide total.** It counts only the frontier the search touched, which is exactly the set where a hidden edge would have changed this answer. A non-zero count forbids reading an empty `paths` as "no path exists".
	 */
	unresolved_indirect_sites_on_frontier: number;
	/**
	 * Whether the visit budget ran out with work still queued.
	 */
	visit_limit_reached: boolean;
	/**
	 * Distinct functions whose outgoing edges were expanded. A count of functions, not of work: a function is expanded once per distinct path prefix that reaches it, and `max_visited` bounds those expansions rather than this number.
	 */
	visited_function_count: number;
}

/**
 * Whether an image's code passes ran, and why not when they did not.
 *
 * Empty instruction, function and xref lists have two incompatible meanings, and only one of them is a fact about the sample. An image Delver has no disassembler for reports zero of each, and presenting that as a finding is a confident false claim about the binary — the failure this codebase ranks worst. Tagged rather than a boolean plus an optional string: a client that has not been taught about a reason must fail to parse it rather than read an unknown state as "fine".
 */
export type ICodeDecodingWire =
	/**
	 * Every code pass ran. Empty lists here are a fact about the image.
	 */
	| {
		kind: 'decoded';
	}
	/**
	 * Delver has no disassembler for the image's architecture, so recursive descent, the linear sweep and xref building were all skipped. Strings and the parsed headers are still valid; only the code facts are absent.
	 */
	| {
		/**
		 * The architecture the image declared, so a caller can name it.
		 */
		arch: string;
		kind: 'unsupportedArchitecture';
	};

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
	 * Call through a register or memory operand. The callee is not statically known, but control returns to the following address.
	 */
	IndirectCall = 'indirectCall',
	/**
	 * Branch through a register or memory operand — a jump-table dispatch or a tail call through a thunk.
	 */
	IndirectBranch = 'indirectBranch',
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
 * What an authored correction asserts.
 */
export const enum FunctionCorrectionKindWire {
	/**
	 * A function starts at this address, whatever detection concluded.
	 */
	Define = 'define',
	/**
	 * No function starts at this address, whatever detection concluded.
	 *
	 * It must survive re-derivation: removing a seed is not enough when recursive descent would rediscover the address as a call target.
	 */
	Undefine = 'undefine',
}

/**
 * One authored correction to function detection.
 *
 * A correction is a change to the *seed set* analysis derives from, not an edit to its output: the server re-derives everything from the bytes plus the corrected seeds. That is what keeps facts recomputable and keeps the correction itself in the authored log where `CLAUDE.md` invariant 3 wants it. Nothing here modifies the target's bytes.
 */
export interface IFunctionCorrectionWire {
	/**
	 * Exclusive end of the defined function.
	 *
	 * `define` only, and optional: absent means the extent is inferred exactly as a detected function's is, rather than guessed at here.
	 */
	end_rva?: string;
	/**
	 * What the analyst asserts about that address.
	 */
	kind: FunctionCorrectionKindWire;
	/**
	 * Image-relative address the correction is about.
	 */
	rva: string;
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
 * Parameters for `analysis/functionProfile`.
 */
export interface IFunctionProfileParams {
	/**
	 * Exact detected function entry RVA.
	 */
	function_rva: string;
	/**
	 * Image handle.
	 */
	image_id: string;
}

/**
 * Response payload for `analysis/functionProfile`.
 *
 * Aggregate counts only. Every one of them is derived from the same facts the bounded `analysis/basicBlocks` and `analysis/callGraph` results expose, so a caller can use this to decide whether fetching the detail is worthwhile without first paging through it.
 */
export interface IFunctionProfileResult {
	/**
	 * Basic blocks inside the extent.
	 */
	block_count: number;
	/**
	 * Whether the extent came from a recorded end rather than being inferred — from the next detected function, or from the run of decoded instructions leaving the entry. An inferred extent is a guess and every count below inherits that uncertainty.
	 */
	bounded: boolean;
	/**
	 * Bytes inside the extent actually covered by decoded instructions. Less than the extent when the function contains data or undecoded gaps.
	 */
	decoded_extent_bytes: number;
	/**
	 * Direct intra-function control-flow edges inside the extent.
	 */
	edge_count: number;
	/**
	 * The function's own recorded end, absent when no source recorded one.
	 */
	end_rva?: string;
	/**
	 * Function entry RVA.
	 */
	function_rva: string;
	/**
	 * Sites elsewhere that reference the entry.
	 */
	incoming_call_site_count: number;
	/**
	 * Distinct detected functions containing those sites.
	 */
	incoming_caller_function_count: number;
	/**
	 * Call sites inside the extent whose callee is not statically known.
	 */
	indirect_call_site_count: number;
	/**
	 * Decoded instructions inside the extent.
	 */
	instruction_count: number;
	/**
	 * Sites inside the extent that reference code outside it.
	 */
	outgoing_call_site_count: number;
	/**
	 * Distinct detected functions those sites resolve to.
	 */
	outgoing_target_function_count: number;
	/**
	 * How many of those the import table names a target for. The difference between the two is what the graph genuinely cannot see.
	 */
	resolved_indirect_call_site_count: number;
	/**
	 * Instructions inside the extent that return from the function.
	 */
	return_count: number;
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
	 * An analyst said so. Outranks anything derived.
	 */
	Authored = 'authored',
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
	/**
	 * Whether functions were omitted because of the response bound.
	 */
	list_truncated: boolean;
	/**
	 * Detected functions before the response bound was applied.
	 */
	total: number;
}

/**
 * Response payload for `getExports`.
 */
export interface IGetExportsResult {
	/**
	 * Exported symbols.
	 */
	exports: IExportWire[];
	/**
	 * The export directory is present but could not be parsed. `exports` then holds only what was recovered first, and an empty list is not a claim that the image exports nothing.
	 */
	failed: boolean;
	/**
	 * Exports present before the cap was applied.
	 */
	total: number;
	/**
	 * Whether exports were dropped at the parser's export cap.
	 */
	truncated: boolean;
}

/**
 * Response payload for `getFunctionSeeds`.
 */
export interface IGetFunctionSeedsResult {
	/**
	 * The exception directory is present but could not be read whole, so compiler-emitted function starts are missing. On x64 those are the most authoritative starts the image has, and everything downstream — detected functions, recorded extents — is poorer without them.
	 */
	exception_directory_failed: boolean;
	/**
	 * Candidate function starts, sorted by address.
	 */
	seeds: IFunctionSeedWire[];
	/**
	 * Whether exception-directory seeds were dropped at the seed cap.
	 */
	truncated: boolean;
}

/**
 * Response payload for `getImageInfo`.
 *
 * Deliberately a summary. Imports, exports, and function seeds are unbounded in principle — a large system DLL exports thousands of symbols — so they are fetched through their own methods rather than inflating every image open.
 *
 * Every count here counts what the parse *delivered*, which is not the same as what the image *has*. The completeness block at the bottom separates the two, and `fully_parsed` is the single field a client needs when all it wants answered is "may I present these numbers as the whole truth?". A zero count with a `_failed` flag set beside it is a parse that gave up, not a claim about the sample — and reporting the second as the first tells an analyst that a packed binary calls no APIs.
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
	 *
	 * For a linked executable this is the C runtime's startup stub, not the `main` an analyst is looking for. See `FunctionWire::role`.
	 */
	entry: string;
	/**
	 * The exception directory is present but could not be read whole.
	 *
	 * Function starts are missing whenever this is set, and on x64 those are the compiler-emitted ones — the most authoritative source the image has.
	 */
	exception_directory_failed: boolean;
	/**
	 * Number of exported symbols.
	 */
	export_count: number;
	/**
	 * The export directory is present but could not be parsed.
	 */
	exports_failed: boolean;
	/**
	 * Whether exports were dropped at the parser's export cap.
	 */
	exports_truncated: boolean;
	/**
	 * Whether every directory parsed to the end with no cap applied.
	 *
	 * Folds in the per-module and per-callback signals as well as every flag below, so one field answers "may I present these lists as the whole truth?". False means at least one flag below — or one on an `ImportedModuleWire`, an `ImportedSymbolWire`, or the `TlsWire` — is set.
	 */
	fully_parsed: boolean;
	/**
	 * Number of candidate function starts.
	 */
	function_seed_count: number;
	/**
	 * Whether exception-directory seeds were dropped at the seed cap.
	 *
	 * Names its source rather than the merged seed list, which draws on several sources and so cannot carry one total.
	 */
	function_seeds_truncated: boolean;
	/**
	 * Preferred or actual image base.
	 */
	image_base: string;
	/**
	 * Number of imported modules.
	 */
	import_module_count: number;
	/**
	 * Total number of imported symbols across all modules, when known.
	 *
	 * Absent when a module or thunk walk was truncated or failed. The recovered prefix remains available from `getImports`, but it is not an image total.
	 */
	import_symbol_count?: number;
	/**
	 * The import directory is present but could not be parsed to the end.
	 *
	 * What `getImports` returns is then only what was recovered first. It is not the image's import list and must never be presented as one.
	 */
	imports_failed: boolean;
	/**
	 * Whether modules were dropped at the parser's module cap.
	 */
	imports_truncated: boolean;
	/**
	 * Number of base relocation targets.
	 */
	relocation_count: number;
	/**
	 * The relocation directory is present but could not be parsed to the end.
	 *
	 * An empty relocation list reads as "this image cannot be rebased", so a swallowed failure here is a claim about the sample's behaviour under ASLR.
	 */
	relocations_failed: boolean;
	/**
	 * Whether relocation targets were dropped at the relocation cap.
	 */
	relocations_truncated: boolean;
	/**
	 * At least one section header carries a name that could not be decoded. Those sections report an empty name, which is not the name they have.
	 */
	section_names_unreadable: boolean;
	/**
	 * Loadable sections.
	 */
	sections: ISectionWire[];
	/**
	 * Windows subsystem the image declares.
	 */
	subsystem: ISubsystemWire;
	/**
	 * TLS directory, when the image has one. Absent either because the image has none or because `tls_failed` is set; those are different facts.
	 */
	tls?: ITlsWire;
	/**
	 * The TLS directory is present but could not be parsed, so `tls` is absent for a reason that is not "the image has no TLS directory". Callbacks run before the entry point, which is exactly why anti-analysis code hides there.
	 */
	tls_failed: boolean;
}

/**
 * Response payload for `getImports`.
 *
 * An empty `modules` is two incompatible claims — "this sample imports nothing", which is a strong and rare thing to say about a binary, and "the import directory is malformed and the parse gave up". `failed` is what tells them apart.
 */
export interface IGetImportsResult {
	/**
	 * The import directory is present but could not be parsed to the end. `modules` then holds only what was recovered first.
	 */
	failed: boolean;
	/**
	 * Import descriptors present before the cap was applied.
	 */
	module_total: number;
	/**
	 * Imported modules.
	 */
	modules: IImportedModuleWire[];
	/**
	 * Whether modules were dropped at the parser's module cap.
	 */
	truncated: boolean;
}

/**
 * One decoded instruction that names a global-data address.
 */
export interface IGlobalAccessWire {
	/**
	 * Entry RVA of the detected function containing the site, when known.
	 */
	function_rva?: string;
	/**
	 * RVA of the referencing instruction.
	 */
	site: string;
}

/**
 * Parameters for `analysis/globalAccesses`.
 */
export interface IGlobalAccessesParams {
	/**
	 * Image handle.
	 */
	image_id: string;
	/**
	 * Maximum number of accesses returned.
	 */
	max_accesses?: number;
	/**
	 * Global-data RVA to query. An address with no retained data references returns an empty list; that is not proof that no runtime access exists.
	 */
	rva: string;
}

/**
 * Response payload for `analysis/globalAccesses`.
 */
export interface IGlobalAccessesResult {
	/**
	 * Referencing instructions ordered by RVA.
	 */
	accesses: IGlobalAccessWire[];
	/**
	 * Queried global-data RVA.
	 */
	rva: string;
	/**
	 * Total retained data references before the response bound.
	 */
	total: number;
	/**
	 * Whether accesses were omitted by the response bound.
	 */
	truncated: boolean;
}

/**
 * One address in a non-executable section named by a retained data reference.
 */
export interface IGlobalWire {
	/**
	 * Number of retained data references to this exact address.
	 */
	reference_count: number;
	/**
	 * Referenced image RVA.
	 */
	rva: string;
	/**
	 * Section name as written in the image.
	 */
	section: string;
	/**
	 * Whether the containing image section is writable.
	 */
	writable: boolean;
}

/**
 * Parameters for `analysis/globals`.
 */
export interface IGlobalsParams {
	/**
	 * Image handle.
	 */
	image_id: string;
	/**
	 * Maximum number of candidates returned.
	 */
	max_globals?: number;
	/**
	 * Zero-based candidate index at which to start the page.
	 */
	start?: number;
}

/**
 * Response payload for `analysis/globals`.
 */
export interface IGlobalsResult {
	/**
	 * Observed global-data addresses ordered by RVA.
	 */
	globals: IGlobalWire[];
	/**
	 * Index of the next candidate, absent exactly when the walk has ended.
	 */
	next_start?: number;
	/**
	 * Total observed candidates before paging.
	 */
	total: number;
}

/**
 * Parameters for an image-scoped list query.
 */
export interface IImageQueryParams {
	/**
	 * Image handle.
	 */
	image_id: string;
	/**
	 * Maximum entries returned. Zero — or an omitted field, which is how an older client asks — requests the server's own cap rather than an unbounded list.
	 */
	max_results?: number;
}

/**
 * An imported module on the wire.
 *
 * The signals below are per module on purpose: the symbol cap is applied per module, and one unreadable thunk array must not cast doubt on the other four thousand modules that parsed cleanly.
 */
export interface IImportedModuleWire {
	/**
	 * Module name as written in the import descriptor. Empty when `name_unreadable` is set — check that before showing it, because a module rendered as an empty string is not a module named one.
	 */
	name: string;
	/**
	 * Whether the descriptor's name string could not be read.
	 */
	name_unreadable: boolean;
	/**
	 * Total symbols before the per-module return cap, when the thunk walk reached its terminator. Absent after a failed walk.
	 */
	symbol_total?: number;
	/**
	 * Symbols imported from this module.
	 */
	symbols: IImportedSymbolWire[];
	/**
	 * Whether the symbol list is incomplete because reading it failed. An empty `symbols` with this set is emphatically not a module the image imports nothing from.
	 */
	symbols_failed: boolean;
	/**
	 * Whether symbols were dropped at the per-module symbol cap.
	 */
	symbols_truncated: boolean;
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
	 * Whether the hint/name entry this thunk points at could not be read.
	 *
	 * `name` and `ordinal` are then both absent, which no real import is. The slot exists and the call site indirecting through it is real; only the symbol's identity is unknown.
	 */
	name_unreadable: boolean;
	/**
	 * Ordinal, present for imports by ordinal.
	 */
	ordinal?: number;
}

/**
 * One call site whose callee the decoder could not name, and what — if anything — the import table names for it.
 */
export interface IIndirectCallSiteWire {
	/**
	 * The import the site indirects through, when exactly one is named for it. Absent means unresolved, never "probably nothing".
	 */
	resolved?: IResolvedImportWire;
	/**
	 * RVA of the calling instruction.
	 */
	site: string;
}

/**
 * How an indirect target was named.
 */
export const enum IndirectResolutionMethodWire {
	/**
	 * The call's own memory operand names an IAT slot — `call [rip+X]`.
	 */
	IatOperand = 'iatOperand',
	/**
	 * The call targets a one-instruction thunk that branches through an IAT slot — `call sub_1234` where `sub_1234` is `jmp [rip+X]`.
	 */
	ImportThunk = 'importThunk',
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
 * A string occupying a listing row.
 */
export interface IListingStringRowWire {
	/**
	 * How it was encoded.
	 */
	encoding: StringEncodingWire;
	/**
	 * Row ordinal.
	 */
	row: number;
	/**
	 * RVA of the first character.
	 */
	rva: string;
	/**
	 * Decoded text. Untrusted — escape before display.
	 */
	text: string;
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
	rows: IListingWindowRowWire[];
	/**
	 * Total rows available, so a client can size its scrollbar.
	 */
	total_rows: number;
}

/**
 * One row of the unified listing.
 *
 * A listing is one address-ordered sequence over the whole image, so a row is not always an instruction. Tagged rather than a struct with optional fields: a client that has not been taught about a row kind must fail to parse it, not render a string as an instruction with an empty mnemonic.
 *
 * `ListingRowWire` stays the instruction shape and keeps its own consumers — signature generation and the agent bridge both want instructions and nothing else.
 */
export type IListingWindowRowWire =
	/**
	 * A decoded instruction.
	 */
	| {
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
		kind: 'instruction';
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
	 * A string found by the scanner, at its own address.
	 */
	| {
		/**
		 * How it was encoded.
		 */
		encoding: StringEncodingWire;
		kind: 'string';
		/**
		 * Row ordinal.
		 */
		row: number;
		/**
		 * RVA of the first character.
		 */
		rva: string;
		/**
		 * Decoded text. Untrusted — escape before display.
		 */
		text: string;
	};

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
	 *
	 * A full `u64`: a live provider is free to stamp moments with a tick count or a nanosecond clock, both of which pass 2^53 while a process is still running. A JSON number would silently truncate it (ADR 0001).
	 */
	epoch: string;
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
	 * Authored corrections to apply before deriving any fact.
	 *
	 * Ascending by `rva` and at most one per address; the server refuses a set that is neither rather than applying part of it, because a partly applied correction set is a fact store nobody can reason about.
	 */
	corrections?: IFunctionCorrectionWire[];
	/**
	 * Address space to analyse. Defaults to the provider's file space.
	 */
	space?: string;
}

/**
 * Response payload for `analysis/openImage`.
 *
 * Every count below is a count over the bytes the provider actually served, which is not always the whole space. `coverage_complete` is what separates the two readings: when it is false the analysis never saw `unreadable_ranges`, so a zero count over them is an absence of evidence and not evidence of absence. A client that renders these numbers without checking it is presenting a partial image as a complete one.
 *
 * `decoding` is the second such qualifier, and it governs the three code counts absolutely: unless it is `decoded`, `instruction_count`, `function_count` and `xref_count` are zero because no pass ran, not because the sample has no code.
 *
 * `fully_parsed` is the third. It describes the analysis server's **own** parse of the bytes it read, which can be less complete than the provider's parse of the same file: a partial read truncates directories that were intact on disk. The detail behind it belongs to `getImageInfo`, which owns the parse; this is the one bit the analysis server has to pass on so that no count here reads as a whole-image answer over a partial parse.
 */
export interface IOpenImageResult {
	/**
	 * Architecture the image was decoded as.
	 */
	arch: string;
	/**
	 * Bytes the provider actually served for the analysed space.
	 */
	bytes_read: string;
	/**
	 * Whether every byte of the analysed space was readable.
	 */
	coverage_complete: boolean;
	/**
	 * Whether the code passes ran at all, and why not when they did not.
	 */
	decoding: ICodeDecodingWire;
	/**
	 * Whether the analysis server's parse of the bytes it read delivered every directory in full. False means seeds, imports or relocations are missing, so the counts below understate the image by an unknown amount; ask `getImageInfo` which directory it was.
	 */
	fully_parsed: boolean;
	/**
	 * Number of detected functions.
	 */
	function_count: number;
	/**
	 * Handle for subsequent analysis calls.
	 */
	image_id: string;
	/**
	 * Total decoded instructions — the listing's exact row count. Zero and meaningless unless `decoding` is `decoded`.
	 */
	instruction_count: number;
	/**
	 * Number of strings located.
	 */
	string_count: number;
	/**
	 * Ranges of the analysed space that were never read, and which no count above therefore covers.
	 *
	 * The read stops at the first byte the provider will not serve, so this is one range running from that byte to the end of the space. Bytes past a hole go unanalysed even where a later read would have succeeded: nothing is fabricated to fill the hole, because decoding a zero-fill would manufacture instructions the sample does not contain.
	 */
	unreadable_ranges: IRangeWire[];
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
 * How much weight a resolution carries.
 */
export const enum ResolutionConfidenceWire {
	/**
	 * The operand names one slot and the import table names one symbol for it. There is nothing left to guess.
	 */
	Exact = 'exact',
	/**
	 * Derived from evidence that narrows the target without proving it.
	 *
	 * Nothing produces this yet. It exists so that the first resolution which *is* a narrowing — a vtable slot, a value recovered by dataflow — has a place to land, and so a caller switching on this enum today already handles the shape it will arrive in. Do not delete it as dead.
	 */
	Probable = 'probable',
}

/**
 * One import a call site or thunk resolves to.
 */
export interface IResolvedImportWire {
	/**
	 * How much weight the resolution carries.
	 */
	confidence: ResolutionConfidenceWire;
	/**
	 * RVA of the import address table slot the call indirects through.
	 */
	iat_rva: string;
	/**
	 * Which shape named this import.
	 */
	method: IndirectResolutionMethodWire;
	/**
	 * Module name as written in the import descriptor, e.g. "KERNEL32.dll".
	 */
	module: string;
	/**
	 * Ordinal, present for an import by ordinal.
	 */
	ordinal?: number;
	/**
	 * Symbol name, absent for an import by ordinal.
	 */
	symbol?: string;
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
 * Parameters for `analysis/scanStrings`.
 *
 * The resumable counterpart to `analysis/strings`. That one serves the list retained when the image was analysed, which stops at the scanner's cap — a bound nine of the thirty-five largest binaries in a stock `System32` reach, `mshtml.dll` and a 228 MB `MRT.exe` among them. Everything past it used to be unreachable by any call. This re-scans a bounded window instead, so the cap bounds one *response* rather than the image.
 */
export interface IScanStringsParams {
	/**
	 * Address to resume from. Zero starts at the beginning of the image.
	 */
	from_rva?: string;
	/**
	 * Image handle.
	 */
	image_id: string;
	/**
	 * Maximum strings returned. Zero requests the server's own cap.
	 */
	max_strings?: number;
}

/**
 * Response payload for `analysis/scanStrings`.
 */
export interface IScanStringsResult {
	/**
	 * Address a continuation resumes at.
	 *
	 * Absent when the scan reached the end of the image rather than its bound, which is the only thing that makes an empty result a claim about the image rather than about the window.
	 */
	next_rva?: string;
	/**
	 * Strings found in this window, in ascending address order.
	 */
	strings: IStringWire[];
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
 * Parameters for `analysis/setCorrections`.
 *
 * Re-derives every fact for an open image against a new correction set. This exists because corrections arrive mid-session — a human accepts a proposal — and the alternative, closing and reopening the image, would discard the provider connection and every cached listing row with it.
 */
export interface ISetCorrectionsParams {
	/**
	 * The complete correction set, replacing whatever was in effect.
	 */
	corrections?: IFunctionCorrectionWire[];
	/**
	 * Image handle.
	 */
	image_id: string;
}

/**
 * Response payload for `analysis/setCorrections`.
 *
 * The before and after counts are the disclosure S5 requires: an analyst approving a correction has to be able to see its exact effect, and "one more function than a moment ago" is that effect stated in the only terms the server can state it.
 */
export interface ISetCorrectionsResult {
	/**
	 * Corrections now in effect.
	 */
	corrections_applied: number;
	/**
	 * Detected functions now.
	 */
	function_count: number;
	/**
	 * Detected functions before the new set was applied.
	 */
	function_count_before: number;
	/**
	 * Image handle the corrections were applied to.
	 */
	image_id: string;
	/**
	 * Decoded instructions now.
	 */
	instruction_count: number;
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
 *
 * Two independent bounds, reported separately because only one of them can be worked around by asking again: `truncated` is the scanner's cap, applied once when the image was analysed, and `list_truncated` is this response's own bound.
 */
export interface IStringsResult {
	/**
	 * Whether strings were omitted because of the response bound.
	 */
	list_truncated: boolean;
	/**
	 * Strings located in the image.
	 */
	strings: IStringWire[];
	/**
	 * Strings the scan retained, before this response's own bound was applied.
	 */
	total: number;
	/**
	 * Whether the scan hit its cap and dropped results.
	 *
	 * The cap stops a hostile file turning string extraction into an allocation attack, but a truncated list that does not say so is worse than none: a client cannot otherwise tell a complete answer from a partial one, and would present a partial one as complete.
	 */
	truncated: boolean;
}

/**
 * Windows subsystem an image declares, on the wire.
 *
 * Tagged rather than a bare string, so an unrecognized value arrives as `other` carrying the number it actually held. A client deciding what the user entry point should look like has to be able to tell "this is a console program" from "this is something neither side was taught about"; collapsing the second into a named variant would erase exactly that difference.
 */
export type ISubsystemWire =
	/**
	 * `IMAGE_SUBSYSTEM_WINDOWS_CUI` — entered through `main` or `wmain`.
	 */
	| {
		kind: 'console';
	}
	/**
	 * `IMAGE_SUBSYSTEM_WINDOWS_GUI` — entered through `WinMain` or `wWinMain`.
	 */
	| {
		kind: 'gui';
	}
	/**
	 * A native or driver image, with no C runtime entry of either family.
	 */
	| {
		kind: 'native';
	}
	/**
	 * Anything else, carrying the declared value rather than a guess.
	 */
	| {
		kind: 'other';
		/**
		 * The raw optional-header value.
		 */
		value: number;
	};

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
	 * Callbacks present before the cap was applied.
	 */
	callback_total: number;
	/**
	 * TLS callback RVAs, in loader invocation order.
	 */
	callbacks: string[];
	/**
	 * The directory names a callback array that could not be read, so `callbacks` is empty for a reason that is not "this image has no TLS callbacks". Callbacks run before the entry point.
	 */
	callbacks_failed: boolean;
	/**
	 * Whether callbacks were dropped at the callback cap.
	 */
	callbacks_truncated: boolean;
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
	 *
	 * A header field, so it is whatever the sample says it is — up to `u64::MAX` — and a JSON number would truncate it above 2^53 without erroring (ADR 0001).
	 */
	raw_data_size: string;
}

/**
 * Parameters for `analysis/xrefIndex`.
 *
 * The whole-table export, as distinct from [`XrefsParams`], which answers one address. It exists so a project can *retain* the xref table: a `.delverdb` opened without its sample still has to answer "who references this", and walking every address to rebuild the table from per-address queries would be millions of round trips for a table the server already holds in one piece.
 */
export interface IXrefIndexParams {
	/**
	 * Image handle.
	 */
	image_id: string;
	/**
	 * Maximum references returned. Zero — or an omitted field — requests the server's own cap.
	 */
	max_xrefs?: number;
	/**
	 * Index of the first reference to return, in the table's source ordering.
	 *
	 * A plain offset rather than an opaque cursor: the table is built once when the image is analysed and never mutated, so an index into it is stable for the life of the handle. A caller that closes the image and reopens it starts the walk again.
	 */
	start?: number;
}

/**
 * Response payload for `analysis/xrefIndex`.
 *
 * `next_start` is the completeness signal. A caller retaining the table must be able to tell "this is the end" from "this page was bounded", because a partial table stored as if it were whole is a source of exactly the false negative — a confident `total: 0` — that the per-address query already has to avoid.
 */
export interface IXrefIndexResult {
	/**
	 * Index to pass as the next `start`, absent once the walk is complete.
	 */
	next_start?: number;
	/**
	 * Total references in the table, independent of this page.
	 */
	total: number;
	/**
	 * References in the requested range, ordered by source address.
	 */
	xrefs: IXrefWire[];
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
	 * Maximum references returned. Zero — or an omitted field, which is how an older client asks — requests the server's own cap. A hot address in a large image has tens of thousands of references, and serialising all of them into one message kills the connection instead of answering.
	 */
	max_xrefs?: number;
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
	 * Matching references before the bound was applied.
	 */
	total: number;
	/**
	 * Whether references were omitted because of the bound.
	 */
	truncated: boolean;
	/**
	 * Matching references, in the order the xref table holds them.
	 */
	xrefs: IXrefWire[];
}
