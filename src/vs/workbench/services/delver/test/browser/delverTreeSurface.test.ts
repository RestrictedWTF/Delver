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

/**
 * A stand-in that reproduces the one coupling this adapter can get wrong.
 *
 * The real `TreeView` builds its `domNode` inside `initialize()`, reachable only
 * from `setVisibility()`. A `show()` before that appends `undefined` and the
 * tree is never attached — silently, because `Node.append` stringifies. So this
 * fake records whether it had been initialized at the moment `show()` arrived,
 * and tracks `container` the way the real one does, which is what the disposal
 * guard reads. A fake without those two properties cannot fail this test.
 */
function recordingTreeView(calls: ITreeViewCall[]): ITreeView {
	let initialized = false;
	let container: HTMLElement | undefined;
	return {
		get container() {
			return container;
		},
		show: (target: HTMLElement) => {
			container = target;
			calls.push({ method: 'show', args: [initialized ? 'initialized' : 'UNINITIALIZED'] });
		},
		setVisibility: (visible: boolean) => {
			initialized = true;
			calls.push({ method: 'setVisibility', args: [visible] });
		},
		layout: (height: number, width: number) => calls.push({ method: 'layout', args: [height, width] }),
		focus: () => calls.push({ method: 'focus', args: [] }),
	} as unknown as ITreeView;
}

suite('Delver tree surface', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('initializes the tree before showing it, and forwards the surface contract', () => {
		const calls: ITreeViewCall[] = [];
		const surface = new DelverTreeSurface(recordingTreeView(calls));
		const container = document.createElement('div');

		surface.render(container);
		surface.layout(new Dimension(320, 240));
		surface.setVisible(true);
		surface.focus();
		surface.dispose();

		assert.deepStrictEqual(calls, [
			// Construction forces initialization, so `show` finds a real domNode.
			{ method: 'setVisibility', args: [false] },
			{ method: 'show', args: ['initialized'] },
			{ method: 'layout', args: [240, 320] },
			{ method: 'setVisibility', args: [true] },
			{ method: 'focus', args: [] },
			// Disposal hides the tree: a zone that swapped segments must not
			// leave a dead tree responding to the focus bus.
			{ method: 'setVisibility', args: [false] },
		]);
	});

	test('disposal leaves a tree alone once another host has taken it over', () => {
		const calls: ITreeViewCall[] = [];
		const treeView = recordingTreeView(calls);
		const surface = new DelverTreeSurface(treeView);

		surface.render(document.createElement('div'));
		// A second host claims the same shared tree view, re-parenting it.
		treeView.show(document.createElement('div'));
		calls.length = 0;

		surface.dispose();

		assert.deepStrictEqual(calls, []);
	});
});
