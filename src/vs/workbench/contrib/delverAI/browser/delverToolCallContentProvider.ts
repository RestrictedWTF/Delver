/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider } from '../../../../editor/common/services/resolverService.js';
import { IDelverToolCallRecord } from '../../../../platform/delver/common/delverToolCall.js';
import { IDelverProjectService } from '../../../services/delver/common/delverProjectService.js';

export const DELVER_TOOL_CALL_SCHEME = 'delver-tool-call';

interface IDelverToolCallResourceIdentity {
	readonly contentHash: string;
	readonly callId: string;
}

/** Stable virtual resource for one immutable retained dispatcher exchange. */
export function delverToolCallResource(call: IDelverToolCallRecord): URI {
	return URI.from({
		scheme: DELVER_TOOL_CALL_SCHEME,
		path: `/${call.capability}-${call.callId}.json`,
		query: JSON.stringify({ contentHash: call.contentHash, callId: call.callId } satisfies IDelverToolCallResourceIdentity),
	});
}

/** Human-readable JSON projection without executing or trusting retained data. */
export function formatDelverToolCallDocument(call: IDelverToolCallRecord): string {
	return `${JSON.stringify({
		schemaVersion: 1,
		callId: call.callId,
		capability: call.capability,
		contentHash: call.contentHash,
		...(call.caller === undefined ? {} : { caller: call.caller }),
		startedAt: call.startedAt,
		finishedAt: call.finishedAt,
		durationMs: call.finishedAt - call.startedAt,
		request: JSON.parse(call.requestJson),
		result: JSON.parse(call.resultJson),
	}, null, '\t')}\n`;
}

export class DelverToolCallContentProvider implements ITextModelContentProvider {
	constructor(
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IDelverProjectService private readonly projectService: IDelverProjectService,
	) { }

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const identity = parseResourceIdentity(resource);
		if (!identity) {
			return null;
		}
		const call = this.projectService.toolCall(identity.contentHash, identity.callId);
		if (!call) {
			return null;
		}
		return this.modelService.getModel(resource)
			?? this.modelService.createModel(formatDelverToolCallDocument(call), this.languageService.createById('json'), resource);
	}
}

function parseResourceIdentity(resource: URI): IDelverToolCallResourceIdentity | undefined {
	if (resource.scheme !== DELVER_TOOL_CALL_SCHEME) {
		return undefined;
	}
	try {
		const value = JSON.parse(resource.query) as Partial<IDelverToolCallResourceIdentity>;
		if (typeof value.contentHash !== 'string' || typeof value.callId !== 'string') {
			return undefined;
		}
		return { contentHash: value.contentHash, callId: value.callId };
	} catch {
		return undefined;
	}
}
