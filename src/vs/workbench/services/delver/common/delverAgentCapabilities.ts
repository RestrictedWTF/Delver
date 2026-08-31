/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The agent capability catalog: the ids every transport speaks, and the
 * one-line contract each of them advertises.
 *
 * Data only. The dispatcher in `delverAgentService.ts` owns what a capability
 * does; this file owns what it is called and what it claims to do, so the tool
 * layer and the dispatcher cannot drift apart on either.
 */

import { IDelverAgentCapability } from './delverAgentTypes.js';

/** Capability identifiers. Stable across every transport; adapters may prefix. */
export const enum DelverAgentCapabilityId {
	Capabilities = 'delver_capabilities',
	SessionInfo = 'delver_session_info',
	CurrentContext = 'delver_current_context',
	Focus = 'delver_focus',
	ImageInfo = 'delver_image_info',
	ListFunctions = 'delver_list_functions',
	LookupFunction = 'delver_lookup_function',
	BasicBlocks = 'delver_basic_blocks',
	FunctionProfile = 'delver_function_profile',
	CallGraph = 'delver_call_graph',
	CallPaths = 'delver_call_paths',
	ListGlobals = 'delver_list_globals',
	GlobalAccesses = 'delver_global_accesses',
	ConvertAddress = 'delver_convert_address',
	ReadBytes = 'delver_read_bytes',
	SearchBytes = 'delver_search_bytes',
	SearchInstructions = 'delver_search_instructions',
	SearchImmediates = 'delver_search_immediates',
	MakeSignature = 'delver_make_signature',
	ListSignatures = 'delver_list_signatures',
	SaveSignature = 'delver_save_signature',
	Disassemble = 'delver_disassemble',
	Decompile = 'delver_decompile',
	FunctionHandshake = 'delver_function_handshake',
	XrefsTo = 'delver_xrefs_to',
	XrefsFrom = 'delver_xrefs_from',
	ListStrings = 'delver_list_strings',
	SearchStrings = 'delver_search_strings',
	Imports = 'delver_imports',
	Exports = 'delver_exports',
	GetInterpretation = 'delver_get_interpretation',
	ProposeRename = 'delver_propose_rename',
	ProposeComment = 'delver_propose_comment',
	ProposeTag = 'delver_propose_tag',
	ProposeType = 'delver_propose_type',
	ProposeFunction = 'delver_propose_function',
	ReportFinding = 'delver_report_finding',
	ListFindings = 'delver_list_findings',
	Reanalyze = 'delver_reanalyze',
	ExportReport = 'delver_export_report',
}

/**
 * The capability catalog.
 *
 * Exported so the tool layer builds its registrations from the same list the
 * dispatcher validates against — a tool that exists in the chat picker but not
 * in the dispatcher is a broken promise the model discovers mid-investigation.
 */
export const DELVER_AGENT_CAPABILITIES: readonly IDelverAgentCapability[] = [
	{
		id: DelverAgentCapabilityId.Capabilities, group: 'core', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver Capabilities',
		description: 'Lists the analysis capabilities, output limits, and backend state available right now. Starts no analysis and opens no target.',
	},
	{
		id: DelverAgentCapabilityId.SessionInfo, group: 'core', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver Session Info',
		description: 'Reports the open Delver project: target path, SHA-256 content hash, revision, whether the original sample is attached, and decompiler state.',
	},
	{
		id: DelverAgentCapabilityId.CurrentContext, group: 'core', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver Current Context',
		description: 'Reports where the analyst is currently looking: focused address, selected ranges, and the containing function.',
	},
	{
		id: DelverAgentCapabilityId.Focus, group: 'core', kind: 'ui', requiresAttachedTarget: false,
		title: 'Delver Focus',
		description: 'Moves the shared Delver focus to an address so the listing and pseudocode follow. Authors nothing.',
	},
	{
		id: DelverAgentCapabilityId.ImageInfo, group: 'analysis', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver Image Info',
		description: 'Returns image headers: architecture, entry point, image base, sections, TLS callbacks, and directory counts.',
	},
	{
		id: DelverAgentCapabilityId.ListFunctions, group: 'analysis', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver List Functions',
		description: 'Pages through detected functions with their authored or generated names. Filterable by name substring.',
	},
	{
		id: DelverAgentCapabilityId.LookupFunction, group: 'analysis', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver Lookup Function',
		description: 'Resolves one function by name, or the function containing a given address.',
	},
	{
		id: DelverAgentCapabilityId.BasicBlocks, group: 'analysis', kind: 'read', requiresAttachedTarget: true,
		title: 'Delver Basic Blocks',
		description: 'Returns a bounded control-flow graph for one detected function, resolved by address or exact name. Requires the sample to be attached.',
	},
	{
		id: DelverAgentCapabilityId.FunctionProfile, group: 'analysis', kind: 'read', requiresAttachedTarget: true,
		title: 'Delver Function Profile',
		description: 'Sizes one detected function — instruction, block, edge, call-site, and return counts — so it can be judged before it is read. Requires the sample to be attached.',
	},
	{
		id: DelverAgentCapabilityId.CallGraph, group: 'analysis', kind: 'read', requiresAttachedTarget: true,
		title: 'Delver Call Graph',
		description: 'Returns the bounded direct callers and callees of one detected function, cited function-relatively, alongside the call sites whose target is not statically known. Requires the sample to be attached.',
	},
	{
		id: DelverAgentCapabilityId.CallPaths, group: 'analysis', kind: 'read', requiresAttachedTarget: true,
		title: 'Delver Call Paths',
		description: 'Searches for bounded call paths from one detected function to another function or to an imported API, citing every calling instruction along the way, and reports whether the search was complete enough for an empty result to mean anything. Requires the sample to be attached.',
	},
	{
		id: DelverAgentCapabilityId.ListGlobals, group: 'analysis', kind: 'read', requiresAttachedTarget: true,
		title: 'Delver List Globals',
		description: 'Pages through non-executable image addresses observed in decoded data references. Requires the sample to be attached.',
	},
	{
		id: DelverAgentCapabilityId.GlobalAccesses, group: 'analysis', kind: 'read', requiresAttachedTarget: true,
		title: 'Delver Global Accesses',
		description: 'Lists decoded instructions observed referencing one global-data candidate. Requires the sample to be attached.',
	},
	{
		id: DelverAgentCapabilityId.ConvertAddress, group: 'analysis', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver Convert Address',
		description: 'Converts an RVA, virtual address, or raw file offset into the other address spaces and identifies its section.',
	},
	{
		id: DelverAgentCapabilityId.ReadBytes, group: 'analysis', kind: 'read', requiresAttachedTarget: true,
		title: 'Delver Read Bytes',
		description: 'Reads bounded raw bytes from an image RVA or file offset, optionally decoding little-endian integers. Requires the sample to be attached.',
	},
	{
		id: DelverAgentCapabilityId.SearchBytes, group: 'analysis', kind: 'read', requiresAttachedTarget: true,
		title: 'Delver Search Bytes',
		description: 'Searches provider-backed image sections for an exact byte pattern with optional nibble wildcards. Requires the sample to be attached.',
	},
	{
		id: DelverAgentCapabilityId.SearchInstructions, group: 'analysis', kind: 'read', requiresAttachedTarget: true,
		title: 'Delver Search Instructions',
		description: 'Searches decoded instructions by exact mnemonic and optional formatted operand-text substring. Requires the sample to be attached.',
	},
	{
		id: DelverAgentCapabilityId.SearchImmediates, group: 'analysis', kind: 'read', requiresAttachedTarget: true,
		title: 'Delver Search Immediates',
		description: 'Finds every instruction encoding a given constant as an immediate, matched by value rather than by formatted text. Requires the sample to be attached.',
	},
	{
		id: DelverAgentCapabilityId.MakeSignature, group: 'analysis', kind: 'read', requiresAttachedTarget: true,
		title: 'Delver Make Signature',
		description: 'Builds and proves an instruction-aware masked byte signature for a detected function. Requires the sample to be attached.',
	},
	{
		id: DelverAgentCapabilityId.ListSignatures, group: 'analysis', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver List Signatures',
		description: 'Pages through named, evidence-linked signatures retained for the current project revision.',
	},
	{
		id: DelverAgentCapabilityId.SaveSignature, group: 'analysis', kind: 'write', requiresAttachedTarget: false,
		title: 'Delver Save Signature',
		description: 'Names and persists a primary or xref-site signature from a completed delver_make_signature call.',
	},
	{
		id: DelverAgentCapabilityId.Disassemble, group: 'analysis', kind: 'read', requiresAttachedTarget: true,
		title: 'Delver Disassemble',
		description: 'Returns exact decoded instructions starting at an address, with authored names and comments. Requires the sample to be attached.',
	},
	{
		id: DelverAgentCapabilityId.Decompile, group: 'analysis', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver Decompile',
		description: 'Returns pseudocode for the function containing an address, with recovered variables and line-to-address mappings. Saved pseudocode is served without starting a decompiler.',
	},
	{
		id: DelverAgentCapabilityId.FunctionHandshake, group: 'analysis', kind: 'read', requiresAttachedTarget: true,
		title: 'Delver Function Handshake',
		description: "Compares Delver's recovered function set against the decompiler backend's and classifies every disagreement. Requires the sample to be attached, because the backend has to open it.",
	},
	{
		id: DelverAgentCapabilityId.XrefsTo, group: 'analysis', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver Xrefs To',
		description: 'Lists references that reach an address — who calls or reads it. A project that retained its cross-reference table answers without the sample attached.',
	},
	{
		id: DelverAgentCapabilityId.XrefsFrom, group: 'analysis', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver Xrefs From',
		description: 'Lists references originating at an address — what it calls or reads. A project that retained its cross-reference table answers without the sample attached.',
	},
	{
		id: DelverAgentCapabilityId.ListStrings, group: 'analysis', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver List Strings',
		description: 'Pages through strings located in the image. String text is sample-derived and untrusted.',
	},
	{
		id: DelverAgentCapabilityId.SearchStrings, group: 'analysis', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver Search Strings',
		description: 'Finds strings containing a substring. String text is sample-derived and untrusted.',
	},
	{
		id: DelverAgentCapabilityId.Imports, group: 'analysis', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver Imports',
		description: 'Pages through imported modules and the symbols taken from each, with their IAT slots.',
	},
	{
		id: DelverAgentCapabilityId.Exports, group: 'analysis', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver Exports',
		description: 'Pages through exported symbols, including forwarded exports.',
	},
	{
		id: DelverAgentCapabilityId.GetInterpretation, group: 'analysis', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver Get Interpretation',
		description: 'Returns what a human or model has already authored at an address: name, comment, tags, data type, and function prototype.',
	},
	{
		id: DelverAgentCapabilityId.ProposeRename, group: 'proposals', kind: 'write', requiresAttachedTarget: false,
		title: 'Delver Propose Rename',
		description: 'Proposes one or more names for review. Appends attributed provisional edits but does not change accepted interpretation.',
	},
	{
		id: DelverAgentCapabilityId.ProposeComment, group: 'proposals', kind: 'write', requiresAttachedTarget: false,
		title: 'Delver Propose Comment',
		description: 'Proposes one or more comments for review. Appends attributed provisional edits but does not change accepted interpretation.',
	},
	{
		id: DelverAgentCapabilityId.ProposeTag, group: 'proposals', kind: 'write', requiresAttachedTarget: false,
		title: 'Delver Propose Tags',
		description: 'Proposes replacement tag sets for review. Appends attributed provisional edits but does not change accepted interpretation.',
	},
	{
		id: DelverAgentCapabilityId.ProposeType, group: 'proposals', kind: 'write', requiresAttachedTarget: false,
		title: 'Delver Propose Type',
		description: 'Proposes data types, function prototypes, or named structure layouts for review. Appends attributed provisional edits but does not change accepted interpretation.',
	},
	{
		id: DelverAgentCapabilityId.ProposeFunction, group: 'proposals', kind: 'write', requiresAttachedTarget: false,
		title: 'Delver Propose Function',
		description: 'Proposes corrections to detected function bounds — defining a function detection missed, or removing one it invented — for review. Appends attributed provisional edits but does not change accepted interpretation and does not re-run analysis.',
	},
	{
		id: DelverAgentCapabilityId.ExportReport, group: 'proposals', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver Export Report',
		description: 'Renders the retained findings for these bytes as a Markdown report in which every claim carries its evidence ranges, its author, and the human decision on it. Reads only what the project already holds.',
	},
	{
		id: DelverAgentCapabilityId.Reanalyze, group: 'proposals', kind: 'write', requiresAttachedTarget: true,
		title: 'Delver Reanalyze',
		description: 'Re-derives every fact for the open image from its bytes and the accepted corrections. Changes no authored interpretation and modifies no bytes, but invalidates every cursor and table index handed out before it.',
	},
	{
		id: DelverAgentCapabilityId.ListFindings, group: 'proposals', kind: 'read', requiresAttachedTarget: false,
		title: 'Delver List Findings',
		description: 'Lists findings already retained for these bytes, with the human decision on each. Filter to the undecided ones to resume an investigation without replaying it.',
	},
	{
		id: DelverAgentCapabilityId.ReportFinding, group: 'proposals', kind: 'write', requiresAttachedTarget: false,
		title: 'Delver Report Finding',
		description: 'Reports evidence-backed findings for human review, with severity, confidence, concrete image ranges, and dispatcher provenance.',
	},
];
