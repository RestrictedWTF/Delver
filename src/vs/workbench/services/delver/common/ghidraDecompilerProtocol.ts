/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IDecompiledAddressRange, IDecompiledFunction, IDecompiledLineMapping, IDecompiledVariable } from './delverDecompilerService.js';

export const GHIDRA_DECOMPILER_BACKEND_ID = 'ghidra-headless';
export const GHIDRA_DECOMPILER_SCHEMA_VERSION = 1;

const hexadecimalRvaPattern = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;

/** Raised when Ghidra emits data that does not match Delver's versioned protocol. */
export class DelverDecompilerOutputError extends Error {
	override readonly name = 'DelverDecompilerOutputError';
}

function invalidOutput(detail: string): never {
	throw new DelverDecompilerOutputError(localize('delverGhidraInvalidOutput', "Ghidra returned invalid decompiler output: {0}", detail));
}

function readObject(value: unknown, path: string, allowedKeys: readonly string[]): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		invalidOutput(`${path} must be an object`);
	}

	const object = value as Record<string, unknown>;
	const unexpectedKey = Object.keys(object).find(key => !allowedKeys.includes(key));
	if (unexpectedKey) {
		invalidOutput(`${path}.${unexpectedKey} is not supported`);
	}
	return object;
}

function readArray(value: unknown, path: string): readonly unknown[] {
	if (!Array.isArray(value)) {
		invalidOutput(`${path} must be an array`);
	}
	return value;
}

function readString(value: unknown, path: string, allowEmpty = true): string {
	if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
		invalidOutput(`${path} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
	}
	return value;
}

function readPositiveInteger(value: unknown, path: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		invalidOutput(`${path} must be a positive integer`);
	}
	return value;
}

function readRva(value: unknown, path: string): bigint {
	const encoded = readString(value, path);
	if (!hexadecimalRvaPattern.test(encoded)) {
		invalidOutput(`${path} must be a canonical hexadecimal RVA`);
	}
	return BigInt(encoded);
}

function readOptionalString(object: Record<string, unknown>, key: string, path: string): string | undefined {
	return Object.prototype.hasOwnProperty.call(object, key) ? readString(object[key], `${path}.${key}`, false) : undefined;
}

function readOptionalPositiveInteger(object: Record<string, unknown>, key: string, path: string): number | undefined {
	return Object.prototype.hasOwnProperty.call(object, key) ? readPositiveInteger(object[key], `${path}.${key}`) : undefined;
}

function readRange(value: unknown, path: string): IDecompiledAddressRange {
	const object = readObject(value, path, ['startRva', 'endRva']);
	const startRva = readRva(object.startRva, `${path}.startRva`);
	const endRva = readRva(object.endRva, `${path}.endRva`);
	if (startRva >= endRva) {
		invalidOutput(`${path} must be a non-empty half-open range`);
	}
	return { startRva, endRva };
}

function readLineMapping(value: unknown, index: number): IDecompiledLineMapping {
	const path = `lineMappings[${index}]`;
	const object = readObject(value, path, ['line', 'ranges']);
	return {
		line: readPositiveInteger(object.line, `${path}.line`),
		ranges: readArray(object.ranges, `${path}.ranges`).map((range, rangeIndex) => readRange(range, `${path}.ranges[${rangeIndex}]`)),
	};
}

function readVariable(value: unknown, index: number): IDecompiledVariable {
	const path = `variables[${index}]`;
	const object = readObject(value, path, ['name', 'typeName', 'storage', 'declarationLine']);
	return {
		name: readString(object.name, `${path}.name`, false),
		typeName: readOptionalString(object, 'typeName', path),
		storage: readOptionalString(object, 'storage', path),
		declarationLine: readOptionalPositiveInteger(object, 'declarationLine', path),
	};
}

/** Decodes and validates the untrusted JSON produced by Delver's Ghidra script. */
export function decodeGhidraDecompilerOutput(serialized: string, expectedFunctionRva: bigint, backendId = GHIDRA_DECOMPILER_BACKEND_ID): IDecompiledFunction {
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		invalidOutput('the response is not valid JSON');
	}

	const object = readObject(value, 'response', ['schemaVersion', 'functionRva', 'text', 'lineMappings', 'variables']);
	if (object.schemaVersion !== GHIDRA_DECOMPILER_SCHEMA_VERSION) {
		invalidOutput(`schemaVersion must be ${GHIDRA_DECOMPILER_SCHEMA_VERSION}`);
	}

	const functionRva = readRva(object.functionRva, 'functionRva');
	if (functionRva !== expectedFunctionRva) {
		invalidOutput('functionRva does not match the requested function');
	}

	return {
		backendId,
		functionRva,
		text: readString(object.text, 'text'),
		lineMappings: readArray(object.lineMappings, 'lineMappings').map(readLineMapping),
		variables: readArray(object.variables, 'variables').map(readVariable),
	};
}
