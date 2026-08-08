/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises } from 'fs';
import { isAbsolute, join, resolve } from '../../../base/common/path.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import {
	IDelverInterpretationStoreService,
	IInterpretationEditWire,
	isContentHash,
} from '../common/delverInterpretationStoreService.js';
import { EditOp, EditStatus } from '../common/interpretation.js';

const WIRE_RVA = /^0x[0-9a-fA-F]+$/;
const MAX_U64 = 0xFFFFFFFFFFFFFFFFn;

/** Node-side append-only JSONL store for authored interpretation. */
export class DelverInterpretationStoreService implements IDelverInterpretationStoreService {
	readonly _serviceBrand: undefined;

	private readonly storeRoot: string;
	private readonly operations = new Map<string, Promise<void>>();

	constructor(
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
	) {
		this.storeRoot = join(environmentService.userDataPath, 'delver', 'interpretation');
	}

	load(contentHash: string): Promise<readonly IInterpretationEditWire[]> {
		return this.queued(contentHash, () => this.readLog(contentHash));
	}

	append(contentHash: string, edit: IInterpretationEditWire): Promise<void> {
		return this.queued(contentHash, async () => {
			validateEdit(edit, contentHash, 'edit');
			await promises.mkdir(this.storeRoot, { recursive: true });
			const path = this.storePath(contentHash);
			await repairTruncatedTail(path);
			await promises.appendFile(path, `${JSON.stringify(edit)}\n`, 'utf8');
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
			const edits = parseLog(contents, contentHash, sourcePath);
			if (edits.length === 0) {
				return edits;
			}
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
		|| value.anchor.kind !== 'image'
		|| value.anchor.contentHash !== contentHash
		|| typeof value.anchor.rva !== 'string' || !WIRE_RVA.test(value.anchor.rva)
		|| BigInt(value.anchor.rva) > MAX_U64
		|| (value.op !== EditOp.Rename && value.op !== EditOp.Comment)
		|| typeof value.value !== 'string'
		|| (value.status !== EditStatus.Proposed && value.status !== EditStatus.Accepted && value.status !== EditStatus.Rejected)
	) {
		throw new Error(`Invalid interpretation edit at ${location}`);
	}
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
