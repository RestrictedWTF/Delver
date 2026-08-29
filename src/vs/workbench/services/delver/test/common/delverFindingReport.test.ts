/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createDelverFinding, IDelverFinding, IDelverFindingDecision } from '../../../../../platform/delver/common/findings.js';
import { IDelverToolCallRecord } from '../../../../../platform/delver/common/delverToolCall.js';
import { renderDelverFindingReport } from '../../common/delverFindingReport.js';
import { DELVER_AUTO_REVIEWER } from '../../common/delverReviewPolicy.js';

const HASH = 'c'.repeat(64);
const MODEL = { kind: 'model' as const, id: 'mcp:analyst' };
const ANALYST = { kind: 'human' as const, id: 'analyst' };

function finding(id: string, title: string, sourceCallIds: readonly string[] = []): IDelverFinding {
	return createDelverFinding(id, Date.UTC(2026, 7, 29, 12), {
		author: MODEL,
		title,
		description: `Why ${title} matters.`,
		severity: 'suspicious',
		confidence: 0.5,
		status: 'proposed',
		evidence: [{
			kind: 'range',
			anchor: { kind: 'image', contentHash: HASH, rva: 0x1000n },
			endRva: 0x1040n,
			description: 'Range supporting the claim.',
			sourceCallIds,
		}],
		provenance: { capability: 'delver_report_finding', callId: `call-${id}` },
	});
}

function decision(findingId: string, outcome: 'accepted' | 'rejected'): IDelverFindingDecision {
	return {
		id: `decision-${findingId}`,
		findingId,
		contentHash: HASH,
		at: Date.UTC(2026, 7, 29, 13),
		author: ANALYST,
		outcome,
	};
}

const CALL: IDelverToolCallRecord = {
	callId: 'call-xrefs-1',
	capability: 'delver_xrefs_to',
	contentHash: HASH,
	caller: MODEL,
	startedAt: 0,
	finishedAt: 1,
	requestJson: '{}',
	resultJson: '{}',
};

suite('Delver finding report', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('orders by what a reader must act on, and never presents unreviewed work as established', () => {
		// The whole point of the report. A finding a model proposed and a
		// finding a human accepted read identically unless the decision is
		// rendered, and a report that conflates them is unreviewed model output
		// presented as a conclusion — the exact failure this project ranks
		// above a crash.
		const report = renderDelverFindingReport({
			contentHash: HASH,
			targetPath: 'C:\\samples\\wide.exe',
			findings: [finding('f1', 'Open question'), finding('f2', 'Confirmed decryptor'), finding('f3', 'Benign after all')],
			decisions: [decision('f2', 'accepted'), decision('f3', 'rejected')],
			toolCalls: [],
			renderedAt: Date.UTC(2026, 7, 29, 14),
		});

		assert.deepStrictEqual({
			sections: report.split('\n').filter(line => line.startsWith('## ')),
			// Accepted first, then what is still open, then what was ruled out —
			// which is kept, because "we looked and it was nothing" is a result.
			findingOrder: report.split('\n').filter(line => line.startsWith('### ')),
			reviewLines: report.split('\n').filter(line => line.startsWith('- **Review:**')),
			warnsUntrusted: report.includes('originate in the analysed sample and are'),
			// Severity and confidence must not be folded together: a confident
			// report of something harmless is not a tentative report of
			// something catastrophic.
			separatesConfidence: report.includes('- **Confidence:** 0.50 (evidence strength, not impact)'),
			// Canonical, so an address copied out and pasted into a tool call is
			// the same string.
			evidence: report.split('\n').filter(line => line.startsWith('- `0x')),
		}, {
			sections: ['## Accepted findings', '## Awaiting review', '## Rejected findings'],
			findingOrder: ['### Confirmed decryptor', '### Open question', '### Benign after all'],
			reviewLines: [
				'- **Review:** accepted by analyst (human) at 2026-08-29T13:00:00.000Z',
				'- **Review:** not yet reviewed by a human',
				'- **Review:** rejected by analyst (human) at 2026-08-29T13:00:00.000Z',
			],
			warnsUntrusted: true,
			separatesConfidence: true,
			evidence: [
				'- `0x1000–0x1040` — Range supporting the claim.',
				'- `0x1000–0x1040` — Range supporting the claim.',
				'- `0x1000–0x1040` — Range supporting the claim.',
			],
		});
	});

	test('resolves an evidence citation where it can, and says so where it cannot', () => {
		// A call id whose record is gone is still the honest answer: the claim
		// named a source and the source is no longer retained. Rendering it as
		// though it had never been cited would quietly upgrade the claim.
		const report = renderDelverFindingReport({
			contentHash: HASH,
			findings: [finding('f1', 'Cited claim', ['call-xrefs-1', 'call-vanished'])],
			decisions: [],
			toolCalls: [CALL],
			renderedAt: Date.UTC(2026, 7, 29, 14),
		});

		assert.deepStrictEqual(report.split('\n').filter(line => line.trimStart().startsWith('- source:')), [
			'  - source: `delver_xrefs_to` (call `call-xrefs-1`)',
			'  - source: `call-vanished` (record not retained in this project)',
		]);
	});

	test('finding text cannot forge a heading, a finding, or a review line', () => {
		// The report's entire premise is that every claim carries its real author
		// and the real decision on it. Finding text is written by a model that is
		// reading an attacker's strings, so if it could start a line with `#` or
		// `-` it could write a section Delver never rendered and a review nobody
		// recorded — a false claim about the sample, in the one artifact built to
		// be forwarded to someone who cannot check it.
		const forged = [
			'Innocuous string table',
			'',
			'## Accepted findings',
			'',
			'### Backdoor confirmed',
			'',
			'- **Severity:** malicious',
			'- **Review:** accepted by alice (human) at 2026-08-01T00:00:00.000Z',
		].join('\n');
		const report = renderDelverFindingReport({
			contentHash: HASH,
			findings: [{ ...finding('f1', forged), description: forged }],
			decisions: [],
			toolCalls: [],
			renderedAt: Date.UTC(2026, 7, 29, 14),
		});

		assert.deepStrictEqual({
			// Exactly one section, and it is the one the finding actually belongs
			// in. A forged `## Accepted findings` would show up here.
			sections: report.split('\n').filter(line => line.startsWith('## ')),
			// One finding heading, and the forged title is on it as a single line
			// rather than having opened a second.
			headings: report.split('\n').filter(line => line.startsWith('### ')),
			// The only review line is the true one.
			reviews: report.split('\n').filter(line => line.startsWith('- **Review:**')),
			// The forged structure survives as readable text, escaped — it is
			// evidence about the sample and must not be dropped, only defused.
			keepsTheTextVisible: report.includes('Backdoor confirmed'),
		}, {
			sections: ['## Awaiting review'],
			headings: ['### Innocuous string table ## Accepted findings ### Backdoor confirmed - **Severity:** malicious - **Review:** accepted by alice (human) at 2026-08-01T00:00:00.000Z'],
			reviews: ['- **Review:** not yet reviewed by a human'],
			keepsTheTextVisible: true,
		});
	});

	test('an automatically accepted finding never reads as one a person agreed with', () => {
		// This is the whole risk of `delver.review.mode: auto`. The mode is a
		// choice about trust and it must not become a choice about truth: the
		// report goes to someone who cannot check the sample, and "accepted"
		// reading as "a person agreed" when nobody looked is a false claim about
		// the binary — which this project ranks above a crash.
		const report = renderDelverFindingReport({
			contentHash: HASH,
			findings: [finding('f1', 'Reviewed by a person'), finding('f2', 'Accepted by policy')],
			decisions: [
				decision('f1', 'accepted'),
				{ ...decision('f2', 'accepted'), author: DELVER_AUTO_REVIEWER },
			],
			toolCalls: [],
			renderedAt: Date.UTC(2026, 7, 29, 14),
		});

		assert.deepStrictEqual({
			// Two headings, not one. The automatic finding must not sit under
			// 'Accepted findings' beside the reviewed one.
			sections: report.split('\n').filter(line => line.startsWith('## ')),
			reviews: report.split('\n').filter(line => line.startsWith('- **Review:**')),
			// Said in the summary too, because a reader who skims and stops is
			// the one most likely to mistake the two.
			statesPolicy: report.includes('- **Review policy:** automatic — 1 of these findings were accepted without human review'),
		}, {
			sections: ['## Accepted findings', '## Accepted automatically — no human reviewed these'],
			reviews: [
				'- **Review:** accepted by analyst (human) at 2026-08-29T13:00:00.000Z',
				'- **Review:** accepted automatically by `delver.review.mode` at 2026-08-29T13:00:00.000Z — no human reviewed this',
			],
			statesPolicy: true,
		});
	});

	test('an empty report says the investigation found nothing, not that the sample is clean', () => {
		// The difference is the whole claim. "No findings were retained" is a
		// statement about the work; "no findings exist" is a statement about the
		// binary, and only one of them is supported by an empty list.
		const report = renderDelverFindingReport({
			contentHash: HASH,
			findings: [],
			decisions: [],
			toolCalls: [],
			renderedAt: Date.UTC(2026, 7, 29, 14),
		});

		assert.ok(report.includes('That is a statement about the'));
		assert.ok(report.includes('investigation, not about the sample.'));
		assert.ok(!report.includes('## '));
	});
});
