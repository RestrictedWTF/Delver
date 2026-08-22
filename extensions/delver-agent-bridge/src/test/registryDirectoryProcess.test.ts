/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it } from 'node:test';
import { prepareWindowsRendezvousRegistryDirectory, registryDirectoryEnvironment } from '../relayProcess';
import { resolveRendezvousRegistryDirectory } from '../rendezvousRegistry';
import { TestRelayProcess, TestRelayTimers } from './relayTestUtils';

const ENVIRONMENT: NodeJS.ProcessEnv = {
	LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local',
	SystemRoot: 'C:\\Windows',
	DELVER_SESSION: 'must-not-leak',
};
const DIRECTORY = resolveRendezvousRegistryDirectory('win32', ENVIRONMENT);
const READY = '{"event":"registryDirectoryReady","schemaVersion":1}\n';

describe('Windows rendezvous directory process', () => {
	it('uses exact arguments and a credential-free environment, then waits for readiness and clean exit', async () => {
		const fixture = createFixture();
		let settled = false;
		fixture.preparation.then(() => settled = true);
		fixture.process.emitStderr(READY.slice(0, 12));
		fixture.process.emitStderr(READY.slice(12));
		await settlePromises();
		assert.strictEqual(settled, false);
		fixture.process.emitExit(0);
		await fixture.preparation;

		assert.deepStrictEqual(fixture.spawnCalls, [{
			executable: 'C:\\Delver\\delver-agent-relay.exe',
			args: ['--prepare-registry-directory'],
			environment: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: ENVIRONMENT.LOCALAPPDATA },
		}]);
		assert.strictEqual(JSON.stringify(fixture.spawnCalls).includes('must-not-leak'), false);
		assert.strictEqual(fixture.process.terminateCount, 0);
	});

	it('rejects malformed, extended, oversized, and nonzero helper results', async () => {
		for (const send of [
			(process: TestRelayProcess) => { process.emitStderr('{"event":"wrong","schemaVersion":1}\n'); process.emitExit(0); },
			(process: TestRelayProcess) => { process.emitStderr(READY + 'extra\n'); process.emitExit(0); },
			(process: TestRelayProcess) => process.emitStderr(Buffer.alloc(4 * 1024 + 1)),
			(process: TestRelayProcess) => { process.emitStderr(READY); process.emitExit(1); },
			(process: TestRelayProcess) => process.emitExit(0),
		]) {
			const fixture = createFixture();
			send(fixture.process);
			await assert.rejects(fixture.preparation);
			assert.strictEqual(fixture.process.terminateCount, 1);
		}
	});

	it('rejects any stdout bytes, process errors, timeout, and cancellation', async () => {
		const stdout = createFixture();
		stdout.process.emitStdout('unexpected');
		await assert.rejects(stdout.preparation, /stdout/);

		const failed = createFixture();
		failed.process.emitError();
		await assert.rejects(failed.preparation, /failed/);

		const timedOut = createFixture();
		timedOut.timers.runDelay(5_000);
		await assert.rejects(timedOut.preparation, /timed out/);

		const abortController = new AbortController();
		const cancelled = createFixture(abortController.signal);
		abortController.abort();
		await assert.rejects(cancelled.preparation, /cancelled/);

		assert.deepStrictEqual([
			stdout.process.terminateCount,
			failed.process.terminateCount,
			timedOut.process.terminateCount,
			cancelled.process.terminateCount,
		], [1, 1, 1, 1]);
	});

	it('fails before spawn for a mismatched path, platform, or pre-cancelled request', async () => {
		let spawnCount = 0;
		const spawn = () => {
			spawnCount++;
			return new TestRelayProcess();
		};
		await assert.rejects(prepareWindowsRendezvousRegistryDirectory('C:\\Delver\\relay.exe', 'C:\\wrong', {
			platform: 'win32', environment: ENVIRONMENT, spawn,
		}), /deterministic registry path/);
		await assert.rejects(prepareWindowsRendezvousRegistryDirectory('C:\\Delver\\relay.exe', DIRECTORY, {
			platform: 'linux', environment: ENVIRONMENT, spawn,
		}), /only supported on Windows/);
		const abortController = new AbortController();
		abortController.abort();
		await assert.rejects(prepareWindowsRendezvousRegistryDirectory('C:\\Delver\\relay.exe', DIRECTORY, {
			platform: 'win32', environment: ENVIRONMENT, spawn, signal: abortController.signal,
		}), /cancelled/);
		assert.strictEqual(spawnCount, 0);
	});

	it('whitelists only Windows boot paths and LOCALAPPDATA', () => {
		assert.deepStrictEqual(registryDirectoryEnvironment(ENVIRONMENT), {
			SystemRoot: 'C:\\Windows',
			LOCALAPPDATA: ENVIRONMENT.LOCALAPPDATA,
		});
	});

	it('activates only the production composition after startup', () => {
		const extensionRoot = path.resolve(__dirname, '..', '..');
		const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')) as {
			activationEvents?: readonly string[];
			capabilities?: { readonly virtualWorkspaces?: boolean };
		};
		const extensionSource = fs.readFileSync(path.join(extensionRoot, 'src', 'extension.ts'), 'utf8');
		assert.deepStrictEqual({ activationEvents: manifest.activationEvents, virtualWorkspaces: manifest.capabilities?.virtualWorkspaces }, {
			activationEvents: ['onStartupFinished'],
			virtualWorkspaces: false,
		});
		assert.match(extensionSource, /DelverAgentBridgeActivation|DelverAgentBridgeRuntime/);
		assert.doesNotMatch(extensionSource, /prepareWindowsRendezvousRegistryDirectory|FileRendezvousRegistry|DelverBootstrapRelayManager|DelverWindowRendezvousLifecycle|BootstrapApprovalController/);
	});
});

function createFixture(signal?: AbortSignal) {
	const process = new TestRelayProcess();
	const timers = new TestRelayTimers();
	const spawnCalls: { readonly executable: string; readonly args: readonly string[]; readonly environment: NodeJS.ProcessEnv }[] = [];
	const preparation = prepareWindowsRendezvousRegistryDirectory(
		'C:\\Delver\\delver-agent-relay.exe',
		DIRECTORY,
		{
			platform: 'win32',
			environment: ENVIRONMENT,
			signal,
			timers,
			spawn: (executable, args, environment) => {
				spawnCalls.push({ executable, args, environment });
				return process;
			},
		},
	);
	return { preparation, process, timers, spawnCalls };
}

async function settlePromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
