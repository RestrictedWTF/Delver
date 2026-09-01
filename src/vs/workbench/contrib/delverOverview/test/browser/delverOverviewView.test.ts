/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IGetImageInfoResult, IOpenImageResult } from '../../../../../platform/delver/common/protocol.generated.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { DelverSurfaceId, DelverZone, IDelverSurface } from '../../../../services/delver/browser/delverSurface.js';
import { allDelverSurfaces, registerDelverSurface, zoneForSurface } from '../../../../services/delver/browser/delverSurfaceRegistry.js';
import { DelverWorkspaceService, IDelverWorkspaceService } from '../../../../services/delver/common/delverWorkspaceService.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { DelverOverviewTreeDataProvider, DELVER_OVERVIEW_GO_TO_COMMAND, DELVER_OVERVIEW_REVEAL_COMMAND } from '../../browser/delverOverviewView.js';
import '../../browser/delverOverview.contribution.js';

suite('Delver overview navigation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('actionable rows preserve addresses and route to their workspace surfaces', async () => {
		const provider = new DelverOverviewTreeDataProvider();
		provider.setContent('C:\\samples\\wide.exe', imageInfo(), openResult());

		const rows = await provider.getChildren();
		assert.deepStrictEqual(
			rows?.map(row => ({
				label: row.label?.label,
				description: row.description,
				command: row.command?.id,
				arguments: row.command?.arguments,
			})),
			[
				{ label: 'File', description: 'wide.exe', command: undefined, arguments: undefined },
				{ label: 'Architecture', description: 'x86_64', command: undefined, arguments: undefined },
				{ label: 'Entry point', description: '0x1000000000000001', command: DELVER_OVERVIEW_GO_TO_COMMAND, arguments: ['0x1000000000000001'] },
				{ label: 'Image base', description: '0x1000000000000000', command: undefined, arguments: undefined },
				{ label: 'Instructions', description: (34_567).toLocaleString(), command: 'delver.listing.openCurrent', arguments: [] },
				{ label: 'Functions', description: '12', command: DELVER_OVERVIEW_REVEAL_COMMAND, arguments: [DelverSurfaceId.Functions] },
				{ label: 'References', description: '123', command: DELVER_OVERVIEW_REVEAL_COMMAND, arguments: [DelverSurfaceId.Xrefs] },
				{ label: 'Strings', description: '89', command: 'delver.strings.open', arguments: [] },
			],
		);
	});

	// A count is only a fact about the sample when the parse ran to the end. A
	// clean image must not pick up completeness clutter it has not earned.
	test('a fully parsed image gains no completeness rows', async () => {
		const provider = new DelverOverviewTreeDataProvider();
		provider.setContent('C:\\samples\\wide.exe', imageInfo(), openResult());

		const rows = await provider.getChildren();
		assert.deepStrictEqual(
			rows?.map(row => ({ label: row.label?.label, description: row.description, tooltip: row.tooltip })),
			[
				{ label: 'File', description: 'wide.exe', tooltip: undefined },
				{ label: 'Architecture', description: 'x86_64', tooltip: undefined },
				{ label: 'Entry point', description: '0x1000000000000001', tooltip: undefined },
				{ label: 'Image base', description: '0x1000000000000000', tooltip: undefined },
				{ label: 'Instructions', description: (34_567).toLocaleString(), tooltip: undefined },
				{ label: 'Functions', description: '12', tooltip: undefined },
				{ label: 'References', description: '123', tooltip: undefined },
				{ label: 'Strings', description: '89', tooltip: undefined },
			],
		);
	});

	// The whole point of the flags: a failed import parse reporting zero modules
	// must not read as "this binary calls no APIs", and a truncation is a
	// different fact from a failure, so the two never share a row.
	test('a failed import parse and a truncated export table each get their own row', async () => {
		const provider = new DelverOverviewTreeDataProvider();
		const info = openResult();
		provider.setContent('C:\\samples\\wide.exe', imageInfo(), {
			...info,
			fully_parsed: false,
			imports_failed: true,
			exports_truncated: true,
			export_count: 64,
		});

		const rows = await provider.getChildren();
		assert.deepStrictEqual(
			rows?.slice(8).map(row => ({ label: row.label?.label, description: row.description, icon: row.themeIcon?.id, tooltip: row.tooltip })),
			[
				{
					label: 'Imports',
					description: '0 recovered — import directory parse failed',
					icon: 'warning',
					tooltip: 'The import directory is present but could not be parsed to the end. 0 module(s) were recovered before it gave up; that is not the image\'s import list.',
				},
				{
					label: 'Exports',
					description: '64 recovered — export cap reached',
					icon: 'warning',
					tooltip: 'Exports were dropped at the parser\'s export cap. The image exports at least the 64 shown.',
				},
			],
		);
	});
});

/** Stands in for the surface its owning contribution would register. */
class StubSurface extends Disposable implements IDelverSurface {
	render(_container: HTMLElement): void { }
	layout(_dimension: Dimension): void { }
	setVisible(_visible: boolean): void { }
	focus(): void { }
}

suite('Delver overview reveal', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	// The rows used to name *view* ids and reveal through `IViewsService`, which
	// could never open a Delver surface: their view descriptors are registered
	// `when: false`, so they belong to no container's view model and the click
	// did nothing at all. Asserting that the command was called would not have
	// caught it; this asserts the id it names resolves to a surface a zone hosts.
	test('the Functions and References rows resolve to a hosted surface', async () => {
		disposables.add(registerDelverSurface({
			id: DelverSurfaceId.Functions,
			title: { value: 'Functions', original: 'Functions' },
			zone: DelverZone.Navigator,
			order: 10,
			ctor: new SyncDescriptor<IDelverSurface>(StubSurface),
		}));
		disposables.add(registerDelverSurface({
			id: DelverSurfaceId.Xrefs,
			title: { value: 'References', original: 'References' },
			zone: DelverZone.Inspector,
			order: 10,
			ctor: new SyncDescriptor<IDelverSurface>(StubSurface),
		}));

		const workspaceService = disposables.add(new DelverWorkspaceService());
		const reached: { id: string; zone: DelverZone | undefined }[] = [];
		disposables.add(workspaceService.onDidRequestSurface(id => reached.push({ id, zone: zoneForSurface(allDelverSurfaces(), id) })));
		const accessor = {
			get: <T>(id: unknown) => (id === IDelverWorkspaceService ? workspaceService : undefined) as T,
		} as unknown as ServicesAccessor;

		const provider = new DelverOverviewTreeDataProvider();
		provider.setContent('C:\\samples\\wide.exe', imageInfo(), openResult());
		const rows = await provider.getChildren();
		const reveals = rows!.filter(row => row.command?.id === DELVER_OVERVIEW_REVEAL_COMMAND);
		const handler = CommandsRegistry.getCommand(DELVER_OVERVIEW_REVEAL_COMMAND)!.handler;
		for (const row of reveals) {
			handler(accessor, ...row.command!.arguments!);
		}

		assert.deepStrictEqual(reached, [
			{ id: DelverSurfaceId.Functions, zone: DelverZone.Navigator },
			{ id: DelverSurfaceId.Xrefs, zone: DelverZone.Inspector },
		]);
	});
});

function imageInfo(): IOpenImageResult {
	return {
		arch: 'x86_64',
		function_count: 12,
		image_id: 'image-1',
		instruction_count: 34_567,
		string_count: 89,
		strings_truncated: false,
		xref_count: 123,
		bytes_read: '0x1000',
		coverage_complete: true,
		decoding: { kind: 'decoded' },
		fully_parsed: true,
		unreadable_ranges: [],
	};
}

function openResult(): IGetImageInfoResult {
	return {
		arch: 'x86_64',
		subsystem: { kind: 'console' },
		content_hash: 'hash',
		entry: '0x1000000000000001',
		export_count: 0,
		function_seed_count: 1,
		image_base: '0x1000000000000000',
		import_module_count: 0,
		import_symbol_count: 0,
		relocation_count: 0,
		fully_parsed: true,
		imports_failed: false,
		imports_truncated: false,
		exports_failed: false,
		exports_truncated: false,
		exception_directory_failed: false,
		function_seeds_truncated: false,
		relocations_failed: false,
		relocations_truncated: false,
		tls_failed: false,
		section_names_unreadable: false,
		sections: [],
	};
}
