/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDelverNamedSignature } from '../../../../../platform/delver/common/delverSignature.js';
import { IDelverAgentResult } from '../../../../services/delver/common/delverAgentTypes.js';
import { byteSearchPresentation, idaPythonMatcher, idaPythonMatcherBundle, revisionSignatureGenerationInvocation, revisionSignaturePresentation, revisionSignatureRegenerationRequest, validateByteSearchPattern } from '../../browser/delverSignaturesActions.js';
import { delverRevisionSignatureHandle } from '../../browser/delverSignaturesState.js';
import { DelverSignaturesTreeDataProvider } from '../../browser/delverSignaturesView.js';

suite('Delver signatures view', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('presents matches, paging, and searchable saved signatures', async () => {
		const provider = new DelverSignaturesTreeDataProvider();
		provider.setSearch({
			pattern: '48 8B ?? FF',
			matches: [{ rva: '0x1010', section: '.text', bytesHex: '488b12ff' }],
			completeness: 'partial',
			nextCursor: 'next-page',
		});
		provider.setSignatures([signature()]);

		const roots = await provider.getChildren();
		const matches = await provider.getChildren(roots[0]);
		const saved = await provider.getChildren(roots[1]);
		const evidence = await provider.getChildren(saved[0]);
		const wildcards = await provider.getChildren(evidence[evidence.length - 1]);
		assert.deepStrictEqual({
			roots: roots.map(item => ({ label: item.label?.label, description: item.description })),
			matches: matches.map(item => ({
				label: item.label?.label,
				description: item.description,
				command: item.command?.id,
				arguments: item.command?.arguments,
			})),
			saved: saved.map(item => ({ label: item.label?.label, contextValue: item.contextValue, command: item.command?.id, arguments: item.command?.arguments })),
			evidence: evidence.map(item => ({
				label: item.label?.label,
				description: item.description,
				command: item.command?.id,
				arguments: item.command?.arguments,
			})),
			wildcards: wildcards.map(item => ({
				label: item.label?.label,
				description: item.description,
				command: item.command?.id,
				arguments: item.command?.arguments,
			})),
		}, {
			roots: [
				{ label: 'Search Results', description: '1+ matches · 48 8B ?? FF' },
				{ label: 'Saved Signatures', description: '1' },
			],
			matches: [
				{ label: '.text:0x1010', description: '48 8B 12 FF', command: 'delver.signatures.goTo', arguments: ['0x1010'] },
				{ label: 'Load More Matches...', description: undefined, command: 'delver.signatures.search', arguments: ['48 8B ?? FF', 'next-page', true] },
			],
			saved: [{ label: 'decrypt_config', contextValue: 'delver-saved-signature-primary', command: 'delver.signatures.search', arguments: ['E8 ?? ?? ?? ??'] }],
			evidence: [
				{ label: 'Pattern', description: 'E8 ?? ?? ?? ??', command: 'delver.signatures.copyPattern', arguments: ['E8 ?? ?? ?? ??'] },
				{ label: 'Function', description: 'decrypt_config · 0x1000', command: 'delver.signatures.goTo', arguments: ['0x1000'] },
				{ label: 'Strategy', description: 'primary · relocation stable · executable sections', command: undefined, arguments: undefined },
				{ label: 'Covered Bytes', description: '0x1000–0x1005 · 5 bytes', command: 'delver.signatures.goTo', arguments: ['0x1000'] },
				{ label: 'Uniqueness Proof', description: '1 exact match · executable sections', command: undefined, arguments: undefined },
				{ label: 'Quality', description: 'high confidence · 90% score · 1/5 fixed bytes', command: undefined, arguments: undefined },
				{ label: 'Wildcarded Operands', description: '4 bytes in 1 field', command: undefined, arguments: undefined },
			],
			wildcards: [
				{ label: 'Bytes 1–4', description: '0x1000 · a relative branch target', command: 'delver.signatures.goTo', arguments: ['0x1000'] },
			],
		});
	});

	test('validates input and fails closed on malformed search evidence', () => {
		assert.deepStrictEqual({
			valid: validateByteSearchPattern('AB ?? C? ?3'),
			invalid: validateByteSearchPattern('AB Z1'),
			presentation: byteSearchPresentation(result({
				pattern: 'ab ??',
				matches: [{ rva: '0x2000', section: '.text', bytesHex: 'ab12' }],
			})),
		}, {
			valid: undefined,
			invalid: 'Use two hexadecimal or wildcard nibbles per byte, separated by spaces.',
			presentation: {
				pattern: 'AB ??',
				matches: [{ rva: '0x2000', section: '.text', bytesHex: 'ab12' }],
				completeness: 'complete',
			},
		});
		assert.throws(() => byteSearchPresentation(result({
			pattern: 'AB',
			matches: [{ rva: 'not-an-rva', section: '.text', bytesHex: 'ab' }],
		})), /malformed/);
	});

	test('classifies and presents saved patterns scanned against a newer revision', async () => {
		const historical = {
			revision: {
				revisionId: 'revision-v1',
				contentHash: 'a'.repeat(64),
				displayName: 'sample-v1.exe',
				createdAt: 1,
			},
			signature: signature(),
		};
		const unique = revisionSignaturePresentation(historical, result({
			pattern: 'E8 ?? ?? ?? ??',
			matches: [{ rva: '0x2200', section: '.text', bytesHex: 'e812345678' }],
		}));
		const ambiguous = revisionSignaturePresentation(historical, result({
			pattern: 'E8 ?? ?? ?? ??',
			matches: [
				{ rva: '0x2200', section: '.text', bytesHex: 'e812345678' },
				{ rva: '0x3300', section: '.text', bytesHex: 'e887654321' },
			],
		}));
		const missing = revisionSignaturePresentation(historical, result({ pattern: 'E8 ?? ?? ?? ??', matches: [] }));
		const partial = revisionSignaturePresentation(historical, {
			...result({ pattern: 'E8 ?? ?? ?? ??', matches: [{ rva: '0x4400', section: '.text', bytesHex: 'e800000000' }] }),
			completeness: 'partial',
			nextCursor: 'more-matches',
		});
		const incomplete = { ...historical, status: 'incomplete' as const, matches: [], detail: 'Provider read failed.' };
		const provider = new DelverSignaturesTreeDataProvider();
		const scan = {
			targetContentHash: 'b'.repeat(64),
			results: [unique, ambiguous, missing, incomplete],
			omittedCount: 3,
		};
		provider.setRevisionScan(scan);

		const [group] = await provider.getChildren();
		const entries = await provider.getChildren(group);
		const candidates = await provider.getChildren(entries[1]);

		assert.deepStrictEqual({
			group: { label: group.label?.label, description: group.description },
			entries: entries.map(item => ({
				label: item.label?.label,
				description: item.description,
				contextValue: item.contextValue,
				command: item.command?.id,
				arguments: item.command?.arguments,
				collapsibleState: item.collapsibleState,
			})),
			candidates: candidates.map(item => ({ label: item.label?.label, command: item.command?.id, arguments: item.command?.arguments })),
		}, {
			group: { label: 'Earlier Revision Scan', description: '1/4 unique · 3 omitted' },
			entries: [
				{ label: 'decrypt_config', description: 'unique · sample-v1.exe · .text:0x2200', contextValue: 'delver-revision-signature-unique-primary', command: 'delver.signatures.goTo', arguments: ['0x2200'], collapsibleState: 0 },
				{ label: 'decrypt_config', description: '2 matches · sample-v1.exe', contextValue: 'delver-revision-signature-ambiguous', command: undefined, arguments: undefined, collapsibleState: 1 },
				{ label: 'decrypt_config', description: 'not found · sample-v1.exe', contextValue: 'delver-revision-signature-missing', command: undefined, arguments: undefined, collapsibleState: 0 },
				{ label: 'decrypt_config', description: 'not verified · sample-v1.exe', contextValue: 'delver-revision-signature-incomplete', command: undefined, arguments: undefined, collapsibleState: 0 },
			],
			candidates: [
				{ label: '.text:0x2200', command: 'delver.signatures.goTo', arguments: ['0x2200'] },
				{ label: '.text:0x3300', command: 'delver.signatures.goTo', arguments: ['0x3300'] },
			],
		});
		const xrefSite = { ...unique, signature: { ...unique.signature, variant: 'xref-site' as const } };
		const uniquePrimary = revisionSignatureRegenerationRequest(entries[0].handle, scan);
		assert.deepStrictEqual({
			uniquePrimary,
			generation: uniquePrimary && revisionSignatureGenerationInvocation(uniquePrimary),
			ambiguous: revisionSignatureRegenerationRequest(entries[1].handle, scan),
			uniqueXref: revisionSignatureRegenerationRequest(delverRevisionSignatureHandle(xrefSite), { ...scan, results: [xrefSite] }),
		}, {
			uniquePrimary: {
				rva: '0x2200',
				suggestedName: 'decrypt_config',
				sourceRevisionId: 'revision-v1',
				sourceSignatureId: 'signature-1',
				searchCallId: 'search-call',
			},
			generation: {
				policy: 'cross-revision-stable',
				sourceRevisionId: 'revision-v1',
				sourceSignatureId: 'signature-1',
			},
			ambiguous: undefined,
			uniqueXref: undefined,
		});
		assert.deepStrictEqual({ status: partial.status, hasDetail: typeof partial.detail === 'string' }, { status: 'ambiguous', hasDetail: true });
		assert.throws(() => revisionSignaturePresentation(historical, result({ pattern: '90', matches: [] })), /does not match/);
	});

	test('generates a fail-closed IDAPython function matcher', () => {
		const script = idaPythonMatcher({ ...signature(), name: 'decrypt_"config' });
		assert.deepStrictEqual({
			pattern: script.includes('"E8 ?? ?? ?? ??"'),
			escapedName: script.includes('"decrypt_\\"config"'),
			searchesAgain: script.includes('find_bytes(pattern, match_ea + 1, range_end=END_EA)'),
			requiresFunctionEntry: script.includes('function is None or function.start_ea != match_ea'),
			preservesNames: script.includes('ida_bytes.has_name(ida_bytes.get_flags(match_ea))'),
			checksName: script.includes('ida_name.SN_CHECK | ida_name.SN_NOWARN'),
			forcesName: script.includes('SN_FORCE'),
			jumpsForSingle: script.includes('len(SIGNATURES) == 1'),
			summarizes: script.includes('{applied} applied, {already_named} already named'),
		}, {
			pattern: true,
			escapedName: true,
			searchesAgain: true,
			requiresFunctionEntry: true,
			preservesNames: true,
			checksName: true,
			forcesName: false,
			jumpsForSingle: true,
			summarizes: true,
		});
		assert.throws(() => idaPythonMatcher({ ...signature(), variant: 'xref-site' }), /Only primary signatures/);
	});

	test('exports sorted primary signatures as one IDAPython bundle', () => {
		const bundle = idaPythonMatcherBundle([
			{ ...signature(), id: 'zeta', name: 'zeta' },
			{ ...signature(), id: 'xref', name: 'ignored_xref', variant: 'xref-site' },
			{ ...signature(), id: 'alpha', name: 'alpha' },
		]);
		assert.deepStrictEqual({
			sorted: bundle.indexOf('"alpha"') < bundle.indexOf('"zeta"'),
			xrefIncluded: bundle.includes('ignored_xref'),
			searchLoop: bundle.includes('for function_name, pattern in SIGNATURES:'),
			finalSummary: bundle.includes('non-function matches, {rejected} names rejected'),
		}, {
			sorted: true,
			xrefIncluded: false,
			searchLoop: true,
			finalSummary: true,
		});
		assert.throws(() => idaPythonMatcherBundle([{ ...signature(), variant: 'xref-site' }]), /At least one primary signature/);
	});
});

function result(data: unknown): IDelverAgentResult {
	return {
		schemaVersion: 1,
		callId: 'search-call',
		capability: 'delver_search_bytes',
		provenance: [],
		completeness: 'complete',
		data,
	};
}

function signature(): IDelverNamedSignature {
	return {
		id: 'signature-1',
		name: 'decrypt_config',
		contentHash: 'a'.repeat(64),
		sourceCallId: 'signature-call',
		functionRva: '0x1000',
		functionName: 'decrypt_config',
		variant: 'primary',
		scope: 'executableSections',
		policy: 'relocation-stable',
		pattern: 'E8 ?? ?? ?? ??',
		byteCount: 5,
		fixedByteCount: 1,
		wildcardByteCount: 4,
		coveredStartRva: '0x1000',
		coveredEndRva: '0x1005',
		wildcards: [{
			instructionRva: '0x1000',
			instructionByteIndex: 1,
			length: 4,
			patternByteIndex: 1,
			reason: 'relativeBranch',
		}],
		unique: true,
		matchCount: 1,
		matchCountExact: true,
		qualityScore: 0.9,
		confidence: 'high',
		createdAt: 1,
		updatedAt: 1,
	};
}
