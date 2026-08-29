/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IDecompilationSemanticComposite, IDecompilationSemanticDeclaration, IDecompilationSemanticDependencies, IDecompiledAddressRange, IDecompiledFunction, IDecompiledLineMapping, IDecompiledVariable } from './delverDecompilerService.js';

export const GHIDRA_DECOMPILER_BACKEND_ID = 'ghidra-headless';
export const GHIDRA_DECOMPILER_SCHEMA_VERSION = 1;

const hexadecimalRvaPattern = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

function readNonNegativeInteger(value: unknown, path: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		invalidOutput(`${path} must be a non-negative integer`);
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

function readSemanticDeclarations(value: unknown, path: string): readonly IDecompilationSemanticDeclaration[] {
	const declarations = readArray(value, path).map((entry, index) => {
		const entryPath = `${path}[${index}]`;
		const object = readObject(entry, entryPath, ['rva', 'declaration']);
		const rva = readString(object.rva, `${entryPath}.rva`, false);
		if (!hexadecimalRvaPattern.test(rva)) {
			invalidOutput(`${entryPath}.rva must be a canonical hexadecimal RVA`);
		}
		const declaration = readString(object.declaration, `${entryPath}.declaration`, false);
		if (declaration.length > 2048) {
			invalidOutput(`${entryPath}.declaration is too long`);
		}
		return { rva, declaration };
	});
	for (let index = 1; index < declarations.length; index++) {
		if (BigInt(declarations[index - 1].rva) >= BigInt(declarations[index].rva)) {
			invalidOutput(`${path} must contain unique declarations in ascending RVA order`);
		}
	}
	return declarations;
}

function readSemanticComposites(value: unknown, path: string): readonly IDecompilationSemanticComposite[] {
	const composites = readArray(value, path).map((entry, index) => {
		const entryPath = `${path}[${index}]`;
		const object = readObject(entry, entryPath, ['name', 'kind', 'size', 'fields']);
		const name = readString(object.name, `${entryPath}.name`, false);
		if (!identifierPattern.test(name)) {
			invalidOutput(`${entryPath}.name must be a C identifier`);
		}
		// Fail closed on a kind this build does not know. A union decoded as a
		// struct would lay every field out at its own offset, which is a
		// different type wearing the analyst's name for this one.
		if (object.kind !== 'struct') {
			invalidOutput(`${entryPath}.kind must be "struct"`);
		}
		const size = readPositiveInteger(object.size, `${entryPath}.size`);
		const fields = readArray(object.fields, `${entryPath}.fields`).map((field, fieldIndex) => {
			const fieldPath = `${entryPath}.fields[${fieldIndex}]`;
			const fieldObject = readObject(field, fieldPath, ['offset', 'name', 'type']);
			const offset = readNonNegativeInteger(fieldObject.offset, `${fieldPath}.offset`);
			if (offset >= size) {
				invalidOutput(`${fieldPath}.offset must fall inside the composite`);
			}
			const fieldName = readString(fieldObject.name, `${fieldPath}.name`, false);
			if (!identifierPattern.test(fieldName)) {
				invalidOutput(`${fieldPath}.name must be a C identifier`);
			}
			const type = readString(fieldObject.type, `${fieldPath}.type`, false);
			if (type.length > 2048) {
				invalidOutput(`${fieldPath}.type is too long`);
			}
			return { offset, name: fieldName, type };
		});
		for (let index = 1; index < fields.length; index++) {
			if (fields[index - 1].offset >= fields[index].offset) {
				invalidOutput(`${entryPath}.fields must be in ascending offset order`);
			}
		}
		return { name, kind: 'struct' as const, size, fields };
	});
	for (let index = 1; index < composites.length; index++) {
		if (composites[index - 1].name >= composites[index].name) {
			invalidOutput(`${path} must contain unique composites in ascending name order`);
		}
	}
	return composites;
}

/**
 * Reads the snapshot a saved result was produced against, normalized to v2.
 *
 * A result saved before composites existed carries a v1 envelope, and a v1
 * snapshot *is* a v2 one with no composites — it already described the whole
 * accepted type model at the time. Normalizing on the way in is what keeps that
 * pseudocode reusable: the comparison against the current snapshot is by value,
 * so leaving the version at 1 would make every pre-existing saved function look
 * stale and re-decompile the entire project on first open.
 */
function readSemanticDependencies(value: unknown): IDecompilationSemanticDependencies {
	if (value === undefined) {
		return { schemaVersion: 2, composites: [], dataTypes: [], functionPrototypes: [] };
	}
	const versioned = readObject(value, 'semanticDependencies', ['schemaVersion', 'composites', 'dataTypes', 'functionPrototypes']);
	if (versioned.schemaVersion !== 1 && versioned.schemaVersion !== 2) {
		invalidOutput('semanticDependencies.schemaVersion must be 1 or 2');
	}
	// The key set is pinned per version, so a payload confused about its own
	// shape is refused rather than guessed at.
	const object = versioned.schemaVersion === 1
		? readObject(value, 'semanticDependencies', ['schemaVersion', 'dataTypes', 'functionPrototypes'])
		: readObject(value, 'semanticDependencies', ['schemaVersion', 'composites', 'dataTypes', 'functionPrototypes']);
	return {
		schemaVersion: 2,
		composites: object.schemaVersion === 1 ? [] : readSemanticComposites(object.composites, 'semanticDependencies.composites'),
		dataTypes: readSemanticDeclarations(object.dataTypes, 'semanticDependencies.dataTypes'),
		functionPrototypes: readSemanticDeclarations(object.functionPrototypes, 'semanticDependencies.functionPrototypes'),
	};
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

	const object = readObject(value, 'response', ['schemaVersion', 'functionRva', 'text', 'lineMappings', 'variables', 'semanticDependencies']);
	if (object.schemaVersion !== GHIDRA_DECOMPILER_SCHEMA_VERSION) {
		invalidOutput(`schemaVersion must be ${GHIDRA_DECOMPILER_SCHEMA_VERSION}`);
	}

	const functionRva = readRva(object.functionRva, 'functionRva');
	if (functionRva !== expectedFunctionRva) {
		invalidOutput('functionRva does not match the requested function');
	}

	const semanticDependencies = readSemanticDependencies(object.semanticDependencies);
	return {
		backendId,
		functionRva,
		text: readString(object.text, 'text'),
		lineMappings: readArray(object.lineMappings, 'lineMappings').map(readLineMapping),
		variables: readArray(object.variables, 'variables').map(readVariable),
		...(object.semanticDependencies === undefined ? {} : { semanticDependencies }),
	};
}
