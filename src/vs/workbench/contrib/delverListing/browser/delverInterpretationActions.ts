/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../base/common/path.js';
import { joinPath } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDelverInterpretationService } from '../../../services/delver/common/delverInterpretationService.js';
import { DELVER_TARGET_OPEN, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';

const DELVERLOG_FILTER = [{
	name: localize('delverInterpretationFiles', "Delver Interpretation"),
	extensions: ['delverlog'],
}];

/** Exports the active image's authored log to a discoverable file. */
export class ExportInterpretationAction extends Action2 {
	constructor() {
		super({
			id: 'delver.interpretation.export',
			title: localize2('delverExportInterpretation', 'Export Interpretation...'),
			category: localize2('delverCategory', 'Delver'),
			precondition: DELVER_TARGET_OPEN,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// The accessor is only valid synchronously, so every service this action
		// needs is resolved before the first dialog await.
		const session = accessor.get(IDelverSessionService).activeSession;
		const fileDialogService = accessor.get(IFileDialogService);
		const interpretationService = accessor.get(IDelverInterpretationService);
		const notificationService = accessor.get(INotificationService);
		if (!session) {
			return;
		}

		const destination = await fileDialogService.showSaveDialog({
			title: localize('delverExportInterpretationDialog', "Export Delver Interpretation"),
			availableFileSystems: [Schemas.file],
			defaultUri: joinPath(await fileDialogService.defaultFilePath(), `${basename(session.targetPath)}.delverlog`),
			filters: DELVERLOG_FILTER,
		});
		if (!destination) {
			return;
		}

		try {
			const count = await interpretationService.exportTo(session.contentHash, destination.fsPath);
			notificationService.info(localize(
				'delverInterpretationExported',
				"Exported {0} interpretation edits.",
				count,
			));
		} catch (error) {
			notificationService.error(error instanceof Error ? error : String(error));
		}
	}
}

/** Imports an authored log for the exact bytes of the active image. */
export class ImportInterpretationAction extends Action2 {
	constructor() {
		super({
			id: 'delver.interpretation.import',
			title: localize2('delverImportInterpretation', 'Import Interpretation...'),
			category: localize2('delverCategory', 'Delver'),
			precondition: DELVER_TARGET_OPEN,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// The accessor is only valid synchronously, so every service this action
		// needs is resolved before the first dialog await.
		const session = accessor.get(IDelverSessionService).activeSession;
		const fileDialogService = accessor.get(IFileDialogService);
		const interpretationService = accessor.get(IDelverInterpretationService);
		const notificationService = accessor.get(INotificationService);
		if (!session) {
			return;
		}

		const result = await fileDialogService.showOpenDialog({
			title: localize('delverImportInterpretationDialog', "Import Delver Interpretation"),
			availableFileSystems: [Schemas.file],
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: DELVERLOG_FILTER,
		});
		if (!result?.[0]) {
			return;
		}

		try {
			const count = await interpretationService.importFrom(session.contentHash, result[0].fsPath);
			notificationService.info(localize(
				'delverInterpretationImported',
				"Imported {0} interpretation edits.",
				count,
			));
		} catch (error) {
			notificationService.error(error instanceof Error ? error : String(error));
		}
	}
}
