/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Anchor, EditOp, EditStatus, IAuthor, InterpretationLog } from '../../../../../platform/delver/common/interpretation.js';
import { IDelverInterpretationService } from '../../common/delverInterpretationService.js';
import { functionCorrectionsFor } from '../../common/delverFunctionCorrections.js';

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

const ANALYST: IAuthor = { kind: 'human', id: 'analyst' };
const MODEL: IAuthor = { kind: 'model', id: 'claude' };

function at(rva: bigint, contentHash = HASH): Anchor {
	return { kind: 'image', contentHash, rva };
}

/**
 * The real log behind the two methods the builder uses.
 *
 * A hand-written fake would have to reimplement what "accepted" means, which is
 * the one thing these tests are checking.
 */
function interpretationOf(log: InterpretationLog): IDelverInterpretationService {
	return {
		logFor: (contentHash: string) => log.log.filter(edit => edit.anchor.contentHash === contentHash),
		at: (anchor: Anchor) => log.at(anchor),
	} as unknown as IDelverInterpretationService;
}

suite('Delver function corrections', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('collects accepted corrections in address order and drops what no longer reads', () => {
		const log = new InterpretationLog();
		log.append({ author: ANALYST, anchor: at(0x2000n), op: EditOp.FunctionBounds, value: '{"kind":"undefine"}' });
		log.append({ author: ANALYST, anchor: at(0x1400n), op: EditOp.FunctionBounds, value: '{"kind":"define","endRva":"0x1480"}' });
		log.append({ author: ANALYST, anchor: at(0x1000n), op: EditOp.FunctionBounds, value: '{"kind":"define"}' });
		// Four rows that must not reach the analysis server: a proposal nobody has
		// accepted, a truncated value, an end that is not past its start, and a
		// correction the analyst cleared.
		log.append({ author: MODEL, anchor: at(0x1800n), op: EditOp.FunctionBounds, value: '{"kind":"undefine"}', status: EditStatus.Proposed });
		log.append({ author: ANALYST, anchor: at(0x3000n), op: EditOp.FunctionBounds, value: '{"kind":"define","endRva":' });
		log.append({ author: ANALYST, anchor: at(0x3100n), op: EditOp.FunctionBounds, value: '{"kind":"define","endRva":"0x3000"}' });
		log.append({ author: ANALYST, anchor: at(0x3200n), op: EditOp.FunctionBounds, value: '{"kind":"undefine"}' });
		log.append({ author: ANALYST, anchor: at(0x3200n), op: EditOp.FunctionBounds, value: '' });
		// Another image's log is another image's business.
		log.append({ author: ANALYST, anchor: at(0x1100n, OTHER_HASH), op: EditOp.FunctionBounds, value: '{"kind":"undefine"}' });

		assert.deepStrictEqual(functionCorrectionsFor(interpretationOf(log), HASH), [
			{ rva: '0x1000', kind: 'define' },
			{ rva: '0x1400', kind: 'define', endRva: '0x1480' },
			{ rva: '0x2000', kind: 'undefine' },
		]);
	});

	test('canonicalizes an address however the stored value spelled it', () => {
		// The set is compared, so one correction must produce one spelling. A
		// project written by hand is the case that reaches this.
		const log = new InterpretationLog();
		log.append({ author: ANALYST, anchor: at(0x1ab0n), op: EditOp.FunctionBounds, value: '{"kind":"define","endRva":"0x1AC0"}' });

		assert.deepStrictEqual(functionCorrectionsFor(interpretationOf(log), HASH), [
			{ rva: '0x1ab0', kind: 'define', endRva: '0x1ac0' },
		]);
	});

	test('has nothing to say about an image nobody has corrected', () => {
		const log = new InterpretationLog();
		log.append({ author: ANALYST, anchor: at(0x1000n), op: EditOp.Rename, value: 'decode_stage2' });

		assert.deepStrictEqual(functionCorrectionsFor(interpretationOf(log), HASH), []);
	});
});
