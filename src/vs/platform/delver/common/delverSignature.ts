/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isContentHash } from './delverInterpretationStoreService.js';

export const DELVER_SIGNATURE_LIMITS = {
	nameCharacters: 128,
	patternBytes: 256,
	wildcards: 256,
} as const;

export type DelverSignatureScope = 'function' | 'executableSections' | 'image';
export type DelverSignaturePolicy = 'unique-now' | 'relocation-stable';
export type DelverSignatureVariant = 'primary' | 'xref-site';
export type DelverSignatureConfidence = 'low' | 'medium' | 'high';

export interface IDelverSignatureWildcard {
	readonly instructionRva: string;
	readonly instructionByteIndex: number;
	readonly length: number;
	readonly patternByteIndex: number;
	readonly reason: 'relativeBranch' | 'ipRelativeMemory' | 'baseRelocation';
}

export interface IDelverNamedSignature {
	readonly id: string;
	readonly name: string;
	readonly contentHash: string;
	readonly sourceCallId: string;
	readonly functionRva: string;
	readonly functionName: string;
	readonly variant: DelverSignatureVariant;
	readonly scope: DelverSignatureScope;
	readonly policy: DelverSignaturePolicy;
	readonly pattern: string;
	readonly byteCount: number;
	readonly fixedByteCount: number;
	readonly wildcardByteCount: number;
	readonly coveredStartRva: string;
	readonly coveredEndRva: string;
	readonly wildcards: readonly IDelverSignatureWildcard[];
	readonly unique: boolean;
	readonly matchCount: number;
	readonly matchCountExact: boolean;
	readonly qualityScore: number;
	readonly confidence: DelverSignatureConfidence;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export type IDelverNamedSignatureWire = IDelverNamedSignature;

export interface IDelverNamedSignatureDraft extends Omit<IDelverNamedSignature, 'id' | 'createdAt' | 'updatedAt'> { }

export function delverNamedSignatureToWire(signature: IDelverNamedSignature): IDelverNamedSignatureWire {
	return delverNamedSignatureFromWire(signature);
}

export function delverNamedSignatureFromWire(value: unknown): IDelverNamedSignature {
	if (!isRecord(value)) {
		throw new Error('Invalid named signature');
	}
	const wildcards = requireArray(value.wildcards, 'signature wildcards').map((candidate, index) => parseWildcard(candidate, index));
	return validateSignature({
		id: requireText(value.id, 128, 'signature id'),
		name: requireText(value.name, DELVER_SIGNATURE_LIMITS.nameCharacters, 'signature name'),
		contentHash: requireString(value.contentHash, 'signature content hash'),
		sourceCallId: requireText(value.sourceCallId, 128, 'signature source call id'),
		functionRva: requireRva(value.functionRva, 'signature function RVA'),
		functionName: requireText(value.functionName, 512, 'signature function name'),
		variant: requireVariant(value.variant),
		scope: requireScope(value.scope),
		policy: requirePolicy(value.policy),
		pattern: requireString(value.pattern, 'signature pattern'),
		byteCount: requireInteger(value.byteCount, 1, DELVER_SIGNATURE_LIMITS.patternBytes, 'signature byte count'),
		fixedByteCount: requireInteger(value.fixedByteCount, 0, DELVER_SIGNATURE_LIMITS.patternBytes, 'signature fixed-byte count'),
		wildcardByteCount: requireInteger(value.wildcardByteCount, 0, DELVER_SIGNATURE_LIMITS.patternBytes, 'signature wildcard-byte count'),
		coveredStartRva: requireRva(value.coveredStartRva, 'signature covered start RVA'),
		coveredEndRva: requireRva(value.coveredEndRva, 'signature covered end RVA'),
		wildcards,
		unique: requireBoolean(value.unique, 'signature uniqueness'),
		matchCount: requireInteger(value.matchCount, 0, Number.MAX_SAFE_INTEGER, 'signature match count'),
		matchCountExact: requireBoolean(value.matchCountExact, 'signature match-count precision'),
		qualityScore: requireNumber(value.qualityScore, 0, 1, 'signature quality score'),
		confidence: requireConfidence(value.confidence),
		createdAt: requireInteger(value.createdAt, 0, Number.MAX_SAFE_INTEGER, 'signature creation time'),
		updatedAt: requireInteger(value.updatedAt, 0, Number.MAX_SAFE_INTEGER, 'signature update time'),
	});
}

function validateSignature(signature: IDelverNamedSignature): IDelverNamedSignature {
	if (!isContentHash(signature.contentHash)) {
		throw new Error('Invalid signature content hash');
	}
	const tokens = signature.pattern.split(' ');
	if (tokens.length !== signature.byteCount || tokens.some(token => !/^(?:[0-9a-f]{2}|\?\?)$/.test(token))) {
		throw new Error('Invalid signature pattern');
	}
	const wildcardByteCount = tokens.filter(token => token === '??').length;
	if (signature.fixedByteCount + signature.wildcardByteCount !== signature.byteCount || wildcardByteCount !== signature.wildcardByteCount) {
		throw new Error('Signature byte counts do not match its pattern');
	}
	const coveredStart = BigInt(signature.coveredStartRva);
	const coveredEnd = BigInt(signature.coveredEndRva);
	if (coveredEnd - coveredStart !== BigInt(signature.byteCount)) {
		throw new Error('Signature covered range does not match its byte count');
	}
	const explainedWildcardBytes = new Set<number>();
	for (const wildcard of signature.wildcards) {
		const instructionRva = BigInt(wildcard.instructionRva);
		if (instructionRva < coveredStart || instructionRva >= coveredEnd
			|| wildcard.instructionByteIndex + wildcard.length > 15
			|| wildcard.patternByteIndex + wildcard.length > signature.byteCount) {
			throw new Error('Signature wildcard falls outside its covered bytes');
		}
		for (let index = wildcard.patternByteIndex; index < wildcard.patternByteIndex + wildcard.length; index++) {
			if (tokens[index] !== '??') {
				throw new Error('Signature wildcard does not match its pattern');
			}
			explainedWildcardBytes.add(index);
		}
	}
	if (explainedWildcardBytes.size !== signature.wildcardByteCount) {
		throw new Error('Signature pattern contains unexplained wildcard bytes');
	}
	if (signature.updatedAt < signature.createdAt || (signature.unique && (!signature.matchCountExact || signature.matchCount !== 1))) {
		throw new Error('Invalid signature proof metadata');
	}
	return signature;
}

function parseWildcard(value: unknown, index: number): IDelverSignatureWildcard {
	if (!isRecord(value)) {
		throw new Error(`Invalid signature wildcard ${index}`);
	}
	const reason = value.reason;
	if (reason !== 'relativeBranch' && reason !== 'ipRelativeMemory' && reason !== 'baseRelocation') {
		throw new Error(`Invalid signature wildcard ${index} reason`);
	}
	return {
		instructionRva: requireRva(value.instructionRva, `signature wildcard ${index} instruction RVA`),
		instructionByteIndex: requireInteger(value.instructionByteIndex, 0, 15, `signature wildcard ${index} instruction byte index`),
		length: requireInteger(value.length, 1, 8, `signature wildcard ${index} length`),
		patternByteIndex: requireInteger(value.patternByteIndex, 0, DELVER_SIGNATURE_LIMITS.patternBytes - 1, `signature wildcard ${index} pattern byte index`),
		reason,
	};
}

function requireScope(value: unknown): DelverSignatureScope {
	if (value === 'function' || value === 'executableSections' || value === 'image') {
		return value;
	}
	throw new Error('Invalid signature scope');
}

function requirePolicy(value: unknown): DelverSignaturePolicy {
	if (value === 'unique-now' || value === 'relocation-stable') {
		return value;
	}
	throw new Error('Invalid signature policy');
}

function requireVariant(value: unknown): DelverSignatureVariant {
	if (value === 'primary' || value === 'xref-site') {
		return value;
	}
	throw new Error('Invalid signature variant');
}

function requireConfidence(value: unknown): DelverSignatureConfidence {
	if (value === 'low' || value === 'medium' || value === 'high') {
		return value;
	}
	throw new Error('Invalid signature confidence');
}

function requireRva(value: unknown, label: string): string {
	const rva = requireString(value, label);
	if (!/^0x[0-9a-f]+$/.test(rva)) {
		throw new Error(`Invalid ${label}`);
	}
	return rva;
}

function requireText(value: unknown, maxLength: number, label: string): string {
	const text = requireString(value, label);
	if (text.length === 0 || text.length > maxLength || text.trim() !== text) {
		throw new Error(`Invalid ${label}`);
	}
	return text;
}

function requireInteger(value: unknown, minimum: number, maximum: number, label: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function requireNumber(value: unknown, minimum: number, maximum: number, label: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function requireBoolean(value: unknown, label: string): boolean {
	if (typeof value !== 'boolean') {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== 'string') {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
	if (!Array.isArray(value) || value.length > DELVER_SIGNATURE_LIMITS.wildcards) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
