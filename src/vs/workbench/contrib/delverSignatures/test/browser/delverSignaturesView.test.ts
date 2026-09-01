/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DelverSignaturePolicy, IDelverNamedSignature } from '../../../../../platform/delver/common/delverSignature.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { DelverSurfaceId } from '../../../../services/delver/browser/delverSurface.js';
import { allDelverSurfaces, registerDelverSurface, zoneForSurface } from '../../../../services/delver/browser/delverSurfaceRegistry.js';
import { DelverZone, IDelverSurface } from '../../../../services/delver/browser/delverSurface.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { DelverWorkspaceService, IDelverWorkspaceService } from '../../../../services/delver/common/delverWorkspaceService.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProgressService } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IDelverAgentService } from '../../../../services/delver/common/delverAgentService.js';
import { SearchBytePatternAction } from '../../browser/delverSignaturesActions.js';
import { IDelverAgentResult } from '../../../../services/delver/common/delverAgentTypes.js';
import { IDelverProjectService } from '../../../../services/delver/common/delverProjectService.js';
import { IDelverSessionService } from '../../../../services/delver/common/delverSessionService.js';
import { ViewDescriptorService } from '../../../../services/views/browser/viewDescriptorService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { DelverSignaturesViewContribution } from '../../browser/delverSignatures.contribution.js';
import { byteSearchPresentation, idaPythonMatcher, idaPythonMatcherBundle, revisionSignatureGenerationInvocation, revisionSignaturePresentation, revisionSignatureRegenerationRequest, revisionSignatureScanSummary, validateByteSearchPattern } from '../../browser/delverSignaturesActions.js';
import { delverRevisionSignatureHandle, IDelverRevisionSignatureResult, IDelverSignaturesStateService } from '../../browser/delverSignaturesState.js';
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

	test('names every saved signature policy distinctly', async () => {
		const policies: readonly DelverSignaturePolicy[] = ['unique-now', 'relocation-stable', 'cross-revision-stable'];
		const provider = new DelverSignaturesTreeDataProvider();
		provider.setSignatures(policies.map((policy, index) => ({ ...signature(), id: `signature-${index}`, policy })));

		const [saved] = await provider.getChildren();
		const rows = await provider.getChildren(saved);
		const strategies = await Promise.all(rows.map(async row => {
			const evidence = await provider.getChildren(row);
			return evidence.find(item => item.label?.label === 'Strategy')?.description;
		}));

		assert.deepStrictEqual(strategies, [
			'primary · unique now · executable sections',
			'primary · relocation stable · executable sections',
			'primary · cross-revision stable · executable sections',
		]);
	});

	test('reports omitted signatures in revision scan summaries', () => {
		const base = {
			revision: {
				revisionId: 'revision-v1',
				contentHash: 'a'.repeat(64),
				displayName: 'sample-v1.exe',
				createdAt: 1,
			},
			signature: signature(),
			matches: [],
		};
		const unique: IDelverRevisionSignatureResult = { ...base, status: 'unique' };
		const incomplete: IDelverRevisionSignatureResult = { ...base, status: 'incomplete' };

		assert.deepStrictEqual({
			complete: revisionSignatureScanSummary([unique, incomplete], 0),
			oneOmitted: revisionSignatureScanSummary([unique], 1),
			manyOmitted: revisionSignatureScanSummary([unique, incomplete], 3),
		}, {
			complete: 'Scanned 2 earlier signatures: 1 uniquely located, 1 need attention.',
			oneOmitted: 'Scanned 1 of 2 earlier signatures: 1 uniquely located, 0 need attention. 1 signature was not scanned.',
			manyOmitted: 'Scanned 2 of 5 earlier signatures: 1 uniquely located, 1 need attention. 3 signatures were not scanned.',
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

suite('Delver signatures view contribution lifetime', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('disposing the contribution releases its tree view and its surface', () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(IViewDescriptorService, disposables.add(instantiationService.createInstance(ViewDescriptorService)));
		instantiationService.stub(IDelverSessionService, {
			activeSession: undefined,
			onDidChangeActiveSession: Event.None,
		});
		instantiationService.stub(IDelverProjectService, {
			onDidChangeSignatures: Event.None,
			signaturesFor: () => [],
		});
		instantiationService.stub(IDelverSignaturesStateService, {
			onDidChange: Event.None,
			search: undefined,
			revisionScan: undefined,
			clear: () => { },
		});

		// The tree view itself is covered by the suite's disposable tracker: it
		// is created here and nothing else can release it, so a contribution
		// that forgets to register it fails this test on teardown.
		const contribution = instantiationService.createInstance(DelverSignaturesViewContribution);
		const registeredWhileAlive = allDelverSurfaces().some(surface => surface.id === DelverSurfaceId.Signatures);
		contribution.dispose();

		assert.deepStrictEqual(
			{
				registeredWhileAlive,
				registeredAfterDispose: allDelverSurfaces().some(surface => surface.id === DelverSurfaceId.Signatures),
			},
			{ registeredWhileAlive: true, registeredAfterDispose: false },
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

suite('Delver signatures reveal', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	// The search action used to reveal through `IViewsService.openView`, which
	// can never open a Delver surface: the Signatures view descriptor is
	// registered `when: false` (it exists only so `TreeView`'s progress location
	// resolves), so it is in no container's view model and the reveal silently
	// did nothing. Asserting a call was made would not have caught that; this
	// asserts the reveal names a surface the Inspector zone actually hosts.
	test('searching a byte pattern reveals the Signatures surface in its zone', async () => {
		// A stand-in for the surface `DelverSignaturesViewContribution` registers:
		// its view descriptor cannot be registered twice in one process, and the
		// lifetime suite above already covers that the real contribution
		// registers this id in this zone.
		disposables.add(registerDelverSurface({
			id: DelverSurfaceId.Signatures,
			title: { value: 'Signatures', original: 'Signatures' },
			zone: DelverZone.Inspector,
			order: 10,
			ctor: new SyncDescriptor<IDelverSurface>(StubSurface),
		}));

		const workspaceService = disposables.add(new DelverWorkspaceService());
		const reached: { id: string; zone: DelverZone | undefined }[] = [];
		disposables.add(workspaceService.onDidRequestSurface(id => reached.push({ id, zone: zoneForSurface(allDelverSurfaces(), id) })));

		const stubs = new Map<unknown, unknown>([
			[IDelverWorkspaceService, workspaceService],
			[IDelverAgentService, { invoke: async () => result({ pattern: '48 8B ?? FF', matches: [{ rva: '0x1010', section: '.text', bytesHex: '488b12ff' }] }) }],
			[IDelverSignaturesStateService, { search: undefined, setSearch: () => { } }],
			[IQuickInputService, {}],
			[INotificationService, { info: () => { }, error: () => { } }],
			[IProgressService, { withProgress: (_options: unknown, task: () => Promise<unknown>) => task() }],
			[IDelverSessionService, { activeSession: { contentHash: 'a'.repeat(64) } }],
		]);
		const accessor = { get: (id: unknown) => stubs.get(id) } as unknown as ServicesAccessor;

		await new SearchBytePatternAction().run(accessor, '48 8B ?? FF');

		assert.deepStrictEqual(reached, [{ id: DelverSurfaceId.Signatures, zone: DelverZone.Inspector }]);
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
