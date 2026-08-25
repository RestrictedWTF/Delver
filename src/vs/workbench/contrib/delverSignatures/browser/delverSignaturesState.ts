/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IDelverHistoricalSignature } from '../../../services/delver/common/delverProjectService.js';

export const DELVER_SIGNATURES_VIEW_ID = 'delver.view.signatures';
export const DELVER_SIGNATURES_SEARCH_COMMAND = 'delver.signatures.search';
export const DELVER_SIGNATURES_GO_TO_COMMAND = 'delver.signatures.goTo';
export const DELVER_SIGNATURES_COPY_PATTERN_COMMAND = 'delver.signatures.copyPattern';
export const DELVER_SIGNATURES_COPY_IDAPYTHON_COMMAND = 'delver.signatures.copyIdaPython';
export const DELVER_SIGNATURES_EXPORT_IDAPYTHON_COMMAND = 'delver.signatures.exportIdaPython';
export const DELVER_SIGNATURES_RENAME_COMMAND = 'delver.signatures.rename';
export const DELVER_SIGNATURES_DELETE_COMMAND = 'delver.signatures.delete';
export const DELVER_SIGNATURES_SCAN_REVISIONS_COMMAND = 'delver.signatures.scanRevisions';
export const DELVER_SIGNATURES_REGENERATE_REVISION_COMMAND = 'delver.signatures.regenerateRevisionMatch';
export const DELVER_SIGNATURES_SAVED_HANDLE_PREFIX = 'delver.signatures.saved.';

export interface IDelverSignatureSearchMatch {
	readonly rva: string;
	readonly section: string;
	readonly bytesHex: string;
}

export interface IDelverSignatureSearchState {
	readonly pattern: string;
	readonly matches: readonly IDelverSignatureSearchMatch[];
	readonly completeness: 'complete' | 'partial';
	readonly nextCursor?: string;
}

export type DelverRevisionSignatureStatus = 'unique' | 'ambiguous' | 'missing' | 'incomplete';

/** Result of testing one older revision's saved pattern against the attached target. */
export interface IDelverRevisionSignatureResult extends IDelverHistoricalSignature {
	readonly status: DelverRevisionSignatureStatus;
	readonly matches: readonly IDelverSignatureSearchMatch[];
	/** Retained byte-search proof for accepting a migration from this result. */
	readonly searchCallId?: string;
	readonly detail?: string;
}

export interface IDelverRevisionSignatureScanState {
	readonly targetContentHash: string;
	readonly results: readonly IDelverRevisionSignatureResult[];
	readonly omittedCount: number;
}

export function delverRevisionSignatureHandle(result: IDelverRevisionSignatureResult): string {
	return `delver.signatures.revisionScan.${result.revision.revisionId}.${result.signature.id}.${result.status}`;
}

export const IDelverSignaturesStateService = createDecorator<IDelverSignaturesStateService>('delverSignaturesStateService');

export interface IDelverSignaturesStateService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	readonly search: IDelverSignatureSearchState | undefined;
	readonly revisionScan: IDelverRevisionSignatureScanState | undefined;
	setSearch(search: IDelverSignatureSearchState, append: boolean): void;
	setRevisionScan(scan: IDelverRevisionSignatureScanState): void;
	clear(): void;
}

/** Holds the transient byte-search result displayed by the Signatures view. */
class DelverSignaturesStateService extends Disposable implements IDelverSignaturesStateService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private current: IDelverSignatureSearchState | undefined;
	private currentRevisionScan: IDelverRevisionSignatureScanState | undefined;

	get search(): IDelverSignatureSearchState | undefined {
		return this.current;
	}

	get revisionScan(): IDelverRevisionSignatureScanState | undefined {
		return this.currentRevisionScan;
	}

	setSearch(search: IDelverSignatureSearchState, append: boolean): void {
		if (append && this.current?.pattern === search.pattern) {
			const matches = new Map(this.current.matches.map(match => [`${match.section}:${match.rva}`, match]));
			for (const match of search.matches) {
				matches.set(`${match.section}:${match.rva}`, match);
			}
			this.current = { ...search, matches: [...matches.values()] };
		} else {
			this.current = search;
		}
		this._onDidChange.fire();
	}

	setRevisionScan(scan: IDelverRevisionSignatureScanState): void {
		this.currentRevisionScan = scan;
		this._onDidChange.fire();
	}

	clear(): void {
		if (this.current !== undefined || this.currentRevisionScan !== undefined) {
			this.current = undefined;
			this.currentRevisionScan = undefined;
			this._onDidChange.fire();
		}
	}
}

registerSingleton(IDelverSignaturesStateService, DelverSignaturesStateService, InstantiationType.Delayed);
