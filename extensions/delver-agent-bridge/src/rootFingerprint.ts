/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';

const ROOT_V1_DOMAIN = 'delver-root-v1';
const MAX_ROOT_BYTES = 16 * 1024;
const WINDOWS_EXTENDED_UNC_PREFIX = /^\\\\\?\\UNC\\/i;
const WINDOWS_EXTENDED_DRIVE_PREFIX = /^\\\\\?\\(?=[A-Za-z]:[\\/])/;
const WINDOWS_DEVICE_PREFIX = /^(?:\\\\[.?]\\|\\\?\?\\|\\Device\\)/i;
const WINDOWS_DRIVE_ROOT = /^(?<drive>[A-Za-z]):[\\/](?<tail>.*)$/;
const WINDOWS_UNC_ROOT = /^[\\/]{2}(?<server>[^\\/]+)[\\/](?<share>[^\\/]+)(?<tail>(?:[\\/].*)?)$/;
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export const ROOT_FINGERPRINT_VERSION = 1;

export type RootV1Kind = 'win32-drive' | 'win32-unc' | 'darwin' | 'linux' | 'freebsd' | 'openbsd';

export const enum RootFingerprintErrorCode {
	UnsupportedRootSet = 'UNSUPPORTED_ROOT_SET',
	UnsupportedScheme = 'UNSUPPORTED_SCHEME',
	UnsupportedPlatform = 'UNSUPPORTED_PLATFORM',
	InvalidPath = 'INVALID_PATH',
	RootUnavailable = 'ROOT_UNAVAILABLE',
	NotDirectory = 'NOT_DIRECTORY',
}

export class RootFingerprintError extends Error {
	constructor(readonly code: RootFingerprintErrorCode) {
		super(code);
		this.name = 'RootFingerprintError';
	}
}

export interface ICanonicalRootV1 {
	readonly kind: RootV1Kind;
	readonly path: string;
}

export interface IWorkspaceRootV1Candidate {
	readonly scheme: string;
	readonly authority?: string;
	readonly fsPath: string;
}

export interface IWorkspaceRootV1Selection {
	readonly roots: readonly IWorkspaceRootV1Candidate[];
	readonly remoteName?: string;
	readonly workspaceFileScheme?: string;
	readonly trusted?: boolean;
}

export interface IRootFingerprintStat {
	isDirectory(): boolean;
}

export interface IRootFingerprintDependencies {
	readonly platform?: NodeJS.Platform;
	readonly realpath?: (candidate: string) => Promise<string>;
	readonly stat?: (candidate: string) => Promise<IRootFingerprintStat>;
}

/**
 * Applies the root-v1 workspace policy and fingerprints exactly one local file root.
 */
export async function computeWorkspaceRootFingerprintV1(selection: IWorkspaceRootV1Selection, dependencies: IRootFingerprintDependencies = {}): Promise<string> {
	if (selection.roots.length !== 1 || selection.remoteName !== undefined || selection.workspaceFileScheme === 'untitled' || selection.trusted === false) {
		throw new RootFingerprintError(RootFingerprintErrorCode.UnsupportedRootSet);
	}
	const [root] = selection.roots;
	const platform = dependencies.platform ?? process.platform;
	if (root.scheme !== 'file' || !isPermittedRootV1FileAuthority(root, platform)) {
		throw new RootFingerprintError(RootFingerprintErrorCode.UnsupportedScheme);
	}
	return computeRootFingerprintV1(root.fsPath, platform, dependencies);
}

/**
 * Resolves, verifies, and fingerprints one explicit local directory.
 */
export async function computeRootFingerprintV1(rootPath: string, platform: NodeJS.Platform, dependencies: IRootFingerprintDependencies = {}): Promise<string> {
	validateInputPath(rootPath, platform);
	const realpath = dependencies.realpath ?? fs.promises.realpath;
	const stat = dependencies.stat ?? fs.promises.stat;
	let resolvedPath: string;
	try {
		resolvedPath = await realpath(rootPath);
	} catch {
		throw new RootFingerprintError(RootFingerprintErrorCode.RootUnavailable);
	}

	let resolvedStat: IRootFingerprintStat;
	try {
		resolvedStat = await stat(resolvedPath);
	} catch {
		throw new RootFingerprintError(RootFingerprintErrorCode.RootUnavailable);
	}
	if (!resolvedStat.isDirectory()) {
		throw new RootFingerprintError(RootFingerprintErrorCode.NotDirectory);
	}
	return hashCanonicalRootV1(canonicalizeResolvedRootV1(resolvedPath, platform));
}

/**
 * Canonicalizes an already-realpathed absolute path without accessing the filesystem.
 */
export function canonicalizeResolvedRootV1(resolvedPath: string, platform: NodeJS.Platform): ICanonicalRootV1 {
	validateBoundedString(resolvedPath);
	if (platform === 'win32') {
		return canonicalizeResolvedWindowsRoot(resolvedPath);
	}
	if (platform !== 'darwin' && platform !== 'linux' && platform !== 'freebsd' && platform !== 'openbsd') {
		throw new RootFingerprintError(RootFingerprintErrorCode.UnsupportedPlatform);
	}
	if (!resolvedPath.startsWith('/') || resolvedPath.startsWith('//') || hasNonCanonicalPosixComponent(resolvedPath)) {
		throw new RootFingerprintError(RootFingerprintErrorCode.InvalidPath);
	}
	const canonicalPath = resolvedPath.length > 1 && resolvedPath.endsWith('/') ? resolvedPath.slice(0, -1) : resolvedPath;
	return { kind: platform, path: canonicalPath };
}

/**
 * Produces the lowercase SHA-256 root-v1 fingerprint from a canonical root.
 */
export function hashCanonicalRootV1(root: ICanonicalRootV1): string {
	validateCanonicalRoot(root);
	return crypto.createHash('sha256')
		.update(ROOT_V1_DOMAIN, 'ascii')
		.update('\0', 'ascii')
		.update(root.kind, 'ascii')
		.update('\0', 'ascii')
		.update(root.path, 'utf8')
		.digest('hex');
}

function canonicalizeResolvedWindowsRoot(resolvedPath: string): ICanonicalRootV1 {
	let candidate = resolvedPath;
	if (WINDOWS_EXTENDED_UNC_PREFIX.test(candidate)) {
		candidate = `\\\\${candidate.slice('\\\\?\\UNC\\'.length)}`;
	} else if (WINDOWS_EXTENDED_DRIVE_PREFIX.test(candidate)) {
		candidate = candidate.slice('\\\\?\\'.length);
	} else if (WINDOWS_DEVICE_PREFIX.test(candidate)) {
		throw new RootFingerprintError(RootFingerprintErrorCode.InvalidPath);
	}

	const driveMatch = WINDOWS_DRIVE_ROOT.exec(candidate);
	if (driveMatch?.groups) {
		if (/^[\\/]/.test(driveMatch.groups.tail)) {
			throw new RootFingerprintError(RootFingerprintErrorCode.InvalidPath);
		}
		const tail = canonicalWindowsTail(driveMatch.groups.tail);
		const drive = driveMatch.groups.drive.toUpperCase();
		return { kind: 'win32-drive', path: tail.length === 0 ? `${drive}:/` : `${drive}:/${tail}` };
	}

	const uncMatch = WINDOWS_UNC_ROOT.exec(candidate);
	if (uncMatch?.groups) {
		const { server, share } = uncMatch.groups;
		if (!isValidUncAuthority(server) || !isValidUncAuthority(share)) {
			throw new RootFingerprintError(RootFingerprintErrorCode.InvalidPath);
		}
		const tail = canonicalWindowsTail(uncMatch.groups.tail);
		const canonicalPath = `//${server.toLowerCase()}/${share.toLowerCase()}${tail.length === 0 ? '' : `/${tail}`}`;
		return { kind: 'win32-unc', path: canonicalPath };
	}

	throw new RootFingerprintError(RootFingerprintErrorCode.InvalidPath);
}

function canonicalWindowsTail(tail: string): string {
	if (tail.includes(':') || /[\\/]{2}/.test(tail)) {
		throw new RootFingerprintError(RootFingerprintErrorCode.InvalidPath);
	}
	const components = tail.split(/[\\/]/);
	while (components.length > 0 && components[0].length === 0) {
		components.shift();
	}
	while (components.length > 0 && components[components.length - 1].length === 0) {
		components.pop();
	}
	if (components.some(component => component.length === 0 || component === '.' || component === '..')) {
		throw new RootFingerprintError(RootFingerprintErrorCode.InvalidPath);
	}
	return components.join('/');
}

function isValidUncAuthority(component: string): boolean {
	if (component.length === 0 || component === '.' || component === '..') {
		return false;
	}
	for (const character of component) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 0x20 || codePoint > 0x7e || '<>:"/\\|?*'.includes(character)) {
			return false;
		}
	}
	return true;
}

/** Whether a file-URI authority is compatible with root-v1 on this platform. */
export function isPermittedRootV1FileAuthority(root: IWorkspaceRootV1Candidate, platform: NodeJS.Platform): boolean {
	if (root.authority === undefined || root.authority.length === 0) {
		return true;
	}
	if (platform !== 'win32' || !isValidUncAuthority(root.authority)) {
		return false;
	}
	const match = WINDOWS_UNC_ROOT.exec(root.fsPath);
	return match?.groups !== undefined
		&& isValidUncAuthority(match.groups.server)
		&& match.groups.server.toLowerCase() === root.authority.toLowerCase();
}

function hasNonCanonicalPosixComponent(candidate: string): boolean {
	if (candidate.includes('//')) {
		return true;
	}
	return candidate.split('/').some((component, index) => index !== 0 && (component === '.' || component === '..'));
}

function validateInputPath(candidate: string, platform: NodeJS.Platform): void {
	validateBoundedString(candidate);
	if (platform === 'win32') {
		if (WINDOWS_DEVICE_PREFIX.test(candidate) || !WINDOWS_DRIVE_ROOT.test(candidate) && !WINDOWS_UNC_ROOT.test(candidate)) {
			throw new RootFingerprintError(RootFingerprintErrorCode.InvalidPath);
		}
		const driveMatch = WINDOWS_DRIVE_ROOT.exec(candidate);
		if (driveMatch?.groups?.tail.includes(':')) {
			throw new RootFingerprintError(RootFingerprintErrorCode.InvalidPath);
		}
		const uncMatch = WINDOWS_UNC_ROOT.exec(candidate);
		if (uncMatch?.groups && (!isValidUncAuthority(uncMatch.groups.server) || !isValidUncAuthority(uncMatch.groups.share) || uncMatch.groups.tail.includes(':'))) {
			throw new RootFingerprintError(RootFingerprintErrorCode.InvalidPath);
		}
	} else if (platform === 'darwin' || platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
		if (!candidate.startsWith('/')) {
			throw new RootFingerprintError(RootFingerprintErrorCode.InvalidPath);
		}
	} else {
		throw new RootFingerprintError(RootFingerprintErrorCode.UnsupportedPlatform);
	}
}

function validateCanonicalRoot(root: ICanonicalRootV1): void {
	if (root.kind !== 'win32-drive' && root.kind !== 'win32-unc' && root.kind !== 'darwin' && root.kind !== 'linux' && root.kind !== 'freebsd' && root.kind !== 'openbsd') {
		throw new RootFingerprintError(RootFingerprintErrorCode.UnsupportedPlatform);
	}
	validateBoundedString(root.path);
	const recanonicalized = root.kind === 'win32-drive' || root.kind === 'win32-unc'
		? canonicalizeResolvedRootV1(root.path, 'win32')
		: canonicalizeResolvedRootV1(root.path, root.kind);
	if (recanonicalized.kind !== root.kind || recanonicalized.path !== root.path) {
		throw new RootFingerprintError(RootFingerprintErrorCode.InvalidPath);
	}
}

function validateBoundedString(candidate: string): void {
	if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0') || UNPAIRED_SURROGATE.test(candidate) || Buffer.byteLength(candidate, 'utf8') > MAX_ROOT_BYTES) {
		throw new RootFingerprintError(RootFingerprintErrorCode.InvalidPath);
	}
}
