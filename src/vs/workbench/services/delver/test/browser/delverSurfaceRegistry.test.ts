/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { DelverZone, IDelverSurface } from '../../browser/delverSurface.js';
import { DelverSurfaceRegistry, IDelverSurfaceDescriptor, surfacesForZone } from '../../browser/delverSurfaceRegistry.js';

function descriptor(id: string, zone: DelverZone, order: number): IDelverSurfaceDescriptor {
	return {
		id,
		title: { value: id, original: id },
		zone,
		order,
		ctor: new SyncDescriptor<IDelverSurface>(class { } as never),
	};
}

suite('Delver surface registry', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('selects one zone and orders within it, ignoring registration order', () => {
		const all = [
			descriptor('strings', DelverZone.Navigator, 20),
			descriptor('xrefs', DelverZone.Inspector, 10),
			descriptor('functions', DelverZone.Navigator, 10),
			descriptor('listing', DelverZone.Primary, 10),
			descriptor('sections', DelverZone.Navigator, 30),
		];

		assert.deepStrictEqual(
			surfacesForZone(all, DelverZone.Navigator).map(s => s.id),
			['functions', 'strings', 'sections'],
		);
	});

	test('breaks order ties by id so the segment sequence is stable across sessions', () => {
		const all = [
			descriptor('exports', DelverZone.Navigator, 10),
			descriptor('imports', DelverZone.Navigator, 10),
		];

		assert.deepStrictEqual(
			surfacesForZone(all, DelverZone.Navigator).map(s => s.id),
			['exports', 'imports'],
		);
	});

	test('filters descriptors whose when clause does not match', () => {
		const enabled = { ...descriptor('enabled', DelverZone.Navigator, 10), when: ContextKeyExpr.has('enabled') };
		const disabled = { ...descriptor('disabled', DelverZone.Navigator, 20), when: ContextKeyExpr.has('disabled') };

		assert.deepStrictEqual(
			surfacesForZone([enabled, disabled], DelverZone.Navigator, expression => expression === enabled.when).map(surface => surface.id),
			['enabled'],
		);
	});

	test('rejects duplicate ids at registration and removes disposed descriptors', () => {
		const registry = disposables.add(new DelverSurfaceRegistry());
		const registration = disposables.add(registry.register(descriptor('functions', DelverZone.Navigator, 10)));

		assert.throws(
			() => registry.register(descriptor('functions', DelverZone.Inspector, 20)),
			/A Delver surface with id 'functions' is already registered/,
		);
		registration.dispose();
		assert.deepStrictEqual(registry.all(), []);
	});
});
