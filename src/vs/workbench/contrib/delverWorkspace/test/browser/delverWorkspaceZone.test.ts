/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Dimension } from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { DelverZone, IDelverSurface } from '../../../../services/delver/browser/delverSurface.js';
import { IDelverSurfaceDescriptor } from '../../../../services/delver/browser/delverSurfaceRegistry.js';
import { DelverWorkspaceZone } from '../../browser/delverWorkspaceZone.js';

class RecordingSurface extends Disposable implements IDelverSurface {
	readonly layouts: Dimension[] = [];
	readonly visibility: boolean[] = [];

	render(_container: HTMLElement): void { }
	layout(dimension: Dimension): void { this.layouts.push(dimension); }
	setVisible(visible: boolean): void { this.visibility.push(visible); }
	focus(): void { }
}

function descriptor(id: string, zone: DelverZone): IDelverSurfaceDescriptor {
	return {
		id,
		title: { value: id, original: id },
		zone,
		order: 10,
		ctor: new SyncDescriptor<IDelverSurface>(RecordingSurface),
	};
}

suite('Delver workspace zone', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('switching one zone does not relayout another zone', () => {
		const surfaces = new Map<string, RecordingSurface>();
		const create = (value: IDelverSurfaceDescriptor) => {
			const surface = new RecordingSurface();
			surfaces.set(value.id, surface);
			return surface;
		};
		const navigator = disposables.add(new DelverWorkspaceZone('Navigator', 180, create, id => navigator.show([id])));
		const inspector = disposables.add(new DelverWorkspaceZone('Inspector', 220, create, id => inspector.show([id])));
		navigator.setDescriptors([descriptor('functions', DelverZone.Navigator), descriptor('strings', DelverZone.Navigator)]);
		inspector.setDescriptors([descriptor('xrefs', DelverZone.Inspector)]);
		navigator.layout(240, 0, 600);
		inspector.layout(280, 0, 600);
		const inspectorLayoutsBeforeSwitch = surfaces.get('xrefs')!.layouts.length;

		navigator.show(['strings']);

		assert.deepStrictEqual({
			functions: surfaces.get('functions')!.visibility,
			strings: surfaces.get('strings')!.visibility,
			inspectorLayoutsBeforeSwitch,
			inspectorLayoutsAfterSwitch: surfaces.get('xrefs')!.layouts.length,
			inspectorLastLayout: surfaces.get('xrefs')!.layouts.at(-1),
		}, {
			functions: [false, true, false],
			strings: [false, false, true],
			inspectorLayoutsBeforeSwitch: 1,
			inspectorLayoutsAfterSwitch: 1,
			inspectorLastLayout: new Dimension(280, 568),
		});
	});
});
