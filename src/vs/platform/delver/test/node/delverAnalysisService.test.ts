/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { DelverAnalysisService } from '../../node/delverAnalysisService.js';

suite('DelverAnalysisService decompiler cache', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let testRoot: string;

	setup(async () => {
		testRoot = await fs.mkdtemp(join(tmpdir(), 'delver-decompiler-cache-test-'));
	});

	teardown(async () => {
		await fs.rm(testRoot, { recursive: true, force: true });
	});

	test('measures and clears only the fixed Delver decompiler cache', async () => {
		const cacheRoot = join(testRoot, 'delver', 'decompiler-cache');
		const projectRoot = join(cacheRoot, 'ghidra-12.1', 'analysis-v1', 'hash');
		await fs.mkdir(projectRoot, { recursive: true });
		await fs.writeFile(join(projectRoot, 'sample.gpr'), 'gpr');
		await fs.writeFile(join(projectRoot, 'analysis.bin'), 'data');
		const environmentService: Partial<INativeEnvironmentService> = { userDataPath: testRoot };
		const service = new DelverAnalysisService(environmentService as INativeEnvironmentService);

		try {
			const inventory = await service.decompilerCacheInfo();
			const removed = await service.clearDecompilerCache();
			const after = await service.decompilerCacheInfo();
			assert.deepStrictEqual({ inventory, removed, after }, {
				inventory: { path: cacheRoot, projectCount: 1, fileCount: 2, byteLength: 7 },
				removed: { path: cacheRoot, projectCount: 1, fileCount: 2, byteLength: 7 },
				after: { path: cacheRoot, projectCount: 0, fileCount: 0, byteLength: 0 },
			});
		} finally {
			service.dispose();
		}
	});
});
