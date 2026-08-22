/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describe, it } from 'node:test';
import { canonicalizeResolvedRootV1, computeRootFingerprintV1, computeWorkspaceRootFingerprintV1, hashCanonicalRootV1, RootFingerprintError, RootFingerprintErrorCode } from '../rootFingerprint';

describe('root-v1 fingerprint', () => {
	it('locks the cross-implementation canonicalization and hash vectors', () => {
		const vectors = [
			{ platform: 'win32', input: 'c:\\Users\\Alice\\Project', canonical: { kind: 'win32-drive', path: 'C:/Users/Alice/Project' }, fingerprint: 'f2ba3910dff6197279ca1c4f671d85f3b6014580b4ef125e0637e9a97fb49f6d' },
			{ platform: 'win32', input: 'C:\\', canonical: { kind: 'win32-drive', path: 'C:/' }, fingerprint: 'f2875af4ccc606fdeb4b57526a7bc88dbdb7d789bedc17059703c56e18cbbe38' },
			{ platform: 'win32', input: '\\\\SERVER\\SHARE\\Project', canonical: { kind: 'win32-unc', path: '//server/share/Project' }, fingerprint: '62f8b7c0156774720c4178969dd4970cfcaf39b08433948a04431ec3081b9f27' },
			{ platform: 'linux', input: '/home/alice/project', canonical: { kind: 'linux', path: '/home/alice/project' }, fingerprint: '9994d17eec447dc153e2be8d9f4602b5031539bb1452487512e2c8f12c6d6731' },
			{ platform: 'darwin', input: '/Users/Alice/Café', canonical: { kind: 'darwin', path: '/Users/Alice/Café' }, fingerprint: '5202f76b7bd885e7764e201e634f504681dda90d5d797e383911ec1e42d4eb8e' },
			{ platform: 'darwin', input: '/Users/Alice/Cafe\u0301', canonical: { kind: 'darwin', path: '/Users/Alice/Cafe\u0301' }, fingerprint: 'b5de87e0c91fe13c369397c330b5c326a756df3264aa748206eea96c388fcf56' },
			{ platform: 'linux', input: '/tmp/Café', canonical: { kind: 'linux', path: '/tmp/Café' }, fingerprint: '63c87baa8da05c2bee4e7b3969ae8e7227e713482c10e25b2c0b3db774617911' },
			{ platform: 'linux', input: '/tmp/Cafe\u0301', canonical: { kind: 'linux', path: '/tmp/Cafe\u0301' }, fingerprint: '93e8efd0975cfbaf85d460b98246e24543a61d394566d40625903691efb5e091' },
		] as const;

		assert.deepStrictEqual(vectors.map(vector => {
			const canonical = canonicalizeResolvedRootV1(vector.input, vector.platform);
			return { canonical, fingerprint: hashCanonicalRootV1(canonical) };
		}), vectors.map(vector => ({ canonical: vector.canonical, fingerprint: vector.fingerprint })));
	});

	it('accepts only the safe extended Windows forms returned by native realpath', () => {
		assert.deepStrictEqual(canonicalizeResolvedRootV1('\\\\?\\C:\\StoredCase\\Root', 'win32'), { kind: 'win32-drive', path: 'C:/StoredCase/Root' });
		assert.deepStrictEqual(canonicalizeResolvedRootV1('\\\\?\\UNC\\SERVER\\SHARE\\StoredCase', 'win32'), { kind: 'win32-unc', path: '//server/share/StoredCase' });
		for (const candidate of ['\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\root', '\\\\.\\pipe\\name', '\\Device\\HarddiskVolume1\\root', 'C:relative', 'C:\\root:stream']) {
			assert.throws(() => canonicalizeResolvedRootV1(candidate, 'win32'), errorWithCode(RootFingerprintErrorCode.InvalidPath));
		}
	});

	it('rejects malformed resolver output instead of lexically repairing it', () => {
		for (const [candidate, platform] of [
			['C:\\root\\..\\other', 'win32'],
			['C:\\root\\\\child', 'win32'],
			['C:\\\\root', 'win32'],
			['C://root', 'win32'],
			['\\\\servér\\share\\root', 'win32'],
			['/root/../other', 'linux'],
			['/root//child', 'linux'],
			['relative', 'darwin'],
		] as const) {
			assert.throws(() => canonicalizeResolvedRootV1(candidate, platform), errorWithCode(RootFingerprintErrorCode.InvalidPath));
		}
		assert.throws(() => canonicalizeResolvedRootV1('/root', 'android'), errorWithCode(RootFingerprintErrorCode.UnsupportedPlatform));
		assert.throws(() => canonicalizeResolvedRootV1(`/root/${'a'.repeat(16 * 1024)}`, 'linux'), errorWithCode(RootFingerprintErrorCode.InvalidPath));
		assert.throws(() => canonicalizeResolvedRootV1('/root/\uD800', 'linux'), errorWithCode(RootFingerprintErrorCode.InvalidPath));
	});

	it('resolves once, verifies a directory, and collapses filesystem aliases', async () => {
		const calls: string[] = [];
		const dependencies = {
			realpath: async (candidate: string) => {
				calls.push(`realpath:${candidate}`);
				return '/stored/Project';
			},
			stat: async (candidate: string) => {
				calls.push(`stat:${candidate}`);
				return { isDirectory: () => true };
			},
		};
		const [alias, target] = await Promise.all([
			computeRootFingerprintV1('/alias', 'linux', dependencies),
			computeRootFingerprintV1('/stored/Project', 'linux', dependencies),
		]);

		assert.deepStrictEqual({ alias, target, calls }, {
			alias: '172e0ab8abdea31a0a48ae75985062c52651f1110c32ca21e73b4713ebd7d74e',
			target: '172e0ab8abdea31a0a48ae75985062c52651f1110c32ca21e73b4713ebd7d74e',
			calls: ['realpath:/alias', 'realpath:/stored/Project', 'stat:/stored/Project', 'stat:/stored/Project'],
		});
	});

	it('fails closed for unavailable roots and non-directories without echoing paths', async () => {
		const unavailable = computeRootFingerprintV1('/secret/root', 'linux', { realpath: async () => { throw new Error('denied'); } });
		const file = computeRootFingerprintV1('/secret/file', 'linux', {
			realpath: async () => '/secret/file',
			stat: async () => ({ isDirectory: () => false }),
		});
		await assert.rejects(unavailable, errorWithCode(RootFingerprintErrorCode.RootUnavailable));
		await assert.rejects(file, errorWithCode(RootFingerprintErrorCode.NotDirectory));
		await assert.rejects(unavailable, error => !String(error).includes('/secret/root'));
	});

	it('enforces the single local workspace policy before resolving', async () => {
		let resolutions = 0;
		const dependencies = {
			platform: 'linux' as const,
			realpath: async (candidate: string) => {
				resolutions++;
				return candidate;
			},
			stat: async () => ({ isDirectory: () => true }),
		};
		const root = { scheme: 'file', fsPath: '/root' };
		const rejected = [
			{ roots: [] },
			{ roots: [root, root] },
			{ roots: [root], remoteName: 'ssh-remote' },
			{ roots: [root], workspaceFileScheme: 'untitled' },
			{ roots: [root], trusted: false },
			{ roots: [{ ...root, scheme: 'vscode-remote' }] },
			{ roots: [{ ...root, authority: 'server' }] },
		];
		for (const selection of rejected) {
			await assert.rejects(computeWorkspaceRootFingerprintV1(selection, dependencies));
		}

		const fingerprint = await computeWorkspaceRootFingerprintV1({ roots: [root] }, dependencies);
		assert.deepStrictEqual({ resolutions, fingerprint }, {
			resolutions: 1,
			fingerprint: 'c99a26f4ef3d60c57d8b40ee5b6153a2d67bc6d33e22812229af3e0f7209434a',
		});
	});

	it('accepts only an authority attested by the Windows UNC filesystem path', async () => {
		let resolutions = 0;
		const dependencies = {
			platform: 'win32' as const,
			realpath: async (candidate: string) => {
				resolutions++;
				return candidate;
			},
			stat: async () => ({ isDirectory: () => true }),
		};
		const root = { scheme: 'file', authority: 'server', fsPath: '\\\\SERVER\\SHARE\\Project' };
		await assert.rejects(computeWorkspaceRootFingerprintV1({ roots: [{ ...root, authority: 'other' }] }, dependencies), errorWithCode(RootFingerprintErrorCode.UnsupportedScheme));
		const fingerprint = await computeWorkspaceRootFingerprintV1({ roots: [root] }, dependencies);

		assert.deepStrictEqual({ resolutions, fingerprint }, {
			resolutions: 1,
			fingerprint: '62f8b7c0156774720c4178969dd4970cfcaf39b08433948a04431ec3081b9f27',
		});
	});
});

function errorWithCode(code: RootFingerprintErrorCode): (error: Error) => boolean {
	return error => error instanceof RootFingerprintError && error.code === code;
}
