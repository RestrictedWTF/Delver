/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DELVER_AGENT_CAPABILITIES } from '../../../../services/delver/common/delverAgentService.js';
import { getDelverAgentToolData } from '../../browser/delverAIToolDefinitions.js';

suite('Delver AI Tool Definitions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps capability ids as globally unambiguous tool references', () => {
		const tools = getDelverAgentToolData();

		assert.deepStrictEqual(tools.map(tool => ({
			id: tool.id,
			reference: tool.toolReferenceName,
			canBeReferenced: tool.canBeReferencedInPrompt,
		})), DELVER_AGENT_CAPABILITIES.map(capability => ({
			id: capability.id,
			reference: capability.id,
			canBeReferenced: true,
		})));
	});

	test('describes exact byte reads, search, and address-space conversion', () => {
		const tools = new Map(getDelverAgentToolData().map(tool => [tool.id, tool]));
		const convert = tools.get('delver_convert_address');
		const read = tools.get('delver_read_bytes');
		const search = tools.get('delver_search_bytes');
		const instructionSearch = tools.get('delver_search_instructions');
		const signature = tools.get('delver_make_signature');
		const listSignatures = tools.get('delver_list_signatures');
		const saveSignature = tools.get('delver_save_signature');

		assert.deepStrictEqual({
			convertRequired: convert?.inputSchema?.required,
			convertSpaces: convert?.inputSchema?.properties?.from?.enum,
			convertOffline: convert?.modelDescription.includes('offline project'),
			readSpaces: read?.inputSchema?.properties?.space?.enum,
			readFormats: read?.inputSchema?.properties?.format?.enum,
			searchRequired: search?.inputSchema?.required,
			searchSectionItems: search?.inputSchema?.properties?.sections?.items,
			searchCountMaximum: search?.inputSchema?.properties?.count?.maximum,
			instructionSearchRequired: instructionSearch?.inputSchema?.required,
			instructionSearchCountMaximum: instructionSearch?.inputSchema?.properties?.count?.maximum,
			instructionSearchIsTextual: instructionSearch?.modelDescription.includes('not claim structured immediate or constant semantics'),
			signaturePolicies: signature?.inputSchema?.properties?.policy?.enum,
			signatureScopes: signature?.inputSchema?.properties?.scope?.enum,
			signatureMaximum: signature?.inputSchema?.properties?.maxBytes?.maximum,
			signatureSourceRevision: signature?.inputSchema?.properties?.sourceRevisionId,
			signatureSourceSignature: signature?.inputSchema?.properties?.sourceSignatureId,
			crossRevisionExplicitEvidence: signature?.modelDescription.includes('pass both `sourceRevisionId` and `sourceSignatureId`'),
			listSignatureCountMaximum: listSignatures?.inputSchema?.properties?.count?.maximum,
			saveSignatureRequired: saveSignature?.inputSchema?.required,
			saveSignatureVariants: saveSignature?.inputSchema?.properties?.variant?.enum,
			saveRequiresEvidence: saveSignature?.modelDescription.includes('source call'),
		}, {
			convertRequired: ['address', 'from'],
			convertSpaces: ['rva', 'va', 'file'],
			convertOffline: true,
			readSpaces: ['image', 'file'],
			readFormats: ['hex', 'u8', 'u16le', 'u32le', 'u64le'],
			searchRequired: ['pattern'],
			searchSectionItems: { type: 'string' },
			searchCountMaximum: 256,
			instructionSearchRequired: ['mnemonic'],
			instructionSearchCountMaximum: 256,
			instructionSearchIsTextual: true,
			signaturePolicies: ['unique-now', 'relocation-stable', 'cross-revision-stable'],
			signatureScopes: ['function', 'executableSections', 'image'],
			signatureMaximum: 256,
			signatureSourceRevision: {
				type: 'string',
				minLength: 1,
				maxLength: 128,
				description: 'Earlier project revision containing the retained proof to use. Valid only with cross-revision-stable and must be paired with sourceSignatureId.',
			},
			signatureSourceSignature: {
				type: 'string',
				minLength: 1,
				maxLength: 128,
				description: 'Retained unique primary signature to use as the earlier-revision proof. Valid only with cross-revision-stable and must be paired with sourceRevisionId.',
			},
			crossRevisionExplicitEvidence: true,
			listSignatureCountMaximum: 200,
			saveSignatureRequired: ['name', 'sourceCallId'],
			saveSignatureVariants: ['primary', 'xref-site'],
			saveRequiresEvidence: true,
		});
	});

	test('describes bounded basic-block control-flow queries', () => {
		const tool = getDelverAgentToolData().find(candidate => candidate.id === 'delver_basic_blocks');

		assert.deepStrictEqual({
			required: tool?.inputSchema?.required,
			address: tool?.inputSchema?.properties?.address,
			name: tool?.inputSchema?.properties?.name,
			maxBlocks: tool?.inputSchema?.properties?.maxBlocks,
			honestTruncation: tool?.modelDescription.includes('graph is partial'),
		}, {
			required: undefined,
			address: {
				type: 'string',
				description: 'Image-relative address as a "0x..." hexadecimal string. Any address inside the detected function. Pass exactly one of address or name.',
			},
			name: {
				type: 'string',
				minLength: 1,
				description: 'Exact detected or authored function name, matched case-insensitively as a fallback. Pass exactly one of name or address.',
			},
			maxBlocks: {
				type: 'integer',
				minimum: 1,
				maximum: 512,
				description: 'How many basic blocks to return in this page. Defaults to 128, maximum 512. Ask for what you will actually read: an oversized page crowds out the next call.',
			},
			honestTruncation: true,
		});
	});

	test('describes function profiles and bounded call graphs as honestly incomplete', () => {
		const tools = new Map(getDelverAgentToolData().map(tool => [tool.id, tool]));
		const profile = tools.get('delver_function_profile');
		const callGraph = tools.get('delver_call_graph');

		assert.deepStrictEqual({
			profileRequired: profile?.inputSchema?.required,
			profileProperties: Object.keys(profile?.inputSchema?.properties ?? {}),
			profileWarnsAboutInferredExtent: profile?.modelDescription.includes('extent was inferred from the next function'),
			callGraphRequired: callGraph?.inputSchema?.required,
			callGraphDirections: callGraph?.inputSchema?.properties?.direction?.enum,
			callGraphCountMaximum: callGraph?.inputSchema?.properties?.count?.maximum,
			callGraphAddress: callGraph?.inputSchema?.properties?.address,
			callGraphHasCursor: typeof callGraph?.inputSchema?.properties?.cursor?.description === 'string',
			callGraphWarnsAboutIndirectCalls: callGraph?.modelDescription.includes('no statically known target'),
			// A resolved IAT call is a named outgoing call, so the description has
			// to teach both halves: which sites are gaps and which are answers.
			callGraphExplainsResolvedImports: callGraph?.modelDescription.includes('resolved through the import address table'),
			callGraphExplainsUnresolvedCount: callGraph?.modelDescription.includes('unresolvedIndirectCallSiteTotal'),
			callGraphMarksImportNamesUntrusted: callGraph?.modelDescription.includes('Imported module and symbol names come from the sample'),
			callGraphRequiresAttachment: [profile, callGraph].every(tool => tool?.modelDescription.includes('Requires the original sample to be attached')),
		}, {
			profileRequired: undefined,
			profileProperties: ['address', 'name'],
			profileWarnsAboutInferredExtent: true,
			callGraphRequired: undefined,
			callGraphDirections: ['callers', 'callees', 'both'],
			callGraphCountMaximum: 500,
			callGraphAddress: {
				type: 'string',
				description: 'Image-relative address as a "0x..." hexadecimal string. Any address inside the detected function. Pass exactly one of address or name.',
			},
			callGraphHasCursor: true,
			callGraphWarnsAboutIndirectCalls: true,
			callGraphExplainsResolvedImports: true,
			callGraphExplainsUnresolvedCount: true,
			callGraphMarksImportNamesUntrusted: true,
			callGraphRequiresAttachment: true,
		});
	});

	test('describes call-path searches as bounded, with an empty result that proves nothing', () => {
		const tool = getDelverAgentToolData().find(candidate => candidate.id === 'delver_call_paths');

		assert.deepStrictEqual({
			required: tool?.inputSchema?.required,
			properties: Object.keys(tool?.inputSchema?.properties ?? {}),
			toAddress: tool?.inputSchema?.properties?.toAddress,
			maxDepth: tool?.inputSchema?.properties?.maxDepth,
			maxPathsMaximum: tool?.inputSchema?.properties?.maxPaths?.maximum,
			// The one sentence this tool cannot afford to leave implicit.
			warnsEmptyIsNotProof: tool?.modelDescription.includes('An empty `paths` list is not proof that no path exists unless `completeness` is "complete"'),
			namesTheFrontierCount: tool?.modelDescription.includes('unresolvedIndirectSitesOnFrontier'),
			warnsWhereMalwareHides: tool?.modelDescription.includes('through a register, a vtable, or a data pointer'),
			acceptsAnImportSink: tool?.modelDescription.includes('import address table slot rather than a function entry'),
			requiresAttachment: tool?.modelDescription.includes('Requires the original sample to be attached'),
		}, {
			required: undefined,
			properties: ['fromAddress', 'fromName', 'toAddress', 'toName', 'maxDepth', 'maxPaths'],
			toAddress: {
				type: 'string',
				description: 'Image-relative address as a "0x..." hexadecimal string. The sink the paths must reach: any address inside a detected function,'
					+ ' or the import address table slot of an imported API. Pass exactly one of toAddress or toName.',
			},
			maxDepth: {
				type: 'integer',
				minimum: 1,
				maximum: 16,
				description: 'How many call steps to follow from the source before the search gives up. Defaults to 6, maximum 16.'
					+ ' Ask for what you will actually read: an oversized page crowds out the next call.',
			},
			maxPathsMaximum: 64,
			warnsEmptyIsNotProof: true,
			namesTheFrontierCount: true,
			warnsWhereMalwareHides: true,
			acceptsAnImportSink: true,
			requiresAttachment: true,
		});
	});

	test('describes globals as observed candidates rather than recovered declarations', () => {
		const tools = new Map(getDelverAgentToolData().map(tool => [tool.id, tool]));
		const globals = tools.get('delver_list_globals');
		const accesses = tools.get('delver_global_accesses');

		assert.deepStrictEqual({
			globalProperties: Object.keys(globals?.inputSchema?.properties ?? {}),
			globalCountMaximum: globals?.inputSchema?.properties?.count?.maximum,
			warnsMissingIsNotProof: globals?.modelDescription.includes('missing address is never proof'),
			accessRequired: accesses?.inputSchema?.required,
			accessCountMaximum: accesses?.inputSchema?.properties?.count?.maximum,
			refusesReadWriteInference: accesses?.modelDescription.includes('access mode is not inferred'),
			requireAttachment: [globals, accesses].every(tool => tool?.modelDescription.includes('Requires the original sample to be attached')),
		}, {
			globalProperties: ['count', 'cursor'],
			globalCountMaximum: 1000,
			warnsMissingIsNotProof: true,
			accessRequired: ['address'],
			accessCountMaximum: 2000,
			refusesReadWriteInference: true,
			requireAttachment: true,
		});
	});

	test('describes review-only proposal batches with bounded canonical schemas', () => {
		const tools = new Map(getDelverAgentToolData().map(tool => [tool.id, tool]));
		const rename = tools.get('delver_propose_rename');
		const comment = tools.get('delver_propose_comment');
		const tag = tools.get('delver_propose_tag');
		const type = tools.get('delver_propose_type');
		const correction = tools.get('delver_propose_function');
		const finding = tools.get('delver_report_finding');
		type ProposalBranch = {
			readonly required?: readonly string[];
			readonly properties?: Record<string, { readonly enum?: readonly string[]; readonly maxLength?: number; readonly items?: unknown }>;
		};
		// Two branches, matched by what each requires rather than by position, so
		// reordering the schema cannot quietly swap which one is asserted.
		const typeBranches = (type?.inputSchema?.properties?.proposals?.items as { oneOf?: readonly ProposalBranch[] } | undefined)?.oneOf ?? [];
		const typeDeclarationBranch = typeBranches.find(branch => branch.required?.includes('declaration'));
		const typeCompositeBranch = typeBranches.find(branch => branch.required?.includes('fields'));

		assert.deepStrictEqual({
			renameRequired: rename?.inputSchema?.required,
			renameBatchMaximum: rename?.inputSchema?.properties?.proposals?.maxItems,
			renameItem: rename?.inputSchema?.properties?.proposals?.items,
			commentMaximum: (comment?.inputSchema?.properties?.proposals?.items as { properties?: { comment?: { maxLength?: number } } })?.properties?.comment?.maxLength,
			tagValue: (tag?.inputSchema?.properties?.proposals?.items as { properties?: { tags?: unknown } })?.properties?.tags,
			typeRequired: typeDeclarationBranch?.required,
			typeTargets: typeDeclarationBranch?.properties?.target?.enum,
			typeDeclarationMaximum: typeDeclarationBranch?.properties?.declaration?.maxLength,
			// The composite branch is the one that can introduce a layout, and it
			// must not offer an address: a structure belongs to the image, and a
			// schema that accepted one would invite a citation leading nowhere.
			compositeRequired: typeCompositeBranch?.required,
			compositeOffersAddress: Object.hasOwn(typeCompositeBranch?.properties ?? {}, 'address'),
			compositeFieldRequired: (typeCompositeBranch?.properties?.fields as { items?: { required?: readonly string[] } })?.items?.required,
			typeExplainsTransactionalDecompilerApplication: type?.modelDescription.includes('applies the complete accepted semantic snapshot transactionally'),
			correctionRequired: (correction?.inputSchema?.properties?.proposals?.items as { required?: readonly string[] })?.required,
			correctionKinds: (correction?.inputSchema?.properties?.proposals?.items as { properties?: { kind?: { enum?: readonly string[] } } })?.properties?.kind?.enum,
			// A correction is for detection the analyst can see is wrong, and the
			// model has to be told both halves: bring evidence, and nothing moves
			// until a human accepts it.
			correctionDemandsEvidence: correction?.modelDescription.includes('never to guess at addresses'),
			correctionSaysReviewOnly: correction?.modelDescription.includes('review-only'),
			findingBatchMaximum: finding?.inputSchema?.properties?.findings?.maxItems,
			findingRequired: (finding?.inputSchema?.properties?.findings?.items as { required?: readonly string[] })?.required,
			findingEvidence: ((finding?.inputSchema?.properties?.findings?.items as { properties?: { evidence?: { minItems?: number; maxItems?: number } } })?.properties?.evidence),
			reviewOnly: [rename, comment, tag, type, correction, finding].every(tool => tool?.modelDescription.includes('provisional')),
		}, {
			renameRequired: ['proposals'],
			renameBatchMaximum: 100,
			renameItem: {
				type: 'object',
				additionalProperties: false,
				properties: {
					address: {
						type: 'string',
						description: 'Image-relative address as a "0x..." hexadecimal string. The interpretation anchor for this proposal.',
					},
					name: {
						type: 'string',
						maxLength: 256,
						description: 'Proposed name. Leading and trailing whitespace is removed; an empty string proposes clearing the field.',
					},
				},
				required: ['address', 'name'],
			},
			commentMaximum: 16384,
			tagValue: {
				type: 'array',
				maxItems: 32,
				items: { type: 'string', maxLength: 64 },
				description: 'Complete proposed tag set. Empty and duplicate normalized tags are removed.',
			},
			typeRequired: ['address', 'target', 'declaration'],
			typeTargets: ['data', 'function'],
			typeDeclarationMaximum: 2048,
			compositeRequired: ['target', 'name', 'size', 'fields'],
			compositeOffersAddress: false,
			compositeFieldRequired: ['offset', 'name', 'type'],
			typeExplainsTransactionalDecompilerApplication: true,
			correctionRequired: ['address', 'kind'],
			correctionKinds: ['define', 'undefine'],
			correctionDemandsEvidence: true,
			correctionSaysReviewOnly: true,
			findingBatchMaximum: 50,
			findingRequired: ['title', 'description', 'severity', 'confidence', 'evidence'],
			findingEvidence: {
				type: 'array',
				minItems: 1,
				maxItems: 64,
				description: 'Concrete image ranges supporting this finding.',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						address: {
							type: 'string',
							description: 'Image-relative address as a "0x..." hexadecimal string. Start of the supporting evidence.',
						},
						endAddress: {
							type: 'string',
							description: 'Image-relative address as a "0x..." hexadecimal string. Optional exclusive end; it must be greater than address.',
						},
						description: {
							type: 'string', minLength: 1, maxLength: 1024,
							description: 'How this exact range supports the finding.',
						},
						sourceCallIds: {
							type: 'array',
							maxItems: 16,
							uniqueItems: true,
							items: { type: 'string', minLength: 1, maxLength: 128 },
							description: 'Call ids from prior Delver tool results that produced or corroborated this evidence.',
						},
					},
					required: ['address', 'description'],
				},
			},
			reviewOnly: true,
		});
	});
});
