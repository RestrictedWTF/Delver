/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ISearchComplete, ISearchService } from '../../../../services/search/common/search.js';
import { IDelverSessionService } from '../../../../services/delver/common/delverSessionService.js';
import { DelverProjectAutoOpenContribution } from '../../browser/delverListing.contribution.js';

suite('Delver project auto-open contribution', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('disposing cancels the scan instead of opening a project into a window that is going away', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		let searchToken: CancellationToken | undefined;
		let finishSearch: (() => void) | undefined;
		const search = new Promise<ISearchComplete>(resolve => {
			finishSearch = () => resolve({
				results: [{ resource: URI.file('/repo/sample.delverdb') }],
				messages: [],
			});
		});
		let openedProject = false;

		instantiationService.stub(ISearchService, {
			fileSearch: (_query, token) => {
				searchToken = token;
				return search;
			},
		});
		instantiationService.stub(IDelverSessionService, {
			activeSession: undefined,
			openProject: async () => {
				openedProject = true;
				return { targetPath: 'sample.exe', contentHash: 'a'.repeat(64) };
			},
		});

		// A workspace-wide glob outlives a window closed right after restore. The
		// scan is still in flight when the contribution goes, and its continuation
		// opens a project and an editor — work that must not land afterwards.
		const contribution = instantiationService.createInstance(DelverProjectAutoOpenContribution);
		contribution.dispose();
		finishSearch!();
		await search;
		// One turn for the awaiting continuation, so a missing guard would have
		// had its chance to open the project before the assertion runs.
		await Promise.resolve();

		assert.deepStrictEqual(
			{ cancelled: searchToken?.isCancellationRequested, openedProject },
			{ cancelled: true, openedProject: false },
		);
	});
});
