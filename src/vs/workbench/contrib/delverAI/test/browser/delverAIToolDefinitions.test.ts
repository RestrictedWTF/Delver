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

	test('describes review-only proposal batches with bounded canonical schemas', () => {
		const tools = new Map(getDelverAgentToolData().map(tool => [tool.id, tool]));
		const rename = tools.get('delver_propose_rename');
		const comment = tools.get('delver_propose_comment');
		const tag = tools.get('delver_propose_tag');
		const finding = tools.get('delver_report_finding');

		assert.deepStrictEqual({
			renameRequired: rename?.inputSchema?.required,
			renameBatchMaximum: rename?.inputSchema?.properties?.proposals?.maxItems,
			renameItem: rename?.inputSchema?.properties?.proposals?.items,
			commentMaximum: (comment?.inputSchema?.properties?.proposals?.items as { properties?: { comment?: { maxLength?: number } } })?.properties?.comment?.maxLength,
			tagValue: (tag?.inputSchema?.properties?.proposals?.items as { properties?: { tags?: unknown } })?.properties?.tags,
			findingBatchMaximum: finding?.inputSchema?.properties?.findings?.maxItems,
			findingRequired: (finding?.inputSchema?.properties?.findings?.items as { required?: readonly string[] })?.required,
			findingEvidence: ((finding?.inputSchema?.properties?.findings?.items as { properties?: { evidence?: { minItems?: number; maxItems?: number } } })?.properties?.evidence),
			reviewOnly: [rename, comment, tag, finding].every(tool => tool?.modelDescription.includes('provisional')),
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
