/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it } from 'node:test';
import { encodeRendezvousRegistryEntry, FileRendezvousRegistry, IRendezvousRegistryEntry, parseRendezvousRegistryEntry, RENDEZVOUS_MAX_ENTRY_BYTES, resolveRendezvousRegistryDirectory } from '../rendezvousRegistry';

const ENTRY: IRendezvousRegistryEntry = {
	schemaVersion: 1,
	bootstrapProtocolVersion: 1,
	registryEntryId: 'registry_entry_0001',
	windowInstanceId: 'window_instance_0001',
	rootFingerprint: 'a'.repeat(64),
	bootstrapEndpoint: 'pipe://delver-bootstrap-0001',
	ownerProcessId: 4242,
	publishedAt: 1_000,
	expiresAt: 31_000,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => fs.promises.rm(directory, { recursive: true, force: true })));
});

describe('Rendezvous registry', () => {
	it('publishes one bounded non-secret entry atomically and disposes it idempotently', async () => {
		const fixture = await createFixture();
		const publication = await fixture.registry.publish(ENTRY);
		const names = await fs.promises.readdir(fixture.directory);
		const raw = await fs.promises.readFile(path.join(fixture.directory, `${ENTRY.registryEntryId}.json`));

		assert.deepStrictEqual(names, [`${ENTRY.registryEntryId}.json`]);
		assert.ok(raw.length <= RENDEZVOUS_MAX_ENTRY_BYTES);
		assert.deepStrictEqual(JSON.parse(raw.toString('utf8')), ENTRY);
		for (const forbidden of ['token', 'leaseId', 'clientNonce', 'displayName', 'workspacePath', 'targetPath']) {
			assert.ok(!raw.toString('utf8').includes(forbidden));
		}
		assert.deepStrictEqual(await fixture.registry.list(2_000), [ENTRY]);

		await publication.dispose();
		await publication.dispose();
		assert.deepStrictEqual(await fs.promises.readdir(fixture.directory), []);
	});

	it('allows two windows to publish without locking and removes only the owned generation', async () => {
		const fixture = await createFixture();
		const second = { ...ENTRY, registryEntryId: 'registry_entry_0002', windowInstanceId: 'window_instance_0002' };
		const [firstPublication, secondPublication] = await Promise.all([
			fixture.registry.publish(ENTRY),
			fixture.registry.publish(second),
		]);

		assert.deepStrictEqual((await fixture.registry.list(2_000)).map(entry => entry.registryEntryId), [ENTRY.registryEntryId, second.registryEntryId]);
		await firstPublication.dispose();
		assert.deepStrictEqual((await fixture.registry.list(2_000)).map(entry => entry.registryEntryId), [second.registryEntryId]);
		await secondPublication.dispose();
	});

	it('fails a final-name collision without replacing the existing entry', async () => {
		const fixture = await createFixture();
		const finalPath = path.join(fixture.directory, `${ENTRY.registryEntryId}.json`);
		await fs.promises.writeFile(finalPath, 'existing');

		await assert.rejects(fixture.registry.publish(ENTRY));
		assert.strictEqual(await fs.promises.readFile(finalPath, 'utf8'), 'existing');
		assert.deepStrictEqual((await fs.promises.readdir(fixture.directory)).filter(name => name.startsWith('.tmp-')), []);
	});

	it('ignores malformed, mismatched, future, expired, temporary, and oversized records', async () => {
		const fixture = await createFixture();
		await writeEntry(fixture.directory, ENTRY);
		await writeEntry(fixture.directory, { ...ENTRY, registryEntryId: 'registry_entry_0002', publishedAt: 5_000, expiresAt: 10_000 });
		await writeEntry(fixture.directory, { ...ENTRY, registryEntryId: 'registry_entry_0003', publishedAt: 0, expiresAt: 1_500 });
		await fs.promises.writeFile(path.join(fixture.directory, 'registry_entry_0004.json'), encodeRendezvousRegistryEntry({ ...ENTRY, registryEntryId: 'registry_entry_9999' }, 'win32'));
		await fs.promises.writeFile(path.join(fixture.directory, 'registry_entry_0005.json'), '{bad json');
		await fs.promises.writeFile(path.join(fixture.directory, 'registry_entry_0006.json'), Buffer.alloc(RENDEZVOUS_MAX_ENTRY_BYTES + 1));
		await fs.promises.writeFile(path.join(fixture.directory, '.tmp-temporary_entry_01.json'), encodeRendezvousRegistryEntry(ENTRY, 'win32'));

		assert.deepStrictEqual((await fixture.registry.list(2_000)).map(entry => entry.registryEntryId), [ENTRY.registryEntryId]);
	});

	it('prunes only well-formed expired entries and old temporary files', async () => {
		const fixture = await createFixture();
		const active = { ...ENTRY, publishedAt: 60_000, expiresAt: 90_000 };
		const expired = { ...ENTRY, registryEntryId: 'registry_entry_0002', publishedAt: 0, expiresAt: 1_000 };
		await writeEntry(fixture.directory, active);
		await writeEntry(fixture.directory, expired);
		const malformed = path.join(fixture.directory, 'registry_entry_0003.json');
		const temporary = path.join(fixture.directory, '.tmp-temporary_entry_01.json');
		await fs.promises.writeFile(malformed, '{bad json');
		await fs.promises.writeFile(temporary, 'partial');
		await fs.promises.utimes(temporary, new Date(0), new Date(0));

		await fixture.registry.prune(70_000);

		assert.deepStrictEqual((await fs.promises.readdir(fixture.directory)).sort(), [`${active.registryEntryId}.json`, path.basename(malformed)].sort());
	});

	it('strictly parses the schema and resolves one deterministic client-neutral path per OS', () => {
		assert.deepStrictEqual(parseRendezvousRegistryEntry(encodeRendezvousRegistryEntry(ENTRY, 'win32'), 'win32'), ENTRY);
		assert.throws(() => parseRendezvousRegistryEntry(Buffer.from(JSON.stringify({ ...ENTRY, token: 'secret' })), 'win32'));
		assert.throws(() => encodeRendezvousRegistryEntry({ ...ENTRY, bootstrapEndpoint: 'unix:///tmp/wrong' }, 'win32'));
		assert.deepStrictEqual({
			windows: resolveRendezvousRegistryDirectory('win32', { LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' }, '/unused'),
			linux: resolveRendezvousRegistryDirectory('linux', { XDG_STATE_HOME: '/state/alice' }, '/home/alice'),
			linuxFallback: resolveRendezvousRegistryDirectory('linux', {}, '/home/alice'),
			mac: resolveRendezvousRegistryDirectory('darwin', {}, '/Users/alice'),
		}, {
			windows: 'C:\\Users\\Alice\\AppData\\Local\\Delver\\agent-rendezvous\\v1\\entries',
			linux: '/state/alice/delver/agent-rendezvous/v1/entries',
			linuxFallback: '/home/alice/.local/state/delver/agent-rendezvous/v1/entries',
			mac: '/Users/alice/Library/Application Support/Delver/agent-rendezvous/v1/entries',
		});
		assert.throws(() => resolveRendezvousRegistryDirectory('win32', { LOCALAPPDATA: 'relative' }, '/unused'));
		assert.throws(() => resolveRendezvousRegistryDirectory('linux', { XDG_STATE_HOME: 'relative' }, '/home/alice'));
	});

	it('rejects non-string identity fields a pattern test would silently coerce', () => {
		const coercions = [
			{ registryEntryId: 9_007_199_254_740_991 },
			{ windowInstanceId: ['window_instance_0001'] },
			{ rootFingerprint: ['a'.repeat(64)] },
		];

		assert.deepStrictEqual(coercions.map(coercion => {
			try {
				parseRendezvousRegistryEntry(Buffer.from(JSON.stringify({ ...ENTRY, ...coercion })), 'win32');
				return 'accepted';
			} catch {
				return 'rejected';
			}
		}), ['rejected', 'rejected', 'rejected']);
	});

	it('fails closed on Windows without an audited directory ACL provider', async () => {
		const root = await createTemporaryDirectory();
		const registry = new FileRendezvousRegistry({ directory: path.join(root, 'entries'), platform: 'win32' });
		await assert.rejects(registry.publish(ENTRY), /protected Windows rendezvous directory provider/);
	});
});

async function createFixture() {
	const root = await createTemporaryDirectory();
	const directory = path.join(root, 'entries');
	const registry = new FileRendezvousRegistry({
		directory,
		platform: 'win32',
		prepareDirectory: async candidate => {
			await fs.promises.mkdir(candidate, { recursive: true });
		},
	});
	await fs.promises.mkdir(directory, { recursive: true });
	return { directory, registry };
}

async function createTemporaryDirectory(): Promise<string> {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'delver-rendezvous-test-'));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeEntry(directory: string, entry: IRendezvousRegistryEntry): Promise<void> {
	await fs.promises.writeFile(path.join(directory, `${entry.registryEntryId}.json`), encodeRendezvousRegistryEntry(entry, 'win32'));
}
