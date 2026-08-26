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
import { IDelverSurfaceContext, IDelverSurfaceDescriptor } from '../../../../services/delver/browser/delverSurfaceRegistry.js';
import { IDelverFocus } from '../../../../services/delver/common/delverFocusService.js';
import { DelverWorkspaceZone } from '../../browser/delverWorkspaceZone.js';

class RecordingSurface extends Disposable implements IDelverSurface {
	readonly layouts: Dimension[] = [];
	readonly visibility: boolean[] = [];

	render(_container: HTMLElement): void { }
	layout(dimension: Dimension): void { this.layouts.push(dimension); }
	setVisible(visible: boolean): void { this.visibility.push(visible); }
	focus(): void { }
}

function surfaceContext(targetPath: string): IDelverSurfaceContext {
	return { targetPath, focus: { moment: { kind: 'file' } } as unknown as IDelverFocus };
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

	test('a hidden zone binds no context, and cancels a binding still in flight', () => {
		const bindings: { key: string; cancelled: () => boolean }[] = [];
		const contextual: IDelverSurfaceDescriptor = {
			...descriptor('listing', DelverZone.Primary),
			contextKey: context => context.targetPath,
			setContext: (_surface, context, token) => {
				bindings.push({ key: context.targetPath, cancelled: () => token.isCancellationRequested });
				// Never settles: a real binding is an async analysis request, and
				// the point here is what happens to it when the zone hides.
				return new Promise<void>(() => { });
			},
		};
		const zone = disposables.add(new DelverWorkspaceZone('Primary', 360, () => new RecordingSurface(), () => { }));
		zone.setDescriptors([contextual]);

		zone.setZoneVisible(false);
		zone.setContext(surfaceContext('a.exe'));
		const boundWhileHidden = bindings.length;

		zone.setZoneVisible(true);
		const boundWhenShown = bindings.length;

		zone.setZoneVisible(false);

		assert.deepStrictEqual({
			boundWhileHidden,
			boundWhenShown,
			inFlightCancelledOnHide: bindings.at(-1)?.cancelled(),
		}, {
			// Hidden zones must not issue analysis requests for a workspace
			// nobody is looking at, and a request already running must not land
			// into a surface that has since been hidden.
			boundWhileHidden: 0,
			boundWhenShown: 1,
			inFlightCancelledOnHide: true,
		});
	});

	test('a binding cancelled mid-flight is re-issued when the zone comes back', () => {
		let bindCount = 0;
		const contextual: IDelverSurfaceDescriptor = {
			...descriptor('listing', DelverZone.Primary),
			contextKey: context => context.targetPath,
			setContext: () => { bindCount++; return new Promise<void>(() => { }); },
		};
		const zone = disposables.add(new DelverWorkspaceZone('Primary', 360, () => new RecordingSurface(), () => { }));
		zone.setDescriptors([contextual]);
		zone.setZoneVisible(true);
		zone.setContext(surfaceContext('a.exe'));

		// Hidden while the binding is still running, then shown again with the
		// same context. The surface never received it, so it must be re-issued —
		// the memo that suppresses redundant binds must not outlive a cancel.
		zone.setZoneVisible(false);
		zone.setZoneVisible(true);

		assert.strictEqual(bindCount, 2);
	});

	test('re-showing with unchanged context does not re-issue the binding', () => {
		let bindCount = 0;
		const contextual: IDelverSurfaceDescriptor = {
			...descriptor('listing', DelverZone.Primary),
			contextKey: context => context.targetPath,
			setContext: () => { bindCount++; },
		};
		const zone = disposables.add(new DelverWorkspaceZone('Primary', 360, () => new RecordingSurface(), () => { }));
		zone.setDescriptors([contextual]);
		zone.setZoneVisible(true);

		zone.setContext(surfaceContext('a.exe'));
		zone.setContext(surfaceContext('a.exe'));
		const afterSameContext = bindCount;
		zone.setContext(surfaceContext('b.exe'));

		assert.deepStrictEqual({ afterSameContext, afterNewContext: bindCount }, { afterSameContext: 1, afterNewContext: 2 });
	});
});
