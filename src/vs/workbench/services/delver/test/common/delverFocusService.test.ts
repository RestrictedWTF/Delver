/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILocation } from '../../../../../platform/delver/common/address.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import {
	DelverFocusService,
	FocusReason,
	IDelverFocusChangeEvent,
	IDelverFocusService,
} from '../../common/delverFocusService.js';
import { IDelverSession, IDelverSessionService } from '../../common/delverSessionService.js';

const CONTENT_HASH = 'a'.repeat(64);
const OTHER_CONTENT_HASH = 'b'.repeat(64);

/** Just enough session for the focus bus: which bytes are open, and when that changes. */
class FakeSessionService implements Partial<IDelverSessionService> {
	private readonly emitter = new Emitter<IDelverSession | undefined>();
	readonly onDidChangeActiveSession = this.emitter.event;

	activeSession: IDelverSession | undefined = { targetPath: 'sample.exe', contentHash: CONTENT_HASH };

	open(contentHash: string | undefined): void {
		this.activeSession = contentHash === undefined
			? undefined
			: { targetPath: `${contentHash.slice(0, 4)}.exe`, contentHash };
		this.emitter.fire(this.activeSession);
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

function at(address: bigint): ILocation {
	return { space: 'Image', address };
}

/**
 * Mocha's reporter cannot serialize a BigInt, so a failed assertion on a raw
 * address prints nothing useful. Every address in Delver is a bigint, so
 * assertions format them first.
 */
function hex(address: bigint | undefined): string {
	return address === undefined ? '<none>' : `0x${address.toString(16)}`;
}

suite('DelverFocusService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('is registered as a singleton', () => {
		// Every other test builds the service directly, so none of them notices
		// a missing `registerSingleton` — the first sign is a view failing to
		// instantiate at runtime with "depends on UNKNOWN service".
		assert.ok(
			getSingletonServiceDescriptors().some(([id]) => id === IDelverFocusService),
			'the focus service must be injectable, not just constructible'
		);
	});

	function createService(): { service: DelverFocusService; session: FakeSessionService; events: IDelverFocusChangeEvent[] } {
		const session = store.add(new FakeSessionService());
		const service = store.add(new DelverFocusService(session as unknown as IDelverSessionService));
		const events: IDelverFocusChangeEvent[] = [];
		store.add(service.onDidChangeFocus(e => events.push(e)));
		return { service, session, events };
	}

	test('broadcasts the origin so a view can ignore its own echo', () => {
		const { service, events } = createService();

		service.setFocus({ location: at(0x1000n) }, 'listing', FocusReason.User);

		assert.deepStrictEqual(
			events.map(e => ({ origin: e.origin, reason: e.reason, address: hex(e.focus.location?.address) })),
			[{ origin: 'listing', reason: FocusReason.User, address: '0x1000' }]
		);
	});

	test('does not fire when the focus is unchanged', () => {
		const { service, events } = createService();

		service.setFocus({ location: at(0x1000n) }, 'listing', FocusReason.User);
		service.setFocus({ location: at(0x1000n) }, 'graph', FocusReason.User);

		assert.strictEqual(events.length, 1, 'a no-op set must not wake every view');
	});

	test('undefined fields keep their current value', () => {
		const { service } = createService();

		service.setFocus({ location: at(0x1000n) }, 'listing', FocusReason.User);
		service.setFocus({ selection: { start: 0n, end: 4n } }, 'hex', FocusReason.User);

		assert.deepStrictEqual(
			{ address: hex(service.focus.location?.address), selection: service.focus.selection },
			{ address: '0x1000', selection: { start: 0n, end: 4n } }
		);
	});

	test('preserves exact discontiguous selections independently of their bounding range', () => {
		const { service, events } = createService();
		const selections = [{ start: 0x1000n, end: 0x1004n }, { start: 0x1010n, end: 0x1012n }];

		service.setFocus({
			location: at(0x1000n),
			selection: { start: 0x1000n, end: 0x1012n },
			selections,
		}, 'pseudocode', FocusReason.User);

		assert.deepStrictEqual({ focus: service.focus, eventCount: events.length }, {
			focus: { moment: service.focus.moment, location: at(0x1000n), selection: { start: 0x1000n, end: 0x1012n }, selections, contentHash: CONTENT_HASH },
			eventCount: 1,
		});
	});

	test('location-only navigation clears stale exact semantic selections', () => {
		const { service } = createService();
		service.setFocus({ location: at(0x1000n), selections: [{ start: 0x1000n, end: 0x1004n }] }, 'pseudocode', FocusReason.User);

		service.setFocus({ location: at(0x2000n) }, 'listing', FocusReason.User);

		assert.strictEqual(service.focus.selections, undefined);
	});

	test('nearby positions of a continuous cursor coalesce into one history entry', () => {
		const { service } = createService();

		// A caret walking down decompiled C is not three navigations.
		service.setFocus({ location: at(0x1000n), continuous: true }, 'pseudocode', FocusReason.User);
		service.setFocus({ location: at(0x1003n), continuous: true }, 'pseudocode', FocusReason.User);
		service.setFocus({ location: at(0x1007n), continuous: true }, 'pseudocode', FocusReason.User);

		assert.strictEqual(service.canGoBack, false, 'a moving caret must not fill the back stack');
	});

	test('nearby positions still record when they are separate navigations', () => {
		const { service } = createService();

		// Clicking one instruction after another inside a function is a few
		// bytes apart and is exactly the movement back/forward exists for.
		service.setFocus({ location: at(0x1000n) }, 'listing', FocusReason.User);
		service.setFocus({ location: at(0x1003n) }, 'listing', FocusReason.User);
		service.setFocus({ location: at(0x1007n) }, 'listing', FocusReason.User);

		service.back();
		assert.strictEqual(hex(service.focus.location?.address), hex(0x1003n));
		service.back();
		assert.strictEqual(hex(service.focus.location?.address), hex(0x1000n));
		assert.strictEqual(service.canGoBack, false);
	});

	test('distant positions create separate history entries', () => {
		const { service } = createService();

		service.setFocus({ location: at(0x1000n) }, 'listing', FocusReason.User);
		service.setFocus({ location: at(0x9000n) }, 'listing', FocusReason.User);

		assert.strictEqual(service.canGoBack, true);
		service.back();
		assert.strictEqual(hex(service.focus.location?.address), hex(0x1000n));
		assert.strictEqual(service.canGoForward, true);
	});

	test('back and forward round-trip', () => {
		const { service } = createService();

		for (const address of [0x1000n, 0x9000n, 0x20000n]) {
			service.setFocus({ location: at(address) }, 'listing', FocusReason.User);
		}

		service.back();
		service.back();
		assert.strictEqual(hex(service.focus.location?.address), hex(0x1000n));

		service.forward();
		service.forward();
		assert.strictEqual(hex(service.focus.location?.address), hex(0x20000n));
		assert.strictEqual(service.canGoForward, false);
	});

	test('history navigation is reported with the navigation reason', () => {
		const { service, events } = createService();

		service.setFocus({ location: at(0x1000n) }, 'listing', FocusReason.User);
		service.setFocus({ location: at(0x9000n) }, 'listing', FocusReason.User);
		events.length = 0;

		service.back();

		assert.deepStrictEqual(
			events.map(e => ({ origin: e.origin, reason: e.reason })),
			[{ origin: 'history', reason: FocusReason.Navigation }]
		);
	});

	test('navigating back then somewhere new truncates the forward entries', () => {
		const { service } = createService();

		for (const address of [0x1000n, 0x9000n, 0x20000n]) {
			service.setFocus({ location: at(address) }, 'listing', FocusReason.User);
		}
		service.back();
		service.setFocus({ location: at(0x30000n) }, 'listing', FocusReason.User);

		assert.strictEqual(service.canGoForward, false, 'the old forward branch is gone');
		// History is now [0x1000, 0x9000, 0x30000] — 0x20000 was discarded when
		// the new navigation branched from the middle.
		service.back();
		assert.strictEqual(hex(service.focus.location?.address), hex(0x9000n));
		service.back();
		assert.strictEqual(hex(service.focus.location?.address), hex(0x1000n));
	});

	test('the same address in a different space is a real navigation', () => {
		const { service } = createService();

		service.setFocus({ location: { space: 'Image', address: 0x1000n }, continuous: true }, 'listing', FocusReason.User);
		service.setFocus({ location: { space: 'File', address: 0x1000n }, continuous: true }, 'hex', FocusReason.User);

		assert.strictEqual(service.canGoBack, true, 'coalescing must not span address spaces');
	});

	test('focus does not survive a session change', () => {
		// The failure this prevents is not a stale-looking answer but a
		// confident wrong one: `delver_current_context` reported sample A's
		// address stamped with sample B's content hash and resolved it against
		// sample B's function list. An address cannot be translated between two
		// binaries, so the only safe reset is to have nothing focused.
		const { service, session, events } = createService();
		service.setFocus({ location: at(0x1000n), selection: { start: 0x1000n, end: 0x1004n } }, 'listing', FocusReason.User);
		events.length = 0;

		session.open(OTHER_CONTENT_HASH);

		assert.deepStrictEqual({
			focus: { address: hex(service.focus.location?.address), selection: service.focus.selection, contentHash: service.focus.contentHash },
			canGoBack: service.canGoBack,
			canGoForward: service.canGoForward,
			events: events.map(e => ({ origin: e.origin, reason: e.reason, address: hex(e.focus.location?.address) })),
		}, {
			focus: { address: '<none>', selection: undefined, contentHash: undefined },
			canGoBack: false,
			canGoForward: false,
			events: [{ origin: 'session', reason: FocusReason.TargetEvent, address: '<none>' }],
		});
	});

	test('focus carries the bytes it was set against', () => {
		const { service, session } = createService();

		service.setFocus({ location: at(0x1000n) }, 'listing', FocusReason.User);
		const first = service.focus.contentHash;
		session.open(OTHER_CONTENT_HASH);
		service.setFocus({ location: at(0x1000n) }, 'listing', FocusReason.User);

		assert.deepStrictEqual(
			{ first, second: service.focus.contentHash },
			{ first: CONTENT_HASH, second: OTHER_CONTENT_HASH },
		);
	});

	test('closing the target clears the focus, and reopening the same bytes does not resurrect it', () => {
		const { service, session } = createService();
		service.setFocus({ location: at(0x1000n) }, 'listing', FocusReason.User);

		session.open(undefined);
		const afterClose = hex(service.focus.location?.address);
		session.open(CONTENT_HASH);

		assert.deepStrictEqual(
			{ afterClose, afterReopen: hex(service.focus.location?.address), canGoBack: service.canGoBack },
			{ afterClose: '<none>', afterReopen: '<none>', canGoBack: false },
		);
	});

	test('back and forward at the ends are no-ops', () => {
		const { service, events } = createService();

		service.setFocus({ location: at(0x1000n) }, 'listing', FocusReason.User);
		events.length = 0;

		service.back();
		service.forward();

		assert.strictEqual(events.length, 0);
	});
});
