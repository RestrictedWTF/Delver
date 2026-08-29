/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';

export const RENDEZVOUS_SCHEMA_VERSION = 1;
export const RENDEZVOUS_BOOTSTRAP_PROTOCOL_VERSION = 1;
export const RENDEZVOUS_MAX_ENTRY_BYTES = 8 * 1024;
export const RENDEZVOUS_MAX_ENTRIES = 256;
export const RENDEZVOUS_MAX_TTL_MS = 30_000;
const RENDEZVOUS_TEMP_GRACE_MS = 2 * RENDEZVOUS_MAX_TTL_MS;
const OWNED_DIRECTORY_DEPTH = 4;
const REGISTRY_ID = /^[A-Za-z0-9_-]{16,128}$/;
const ROOT_FINGERPRINT = /^[0-9a-f]{64}$/;
const TEMP_FILE = /^\.tmp-[A-Za-z0-9_-]{16,128}\.json$/;

export interface IRendezvousRegistryEntry {
	readonly schemaVersion: 1;
	readonly bootstrapProtocolVersion: 1;
	readonly registryEntryId: string;
	readonly windowInstanceId: string;
	readonly rootFingerprint: string;
	readonly bootstrapEndpoint: string;
	readonly ownerProcessId: number;
	readonly publishedAt: number;
	readonly expiresAt: number;
}

export interface IRendezvousRegistryPublication {
	dispose(): Promise<void>;
}

export interface IRendezvousRegistry {
	publish(entry: IRendezvousRegistryEntry): Promise<IRendezvousRegistryPublication>;
	list(now: number): Promise<readonly IRendezvousRegistryEntry[]>;
	prune(now: number): Promise<void>;
}

export interface IFileRendezvousRegistryOptions {
	readonly directory: string;
	readonly platform?: NodeJS.Platform;
	readonly prepareDirectory?: (directory: string) => Promise<void>;
	readonly createTemporaryId?: () => string;
	readonly getEffectiveUserId?: () => number | undefined;
}

/** Resolves the client-neutral per-user registry location without using a shared temp directory. */
export function resolveRendezvousRegistryDirectory(
	platform: NodeJS.Platform = process.platform,
	environment: NodeJS.ProcessEnv = process.env,
	homeDirectory: string = os.homedir(),
): string {
	if (platform === 'win32') {
		return path.win32.join(requireAbsoluteBase(environment.LOCALAPPDATA, 'LOCALAPPDATA', path.win32), 'Delver', 'agent-rendezvous', 'v1', 'entries');
	}
	if (!path.posix.isAbsolute(homeDirectory)) {
		throw new Error('The Delver rendezvous home directory must be absolute.');
	}
	if (platform === 'darwin') {
		return path.posix.join(homeDirectory, 'Library', 'Application Support', 'Delver', 'agent-rendezvous', 'v1', 'entries');
	}
	if (platform === 'linux' || platform === 'android' || platform === 'freebsd' || platform === 'openbsd') {
		const stateHome = environment.XDG_STATE_HOME;
		const base = stateHome === undefined || stateHome.length === 0
			? path.posix.join(homeDirectory, '.local', 'state')
			: requireAbsoluteBase(stateHome, 'XDG_STATE_HOME', path.posix);
		return path.posix.join(base, 'delver', 'agent-rendezvous', 'v1', 'entries');
	}
	throw new Error('The current platform does not support Delver rendezvous discovery.');
}

/** Creates and verifies the Delver-owned POSIX registry hierarchy. */
export async function preparePrivatePosixRegistryDirectory(
	directory: string,
	getEffectiveUserId: () => number | undefined = () => typeof process.geteuid === 'function' ? process.geteuid() : undefined,
): Promise<void> {
	if (!path.isAbsolute(directory)) {
		throw new Error('The Delver rendezvous registry directory must be absolute.');
	}
	const userId = getEffectiveUserId();
	if (!Number.isSafeInteger(userId) || (userId ?? -1) < 0) {
		throw new Error('The current POSIX user identity is unavailable.');
	}
	const chain = ownedDirectoryChain(directory);
	await fs.promises.mkdir(path.dirname(chain[0]), { recursive: true, mode: 0o700 });
	for (const ownedDirectory of chain) {
		let stat: fs.Stats;
		try {
			stat = await fs.promises.lstat(ownedDirectory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
			try {
				await fs.promises.mkdir(ownedDirectory, { mode: 0o700 });
			} catch (mkdirError) {
				if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw mkdirError;
				}
			}
			stat = await fs.promises.lstat(ownedDirectory);
		}
		if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== userId || (stat.mode & 0o077) !== 0) {
			throw new Error('The Delver rendezvous registry hierarchy is not private to the current user.');
		}
	}
}

/** Lock-free immutable-entry registry shared by independent Delver windows. */
export class FileRendezvousRegistry implements IRendezvousRegistry {
	private readonly directory: string;
	private readonly platform: NodeJS.Platform;
	private readonly prepareDirectory: (directory: string) => Promise<void>;
	private readonly createTemporaryId: () => string;
	private readonly getEffectiveUserId: () => number | undefined;

	constructor(options: IFileRendezvousRegistryOptions) {
		if (!path.isAbsolute(options.directory)) {
			throw new Error('The Delver rendezvous registry directory must be absolute.');
		}
		this.directory = path.resolve(options.directory);
		this.platform = options.platform ?? process.platform;
		this.prepareDirectory = options.prepareDirectory ?? defaultDirectoryPreparation(this.platform);
		this.createTemporaryId = options.createTemporaryId ?? (() => randomBytes(16).toString('base64url'));
		this.getEffectiveUserId = options.getEffectiveUserId ?? (() => typeof process.geteuid === 'function' ? process.geteuid() : undefined);
	}

	async publish(entry: IRendezvousRegistryEntry): Promise<IRendezvousRegistryPublication> {
		validateRendezvousRegistryEntry(entry, this.platform);
		const encoded = encodeRendezvousRegistryEntry(entry, this.platform);
		await this.prepareDirectory(this.directory);

		const temporaryId = this.createTemporaryId();
		if (!matchesPattern(temporaryId, REGISTRY_ID)) {
			throw new Error('The Delver rendezvous temporary identifier is invalid.');
		}
		const temporaryPath = this.entryPath(`.tmp-${temporaryId}.json`);
		const finalPath = this.entryPath(`${entry.registryEntryId}.json`);
		let handle: fs.promises.FileHandle | undefined;
		let published = false;
		try {
			handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
			if (!this.isPrivateEntryFile(await handle.stat())) {
				throw new Error('The Delver rendezvous entry file is not private to the current user.');
			}
			await handle.writeFile(encoded);
			await handle.sync();
			await handle.close();
			handle = undefined;
			// A hard link publishes the fully-written inode atomically and, unlike
			// POSIX rename, fails rather than replacing an improbable ID collision.
			await fs.promises.link(temporaryPath, finalPath);
			published = true;
			await fs.promises.unlink(temporaryPath);
			await syncDirectory(this.directory, this.platform);
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await fs.promises.unlink(temporaryPath).catch(() => undefined);
			if (published) {
				await fs.promises.unlink(finalPath).catch(() => undefined);
			}
			throw error;
		}

		let disposePromise: Promise<void> | undefined;
		return {
			dispose: () => disposePromise ??= this.removeOwnedEntry(finalPath, entry.registryEntryId),
		};
	}

	async list(now: number): Promise<readonly IRendezvousRegistryEntry[]> {
		validateNow(now);
		await this.prepareDirectory(this.directory);
		const names = (await fs.promises.readdir(this.directory))
			.filter(name => isEntryFileName(name))
			.sort()
			.slice(0, RENDEZVOUS_MAX_ENTRIES);
		const entries: IRendezvousRegistryEntry[] = [];
		for (const name of names) {
			const entry = await this.readEntry(name);
			if (entry && entry.publishedAt <= now && entry.expiresAt > now) {
				entries.push(entry);
			}
		}
		return entries;
	}

	async prune(now: number): Promise<void> {
		validateNow(now);
		await this.prepareDirectory(this.directory);
		const names = (await fs.promises.readdir(this.directory)).sort().slice(0, RENDEZVOUS_MAX_ENTRIES);
		for (const name of names) {
			const candidate = this.entryPath(name);
			if (TEMP_FILE.test(name)) {
				const stat = await safeLstat(candidate);
				if (stat?.isFile() && !stat.isSymbolicLink() && stat.mtimeMs <= now - RENDEZVOUS_TEMP_GRACE_MS) {
					await fs.promises.unlink(candidate).catch(() => undefined);
				}
				continue;
			}
			if (!isEntryFileName(name)) {
				continue;
			}
			const entry = await this.readEntry(name);
			if (entry && entry.expiresAt <= now) {
				await this.removeOwnedEntry(candidate, entry.registryEntryId);
			}
		}
	}

	private async readEntry(name: string): Promise<IRendezvousRegistryEntry | undefined> {
		const expectedId = name.slice(0, -'.json'.length);
		const candidate = this.entryPath(name);
		let handle: fs.promises.FileHandle | undefined;
		try {
			const pathStat = await fs.promises.lstat(candidate);
			if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
				return undefined;
			}
			handle = await fs.promises.open(candidate, 'r');
			const stat = await handle.stat();
			if (!this.isPrivateEntryFile(stat) || stat.size < 1 || stat.size > RENDEZVOUS_MAX_ENTRY_BYTES) {
				return undefined;
			}
			const buffer = Buffer.alloc(stat.size);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead !== buffer.length) {
				return undefined;
			}
			const entry = parseRendezvousRegistryEntry(buffer, this.platform);
			return entry.registryEntryId === expectedId ? entry : undefined;
		} catch {
			return undefined;
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	private async removeOwnedEntry(candidate: string, registryEntryId: string): Promise<void> {
		if (candidate !== this.entryPath(`${registryEntryId}.json`)) {
			throw new Error('Refusing to remove an invalid Delver rendezvous entry path.');
		}
		const stat = await safeLstat(candidate);
		if (!stat) {
			return;
		}
		if (!this.isPrivateEntryFile(stat) || stat.isSymbolicLink()) {
			throw new Error('Refusing to remove a non-file Delver rendezvous entry.');
		}
		await fs.promises.unlink(candidate);
		await syncDirectory(this.directory, this.platform);
	}

	private isPrivateEntryFile(stat: fs.Stats): boolean {
		if (!stat.isFile()) {
			return false;
		}
		if (this.platform === 'win32') {
			return true;
		}
		const userId = this.getEffectiveUserId();
		return Number.isSafeInteger(userId) && (userId ?? -1) >= 0 && stat.uid === userId && (stat.mode & 0o077) === 0;
	}

	private entryPath(name: string): string {
		const candidate = path.join(this.directory, name);
		if (path.dirname(candidate) !== this.directory || path.basename(candidate) !== name) {
			throw new Error('The Delver rendezvous entry path is invalid.');
		}
		return candidate;
	}
}

export function encodeRendezvousRegistryEntry(entry: IRendezvousRegistryEntry, platform: NodeJS.Platform): Buffer {
	validateRendezvousRegistryEntry(entry, platform);
	const encoded = Buffer.from(JSON.stringify(entry), 'utf8');
	if (encoded.length > RENDEZVOUS_MAX_ENTRY_BYTES) {
		throw new Error('The Delver rendezvous entry is too large.');
	}
	return encoded;
}

export function parseRendezvousRegistryEntry(data: Buffer, platform: NodeJS.Platform): IRendezvousRegistryEntry {
	if (data.length < 1 || data.length > RENDEZVOUS_MAX_ENTRY_BYTES) {
		throw new Error('The Delver rendezvous entry size is invalid.');
	}
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
	} catch {
		throw new Error('The Delver rendezvous entry is invalid JSON.');
	}
	if (!isRecord(value) || !hasExactKeys(value, [
		'schemaVersion',
		'bootstrapProtocolVersion',
		'registryEntryId',
		'windowInstanceId',
		'rootFingerprint',
		'bootstrapEndpoint',
		'ownerProcessId',
		'publishedAt',
		'expiresAt',
	])) {
		throw new Error('The Delver rendezvous entry fields are invalid.');
	}
	const entry = value as unknown as IRendezvousRegistryEntry;
	validateRendezvousRegistryEntry(entry, platform);
	return Object.freeze({ ...entry });
}

export function validateRendezvousRegistryEntry(entry: IRendezvousRegistryEntry, platform: NodeJS.Platform): void {
	if (
		entry.schemaVersion !== RENDEZVOUS_SCHEMA_VERSION
		|| entry.bootstrapProtocolVersion !== RENDEZVOUS_BOOTSTRAP_PROTOCOL_VERSION
		|| !matchesPattern(entry.registryEntryId, REGISTRY_ID)
		|| !matchesPattern(entry.windowInstanceId, REGISTRY_ID)
		|| !matchesPattern(entry.rootFingerprint, ROOT_FINGERPRINT)
		|| !isLocalEndpoint(entry.bootstrapEndpoint, platform)
		|| !Number.isSafeInteger(entry.ownerProcessId)
		|| entry.ownerProcessId < 1
		|| !Number.isSafeInteger(entry.publishedAt)
		|| !Number.isSafeInteger(entry.expiresAt)
		|| entry.publishedAt < 0
		|| entry.publishedAt > Number.MAX_SAFE_INTEGER - RENDEZVOUS_MAX_TTL_MS
		|| entry.expiresAt < entry.publishedAt
		|| entry.expiresAt > entry.publishedAt + RENDEZVOUS_MAX_TTL_MS
	) {
		throw new Error('The Delver rendezvous entry is invalid.');
	}
}

/**
 * Tests a pattern against a value that arrived from outside this process.
 * `RegExp.test` coerces its argument, so a number or a one-element array of the
 * right shape would otherwise pass a check on a field that must be a string.
 */
function matchesPattern(value: unknown, pattern: RegExp): boolean {
	return typeof value === 'string' && pattern.test(value);
}

function isLocalEndpoint(endpoint: string, platform: NodeJS.Platform): boolean {
	if (typeof endpoint !== 'string' || endpoint.length < 8 || endpoint.length > 512 || /[\u0000-\u001F\u007F-\u009F]/u.test(endpoint)) {
		return false;
	}
	if (platform === 'win32') {
		return /^pipe:\/\/[A-Za-z0-9._-]+$/.test(endpoint);
	}
	return endpoint.startsWith('unix://') && path.posix.isAbsolute(endpoint.slice('unix://'.length));
}

function defaultDirectoryPreparation(platform: NodeJS.Platform): (directory: string) => Promise<void> {
	if (platform === 'win32') {
		return async () => {
			throw new Error('A protected Windows rendezvous directory provider is required.');
		};
	}
	return directory => preparePrivatePosixRegistryDirectory(directory);
}

function ownedDirectoryChain(directory: string): readonly string[] {
	const result: string[] = [];
	let current = path.resolve(directory);
	for (let index = 0; index < OWNED_DIRECTORY_DEPTH; index++) {
		result.push(current);
		const parent = path.dirname(current);
		if (parent === current) {
			throw new Error('The Delver rendezvous registry path is too shallow.');
		}
		current = parent;
	}
	return result.reverse();
}

async function syncDirectory(directory: string, platform: NodeJS.Platform): Promise<void> {
	if (platform === 'win32') {
		return;
	}
	const handle = await fs.promises.open(directory, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function safeLstat(candidate: string): Promise<fs.Stats | undefined> {
	try {
		return await fs.promises.lstat(candidate);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

function isEntryFileName(name: string): boolean {
	return name.endsWith('.json') && REGISTRY_ID.test(name.slice(0, -'.json'.length));
}

function validateNow(now: number): void {
	if (!Number.isSafeInteger(now) || now < 0) {
		throw new Error('The Delver rendezvous clock is invalid.');
	}
}

function requireAbsoluteBase(value: string | undefined, name: string, pathApi: path.PlatformPath): string {
	if (typeof value !== 'string' || value.length === 0 || !pathApi.isAbsolute(value)) {
		throw new Error(`The ${name} directory must be absolute for Delver rendezvous discovery.`);
	}
	return pathApi.resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
