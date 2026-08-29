/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDelverAgentResult } from '../../../../services/delver/common/delverAgentTypes.js';
import { explicitSignatureGenerationInvocation, explicitSignaturePolicy, explicitSignatureRva, generatedSignaturePresentation, signatureActions, signatureGenerationArgs, signaturePolicyChoices } from '../../../../services/delver/browser/delverSignatureActions.js';

suite('Delver signature actions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('presents IDA-style primary and xref patterns with save gated by exact uniqueness', () => {
		const presentation = generatedSignaturePresentation(result({
			target: { rva: '0x1000', name: 'decrypt_config' },
			policy: 'relocation-stable',
			pattern: '55 48 89 e5 e8 ?? ?? ?? ??',
			byteCount: 9,
			fixedByteCount: 5,
			proof: { unique: false, matchCountExact: true, matchCount: 2 },
			quality: { confidence: 'low' },
			alternativeXrefSignature: {
				available: true,
				pattern: 'e8 ?? ?? ?? ?? 48 83 ec',
				byteCount: 8,
				fixedByteCount: 4,
				proof: { unique: true, matchCountExact: true, matchCount: 1 },
				quality: { confidence: 'medium' },
			},
		}));
		const actions = signatureActions(presentation);

		assert.deepStrictEqual({
			presentation,
			actions: actions.map(action => ({
				operation: action.operation,
				variant: action.signature.variant,
				pattern: action.signature.pattern,
			})),
		}, {
			presentation: {
				functionName: 'decrypt_config',
				policy: 'relocation-stable',
				primary: {
					variant: 'primary', pattern: '55 48 89 E5 E8 ?? ?? ?? ??',
					byteCount: 9, fixedByteCount: 5, confidence: 'low', unique: false,
				},
				xrefSite: {
					variant: 'xref-site', pattern: 'E8 ?? ?? ?? ?? 48 83 EC',
					byteCount: 8, fixedByteCount: 4, confidence: 'medium', unique: true,
				},
			},
			actions: [
				{ operation: 'copy', variant: 'primary', pattern: '55 48 89 E5 E8 ?? ?? ?? ??' },
				{ operation: 'save', variant: 'xref-site', pattern: 'E8 ?? ?? ?? ?? 48 83 EC' },
				{ operation: 'copy', variant: 'xref-site', pattern: 'E8 ?? ?? ?? ?? 48 83 EC' },
			],
		});
	});

	test('presents retained cross-revision proof with the generated primary pattern', () => {
		const presentation = generatedSignaturePresentation(result({
			target: { rva: '0x2000', name: 'parse_packet' },
			policy: 'cross-revision-stable',
			pattern: '48 89 5c 24 ?? 57',
			byteCount: 6,
			fixedByteCount: 5,
			proof: { unique: true, matchCountExact: true, matchCount: 1 },
			quality: { confidence: 'high' },
			crossRevisionProof: {
				method: 'retained-exact-primary-signatures',
				revisionCount: 2,
				revisions: [{
					revisionId: 'revision-v2', displayName: 'sample-v2.exe', signatureId: 'signature-v2',
					contentHash: 'b'.repeat(64), sourceCallId: 'call-v2', functionRva: '0x2000', pattern: '48 89 5c 24 ?? 57',
				}, {
					revisionId: 'revision-v1', displayName: 'sample-v1.exe', signatureId: 'signature-v1',
					contentHash: 'c'.repeat(64), sourceCallId: 'call-v1', functionRva: '0x1800', pattern: '48 89 5c 24 ?? 57',
				}],
			},
		}));
		const actions = signatureActions(presentation);

		assert.deepStrictEqual({
			presentation,
			actions: actions.map(action => ({
				operation: action.operation,
				description: action.description,
				detail: action.detail,
			})),
		}, {
			presentation: {
				functionName: 'parse_packet',
				policy: 'cross-revision-stable',
				primary: {
					variant: 'primary', pattern: '48 89 5C 24 ?? 57',
					byteCount: 6, fixedByteCount: 5, confidence: 'high', unique: true,
				},
				crossRevisionProof: {
					revisionCount: 2,
					revisions: [
						{ revisionId: 'revision-v2', displayName: 'sample-v2.exe', signatureId: 'signature-v2' },
						{ revisionId: 'revision-v1', displayName: 'sample-v1.exe', signatureId: 'signature-v1' },
					],
				},
			},
			actions: [{
				operation: 'save',
				description: 'high confidence, 5/6 fixed bytes, unique, stable across 2 earlier revisions',
				detail: '48 89 5C 24 ?? 57 - Earlier proofs: sample-v2.exe, sample-v1.exe',
			}, {
				operation: 'copy',
				description: 'high confidence, 5/6 fixed bytes, unique, stable across 2 earlier revisions',
				detail: '48 89 5C 24 ?? 57 - Earlier proofs: sample-v2.exe, sample-v1.exe',
			}],
		});
	});

	test('refuses malformed dispatcher output instead of presenting invented evidence', () => {
		assert.throws(() => generatedSignaturePresentation(result({
			target: { rva: '0x1000', name: 'SUB_1000' },
			policy: 'relocation-stable',
			pattern: '55',
			byteCount: 1,
			fixedByteCount: 1,
			proof: { unique: true, matchCountExact: true, matchCount: 1 },
			quality: { confidence: 'certain' },
		})), /invalid confidence metadata/);

		assert.throws(() => generatedSignaturePresentation(result({
			target: { rva: '0x1000', name: 'SUB_1000' },
			policy: 'relocation-stable',
			pattern: '55 ??',
			byteCount: 2,
			fixedByteCount: 2,
			proof: { unique: true, matchCountExact: true, matchCount: 1 },
			quality: { confidence: 'high' },
		})), /invalid pattern metadata/);

		assert.throws(() => generatedSignaturePresentation(result({
			target: { rva: '0x1000', name: 'SUB_1000' },
			policy: 'cross-revision-stable',
			pattern: '55',
			byteCount: 1,
			fixedByteCount: 1,
			proof: { unique: true, matchCountExact: true, matchCount: 1 },
			quality: { confidence: 'high' },
			crossRevisionProof: {
				method: 'retained-exact-primary-signatures',
				revisionCount: 1,
				revisions: [{
					revisionId: 'old', displayName: 'old.exe', signatureId: 'old-signature',
					contentHash: 'd'.repeat(64), sourceCallId: 'old-call', functionRva: '0x1000', pattern: '56',
				}],
			},
		})), /cross-revision pattern mismatch/);
	});

	test('accepts only canonical explicit RVAs for revision regeneration', () => {
		assert.deepStrictEqual({
			valid: explicitSignatureRva('0x2A00'),
			missingPrefix: explicitSignatureRva('2a00'),
			negative: explicitSignatureRva('-0x20'),
			wrongType: explicitSignatureRva(0x2a00),
			policies: signaturePolicyChoices().map(choice => choice.policy),
			explicitPolicy: explicitSignaturePolicy('cross-revision-stable'),
			invalidPolicy: explicitSignaturePolicy('stable-ish'),
			legacyInvocation: explicitSignatureGenerationInvocation('cross-revision-stable'),
			boundInvocation: explicitSignatureGenerationInvocation({
				policy: 'cross-revision-stable',
				sourceRevisionId: 'revision-v1',
				sourceSignatureId: 'signature-1',
			}),
			partialBinding: explicitSignatureGenerationInvocation({ policy: 'cross-revision-stable', sourceRevisionId: 'revision-v1' }),
			wrongPolicyBinding: explicitSignatureGenerationInvocation({ policy: 'relocation-stable', sourceRevisionId: 'revision-v1', sourceSignatureId: 'signature-1' }),
			generationArgs: signatureGenerationArgs(0x2a00n, {
				policy: 'cross-revision-stable',
				sourceRevisionId: 'revision-v1',
				sourceSignatureId: 'signature-1',
			}),
		}, {
			valid: 0x2a00n,
			missingPrefix: undefined,
			negative: undefined,
			wrongType: undefined,
			policies: ['relocation-stable', 'cross-revision-stable', 'unique-now'],
			explicitPolicy: 'cross-revision-stable',
			invalidPolicy: undefined,
			legacyInvocation: { policy: 'cross-revision-stable' },
			boundInvocation: { policy: 'cross-revision-stable', sourceRevisionId: 'revision-v1', sourceSignatureId: 'signature-1' },
			partialBinding: undefined,
			wrongPolicyBinding: undefined,
			generationArgs: {
				address: '0x2a00',
				scope: 'executableSections',
				policy: 'cross-revision-stable',
				sourceRevisionId: 'revision-v1',
				sourceSignatureId: 'signature-1',
			},
		});
	});
});

function result(data: unknown): IDelverAgentResult {
	return {
		schemaVersion: 1,
		callId: 'signature-call',
		capability: 'delver_make_signature',
		provenance: [],
		completeness: 'complete',
		data,
	};
}
