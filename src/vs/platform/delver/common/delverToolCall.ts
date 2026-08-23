/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAuthor } from './interpretation.js';

export const DELVER_TOOL_CALL_LIMITS = {
	requestCharacters: 8 * 1024 * 1024,
	resultCharacters: 2 * 1024 * 1024,
} as const;

/** Durable model-visible dispatcher exchange that a finding may cite. */
export interface IDelverToolCallRecord {
	readonly callId: string;
	readonly capability: string;
	readonly contentHash: string;
	readonly caller?: IAuthor;
	readonly startedAt: number;
	readonly finishedAt: number;
	readonly requestJson: string;
	readonly resultJson: string;
}

export type IDelverToolCallRecordWire = IDelverToolCallRecord;

export function delverToolCallToWire(record: IDelverToolCallRecord): IDelverToolCallRecordWire {
	return validateToolCall(record);
}

export function delverToolCallFromWire(value: unknown): IDelverToolCallRecord {
	if (!isRecord(value)) {
		throw new Error('Invalid tool-call record');
	}
	return validateToolCall({
		callId: requireBoundedText(value.callId, 128, 'tool-call id'),
		capability: requireBoundedText(value.capability, 256, 'tool-call capability'),
		contentHash: requireString(value.contentHash, 'tool-call content hash'),
		...(value.caller === undefined ? {} : { caller: requireAuthor(value.caller) }),
		startedAt: requireTimestamp(value.startedAt, 'tool-call start'),
		finishedAt: requireTimestamp(value.finishedAt, 'tool-call finish'),
		requestJson: requireString(value.requestJson, 'tool-call request'),
		resultJson: requireString(value.resultJson, 'tool-call result'),
	});
}

function validateToolCall(record: IDelverToolCallRecord): IDelverToolCallRecord {
	requireBoundedText(record.callId, 128, 'tool-call id');
	requireBoundedText(record.capability, 256, 'tool-call capability');
	if (!/^[0-9a-f]{64}$/.test(record.contentHash)) {
		throw new Error('Invalid tool-call content hash');
	}
	if (record.caller !== undefined) {
		requireAuthor(record.caller);
	}
	requireTimestamp(record.startedAt, 'tool-call start');
	requireTimestamp(record.finishedAt, 'tool-call finish');
	if (record.finishedAt < record.startedAt) {
		throw new Error('Tool-call finish precedes its start');
	}
	validateJson(record.requestJson, DELVER_TOOL_CALL_LIMITS.requestCharacters, 'tool-call request');
	validateJson(record.resultJson, DELVER_TOOL_CALL_LIMITS.resultCharacters, 'tool-call result');
	return record;
}

function validateJson(value: string, maxCharacters: number, label: string): void {
	if (value.length === 0 || value.length > maxCharacters) {
		throw new Error(`Invalid ${label} size`);
	}
	try {
		JSON.parse(value);
	} catch {
		throw new Error(`Invalid ${label} JSON`);
	}
}

function requireAuthor(value: unknown): IAuthor {
	if (!isRecord(value) || !['human', 'rule', 'model', 'import'].includes(String(value.kind))) {
		throw new Error('Invalid tool-call caller');
	}
	return { kind: value.kind as IAuthor['kind'], id: requireBoundedText(value.id, 256, 'tool-call caller id') };
}

function requireTimestamp(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function requireBoundedText(value: unknown, maxLength: number, label: string): string {
	const text = requireString(value, label);
	if (text.length === 0 || text.length > maxLength || text.trim() !== text) {
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
