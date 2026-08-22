/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as path from 'path';
import { describe, it } from 'node:test';
import {
	buildMcpClientConfiguration,
	describeMcpClientConfiguration,
	resolveMcpAdapterExecutable,
	serializeMcpClientConfiguration,
} from '../clientConfiguration';
import { IWorkspaceRootV1Selection } from '../rootFingerprint';

const extensionPath = path.resolve('repo', 'extensions', 'delver-agent-bridge');
const applicationRoot = path.resolve(extensionPath, '..', '..');
const developmentAdapter = path.join(applicationRoot, 'delver', 'target', 'debug', 'delver-mcp.exe');
const packagedAdapter = path.join(applicationRoot, 'resources', 'delver', 'bin', 'win32', 'delver-mcp.exe');
const rootPath = path.resolve('samples', 'auto-updater');

function selection(overrides: Partial<IWorkspaceRootV1Selection> = {}): IWorkspaceRootV1Selection {
	return {
		roots: [{ scheme: 'file', authority: undefined, fsPath: rootPath }],
		remoteName: undefined,
		workspaceFileScheme: undefined,
		trusted: true,
		...overrides,
	};
}

describe('Delver MCP client configuration', () => {
	it('binds the adapter to one absolute root and an optional untrusted label', () => {
		assert.deepStrictEqual([
			buildMcpClientConfiguration({ executable: packagedAdapter, rootPath }),
			buildMcpClientConfiguration({ executable: packagedAdapter, rootPath, displayName: '  Codex  ', serverName: 'delver-samples' }),
		], [
			{ mcpServers: { delver: { command: packagedAdapter, args: ['--root', rootPath] } } },
			{ mcpServers: { 'delver-samples': { command: packagedAdapter, args: ['--root', rootPath, '--display-name', 'Codex'] } } },
		]);
	});

	it('refuses relative paths, unsafe labels, and oversized labels', () => {
		assert.deepStrictEqual([
			() => buildMcpClientConfiguration({ executable: 'delver-mcp', rootPath }),
			() => buildMcpClientConfiguration({ executable: packagedAdapter, rootPath: 'samples' }),
			() => buildMcpClientConfiguration({ executable: packagedAdapter, rootPath, displayName: 'Codex‮gnitide' }),
			() => buildMcpClientConfiguration({ executable: packagedAdapter, rootPath, displayName: 'c'.repeat(129) }),
			() => buildMcpClientConfiguration({ executable: packagedAdapter, rootPath, serverName: 'del\0ver' }),
		].map(build => {
			try {
				build();
				return 'accepted';
			} catch (error) {
				return (error as Error).message;
			}
		}), [
			'The Delver MCP adapter path must be absolute.',
			'The Delver MCP workspace root must be absolute.',
			'The Delver MCP client display name is invalid.',
			'The Delver MCP client display name is invalid.',
			'The Delver MCP server name is invalid.',
		]);
	});

	it('serializes a pasteable two-space document ending in one newline', () => {
		assert.strictEqual(
			serializeMcpClientConfiguration({ executable: packagedAdapter, rootPath }),
			`{\n  "mcpServers": {\n    "delver": {\n      "command": ${JSON.stringify(packagedAdapter)},\n      "args": [\n        "--root",\n        ${JSON.stringify(rootPath)}\n      ]\n    }\n  }\n}\n`,
		);
	});

	it('resolves only staged adapters and never a PATH fallback', () => {
		assert.deepStrictEqual([
			resolveMcpAdapterExecutable(extensionPath, 'win32', candidate => candidate === developmentAdapter || candidate === packagedAdapter),
			resolveMcpAdapterExecutable(extensionPath, 'win32', candidate => candidate === packagedAdapter),
		], [developmentAdapter, packagedAdapter]);
		assert.throws(
			() => resolveMcpAdapterExecutable(extensionPath, 'linux', () => false),
			/The staged Delver MCP adapter executable is unavailable/,
		);
	});

	it('reports the single reason a window cannot publish a recipe', () => {
		const request = { extensionPath, platform: 'win32' as NodeJS.Platform, exists: (candidate: string) => candidate === packagedAdapter };

		assert.deepStrictEqual([
			describeMcpClientConfiguration({ ...request, selection: selection() }),
			describeMcpClientConfiguration({ ...request, selection: selection({ trusted: false }) }),
			describeMcpClientConfiguration({ ...request, selection: selection({ remoteName: 'ssh-remote' }) }),
			describeMcpClientConfiguration({ ...request, selection: selection({ workspaceFileScheme: 'untitled' }) }),
			describeMcpClientConfiguration({ ...request, selection: selection({ roots: [] }) }),
			describeMcpClientConfiguration({
				...request,
				selection: selection({ roots: [{ scheme: 'file', authority: undefined, fsPath: rootPath }, { scheme: 'file', authority: undefined, fsPath: applicationRoot }] }),
			}),
			describeMcpClientConfiguration({ ...request, selection: selection({ roots: [{ scheme: 'vscode-vfs', authority: 'github', fsPath: rootPath }] }) }),
			describeMcpClientConfiguration({ ...request, platform: 'sunos' as NodeJS.Platform, selection: selection() }),
			describeMcpClientConfiguration({ ...request, selection: selection(), exists: () => false }),
		], [
			{
				kind: 'available',
				configuration: serializeMcpClientConfiguration({ executable: packagedAdapter, rootPath }),
				rootPath,
				executable: packagedAdapter,
			},
			{ kind: 'ineligible', reason: 'untrusted-workspace' },
			{ kind: 'ineligible', reason: 'remote-workspace' },
			{ kind: 'ineligible', reason: 'untitled-workspace' },
			{ kind: 'ineligible', reason: 'no-root' },
			{ kind: 'ineligible', reason: 'multiple-roots' },
			{ kind: 'ineligible', reason: 'non-local-root' },
			{ kind: 'ineligible', reason: 'unsupported-platform' },
			{ kind: 'adapter-missing' },
		]);
	});
});
