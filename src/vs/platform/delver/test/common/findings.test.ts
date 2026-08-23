/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	createDelverFinding,
	createDelverFindingDecision,
	delverFindingDecisionFromWire,
	delverFindingDecisionToWire,
	delverFindingFromWire,
	delverFindingToWire,
	IDelverFindingDraft,
} from '../../common/findings.js';

const HASH = 'a'.repeat(64);

function draft(): IDelverFindingDraft {
	return {
		author: { kind: 'model', id: 'test-model' },
		title: 'Configuration decryptor',
		description: 'The function transforms an embedded blob before parsing key/value pairs.',
		severity: 'suspicious',
		confidence: 0.91,
		status: 'proposed',
		evidence: [{
			kind: 'range',
			anchor: { kind: 'image', contentHash: HASH, rva: 0x1fffffffffffff9n },
			endRva: 0x200000000000010n,
			description: 'The loop XORs each byte and passes the result to the parser.',
			sourceCallIds: ['call-decompile-1'],
		}, {
			kind: 'range',
			anchor: { kind: 'image', contentHash: HASH, rva: 0x2000n },
			description: 'This call consumes the transformed buffer as configuration.',
		}],
		provenance: { capability: 'delver_report_finding', callId: 'call-1' },
	};
}

suite('Delver findings', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('round-trips attributed evidence without losing 64-bit addresses', () => {
		const finding = createDelverFinding('finding-1', 1_700_000_000_000, draft());
		const wire = delverFindingToWire(finding);
		const restored = delverFindingFromWire(JSON.parse(JSON.stringify(wire)));

		assert.deepStrictEqual({
			wire,
			addresses: restored.evidence.map(entry => ({ start: entry.anchor.rva, end: entry.endRva })),
			anchors: restored.anchors.map(anchor => anchor.rva),
			status: restored.status,
			provenance: restored.provenance,
		}, {
			wire: {
				id: 'finding-1',
				at: 1_700_000_000_000,
				author: { kind: 'model', id: 'test-model' },
				title: 'Configuration decryptor',
				description: 'The function transforms an embedded blob before parsing key/value pairs.',
				severity: 'suspicious',
				confidence: 0.91,
				status: 'proposed',
				anchors: [
					{ kind: 'image', contentHash: HASH, rva: '0x1fffffffffffff9' },
					{ kind: 'image', contentHash: HASH, rva: '0x2000' },
				],
				evidence: [{
					kind: 'range',
					anchor: { kind: 'image', contentHash: HASH, rva: '0x1fffffffffffff9' },
					endRva: '0x200000000000010',
					description: 'The loop XORs each byte and passes the result to the parser.',
					sourceCallIds: ['call-decompile-1'],
				}, {
					kind: 'range',
					anchor: { kind: 'image', contentHash: HASH, rva: '0x2000' },
					description: 'This call consumes the transformed buffer as configuration.',
					sourceCallIds: [],
				}],
				provenance: { capability: 'delver_report_finding', callId: 'call-1' },
			},
			addresses: [{ start: 0x1fffffffffffff9n, end: 0x200000000000010n }, { start: 0x2000n, end: undefined }],
			anchors: [0x1fffffffffffff9n, 0x2000n],
			status: 'proposed',
			provenance: { capability: 'delver_report_finding', callId: 'call-1' },
		});
	});

	test('rejects ungrounded, malformed, and cross-image findings', () => {
		const valid = delverFindingToWire(createDelverFinding('finding-1', 1, draft()));

		assert.deepStrictEqual({
			noEvidence: validationError({ ...valid, anchors: [], evidence: [] }),
			backwardsRange: validationError({ ...valid, evidence: [{ ...valid.evidence[0], endRva: valid.evidence[0].anchor.rva }] }),
			crossImage: validationError({
				...valid,
				evidence: [{ ...valid.evidence[0], anchor: { ...valid.evidence[0].anchor, contentHash: 'b'.repeat(64) } }, valid.evidence[1]],
			}),
			badConfidence: validationError({ ...valid, confidence: 1.1 }),
		}, {
			noEvidence: 'A finding must have between 1 and 64 evidence ranges',
			backwardsRange: 'Evidence end RVA must be greater than its start RVA',
			crossImage: 'Finding anchors must match its evidence ranges',
			badConfidence: 'Invalid finding confidence',
		});
	});

	test('round-trips an append-only human decision and rejects proposed outcomes', () => {
		const finding = createDelverFinding('finding-1', 1000, draft());
		const decision = createDelverFindingDecision('decision-1', finding, 'accepted', { kind: 'human', id: 'local' }, 2000);

		assert.deepStrictEqual(delverFindingDecisionFromWire(delverFindingDecisionToWire(decision)), decision);
		assert.throws(() => delverFindingDecisionFromWire({ ...decision, outcome: 'proposed' }), /outcome/);
	});
});

function validationError(value: unknown): string {
	try {
		delverFindingFromWire(value);
		return 'VALID';
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
