/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'node:test';
import { prepareWindowsRendezvousRegistryDirectory, resolveRelayExecutable } from '../relayProcess';
import { FileRendezvousRegistry, IRendezvousRegistryEntry, resolveRendezvousRegistryDirectory } from '../rendezvousRegistry';

describe('Windows rendezvous directory process integration', () => {
	it('prepares and reaudits a real protected hierarchy before registry publication', { skip: process.platform !== 'win32' }, async context => {
		let executable: string;
		try {
			executable = resolveRelayExecutable(path.resolve(__dirname, '..', '..'));
		} catch (error) {
			if (process.env.DELVER_REQUIRE_RELAY_INTEGRATION === '1') {
				throw error;
			}
			context.skip('The staged Delver relay executable is unavailable.');
			return;
		}

		const localAppData = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'delver-registry-helper-test-'));
		const environment = { ...process.env, LOCALAPPDATA: localAppData };
		const directory = resolveRendezvousRegistryDirectory('win32', environment);
		const prepare = () => prepareWindowsRendezvousRegistryDirectory(executable, directory, { environment });
		try {
			await prepare();
			await prepare();
			const registry = new FileRendezvousRegistry({ directory, platform: 'win32', prepareDirectory: prepare });
			const entry: IRendezvousRegistryEntry = {
				schemaVersion: 1,
				bootstrapProtocolVersion: 1,
				registryEntryId: 'integration_entry_0001',
				windowInstanceId: 'integration_window_0001',
				rootFingerprint: 'a'.repeat(64),
				bootstrapEndpoint: 'pipe://integration-bootstrap',
				ownerProcessId: process.pid,
				publishedAt: 1_000,
				expiresAt: 31_000,
			};
			const publication = await registry.publish(entry);
			assert.deepStrictEqual(await registry.list(2_000), [entry]);
			await publication.dispose();
			assert.deepStrictEqual(await registry.list(2_000), []);
		} finally {
			await fs.promises.rm(localAppData, { recursive: true, force: true });
		}
	});
});
