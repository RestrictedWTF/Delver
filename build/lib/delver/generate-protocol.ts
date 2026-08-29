/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Generates `src/vs/platform/delver/common/protocol.generated.ts` from
 * `delver/schema/protocol.schema.json`.
 *
 * The Rust `delver-protocol` crate is the single source of truth for the wire
 * format (ADR 0002). This script derives the TypeScript view of it — it must
 * never contain hand-written type declarations, because a hardcoded output
 * makes the "regenerating produces no diff" CI check vacuously true while the
 * two sides silently drift.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const schemaPath = path.join(repoRoot, 'delver', 'schema', 'protocol.schema.json');
const outPath = path.join(repoRoot, 'src', 'vs', 'platform', 'delver', 'common', 'protocol.generated.ts');

interface ISchemaNode {
	readonly description?: string;
	readonly type?: string | string[];
	readonly format?: string;
	readonly properties?: Record<string, ISchemaNode>;
	readonly required?: string[];
	readonly items?: ISchemaNode;
	readonly enum?: string[];
	readonly oneOf?: ISchemaNode[];
	readonly anyOf?: ISchemaNode[];
	readonly $ref?: string;
}

type DefinitionKind = 'interface' | 'enum' | 'union';

const schema: { definitions: Record<string, ISchemaNode> } = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const definitions = schema.definitions;

/** Enums are emitted bare; objects get the `I` prefix, per VS Code convention. */
function kindOf(node: ISchemaNode): DefinitionKind {
	if (node.enum || node.oneOf?.every(v => Array.isArray(v.enum))) {
		return 'enum';
	}
	// A serde-tagged enum: `oneOf` over objects, each carrying the tag as a
	// single-valued `kind`. Emitted as a discriminated union so a consumer must
	// narrow before touching a branch's fields.
	if (node.oneOf?.every(v => v.properties !== undefined)) {
		return 'union';
	}
	return 'interface';
}

const kinds = new Map<string, DefinitionKind>(
	Object.entries(definitions).map(([name, node]) => [name, kindOf(node)])
);

function typeName(name: string): string {
	return kinds.get(name) === 'enum' ? name : `I${name}`;
}

function refName(ref: string): string {
	return typeName(ref.replace('#/definitions/', ''));
}

/** Strips the `null` branch that schemars emits for `Option<T>`. */
function withoutNull(node: ISchemaNode): { inner: ISchemaNode; nullable: boolean } {
	if (Array.isArray(node.type)) {
		const types = node.type.filter(t => t !== 'null');
		return { inner: { ...node, type: types.length === 1 ? types[0] : types }, nullable: node.type.includes('null') };
	}
	if (node.anyOf) {
		const branches = node.anyOf.filter(b => b.type !== 'null');
		if (branches.length === 1) {
			return { inner: branches[0], nullable: branches.length !== node.anyOf.length };
		}
	}
	return { inner: node, nullable: false };
}

function tsType(node: ISchemaNode): string {
	if (node.$ref) {
		return refName(node.$ref);
	}
	if (node.anyOf || Array.isArray(node.type)) {
		return tsType(withoutNull(node).inner);
	}
	switch (node.type) {
		case 'string':
			return 'string';
		case 'integer':
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'array':
			return node.items ? `${tsType(node.items)}[]` : 'unknown[]';
		case 'object':
			return 'Record<string, unknown>';
		default:
			// No `type` at all: an opaque `serde_json::Value`.
			return 'unknown';
	}
}

function docComment(description: string | undefined, indent: string): string {
	if (!description) {
		return '';
	}
	const lines = description.split('\n');
	if (lines.length === 1) {
		return `${indent}/**\n${indent} * ${lines[0]}\n${indent} */\n`;
	}
	return `${indent}/**\n${lines.map(line => line.length === 0 ? `${indent} *` : `${indent} * ${line}`).join('\n')}\n${indent} */\n`;
}

/** Property names come from serde and may not be valid TS identifiers. */
function propertyKey(name: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `['${name}']`;
}

function emitMembers(node: ISchemaNode, indent: string): string {
	const required = new Set(node.required ?? []);
	let out = '';
	for (const [prop, propNode] of Object.entries(node.properties ?? {})) {
		const { nullable } = withoutNull(propNode);
		const optional = !required.has(prop) || nullable;
		out += docComment(propNode.description, indent);
		// A single-valued enum is a union's tag. Emit the literal so TypeScript
		// can discriminate on it instead of widening it to `string`.
		const type = propNode.enum?.length === 1 ? `'${propNode.enum[0]}'` : tsType(propNode);
		out += `${indent}${propertyKey(prop)}${optional ? '?' : ''}: ${type};\n`;
	}
	return out;
}

function emitInterface(name: string, node: ISchemaNode): string {
	let out = docComment(node.description, '');
	out += `export interface ${typeName(name)} {\n`;
	out += emitMembers(node, '\t');
	out += '}\n';
	return out;
}

/** A serde-tagged enum, as a discriminated union of its branches. */
function emitUnion(name: string, node: ISchemaNode): string {
	let out = docComment(node.description, '');
	out += `export type ${typeName(name)} =\n`;
	out += (node.oneOf ?? [])
		.map(branch => `${docComment(branch.description, '\t')}\t| {\n${emitMembers(branch, '\t\t')}\t}`)
		.join('\n');
	out += ';\n';
	return out;
}

function emitEnum(name: string, node: ISchemaNode): string {
	const members: { value: string; description?: string }[] = node.oneOf
		? node.oneOf.map(v => ({ value: v.enum![0], description: v.description }))
		: (node.enum ?? []).map(v => ({ value: v }));

	let out = docComment(node.description, '');
	out += `export const enum ${name} {\n`;
	for (const member of members) {
		out += docComment(member.description, '\t');
		// PascalCase the member name; the wire value is preserved verbatim.
		const key = member.value.charAt(0).toUpperCase() + member.value.slice(1);
		out += `\t${key} = '${member.value}',\n`;
	}
	out += '}\n';
	return out;
}

const header = `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GENERATED — DO NOT EDIT
// Generated from delver/schema/protocol.schema.json by \`npm run delver:protocol\`.
// Edit the delver-protocol crate and regenerate.
//
// Addresses cross the wire as "0x..." strings, never JSON numbers, because JSON
// numbers are IEEE 754 doubles and truncate above 2^53 (ADR 0001). Parse them
// to bigint before use — never to number.
`;

const blocks = Object.keys(definitions)
	.sort()
	.map(name => {
		const node = definitions[name];
		switch (kinds.get(name)) {
			case 'enum': return emitEnum(name, node);
			case 'union': return emitUnion(name, node);
			default: return emitInterface(name, node);
		}
	});

fs.writeFileSync(outPath, `${header}\n${blocks.join('\n')}`, 'utf8');
console.log(`Wrote ${outPath} (${blocks.length} types)`);
