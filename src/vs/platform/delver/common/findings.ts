/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAuthor, IImageAnchor } from './interpretation.js';

export type DelverFindingSeverity = 'info' | 'suspicious' | 'malicious';
export type DelverFindingStatus = 'proposed' | 'accepted' | 'rejected';
export type DelverFindingOutcome = Exclude<DelverFindingStatus, 'proposed'>;

export const DELVER_FINDING_LIMITS = {
	batch: 50,
	titleCharacters: 256,
	descriptionCharacters: 16 * 1024,
	evidencePerFinding: 64,
	evidenceDescriptionCharacters: 1024,
	sourceCallsPerEvidence: 16,
} as const;

/**
 * One concrete image range that supports a finding. `endRva` is exclusive.
 *
 * The anchor names a place, deliberately: a finding is a claim about bytes, and
 * there is nothing to cite in a range that has no address. This matches what
 * `IDelverFindingAnchorWire` has always required.
 */
export interface IDelverFindingEvidence {
	readonly kind: 'range';
	readonly anchor: IImageAnchor;
	readonly endRva?: bigint;
	readonly description: string;
	/** Earlier successful dispatcher calls whose results support this range. */
	readonly sourceCallIds?: readonly string[];
}

/** The dispatcher call that authored a finding, distinct from its evidence. */
export interface IDelverFindingProvenance {
	readonly capability: string;
	readonly callId: string;
}

/** Append-only human decision over a provisional finding. */
export interface IDelverFindingDecision {
	readonly id: string;
	readonly findingId: string;
	readonly contentHash: string;
	readonly at: number;
	readonly author: IAuthor;
	readonly outcome: DelverFindingOutcome;
}

/** Durable investigation output. Model-authored findings begin as proposed. */
export interface IDelverFinding {
	readonly id: string;
	readonly at: number;
	readonly author: IAuthor;
	readonly title: string;
	readonly description: string;
	readonly severity: DelverFindingSeverity;
	readonly confidence: number;
	readonly status: DelverFindingStatus;
	readonly anchors: readonly IImageAnchor[];
	readonly evidence: readonly IDelverFindingEvidence[];
	readonly provenance: IDelverFindingProvenance;
}

export interface IDelverFindingDraft {
	readonly author: IAuthor;
	readonly title: string;
	readonly description: string;
	readonly severity: DelverFindingSeverity;
	readonly confidence: number;
	readonly status: DelverFindingStatus;
	readonly evidence: readonly IDelverFindingEvidence[];
	readonly provenance: IDelverFindingProvenance;
}

export interface IDelverFindingAnchorWire {
	readonly kind: 'image';
	readonly contentHash: string;
	readonly rva: string;
}

export interface IDelverFindingEvidenceWire {
	readonly kind: 'range';
	readonly anchor: IDelverFindingAnchorWire;
	readonly endRva?: string;
	readonly description: string;
	readonly sourceCallIds?: readonly string[];
}

export interface IDelverFindingWire {
	readonly id: string;
	readonly at: number;
	readonly author: IAuthor;
	readonly title: string;
	readonly description: string;
	readonly severity: DelverFindingSeverity;
	readonly confidence: number;
	readonly status: DelverFindingStatus;
	readonly anchors: readonly IDelverFindingAnchorWire[];
	readonly evidence: readonly IDelverFindingEvidenceWire[];
	readonly provenance: IDelverFindingProvenance;
}

export interface IDelverFindingDecisionWire {
	readonly id: string;
	readonly findingId: string;
	readonly contentHash: string;
	readonly at: number;
	readonly author: IAuthor;
	readonly outcome: DelverFindingOutcome;
}

/** Constructs and validates a finding before it reaches memory or persistence. */
export function createDelverFinding(id: string, at: number, draft: IDelverFindingDraft): IDelverFinding {
	const anchors = uniqueAnchors(draft.evidence.map(entry => entry.anchor));
	const finding: IDelverFinding = { id, at, ...draft, anchors };
	validateFinding(finding);
	return finding;
}

export function delverFindingToWire(finding: IDelverFinding): IDelverFindingWire {
	validateFinding(finding);
	return {
		...finding,
		anchors: finding.anchors.map(anchorToWire),
		evidence: finding.evidence.map(entry => ({
			kind: entry.kind,
			anchor: anchorToWire(entry.anchor),
			...(entry.endRva === undefined ? {} : { endRva: wireRva(entry.endRva) }),
			description: entry.description,
			sourceCallIds: entry.sourceCallIds ?? [],
		})),
	};
}

export function delverFindingFromWire(value: unknown): IDelverFinding {
	if (!isRecord(value) || !Array.isArray(value.anchors) || !Array.isArray(value.evidence)) {
		throw new Error('Invalid finding record');
	}
	const finding: IDelverFinding = {
		id: requireString(value.id, 'finding id'),
		at: requireNonNegativeInteger(value.at, 'finding timestamp'),
		author: requireAuthor(value.author),
		title: requireString(value.title, 'finding title'),
		description: requireString(value.description, 'finding description'),
		severity: requireSeverity(value.severity),
		confidence: requireConfidence(value.confidence),
		status: requireStatus(value.status),
		anchors: value.anchors.map(anchorFromWire),
		evidence: value.evidence.map(evidenceFromWire),
		provenance: requireProvenance(value.provenance),
	};
	validateFinding(finding);
	return finding;
}

export function createDelverFindingDecision(
	id: string,
	finding: IDelverFinding,
	outcome: DelverFindingOutcome,
	author: IAuthor,
	at: number,
): IDelverFindingDecision {
	if (finding.status !== 'proposed') {
		throw new Error('Only a proposed finding can be decided');
	}
	const contentHashes = new Set(finding.anchors.map(anchor => anchor.contentHash));
	if (contentHashes.size !== 1) {
		throw new Error('A finding decision must belong to one target revision');
	}
	return validateDecision({ id, findingId: finding.id, contentHash: [...contentHashes][0], at, author, outcome });
}

export function delverFindingDecisionToWire(decision: IDelverFindingDecision): IDelverFindingDecisionWire {
	return validateDecision(decision);
}

export function delverFindingDecisionFromWire(value: unknown): IDelverFindingDecision {
	if (!isRecord(value)) {
		throw new Error('Invalid finding decision record');
	}
	return validateDecision({
		id: requireString(value.id, 'finding decision id'),
		findingId: requireString(value.findingId, 'decided finding id'),
		contentHash: requireString(value.contentHash, 'finding decision content hash'),
		at: requireNonNegativeInteger(value.at, 'finding decision timestamp'),
		author: requireAuthor(value.author),
		outcome: requireOutcome(value.outcome),
	});
}

function validateFinding(finding: IDelverFinding): void {
	boundedText(finding.id, 128, 'finding id');
	requireNonNegativeInteger(finding.at, 'finding timestamp');
	requireAuthor(finding.author);
	boundedText(finding.title, DELVER_FINDING_LIMITS.titleCharacters, 'finding title');
	boundedText(finding.description, DELVER_FINDING_LIMITS.descriptionCharacters, 'finding description');
	requireSeverity(finding.severity);
	requireConfidence(finding.confidence);
	requireStatus(finding.status);
	requireProvenance(finding.provenance);
	if (finding.evidence.length === 0 || finding.evidence.length > DELVER_FINDING_LIMITS.evidencePerFinding) {
		throw new Error(`A finding must have between 1 and ${DELVER_FINDING_LIMITS.evidencePerFinding} evidence ranges`);
	}
	const evidenceAnchors = uniqueAnchors(finding.evidence.map(entry => {
		validateEvidence(entry);
		return entry.anchor;
	}));
	if (finding.anchors.length !== evidenceAnchors.length || finding.anchors.some((anchor, index) => anchorKey(anchor) !== anchorKey(evidenceAnchors[index]))) {
		throw new Error('Finding anchors must match its evidence ranges');
	}
}

function validateDecision(decision: IDelverFindingDecision): IDelverFindingDecision {
	boundedText(decision.id, 128, 'finding decision id');
	boundedText(decision.findingId, 128, 'decided finding id');
	if (!isContentHash(decision.contentHash)) {
		throw new Error('Invalid finding decision content hash');
	}
	requireNonNegativeInteger(decision.at, 'finding decision timestamp');
	requireAuthor(decision.author);
	requireOutcome(decision.outcome);
	return decision;
}

function validateEvidence(evidence: IDelverFindingEvidence): void {
	validateAnchor(evidence.anchor);
	boundedText(evidence.description, DELVER_FINDING_LIMITS.evidenceDescriptionCharacters, 'evidence description');
	if (evidence.endRva !== undefined && evidence.endRva <= evidence.anchor.rva) {
		throw new Error('Evidence end RVA must be greater than its start RVA');
	}
	const sourceCallIds = evidence.sourceCallIds ?? [];
	if (sourceCallIds.length > DELVER_FINDING_LIMITS.sourceCallsPerEvidence || new Set(sourceCallIds).size !== sourceCallIds.length) {
		throw new Error(`Finding evidence may cite at most ${DELVER_FINDING_LIMITS.sourceCallsPerEvidence} unique tool calls`);
	}
	for (const callId of sourceCallIds) {
		boundedText(callId, 128, 'evidence source call id');
	}
}

function evidenceFromWire(value: unknown): IDelverFindingEvidence {
	if (!isRecord(value) || value.kind !== 'range') {
		throw new Error('Invalid finding evidence');
	}
	return {
		kind: 'range',
		anchor: anchorFromWire(value.anchor),
		...(value.endRva === undefined ? {} : { endRva: parseWireRva(value.endRva) }),
		description: requireString(value.description, 'evidence description'),
		sourceCallIds: value.sourceCallIds === undefined ? [] : requireStringArray(value.sourceCallIds, 'evidence source call ids'),
	};
}

function anchorToWire(anchor: IImageAnchor): IDelverFindingAnchorWire {
	validateAnchor(anchor);
	return { kind: 'image', contentHash: anchor.contentHash, rva: wireRva(anchor.rva) };
}

function anchorFromWire(value: unknown): IImageAnchor {
	if (!isRecord(value) || value.kind !== 'image' || !isContentHash(value.contentHash)) {
		throw new Error('Invalid finding anchor');
	}
	return { kind: 'image', contentHash: value.contentHash, rva: parseWireRva(value.rva) };
}

function validateAnchor(anchor: IImageAnchor): void {
	if (!isContentHash(anchor.contentHash) || anchor.rva < 0n) {
		throw new Error('Invalid finding anchor');
	}
}

function uniqueAnchors(anchors: readonly IImageAnchor[]): readonly IImageAnchor[] {
	const unique = new Map<string, IImageAnchor>();
	for (const anchor of anchors) {
		unique.set(anchorKey(anchor), anchor);
	}
	return [...unique.values()];
}

function anchorKey(anchor: IImageAnchor): string {
	return `${anchor.contentHash}:${anchor.rva.toString(16)}`;
}

function wireRva(rva: bigint): string {
	if (rva < 0n) {
		throw new Error('Invalid finding RVA');
	}
	return `0x${rva.toString(16)}`;
}

function parseWireRva(value: unknown): bigint {
	if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
		throw new Error('Invalid finding RVA');
	}
	return BigInt(value);
}

function requireAuthor(value: unknown): IAuthor {
	if (!isRecord(value) || !['human', 'rule', 'model', 'import'].includes(String(value.kind))) {
		throw new Error('Invalid finding author');
	}
	return { kind: value.kind as IAuthor['kind'], id: boundedText(value.id, 256, 'finding author id') };
}

function requireProvenance(value: unknown): IDelverFindingProvenance {
	if (!isRecord(value)) {
		throw new Error('Invalid finding provenance');
	}
	return {
		capability: boundedText(value.capability, 256, 'finding provenance capability'),
		callId: boundedText(value.callId, 128, 'finding provenance call id'),
	};
}

function requireSeverity(value: unknown): DelverFindingSeverity {
	if (value !== 'info' && value !== 'suspicious' && value !== 'malicious') {
		throw new Error('Invalid finding severity');
	}
	return value;
}

function requireStatus(value: unknown): DelverFindingStatus {
	if (value !== 'proposed' && value !== 'accepted' && value !== 'rejected') {
		throw new Error('Invalid finding status');
	}
	return value;
}

function requireOutcome(value: unknown): DelverFindingOutcome {
	if (value !== 'accepted' && value !== 'rejected') {
		throw new Error('Invalid finding decision outcome');
	}
	return value;
}

function requireConfidence(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error('Invalid finding confidence');
	}
	return value;
}

function boundedText(value: unknown, maxLength: number, label: string): string {
	const text = requireString(value, label);
	if (text.trim() !== text || text.length === 0 || text.length > maxLength) {
		throw new Error(`Invalid ${label}`);
	}
	return text;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== 'string') {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function requireStringArray(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function isContentHash(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
