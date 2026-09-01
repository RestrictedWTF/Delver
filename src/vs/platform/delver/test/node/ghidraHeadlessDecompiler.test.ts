/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { promises as fs } from 'fs';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createGhidraInvocation, discoverGhidraHeadless, resolveGhidraScriptPath } from '../../node/ghidraHeadlessDecompiler.js';
import { getDevGhidraScriptsDir, getStagedGhidraScriptsDir, resolveGhidraScript } from '../../node/delverBinaries.js';
import * as path from '../../../../base/common/path.js';

suite('GhidraHeadlessDecompiler', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('discovers the platform launcher and bundled script', () => {
		const existing = new Set([
			'C:\\ghidra\\support\\analyzeHeadless.bat',
			'D:\\delver\\scripts\\DelverDecompile.java',
		]);

		assert.deepStrictEqual(
			discoverGhidraHeadless('C:\\ghidra', 'D:\\delver\\scripts\\DelverDecompile.java', 'win32', candidate => existing.has(candidate)),
			{
				available: true,
				installation: {
					home: 'C:\\ghidra',
					launcherPath: 'C:\\ghidra\\support\\analyzeHeadless.bat',
					scriptPath: 'D:\\delver\\scripts\\DelverDecompile.java',
				},
			},
		);
	});

	test('reports missing configuration without probing the path', () => {
		let probes = 0;
		const discovery = discoverGhidraHeadless(undefined, 'DelverDecompile.java', 'linux', () => {
			probes++;
			return false;
		});

		assert.deepStrictEqual({ available: discovery.available, probes }, { available: false, probes: 0 });
	});

	test('builds a direct argument-vector invocation on Unix', () => {
		const invocation = createGhidraInvocation(
			{ home: '/opt/ghidra', launcherPath: '/opt/ghidra/support/analyzeHeadless', scriptPath: '/delver/scripts/DelverDecompile.java' },
			'/samples/name with spaces;$(touch nope)',
			'0x1000',
			'/tmp/delver-run',
			'/tmp/delver-run/decompiled.json',
			'linux',
		);

		assert.deepStrictEqual({ command: invocation.command, args: invocation.args, cwd: invocation.options.cwd }, {
			command: '/opt/ghidra/support/analyzeHeadless',
			args: [
				'/tmp/delver-run', 'delver',
				'-import', '/samples/name with spaces;$(touch nope)',
				'-scriptPath', '/delver/scripts',
				'-postScript', 'DelverDecompile.java', '0x1000', '/tmp/delver-run/decompiled.json',
				'-deleteProject',
			],
			cwd: '/tmp/delver-run',
		});
	});

	test('keeps Windows paths out of the command string', () => {
		const invocation = createGhidraInvocation(
			{ home: 'C:\\ghidra', launcherPath: 'C:\\ghidra & tools\\support\\analyzeHeadless.bat', scriptPath: 'D:\\delver\\scripts\\DelverDecompile.java' },
			'D:\\samples\\percent%PATH% & sample.exe',
			'0x1000',
			'C:\\Temp\\delver-run',
			'C:\\Temp\\delver-run\\decompiled.json',
			'win32',
			'C:\\Windows\\System32\\cmd.exe',
		);
		const environment = invocation.options.env;

		assert.deepStrictEqual({
			command: invocation.command,
			args: invocation.args,
			launcher: environment?.DELVER_GHIDRA_LAUNCHER,
			target: environment?.DELVER_GHIDRA_TARGET,
		}, {
			command: 'C:\\Windows\\System32\\cmd.exe',
			args: ['/d', '/q', '/v:off', '/c', 'delver-ghidra.cmd'],
			launcher: 'C:\\ghidra & tools\\support\\analyzeHeadless.bat',
			target: 'D:\\samples\\percent%PATH% & sample.exe',
		});
	});

	test('uses the pinned Ghidra 12.1 HighSymbol storage API', async () => {
		const script = await fs.readFile(resolveGhidraScriptPath(), 'utf8');
		assert.ok(script.includes('variable.getStorage()'));
		assert.ok(!script.includes('variable.getVariableStorage()'));
	});

	test('resolves the checkout script in a dev tree and the staged copy in a package', () => {
		assert.deepStrictEqual(
			{
				dev: resolveGhidraScript('DelverDecompile.java', () => true),
				packaged: resolveGhidraScript('DelverDecompile.java', () => false),
			},
			{
				dev: path.join(getDevGhidraScriptsDir(), 'DelverDecompile.java'),
				packaged: path.join(getStagedGhidraScriptsDir(), 'DelverDecompile.java'),
			},
		);
	});

	test('the staged script directory sits under resources/delver', () => {
		assert.deepStrictEqual(
			[
				getStagedGhidraScriptsDir().split(/[\\/]/).slice(-3),
				getDevGhidraScriptsDir().split(/[\\/]/).slice(-2),
			],
			[['resources', 'delver', 'ghidra'], ['scripts', 'ghidra']],
		);
	});
});
