/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises } from 'fs';
import { isAbsolute, join, resolve } from '../../../base/common/path.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import { ILogService } from '../../log/common/log.js';
import {
	IDelverInterpretationStoreService,
	IInterpretationEditRequestWire,
	IInterpretationEditWire,
	isContentHash,
} from '../common/delverInterpretationStoreService.js';
import { EditOp, EditStatus } from '../common/interpretation.js';

const WIRE_RVA = /^0x[0-9a-fA-F]+$/;
const TYPE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_U64 = 0xFFFFFFFFFFFFFFFFn;

/** Node-side append-only JSONL store for authored interpretation. */
export class DelverInterpretationStoreService implements IDelverInterpretationStoreService {
	readonly _serviceBrand: undefined;

	private readonly storeRoot: string;
	private readonly operations = new Map<string, Promise<void>>();

	constructor(
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) {
		this.storeRoot = join(environmentService.userDataPath, 'delver', 'interpretation');
	}

	load(contentHash: string): Promise<readonly IInterpretationEditWire[]> {
		return this.queued(contentHash, () => this.readLog(contentHash));
	}

	append(contentHash: string, edit: IInterpretationEditRequestWire, minimumSeq = 1): Promise<IInterpretationEditWire> {
		return this.queued(contentHash, async () => {
			if (!Number.isSafeInteger(minimumSeq) || minimumSeq < 1) {
				throw new Error('Interpretation sequence floor must be a positive integer');
			}
			await promises.mkdir(this.storeRoot, { recursive: true });
			const path = this.storePath(contentHash);
			await repairTruncatedTail(path);
			// Read inside the per-image queue, so the number allocated here is
			// unique against every edit already on disk — including one another
			// window wrote a moment ago.
			const stored = await this.readLog(contentHash);
			const seq = Math.max(minimumSeq, stored.reduce((highest, entry) => Math.max(highest, entry.seq), 0) + 1);
			// Rebuilt field by field rather than spread: a stray `seq` on the
			// request must never win over the one allocated here.
			const sequenced: IInterpretationEditWire = {
				seq,
				at: edit.at,
				author: edit.author,
				anchor: edit.anchor,
				op: edit.op,
				value: edit.value,
				status: edit.status,
				compensates: edit.compensates,
				resolves: edit.resolves,
			};
			validateEdit(sequenced, contentHash, 'edit');
			await promises.appendFile(path, `${JSON.stringify(sequenced)}\n`, 'utf8');
			return sequenced;
		});
	}

	exportLog(contentHash: string, destinationPath: string): Promise<number> {
		return this.queued(contentHash, async () => {
			validateExternalPath(destinationPath);
			if (resolve(destinationPath) === resolve(this.storePath(contentHash))) {
				throw new Error('Cannot export an interpretation log over its store');
			}
			const edits = await this.readLog(contentHash);
			const contents = edits.map(edit => `${JSON.stringify(edit)}\n`).join('');
			await promises.writeFile(destinationPath, contents, 'utf8');
			return edits.length;
		});
	}

	importLog(contentHash: string, sourcePath: string): Promise<readonly IInterpretationEditWire[]> {
		return this.queued(contentHash, async () => {
			validateExternalPath(sourcePath);
			if (resolve(sourcePath) === resolve(this.storePath(contentHash))) {
				throw new Error('Cannot import an interpretation log into itself');
			}
			const contents = await promises.readFile(sourcePath, 'utf8');
			const sourceEdits = parseLog(contents, contentHash, sourcePath);
			if (sourceEdits.length === 0) {
				return sourceEdits;
			}
			const existing = await this.readLog(contentHash);
			const edits = resequenceImportedEdits(sourceEdits, existing, dropped => this.logService.warn(
				`[delver] Interpretation import from ${sourcePath} dropped ${dropped} cross-reference(s) to edits the log does not contain.`));
			await promises.mkdir(this.storeRoot, { recursive: true });
			await repairTruncatedTail(this.storePath(contentHash));
			await promises.appendFile(
				this.storePath(contentHash),
				edits.map(edit => `${JSON.stringify(edit)}\n`).join(''),
				'utf8',
			);
			return edits;
		});
	}

	private async readLog(contentHash: string): Promise<readonly IInterpretationEditWire[]> {
		const path = this.storePath(contentHash);
		try {
			return parseLog(await promises.readFile(path, 'utf8'), contentHash, path);
		} catch (error) {
			if (isFileNotFound(error)) {
				return [];
			}
			throw error;
		}
	}

	private storePath(contentHash: string): string {
		validateContentHash(contentHash);
		return join(this.storeRoot, `${contentHash}.delverdb`);
	}

	private queued<T>(contentHash: string, operation: () => Promise<T>): Promise<T> {
		validateContentHash(contentHash);
		const previous = this.operations.get(contentHash) ?? Promise.resolve();
		const result = previous.then(operation, operation);
		const tail = result.then(() => undefined, () => undefined);
		this.operations.set(contentHash, tail);
		void tail.finally(() => {
			if (this.operations.get(contentHash) === tail) {
				this.operations.delete(contentHash);
			}
		});
		return result;
	}
}

function parseLog(contents: string, contentHash: string, source: string): readonly IInterpretationEditWire[] {
	if (contents.startsWith('SQLite format 3\0')) {
		throw new Error(`Cannot import Delver project database ${source} as an interpretation log. Select a .delverlog file instead.`);
	}
	const lines = contents.split('\n');
	const edits: IInterpretationEditWire[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].trim();
		if (!line) {
			continue;
		}
		let edit: unknown;
		try {
			edit = JSON.parse(line) as unknown;
		} catch (error) {
			// A process crash can leave only the final append incomplete. A valid
			// append always ends in a newline, so dropping that fragment loses at
			// most the edit the crash interrupted and preserves the earlier work.
			if (index === lines.length - 1 && !contents.endsWith('\n')) {
				break;
			}
			throw new Error(`Invalid interpretation log ${source} at line ${index + 1}: ${errorMessage(error)}`);
		}
		try {
			validateEdit(edit, contentHash, `line ${index + 1}`);
		} catch (error) {
			throw new Error(`Invalid interpretation log ${source} at line ${index + 1}: ${errorMessage(error)}`);
		}
		edits.push(edit);
	}
	return edits;
}

function validateEdit(value: unknown, contentHash: string, location: string): asserts value is IInterpretationEditWire {
	if (!isRecord(value)
		|| !Number.isSafeInteger(value.seq) || (value.seq as number) < 1
		|| !Number.isSafeInteger(value.at) || (value.at as number) < 0
		|| !isRecord(value.author)
		|| !isAuthorKind(value.author.kind)
		|| typeof value.author.id !== 'string' || value.author.id.length === 0
		|| !isRecord(value.anchor)
		|| value.anchor.contentHash !== contentHash
		|| !isValidAnchor(value.anchor)
		|| (value.op !== EditOp.Rename && value.op !== EditOp.Comment && value.op !== EditOp.Tags
			&& value.op !== EditOp.DataType && value.op !== EditOp.FunctionPrototype
			&& value.op !== EditOp.CompositeType && value.op !== EditOp.FunctionBounds)
		|| !isOpForAnchor(value.op, value.anchor.kind)
		|| !isValueForOp(value.op, value.value)
		|| (value.status !== EditStatus.Proposed && value.status !== EditStatus.Accepted && value.status !== EditStatus.Rejected)
		|| (value.compensates !== undefined && !isSequenceList(value.compensates))
		|| (value.resolves !== undefined && !isSequenceList(value.resolves))
	) {
		throw new Error(`Invalid interpretation edit at ${location}`);
	}
}

/**
 * Whether an anchor is well formed for whichever kind it claims.
 *
 * The two kinds are checked separately rather than through one shape with
 * optional members: an `image` anchor missing its RVA and a `type` anchor
 * missing its name are both malformed, and a single relaxed check would accept
 * either as the other.
 */
function isValidAnchor(anchor: Record<string, unknown>): boolean {
	if (anchor.kind === 'type') {
		return typeof anchor.name === 'string' && TYPE_NAME.test(anchor.name) && anchor.rva === undefined;
	}
	return anchor.kind === 'image'
		&& typeof anchor.rva === 'string' && WIRE_RVA.test(anchor.rva) && BigInt(anchor.rva) <= MAX_U64
		&& anchor.name === undefined;
}

/**
 * Whether an operation can attach to that kind of anchor.
 *
 * A composite layout belongs to a type and nothing else; a rename or comment
 * belongs to a place. Without this, a log could carry a `compositeType` edit at
 * an RVA — which nothing would ever read, because the snapshot builder only
 * looks at type anchors — and the edit would be silently inert rather than
 * refused.
 */
function isOpForAnchor(op: unknown, kind: unknown): boolean {
	return kind === 'type' ? op === EditOp.CompositeType : op !== EditOp.CompositeType;
}

function isValueForOp(op: EditOp, value: unknown): boolean {
	if (op === EditOp.Tags) {
		return Array.isArray(value)
			&& value.every(tag => typeof tag === 'string' && tag.length > 0 && tag === tag.trim())
			&& new Set(value).size === value.length
			&& value.every((tag, index) => index === 0 || value[index - 1] < tag);
	}
	return typeof value === 'string';
}

function isSequenceList(value: unknown): value is readonly number[] {
	return Array.isArray(value)
		&& value.length > 0
		&& value.every(seq => Number.isSafeInteger(seq) && seq > 0)
		&& new Set(value).size === value.length;
}

/**
 * Renumbers an imported log so it cannot collide with what is already stored.
 *
 * `compensates` and `resolves` name other edits by sequence, so they move with
 * the entries they point at. A reference the imported log does not itself
 * contain has nothing to move to: left alone it would land on whichever *local*
 * edit happens to hold that number and silently claim to undo or decide it, so
 * it is dropped and reported instead.
 */
function resequenceImportedEdits(
	source: readonly IInterpretationEditWire[],
	existing: readonly IInterpretationEditWire[],
	reportDropped: (dropped: number) => void,
): readonly IInterpretationEditWire[] {
	// An empty store leaves the imported sequences alone: they are already
	// unique, and renumbering would only make the import harder to recognize.
	const renumber = existing.length > 0;
	let nextSeq = existing.reduce((maximum, edit) => Math.max(maximum, edit.seq), 0) + 1;
	const mapped = new Map<number, number>();
	for (const edit of source) {
		if (mapped.has(edit.seq)) {
			throw new Error(`Cannot import an interpretation log with duplicate sequence ${edit.seq}`);
		}
		mapped.set(edit.seq, renumber ? nextSeq++ : edit.seq);
	}
	let dropped = 0;
	const remap = (references: readonly number[] | undefined): readonly number[] | undefined => {
		if (references === undefined) {
			return undefined;
		}
		const kept = references.filter(seq => mapped.has(seq)).map(seq => mapped.get(seq)!);
		dropped += references.length - kept.length;
		// An empty list is not a valid reference list; "no references" is the
		// absent field, which is what a fully unmappable set collapses to.
		return kept.length === 0 ? undefined : kept;
	};
	const edits = source.map(edit => {
		// Both reference fields are dropped from the spread and put back only
		// when they survived remapping. Spreading and then assigning would leave
		// `compensates: undefined` on an edit that carried no references, and an
		// own property holding `undefined` is not the same as an absent one — to
		// `deepStrictEqual`, to `in`, or to anything enumerating keys. Spreading
		// and then conditionally adding would be worse: it would keep the
		// *original* references on an edit whose set was fully unmappable, which
		// is the case `remap` exists to collapse. `remap` already says absent is
		// how "no references" is spelled; this is what makes an imported edit
		// identical to one that never went through an import.
		const { compensates: _compensates, resolves: _resolves, ...rest } = edit;
		const compensates = remap(edit.compensates);
		const resolves = remap(edit.resolves);
		return {
			...rest,
			seq: mapped.get(edit.seq)!,
			...(compensates === undefined ? {} : { compensates }),
			...(resolves === undefined ? {} : { resolves }),
		};
	});
	if (dropped > 0) {
		reportDropped(dropped);
	}
	return edits;
}

function validateContentHash(contentHash: string): void {
	if (!isContentHash(contentHash)) {
		throw new Error('Content hash must be a lowercase SHA-256 value');
	}
}

function validateExternalPath(path: string): void {
	if (!path || !isAbsolute(path)) {
		throw new Error('Interpretation import/export path must be absolute');
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthorKind(value: unknown): value is IInterpretationEditWire['author']['kind'] {
	return value === 'human' || value === 'rule' || value === 'model' || value === 'import';
}

function isFileNotFound(error: unknown): boolean {
	return isRecord(error) && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function repairTruncatedTail(path: string): Promise<void> {
	let contents: Uint8Array;
	try {
		contents = await promises.readFile(path);
	} catch (error) {
		if (isFileNotFound(error)) {
			return;
		}
		throw error;
	}
	if (contents.length === 0 || contents[contents.length - 1] === 0x0A) {
		return;
	}
	const lastNewline = contents.lastIndexOf(0x0A);
	await promises.truncate(path, lastNewline + 1);
}
