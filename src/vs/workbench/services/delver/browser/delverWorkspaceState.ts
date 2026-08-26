/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { DelverSurfaceId } from './delverSurface.js';

export interface IDelverWorkspaceState {
	readonly navigatorWidth: number;
	readonly inspectorWidth: number;
	readonly navigatorSurfaceId: string;
	readonly inspectorSurfaceId: string;
	readonly primarySurfaceId: string;
	/** Which zones are shown. Never all false — see `normalizeDelverWorkspaceState`. */
	readonly navigatorVisible: boolean;
	readonly primaryVisible: boolean;
	readonly inspectorVisible: boolean;
	/**
	 * Fraction of the Primary zone given to Listing when Pseudocode sits beside
	 * it. How much disassembly versus C an analyst wants depends on what they
	 * are reading, so it is theirs to set and worth remembering per target.
	 */
	readonly primarySplitRatio: number;
}

export const DEFAULT_DELVER_WORKSPACE_STATE: IDelverWorkspaceState = {
	navigatorWidth: 280,
	inspectorWidth: 280,
	navigatorSurfaceId: DelverSurfaceId.Functions,
	inspectorSurfaceId: DelverSurfaceId.Xrefs,
	primarySurfaceId: DelverSurfaceId.Listing,
	navigatorVisible: true,
	primaryVisible: true,
	inspectorVisible: true,
	primarySplitRatio: 0.5,
};

const STORAGE_PREFIX = 'delver.workspace.layout.';

/** Per-target layout persistence with fail-safe validation of stored state. */
export class DelverWorkspaceStateStore {

	constructor(private readonly storageService: IStorageService) { }

	load(targetPath: string): IDelverWorkspaceState {
		const stored = this.storageService.getObject<Partial<IDelverWorkspaceState>>(this.key(targetPath), StorageScope.WORKSPACE, {});
		return normalizeDelverWorkspaceState(stored);
	}

	save(targetPath: string, state: IDelverWorkspaceState): void {
		this.storageService.store(this.key(targetPath), state, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private key(targetPath: string): string {
		return `${STORAGE_PREFIX}${encodeURIComponent(targetPath)}`;
	}
}

const RECENTS_KEY = 'delver.workspace.recentTargets';
const RECENTS_LIMIT = 10;

/**
 * Recently opened targets, most recent first.
 *
 * Application-scoped rather than workspace-scoped: an analyst opens the same
 * sample from several folders, and a recents list that resets per window is a
 * list nobody uses. Kept separate from layout state, which is genuinely
 * per-target and per-workspace.
 */
export class DelverRecentTargetsStore {

	constructor(private readonly storageService: IStorageService) { }

	list(): readonly string[] {
		const stored = this.storageService.getObject<string[]>(RECENTS_KEY, StorageScope.APPLICATION, []);
		if (!Array.isArray(stored)) {
			return [];
		}
		// Stored data is not trusted to still match this shape — a downgrade or a
		// hand-edited storage file would otherwise render `undefined` as a row.
		return stored.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).slice(0, RECENTS_LIMIT);
	}

	add(targetPath: string): void {
		const next = [targetPath, ...this.list().filter(entry => entry !== targetPath)].slice(0, RECENTS_LIMIT);
		this.storageService.store(RECENTS_KEY, next, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}

export function normalizeDelverWorkspaceState(value: Partial<IDelverWorkspaceState>): IDelverWorkspaceState {
	return {
		navigatorWidth: validWidth(value.navigatorWidth, DEFAULT_DELVER_WORKSPACE_STATE.navigatorWidth),
		inspectorWidth: validWidth(value.inspectorWidth, DEFAULT_DELVER_WORKSPACE_STATE.inspectorWidth),
		navigatorSurfaceId: validId(value.navigatorSurfaceId, DEFAULT_DELVER_WORKSPACE_STATE.navigatorSurfaceId),
		inspectorSurfaceId: validId(value.inspectorSurfaceId, DEFAULT_DELVER_WORKSPACE_STATE.inspectorSurfaceId),
		primarySurfaceId: validId(value.primarySurfaceId, DEFAULT_DELVER_WORKSPACE_STATE.primarySurfaceId),
		// Hiding every zone would leave an empty editor with no way back, so a
		// state that says so is treated as corrupt rather than obeyed.
		...visibleZones(value),
		primarySplitRatio: validRatio(value.primarySplitRatio, DEFAULT_DELVER_WORKSPACE_STATE.primarySplitRatio),
	};
}

function visibleZones(value: Partial<IDelverWorkspaceState>): Pick<IDelverWorkspaceState, 'navigatorVisible' | 'primaryVisible' | 'inspectorVisible'> {
	const navigatorVisible = value.navigatorVisible !== false;
	const primaryVisible = value.primaryVisible !== false;
	const inspectorVisible = value.inspectorVisible !== false;
	return navigatorVisible || primaryVisible || inspectorVisible
		? { navigatorVisible, primaryVisible, inspectorVisible }
		: { navigatorVisible: true, primaryVisible: true, inspectorVisible: true };
}

/**
 * A split fraction, or the fallback.
 *
 * Bounded away from both edges: a stored 0 or 1 would restore a zone with one
 * pane collapsed to nothing and no visible sash to drag back.
 */
function validRatio(value: number | undefined, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0.05 && value <= 0.95 ? value : fallback;
}

function validWidth(value: number | undefined, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 100 && value <= 4000 ? value : fallback;
}

function validId(value: string | undefined, fallback: string): string {
	return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : fallback;
}
