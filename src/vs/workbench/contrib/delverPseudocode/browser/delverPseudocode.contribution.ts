/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/delverPseudocode.css';

import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/path.js';
import Severity from '../../../../base/common/severity.js';
import { localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ByteSize } from '../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions } from '../../../common/editor.js';
import { DelverSurfaceId, DelverZone, MenuDelverPrimaryChrome } from '../../../services/delver/browser/delverSurface.js';
import { registerDelverSurface } from '../../../services/delver/browser/delverSurfaceRegistry.js';
import { IDelverDecompilerService } from '../../../services/delver/common/delverDecompilerService.js';
import { IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { DelverPseudocodeEditor } from './delverPseudocodeEditor.js';
import { DELVER_PSEUDOCODE_EDITOR_ID, DelverPseudocodeInput } from '../../../services/delver/browser/delverPseudocodeInput.js';
import { DelverPseudocodeWidget } from './delverPseudocodeWidget.js';
import {
	DELVER_PSEUDOCODE_SYNC,
	isPseudocodeSyncEnabled,
	onDidChangePseudocodeSync,
	setPseudocodeSyncEnabled,
} from './delverPseudocodeSync.js';

/**
 * Stops the pseudocode cursor dragging the listing along.
 *
 * Reading decompiled C line by line moved the disassembly on every keystroke,
 * losing the instruction the analyst was holding. `principles.md` §5 requires a
 * synchronised view to be defeatable *visibly*, so this lives in the zone header
 * beside pin rather than in settings.
 */
class TogglePseudocodeSyncAction extends Action2 {
	constructor() {
		super({
			id: 'delver.pseudocode.toggleSync',
			title: localize2('delverTogglePseudocodeSync', 'Sync Listing to Pseudocode'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			icon: Codicon.link,
			toggled: {
				condition: DELVER_PSEUDOCODE_SYNC.toNegated(),
				icon: Codicon.debugDisconnect,
				title: localize('delverPseudocodeSyncOff', "Listing Does Not Follow Pseudocode"),
			},
			menu: [{
				// View state, so it is one of the only two things a zone header
				// may carry.
				id: MenuDelverPrimaryChrome,
				group: 'navigation',
				order: 2,
			}],
		});
	}

	async run(): Promise<void> {
		setPseudocodeSyncEnabled(!isPseudocodeSyncEnabled());
	}
}

registerAction2(TogglePseudocodeSyncAction);

/** Mirrors the sync flag into a context key so the toolbar can show its state. */
class DelverPseudocodeSyncContribution extends Disposable {
	constructor(@IContextKeyService contextKeyService: IContextKeyService) {
		super();
		const key = DELVER_PSEUDOCODE_SYNC.bindTo(contextKeyService);
		key.set(isPseudocodeSyncEnabled());
		this._register(onDidChangePseudocodeSync(enabled => key.set(enabled)));
	}
}

registerWorkbenchContribution2(
	'delver.pseudocodeSync',
	DelverPseudocodeSyncContribution,
	WorkbenchPhase.BlockRestore,
);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		DelverPseudocodeEditor,
		DELVER_PSEUDOCODE_EDITOR_ID,
		localize2('delverPseudocodeEditor', "Delver Pseudocode").value,
	),
	[new SyncDescriptor(DelverPseudocodeInput)],
);

registerDelverSurface({
	id: DelverSurfaceId.Pseudocode,
	title: localize2('delverPseudocodeSurface', "Pseudocode"),
	zone: DelverZone.Primary,
	order: 11,
	ctor: new SyncDescriptor(DelverPseudocodeWidget),
	contextKey: context => `${context.targetPath}:${context.functionRva?.toString(16) ?? 'none'}`,
	setContext: (surface, context, token) => surface.setTarget(context.targetPath, context.functionRva, context.functionName, token),
	tearOff: context => context.functionRva === undefined
		? undefined
		: new DelverPseudocodeInput(context.targetPath, context.functionRva, context.functionName),
});

/** Warms the one persistent PyGhidra JVM while the analyst explores a live target. */
class DelverDecompilerPrewarmContribution extends Disposable {
	constructor(
		@IDelverSessionService private readonly sessionService: IDelverSessionService,
		@IDelverDecompilerService private readonly decompilerService: IDelverDecompilerService,
		@IProgressService private readonly progressService: IProgressService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.sessionService.onDidChangeActiveSession(session => {
			if (session?.sessionId) {
				this.prepareTarget(session.sessionId, session.targetPath, session.contentHash);
			}
		}));
		const session = this.sessionService.activeSession;
		if (session?.sessionId) {
			this.prepareTarget(session.sessionId, session.targetPath, session.contentHash);
		}
	}

	private prepareTarget(sessionId: string, targetPath: string, contentHash: string): void {
		void this.progressService.withProgress({
			location: ProgressLocation.Window,
			delay: 800,
			title: localize2('delverPreparingDecompilerTarget', 'Preparing PyGhidra for {0}', basename(targetPath)).value,
		}, () => this.decompilerService.prepareTarget({ sessionId, targetPath, contentHash })).catch(error => {
			this.logService.warn(`[Delver decompiler] background target preparation failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}
}

registerWorkbenchContribution2(
	'delver.decompilerPrewarm',
	DelverDecompilerPrewarmContribution,
	WorkbenchPhase.AfterRestored,
);

registerAction2(class ShowDecompilerCacheAction extends Action2 {
	constructor() {
		super({ id: 'delver.decompiler.showCache', title: localize2('delverShowDecompilerCache', 'Show Decompiler Cache Information'), category: localize2('delverCategory', 'Delver'), f1: true });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const decompilerService = accessor.get(IDelverDecompilerService);
		const dialogService = accessor.get(IDialogService);
		const info = await decompilerService.cacheInfo();
		await dialogService.info(
			localize2('delverDecompilerCacheTitle', 'Decompiler Cache').value,
			localize2('delverDecompilerCacheDetail', 'Path: {0}\nProjects: {1}\nFiles: {2}\nSize: {3}', info.path, info.projectCount, info.fileCount, ByteSize.formatSize(info.byteLength)).value,
		);
	}
});

registerAction2(class ClearDecompilerCacheAction extends Action2 {
	constructor() {
		super({ id: 'delver.decompiler.clearCache', title: localize2('delverClearDecompilerCache', 'Clear Decompiler Cache'), category: localize2('delverCategory', 'Delver'), f1: true });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const decompilerService = accessor.get(IDelverDecompilerService);
		const dialogService = accessor.get(IDialogService);
		const info = await decompilerService.cacheInfo();
		const { confirmed } = await dialogService.confirm({
			type: Severity.Warning,
			message: localize2('delverClearDecompilerCacheConfirm', 'Clear the Delver decompiler cache?').value,
			detail: localize2('delverClearDecompilerCacheDetail', 'This stops PyGhidra and removes {0} across {1} cached projects. Portable .delverdb projects and saved pseudocode are not removed.', ByteSize.formatSize(info.byteLength), info.projectCount).value,
			primaryButton: localize2('delverClearDecompilerCacheButton', '&&Clear Cache').value,
		});
		if (!confirmed) {
			return;
		}
		const removed = await decompilerService.clearCache();
		await dialogService.info(
			localize2('delverDecompilerCacheCleared', 'Decompiler Cache Cleared').value,
			localize2('delverDecompilerCacheClearedDetail', 'Removed {0} files ({1}). PyGhidra will recreate analysis data when it is next used.', removed.fileCount, ByteSize.formatSize(removed.byteLength)).value,
		);
	}
});

registerAction2(class ShowDecompilerPerformanceAction extends Action2 {
	constructor() {
		super({ id: 'delver.decompiler.showPerformance', title: localize2('delverShowDecompilerPerformance', 'Show Latest Decompiler Performance'), category: localize2('delverCategory', 'Delver'), f1: true });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const result = accessor.get(IDelverDecompilerService).latestPerformance;
		const dialogService = accessor.get(IDialogService);
		if (!result?.timings) {
			await dialogService.info(localize2('delverDecompilerNoPerformance', 'No live decompilation timing is available yet.').value);
			return;
		}
		const timings = result.timings;
		const requestMs = timings.targetOpenMs + timings.functionRecoveryMs + timings.decompilationMs + timings.serializationMs;
		await dialogService.info(
			localize2('delverDecompilerPerformanceTitle', 'Latest Decompiler Performance').value,
			localize2(
				'delverDecompilerPerformanceDetail',
				'Function: 0x{0}\nBackend: {1} {2}\nWorker startup: {3} ms\nHandshake: {4} ms\nTarget open/analysis: {5} ms\nFunction recovery: {6} ms\nDecompilation: {7} ms\nSerialization: {8} ms\nRequest total: {9} ms',
				result.functionRva.toString(16).toUpperCase(), result.backendId, result.backendVersion ?? '', timings.spawnMs, timings.handshakeMs,
				timings.targetOpenMs, timings.functionRecoveryMs, timings.decompilationMs, timings.serializationMs, requestMs,
			).value,
		);
	}
});
