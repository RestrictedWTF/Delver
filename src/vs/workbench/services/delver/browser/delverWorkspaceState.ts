/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { DelverSurfaceId } from './delverSurface.js';

export type DelverPrimaryMode = 'overview' | 'reading';

export interface IDelverWorkspaceState {
	readonly navigatorWidth: number;
	readonly inspectorWidth: number;
	readonly navigatorSurfaceId: string;
	readonly inspectorSurfaceId: string;
	readonly primaryMode: DelverPrimaryMode;
}

export const DEFAULT_DELVER_WORKSPACE_STATE: IDelverWorkspaceState = {
	navigatorWidth: 240,
	inspectorWidth: 280,
	navigatorSurfaceId: DelverSurfaceId.Functions,
	inspectorSurfaceId: DelverSurfaceId.Xrefs,
	primaryMode: 'overview',
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

export function normalizeDelverWorkspaceState(value: Partial<IDelverWorkspaceState>): IDelverWorkspaceState {
	return {
		navigatorWidth: validWidth(value.navigatorWidth, DEFAULT_DELVER_WORKSPACE_STATE.navigatorWidth),
		inspectorWidth: validWidth(value.inspectorWidth, DEFAULT_DELVER_WORKSPACE_STATE.inspectorWidth),
		navigatorSurfaceId: validId(value.navigatorSurfaceId, DEFAULT_DELVER_WORKSPACE_STATE.navigatorSurfaceId),
		inspectorSurfaceId: validId(value.inspectorSurfaceId, DEFAULT_DELVER_WORKSPACE_STATE.inspectorSurfaceId),
		primaryMode: value.primaryMode === 'reading' ? 'reading' : 'overview',
	};
}

function validWidth(value: number | undefined, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 100 && value <= 4000 ? value : fallback;
}

function validId(value: string | undefined, fallback: string): string {
	return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : fallback;
}
