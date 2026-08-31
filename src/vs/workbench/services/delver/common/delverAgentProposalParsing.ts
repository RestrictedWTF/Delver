/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Validation for everything an agent proposes: renames, comments, tags, types,
 * function-bound corrections, and findings.
 *
 * These run before the handler appends the first provisional edit, so a batch
 * is accepted or rejected whole. A half-applied proposal set is an authored
 * record no one asked for, and the log is append-only — it cannot be taken back.
 */

import { DELVER_FINDING_LIMITS, DelverFindingSeverity, IDelverFindingEvidence } from '../../../../platform/delver/common/findings.js';
import { Anchor, EditOp, EditValue, IAuthor } from '../../../../platform/delver/common/interpretation.js';
import {
	DELVER_AGENT_LIMITS,
	DelverAgentError,
	DelverAgentErrorCode,
	IDelverAgentCaller,
	parseOptionalWireAddress,
	parseWireAddress,
	toWireAddress,
} from './delverAgentTypes.js';

export interface IParsedProposal {
	readonly rva: bigint;
	readonly value: EditValue;
}

/**
 * One parsed type proposal.
 *
 * A union rather than one shape with optional fields, because a composite has
 * no address and the two kinds are validated against entirely different things
 * — a mapped data section versus a name that is free in the image.
 */
export type IParsedTypeProposal =
	| {
		readonly op: EditOp.DataType | EditOp.FunctionPrototype;
		readonly rva: bigint;
		readonly declaration: string;
	}
	| {
		readonly op: EditOp.CompositeType;
		readonly name: string;
		/** Canonical JSON, so one layout always yields one snapshot digest. */
		readonly declaration: string;
	};

/**
 * One parsed correction to the function seed set.
 *
 * `value` is the canonical JSON the log stores, built here rather than at the
 * append so the whole batch is validated and canonicalized before anything is
 * written. Two spellings of one correction must produce one string, because a
 * correction set is compared.
 */
export interface IParsedFunctionProposal {
	readonly rva: bigint;
	readonly kind: 'define' | 'undefine' | 'data';
	readonly value: string;
}

export interface IParsedFinding {
	readonly title: string;
	readonly description: string;
	readonly severity: DelverFindingSeverity;
	readonly confidence: number;
	readonly evidence: readonly IDelverFindingEvidence[];
}

/**
 * How a proposal names what it is about, in the caller's own terms.
 *
 * A composite has no address — reporting `0x0` would be a claim the caller can
 * act on and go and look at. The two fields are mutually exclusive so a caller
 * cannot read one when the other is meant.
 */
export function proposalSubject(anchor: Anchor): { readonly address: string } | { readonly typeName: string } {
	return anchor.kind === 'type' ? { typeName: anchor.name } : { address: toWireAddress(anchor.rva) };
}

/** A C identifier, which is what a composite and each of its fields must be. */
const TYPE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function proposalAuthor(caller: IDelverAgentCaller | undefined): IAuthor {
	if (caller?.kind !== 'model' || caller.id.trim().length === 0 || caller.id.length > 256) {
		throw proposalArgument('Proposal capabilities require an attributed model caller with an id no longer than 256 characters.');
	}
	return { kind: 'model', id: caller.id.trim() };
}

/** Parses every item before the handler appends the first provisional edit. */
export function parseProposals(value: unknown, op: EditOp): readonly IParsedProposal[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > DELVER_AGENT_LIMITS.proposals.max) {
		throw proposalArgument(`proposals must contain between 1 and ${DELVER_AGENT_LIMITS.proposals.max} items.`);
	}

	const parsed = value.map((item, index) => parseProposal(item, index, op));
	const anchors = new Set<string>();
	for (const proposal of parsed) {
		const key = proposal.rva.toString(16);
		if (anchors.has(key)) {
			throw proposalArgument(`proposals contains the same address more than once: ${toWireAddress(proposal.rva)}.`);
		}
		anchors.add(key);
	}
	return parsed;
}

function parseProposal(value: unknown, index: number, op: EditOp): IParsedProposal {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw proposalArgument(`proposals[${index}] must be an object.`);
	}
	const item = value as Readonly<Record<string, unknown>>;
	const valueKey = op === EditOp.Rename ? 'name' : op === EditOp.Comment ? 'comment' : 'tags';
	const unknownKeys = Object.keys(item).filter(key => key !== 'address' && key !== valueKey);
	if (unknownKeys.length > 0) {
		throw proposalArgument(`proposals[${index}] has unknown field "${unknownKeys[0]}".`);
	}

	const rva = parseWireAddress(item.address);
	if (op === EditOp.Tags) {
		return { rva, value: parseProposalTags(item.tags, index) };
	}

	const raw = item[valueKey];
	if (typeof raw !== 'string') {
		throw proposalArgument(`proposals[${index}].${valueKey} must be a string.`);
	}
	const normalized = raw.trim();
	const max = op === EditOp.Rename
		? DELVER_AGENT_LIMITS.proposals.renameCharacters
		: DELVER_AGENT_LIMITS.proposals.commentCharacters;
	if (normalized.length > max) {
		throw proposalArgument(`proposals[${index}].${valueKey} must not exceed ${max} characters.`);
	}
	return { rva, value: normalized };
}

function parseProposalTags(value: unknown, index: number): readonly string[] {
	if (!Array.isArray(value) || value.length > DELVER_AGENT_LIMITS.proposals.tagsPerAddress) {
		throw proposalArgument(`proposals[${index}].tags must be an array of at most ${DELVER_AGENT_LIMITS.proposals.tagsPerAddress} strings.`);
	}
	const tags = value.map((tag, tagIndex) => {
		if (typeof tag !== 'string') {
			throw proposalArgument(`proposals[${index}].tags[${tagIndex}] must be a string.`);
		}
		const normalized = tag.trim();
		if (normalized.length > DELVER_AGENT_LIMITS.proposals.tagCharacters) {
			throw proposalArgument(`proposals[${index}].tags[${tagIndex}] must not exceed ${DELVER_AGENT_LIMITS.proposals.tagCharacters} characters.`);
		}
		return normalized;
	}).filter(tag => tag.length > 0);
	const canonical = [...new Set(tags)];
	canonical.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
	return canonical;
}

export function parseTypeProposals(value: unknown): readonly IParsedTypeProposal[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > DELVER_AGENT_LIMITS.proposals.max) {
		throw proposalArgument(`proposals must contain between 1 and ${DELVER_AGENT_LIMITS.proposals.max} items.`);
	}
	const proposals = value.map((candidate, index) => {
		if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
			throw proposalArgument(`proposals[${index}] must be an object.`);
		}
		const item = candidate as Readonly<Record<string, unknown>>;
		if (item.target === 'composite') {
			return parseCompositeProposal(item, index);
		}
		const unknownKeys = Object.keys(item).filter(key => key !== 'address' && key !== 'target' && key !== 'declaration');
		if (unknownKeys.length > 0) {
			throw proposalArgument(`proposals[${index}] has unknown field "${unknownKeys[0]}".`);
		}
		if (item.target !== 'data' && item.target !== 'function') {
			throw proposalArgument(`proposals[${index}].target must be "data", "function", or "composite".`);
		}
		if (typeof item.declaration !== 'string') {
			throw proposalArgument(`proposals[${index}].declaration must be a string.`);
		}
		const declaration = item.declaration.trim();
		if (declaration.length > DELVER_AGENT_LIMITS.proposals.declarationCharacters) {
			throw proposalArgument(`proposals[${index}].declaration must not exceed ${DELVER_AGENT_LIMITS.proposals.declarationCharacters} characters.`);
		}
		return {
			rva: parseWireAddress(item.address),
			op: item.target === 'data' ? EditOp.DataType : EditOp.FunctionPrototype,
			declaration,
		} satisfies IParsedTypeProposal;
	});

	const anchors = new Set<string>();
	for (const proposal of proposals) {
		const key = proposal.op === EditOp.CompositeType
			? `${proposal.op}:${proposal.name}`
			: `${proposal.op}:${proposal.rva.toString(16)}`;
		if (anchors.has(key)) {
			throw proposalArgument(proposal.op === EditOp.CompositeType
				? `proposals contains the composite "${proposal.name}" more than once.`
				: `proposals contains the same ${proposal.op} address more than once: ${toWireAddress(proposal.rva)}.`);
		}
		anchors.add(key);
	}
	return proposals;
}

/**
 * Parses one composite layout into the canonical JSON the log stores.
 *
 * Canonical because the stored string *is* the identity: ADR 0013 digests the
 * snapshot to key the decompilation cache, so two spellings of one layout must
 * not read as two different type models and re-decompile the whole image.
 *
 * Offsets are required rather than inferred. A real binary's padding is
 * something the analyst knows, and a layout the tool packed itself would be a
 * different structure wearing the name they gave this one.
 */
/**
 * Parses one proposed enum: named constants of a fixed width.
 *
 * Members are canonicalized into ascending name order here rather than demanded
 * of the caller, the same way struct fields are sorted by offset — declaration
 * order is a detail of the encoding, and the snapshot needs one canonical form
 * so its digest is stable. Duplicate *values* are kept: an alias for an existing
 * constant is something real headers do.
 */
function parseEnumProposal(item: Readonly<Record<string, unknown>>, index: number, name: string, size: number): IParsedTypeProposal {
	// Restricted to what a JSON number carries exactly. An 8-byte constant would
	// truncate above 2^53 (ADR 0001), and a truncated constant turns a
	// comparison against it into a different comparison.
	if (size !== 1 && size !== 2 && size !== 4) {
		throw proposalArgument(`proposals[${index}].size must be 1, 2 or 4 bytes for an enum.`);
	}
	if (item.fields !== undefined) {
		throw proposalArgument(`proposals[${index}] declares fields, but an enum carries members.`);
	}
	if (!Array.isArray(item.members) || item.members.length > DELVER_AGENT_LIMITS.proposals.compositeFields) {
		throw proposalArgument(`proposals[${index}].members must be an array of at most ${DELVER_AGENT_LIMITS.proposals.compositeFields} constants.`);
	}
	const limit = 2 ** (size * 8);
	const members = item.members.map((candidate, memberIndex) => {
		const path = `proposals[${index}].members[${memberIndex}]`;
		if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
			throw proposalArgument(`${path} must be an object.`);
		}
		const member = candidate as Readonly<Record<string, unknown>>;
		const unknownMemberKeys = Object.keys(member).filter(key => key !== 'name' && key !== 'value');
		if (unknownMemberKeys.length > 0) {
			throw proposalArgument(`${path} has unknown field "${unknownMemberKeys[0]}".`);
		}
		const memberName = typeof member.name === 'string' ? member.name.trim() : '';
		if (!TYPE_NAME_PATTERN.test(memberName) || memberName.length > DELVER_AGENT_LIMITS.proposals.renameCharacters) {
			throw proposalArgument(`${path}.name must be a C identifier.`);
		}
		if (typeof member.value !== 'number' || !Number.isSafeInteger(member.value)) {
			throw proposalArgument(`${path}.value must be an integer.`);
		}
		// Either signedness: -1 and 0xFFFFFFFF are the same bits, and headers
		// write both.
		if (member.value >= limit || member.value < -(limit / 2)) {
			throw proposalArgument(`${path}.value does not fit in the declared ${size} bytes.`);
		}
		return { name: memberName, value: member.value };
	});
	members.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	for (let member = 1; member < members.length; member++) {
		if (members[member - 1].name === members[member].name) {
			throw proposalArgument(`proposals[${index}].members declares the constant "${members[member].name}" twice.`);
		}
	}
	return {
		op: EditOp.CompositeType,
		name,
		declaration: JSON.stringify({ kind: 'enum', size, members }),
	};
}

function parseCompositeProposal(item: Readonly<Record<string, unknown>>, index: number): IParsedTypeProposal {
	const unknownKeys = Object.keys(item).filter(key => key !== 'target' && key !== 'name' && key !== 'size' && key !== 'fields' && key !== 'members' && key !== 'composite');
	if (unknownKeys.length > 0) {
		throw proposalArgument(`proposals[${index}] has unknown field "${unknownKeys[0]}".`);
	}
	// Absent means struct, because that is what every caller written before
	// unions existed meant. An unrecognized value is refused rather than
	// defaulted: laying a union out as a struct would give the analyst storage
	// they never described.
	const composite = item.composite === undefined ? 'struct' : item.composite;
	if (composite !== 'struct' && composite !== 'union' && composite !== 'enum') {
		throw proposalArgument(`proposals[${index}].composite must be "struct", "union" or "enum".`);
	}
	const name = typeof item.name === 'string' ? item.name.trim() : '';
	if (!TYPE_NAME_PATTERN.test(name) || name.length > DELVER_AGENT_LIMITS.proposals.renameCharacters) {
		throw proposalArgument(`proposals[${index}].name must be a C identifier naming the composite.`);
	}
	const size = item.size;
	if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > DELVER_AGENT_LIMITS.proposals.compositeSizeBytes) {
		throw proposalArgument(`proposals[${index}].size must be the total size in bytes, at most ${DELVER_AGENT_LIMITS.proposals.compositeSizeBytes}.`);
	}
	if (composite === 'enum') {
		return parseEnumProposal(item, index, name, size);
	}
	// Accepting and ignoring `members` here would take a proposal whose author
	// plainly meant an enum and store it as an empty struct.
	if (item.members !== undefined) {
		throw proposalArgument(`proposals[${index}] declares members, but only an enum carries those.`);
	}
	if (!Array.isArray(item.fields) || item.fields.length > DELVER_AGENT_LIMITS.proposals.compositeFields) {
		throw proposalArgument(`proposals[${index}].fields must be an array of at most ${DELVER_AGENT_LIMITS.proposals.compositeFields} fields.`);
	}
	const fields = item.fields.map((candidate, fieldIndex) => {
		const path = `proposals[${index}].fields[${fieldIndex}]`;
		if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
			throw proposalArgument(`${path} must be an object.`);
		}
		const field = candidate as Readonly<Record<string, unknown>>;
		const unknownFieldKeys = Object.keys(field).filter(key => key !== 'offset' && key !== 'name' && key !== 'type');
		if (unknownFieldKeys.length > 0) {
			throw proposalArgument(`${path} has unknown field "${unknownFieldKeys[0]}".`);
		}
		if (typeof field.offset !== 'number' || !Number.isSafeInteger(field.offset) || field.offset < 0 || field.offset >= size) {
			throw proposalArgument(`${path}.offset must be a byte offset inside the composite.`);
		}
		if (composite === 'union' && field.offset !== 0) {
			throw proposalArgument(`${path}.offset must be 0: every member of a union begins at the start of it.`);
		}
		const fieldName = typeof field.name === 'string' ? field.name.trim() : '';
		if (!TYPE_NAME_PATTERN.test(fieldName) || fieldName.length > DELVER_AGENT_LIMITS.proposals.renameCharacters) {
			throw proposalArgument(`${path}.name must be a C identifier.`);
		}
		const type = typeof field.type === 'string' ? field.type.trim() : '';
		if (type.length === 0 || type.length > DELVER_AGENT_LIMITS.proposals.declarationCharacters) {
			throw proposalArgument(`${path}.type must be a non-empty type declaration.`);
		}
		return { offset: field.offset, name: fieldName, type };
	});
	// Sorted here rather than demanded of the caller: the order is a detail of
	// the encoding, and refusing a correct layout for arriving out of order
	// would be pedantry. Two fields at one offset is a real contradiction and
	// is refused.
	fields.sort((left, right) => left.offset - right.offset);
	// Two struct fields at one offset is a contradiction; in a union it is the
	// entire point, and every offset is already required to be 0 above.
	if (composite === 'struct') {
		for (let field = 1; field < fields.length; field++) {
			if (fields[field - 1].offset === fields[field].offset) {
				throw proposalArgument(`proposals[${index}].fields declares two fields at offset ${fields[field].offset}.`);
			}
		}
	}
	if (new Set(fields.map(field => field.name)).size !== fields.length) {
		throw proposalArgument(`proposals[${index}].fields declares the same field name twice.`);
	}
	return {
		op: EditOp.CompositeType,
		name,
		declaration: JSON.stringify({ kind: composite, size, fields }),
	};
}

/**
 * Parses a complete batch of function corrections before any is appended.
 *
 * `endAddress` is refused on an `undefine` rather than ignored. Silently
 * dropping it would accept a request whose author plainly meant something the
 * correction cannot express, and leave them believing a range was recorded.
 */
export function parseFunctionProposals(value: unknown): readonly IParsedFunctionProposal[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > DELVER_AGENT_LIMITS.proposals.max) {
		throw proposalArgument(`proposals must contain between 1 and ${DELVER_AGENT_LIMITS.proposals.max} items.`);
	}
	const proposals = value.map((candidate, index) => {
		if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
			throw proposalArgument(`proposals[${index}] must be an object.`);
		}
		const item = candidate as Readonly<Record<string, unknown>>;
		const unknownKeys = Object.keys(item).filter(key => key !== 'address' && key !== 'kind' && key !== 'endAddress');
		if (unknownKeys.length > 0) {
			throw proposalArgument(`proposals[${index}] has unknown field "${unknownKeys[0]}".`);
		}
		if (item.kind !== 'define' && item.kind !== 'undefine' && item.kind !== 'data') {
			throw proposalArgument(`proposals[${index}].kind must be "define", "undefine", or "data".`);
		}
		const rva = parseWireAddress(item.address);
		if (item.kind === 'data') {
			// The one kind whose end is mandatory. "Data starts here" with no end
			// has no reading that is safe to guess at: the excluded run would be
			// invented, and inventing it too large deletes real functions.
			if (item.endAddress === undefined) {
				throw proposalArgument(`proposals[${index}].endAddress is required for a "data" correction; an excluded range has to say where it ends.`);
			}
			const dataEnd = parseWireAddress(item.endAddress, 'end address');
			if (dataEnd <= rva) {
				throw proposalArgument(`proposals[${index}].endAddress must be greater than address; it is the exclusive end of the data range.`);
			}
			return { rva, kind: 'data', value: JSON.stringify({ kind: 'data', endRva: toWireAddress(dataEnd) }) } satisfies IParsedFunctionProposal;
		}
		if (item.kind === 'undefine') {
			if (item.endAddress !== undefined) {
				throw proposalArgument(`proposals[${index}].endAddress is meaningless for an "undefine" correction, which removes a function rather than sizing one.`);
			}
			return { rva, kind: 'undefine', value: JSON.stringify({ kind: 'undefine' }) } satisfies IParsedFunctionProposal;
		}
		if (item.endAddress === undefined) {
			return { rva, kind: 'define', value: JSON.stringify({ kind: 'define' }) } satisfies IParsedFunctionProposal;
		}
		const endRva = parseWireAddress(item.endAddress, 'end address');
		if (endRva <= rva) {
			throw proposalArgument(`proposals[${index}].endAddress must be greater than address; it is the exclusive end of the function.`);
		}
		// Re-emitted through `toWireAddress` so the stored value is canonical
		// whatever spelling the caller used to say the same address.
		return { rva, kind: 'define', value: JSON.stringify({ kind: 'define', endRva: toWireAddress(endRva) }) } satisfies IParsedFunctionProposal;
	});

	const addresses = new Set<string>();
	for (const proposal of proposals) {
		const key = proposal.rva.toString(16);
		if (addresses.has(key)) {
			throw proposalArgument(`proposals contains the same address more than once: ${toWireAddress(proposal.rva)}.`);
		}
		addresses.add(key);
	}
	return proposals;
}

export function parseFindings(value: unknown, contentHash: string): readonly IParsedFinding[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > DELVER_FINDING_LIMITS.batch) {
		throw proposalArgument(`findings must contain between 1 and ${DELVER_FINDING_LIMITS.batch} items.`);
	}
	return value.map((candidate, index) => {
		if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
			throw proposalArgument(`findings[${index}] must be an object.`);
		}
		const finding = candidate as Readonly<Record<string, unknown>>;
		const allowed = new Set(['title', 'description', 'severity', 'confidence', 'evidence']);
		const unknownKey = Object.keys(finding).find(key => !allowed.has(key));
		if (unknownKey !== undefined) {
			throw proposalArgument(`findings[${index}] has unknown field "${unknownKey}".`);
		}
		const severity = finding.severity;
		if (severity !== 'info' && severity !== 'suspicious' && severity !== 'malicious') {
			throw proposalArgument(`findings[${index}].severity must be "info", "suspicious", or "malicious".`);
		}
		if (typeof finding.confidence !== 'number' || !Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) {
			throw proposalArgument(`findings[${index}].confidence must be a number between 0 and 1.`);
		}
		return {
			title: findingText(finding.title, DELVER_FINDING_LIMITS.titleCharacters, `findings[${index}].title`),
			description: findingText(finding.description, DELVER_FINDING_LIMITS.descriptionCharacters, `findings[${index}].description`),
			severity,
			confidence: finding.confidence,
			evidence: parseFindingEvidence(finding.evidence, contentHash, index),
		};
	});
}

function parseFindingEvidence(value: unknown, contentHash: string, findingIndex: number): readonly IDelverFindingEvidence[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > DELVER_FINDING_LIMITS.evidencePerFinding) {
		throw proposalArgument(`findings[${findingIndex}].evidence must contain between 1 and ${DELVER_FINDING_LIMITS.evidencePerFinding} ranges.`);
	}
	const seen = new Set<string>();
	return value.map((candidate, evidenceIndex) => {
		if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
			throw proposalArgument(`findings[${findingIndex}].evidence[${evidenceIndex}] must be an object.`);
		}
		const evidence = candidate as Readonly<Record<string, unknown>>;
		const unknownKey = Object.keys(evidence).find(key => key !== 'address' && key !== 'endAddress' && key !== 'description' && key !== 'sourceCallIds');
		if (unknownKey !== undefined) {
			throw proposalArgument(`findings[${findingIndex}].evidence[${evidenceIndex}] has unknown field "${unknownKey}".`);
		}
		const rva = parseWireAddress(evidence.address);
		const endRva = parseOptionalWireAddress(evidence.endAddress);
		if (endRva !== undefined && endRva <= rva) {
			throw proposalArgument(`findings[${findingIndex}].evidence[${evidenceIndex}].endAddress must be greater than address.`);
		}
		const key = `${rva.toString(16)}:${endRva?.toString(16) ?? ''}`;
		if (seen.has(key)) {
			throw proposalArgument(`findings[${findingIndex}].evidence contains a duplicate range.`);
		}
		seen.add(key);
		return {
			kind: 'range' as const,
			anchor: { kind: 'image' as const, contentHash, rva },
			...(endRva === undefined ? {} : { endRva }),
			description: findingText(
				evidence.description,
				DELVER_FINDING_LIMITS.evidenceDescriptionCharacters,
				`findings[${findingIndex}].evidence[${evidenceIndex}].description`,
			),
			sourceCallIds: findingSourceCallIds(evidence.sourceCallIds, findingIndex, evidenceIndex),
		};
	});
}

function findingSourceCallIds(value: unknown, findingIndex: number, evidenceIndex: number): readonly string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > DELVER_FINDING_LIMITS.sourceCallsPerEvidence) {
		throw proposalArgument(`findings[${findingIndex}].evidence[${evidenceIndex}].sourceCallIds must contain at most ${DELVER_FINDING_LIMITS.sourceCallsPerEvidence} call ids.`);
	}
	const sourceCallIds = value.map((candidate, sourceIndex) => findingText(
		candidate,
		128,
		`findings[${findingIndex}].evidence[${evidenceIndex}].sourceCallIds[${sourceIndex}]`,
	));
	if (new Set(sourceCallIds).size !== sourceCallIds.length) {
		throw proposalArgument(`findings[${findingIndex}].evidence[${evidenceIndex}].sourceCallIds must not contain duplicates.`);
	}
	return sourceCallIds;
}

function findingText(value: unknown, maxLength: number, path: string): string {
	if (typeof value !== 'string') {
		throw proposalArgument(`${path} must be a string.`);
	}
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.length > maxLength) {
		throw proposalArgument(`${path} must contain between 1 and ${maxLength} characters.`);
	}
	return normalized;
}

export function proposalArgument(message: string): DelverAgentError {
	return new DelverAgentError(DelverAgentErrorCode.InvalidArgument, message);
}
