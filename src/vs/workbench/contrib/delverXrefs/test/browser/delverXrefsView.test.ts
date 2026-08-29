/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDelverAnalysisService } from '../../../../../platform/delver/common/delverAnalysisService.js';
import { FunctionSourceWire, IFunctionWire } from '../../../../../platform/delver/common/protocol.generated.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { DelverSurfaceId } from '../../../../services/delver/browser/delverSurface.js';
import { allDelverSurfaces } from '../../../../services/delver/browser/delverSurfaceRegistry.js';
import { IDelverFocusChangeEvent, IDelverFocusService } from '../../../../services/delver/common/delverFocusService.js';
import { IDelverInterpretationService, IInterpretationChangeEvent } from '../../../../services/delver/common/delverInterpretationService.js';
import { IDelverSession, IDelverSessionService } from '../../../../services/delver/common/delverSessionService.js';
import { ViewDescriptorService } from '../../../../services/views/browser/viewDescriptorService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { DelverXrefsViewContribution } from '../../browser/delverXrefs.contribution.js';
import { referenceAddressLabel } from '../../browser/delverXrefsView.js';

const functions: readonly IFunctionWire[] = [
	{ rva: '0x1000', end_rva: '0x1100', authoritative: true, source: FunctionSourceWire.ExceptionDirectory },
	{ rva: '0x2000', authoritative: false, source: FunctionSourceWire.LinearSweep },
];

suite('Delver references function-relative labels', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses an authored function name and offset inside a known range', () => {
		assert.strictEqual(
			referenceAddressLabel('0x102A', functions, new Map([[0x1000n, 'decrypt_config']])),
			'decrypt_config+0x2A',
		);
	});

	test('uses placeholders at exact entries and does not claim unknown gaps', () => {
		assert.strictEqual(referenceAddressLabel('0x2000', functions, new Map()), 'SUB_2000');
		assert.strictEqual(referenceAddressLabel('0x2001', functions, new Map()), '0x2001');
		assert.strictEqual(referenceAddressLabel('0x1800', functions, new Map()), '0x1800');
	});
});

suite('Delver references view contribution lifetime', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('disposing the contribution releases its tree view, its surface and its listeners', () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(IViewDescriptorService, disposables.add(instantiationService.createInstance(ViewDescriptorService)));
		// Real emitters, not `Event.None`. `Event.None` hands back the frozen
		// `Disposable.None` singleton, which never reaches the leak tracker — so
		// with it the listener half of this test proved nothing, and removing
		// `this._register` from all three registrations left it green.
		const sessionBus = disposables.add(new Emitter<IDelverSession | undefined>());
		const focusBus = disposables.add(new Emitter<IDelverFocusChangeEvent>());
		const interpretationBus = disposables.add(new Emitter<IInterpretationChangeEvent>());
		instantiationService.stub(IDelverSessionService, {
			activeSession: undefined,
			onDidChangeActiveSession: sessionBus.event,
		});
		instantiationService.stub(IDelverFocusService, { onDidChangeFocus: focusBus.event });
		instantiationService.stub(IDelverInterpretationService, { onDidChange: interpretationBus.event });
		instantiationService.stub(IDelverAnalysisService, {});

		// The tree view and the three bus listeners are created here and nothing
		// else can release them, so the suite's disposable tracker fails this
		// test on teardown for a contribution that leaves any of them dangling.
		const contribution = instantiationService.createInstance(DelverXrefsViewContribution);
		const registeredWhileAlive = allDelverSurfaces().some(surface => surface.id === DelverSurfaceId.Xrefs);
		contribution.dispose();

		assert.deepStrictEqual(
			{
				registeredWhileAlive,
				registeredAfterDispose: allDelverSurfaces().some(surface => surface.id === DelverSurfaceId.Xrefs),
			},
			{ registeredWhileAlive: true, registeredAfterDispose: false },
		);
	});
});
