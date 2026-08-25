/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Dimension } from '../../../../../base/browser/dom.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITreeView } from '../../../../common/views.js';
import { DelverTreeSurface } from '../../browser/delverTreeSurface.js';

interface ITreeViewCall {
	readonly method: string;
	readonly args: readonly unknown[];
}

function recordingTreeView(calls: ITreeViewCall[]): ITreeView {
	return {
		show: (container: unknown) => calls.push({ method: 'show', args: [container] }),
		layout: (height: number, width: number) => calls.push({ method: 'layout', args: [height, width] }),
		setVisibility: (visible: boolean) => calls.push({ method: 'setVisibility', args: [visible] }),
		focus: () => calls.push({ method: 'focus', args: [] }),
	} as unknown as ITreeView;
}

suite('Delver tree surface', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('forwards the surface contract onto the tree view, splitting the dimension', () => {
		const calls: ITreeViewCall[] = [];
		const surface = new DelverTreeSurface(recordingTreeView(calls));
		const container = document.createElement('div');

		surface.render(container);
		surface.layout(new Dimension(320, 240));
		surface.setVisible(false);
		surface.focus();
		surface.dispose();

		// The trailing setVisibility(false) is the point of the last assertion:
		// a disposed surface must stop responding to the focus bus, or a zone
		// that swapped segments keeps a dead tree reacting to navigation.
		assert.deepStrictEqual(calls, [
			{ method: 'show', args: [container] },
			{ method: 'layout', args: [240, 320] },
			{ method: 'setVisibility', args: [false] },
			{ method: 'focus', args: [] },
			{ method: 'setVisibility', args: [false] },
		]);
	});
});
