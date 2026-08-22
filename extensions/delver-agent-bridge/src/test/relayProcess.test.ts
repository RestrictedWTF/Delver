/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as path from 'path';
import { describe, it } from 'node:test';
import { createRelayAttempt, relayEnvironment, resolveRelayExecutable, waitForRelayPeer } from '../relayProcess';
import { TestRelayProcess } from './relayTestUtils';

describe('Delver relay process setup', () => {
	it('resolves only absolute development or packaged executables', () => {
		const extensionPath = path.resolve('repo', 'extensions', 'delver-agent-bridge');
		const applicationRoot = path.resolve(extensionPath, '..', '..');
		const development = path.join(applicationRoot, 'delver', 'target', 'debug', 'delver-agent-relay.exe');
		const packaged = path.join(applicationRoot, 'resources', 'delver', 'bin', 'win32', 'delver-agent-relay.exe');

		assert.deepStrictEqual([
			resolveRelayExecutable(extensionPath, 'win32', candidate => candidate === development || candidate === packaged),
			resolveRelayExecutable(extensionPath, 'win32', candidate => candidate === packaged),
		], [development, packaged]);
		assert.throws(
			() => resolveRelayExecutable(extensionPath, 'linux', () => false),
			/The staged Delver agent relay executable is unavailable/,
		);
	});

	it('creates fresh platform endpoints and 256-bit tokens', () => {
		const tokenBytes = Buffer.alloc(32, 0xab);
		const windows = createRelayAttempt('win32', 'ignored', () => '11111111-2222-3333-4444-555555555555', () => tokenBytes);
		const unix = createRelayAttempt('linux', path.resolve('tmp'), () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', () => tokenBytes);

		assert.deepStrictEqual({
			windowsEndpoint: windows.endpoint,
			unixEndpoint: unix.endpoint,
			token: windows.token,
			tokenBytes: Buffer.from(windows.token, 'base64url').length,
		}, {
			windowsEndpoint: 'pipe://delver-agent-11111111222233334444555555555555',
			unixEndpoint: `unix://${path.join(path.resolve('tmp'), 'dv-aaaaaaaabbbbccccddddeeeeeeeeeeee', 'session.sock')}`,
			token: tokenBytes.toString('base64url'),
			tokenBytes: 32,
		});
	});

	it('does not inherit ambient credentials', () => {
		assert.deepStrictEqual(
			relayEnvironment({ DELVER_SESSION: 'secret', PATH: 'untrusted', SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' }, 'win32'),
			{ SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' },
		);
		assert.deepStrictEqual(relayEnvironment({ DELVER_SESSION: 'secret', PATH: 'untrusted' }, 'linux'), {});
	});

	it('accepts only one bounded OS peer-attestation record', async () => {
		const process = new TestRelayProcess();
		const peer = waitForRelayPeer(process, 'win32');
		process.emitStderr('{"event":"peer","schema');
		process.emitStderr('Version":1,"processId":4242}\r\n');
		assert.deepStrictEqual(await peer, { platform: 'win32', processId: 4242 });

		const malformedProcess = new TestRelayProcess();
		const malformed = waitForRelayPeer(malformedProcess, 'linux');
		malformedProcess.emitStderr('{"event":"peer","schemaVersion":1,"userId":1000,"extra":true}\n');
		await assert.rejects(malformed, /peer record is invalid/);
	});

	it('cancels peer attestation without trusting client data', async () => {
		const process = new TestRelayProcess();
		const controller = new AbortController();
		const peer = waitForRelayPeer(process, 'linux', controller.signal);
		controller.abort();
		await assert.rejects(peer, /cancelled/);
	});
});
