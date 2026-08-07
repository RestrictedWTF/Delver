/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/delverStrings.css';

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { DelverStringsEditor } from './delverStringsEditor.js';
import { DELVER_STRINGS_EDITOR_ID, DelverStringsInput } from './delverStringsInput.js';

/**
 * Strings live in the editor area, not the sidebar.
 *
 * Hunting for a string is something you go and do — you stop reading code while
 * you do it — and it wants columns, a filter, and room to show a long string
 * uncut. That is a page, not a pane. It sits as a sibling tab to the listing,
 * which is the layout anyone arriving from IDA already has in their hands.
 */
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		DelverStringsEditor,
		DELVER_STRINGS_EDITOR_ID,
		localize2('delverStringsEditor', "Delver Strings").value,
	),
	[new SyncDescriptor(DelverStringsInput)],
);

class OpenStringsAction extends Action2 {
	constructor() {
		super({
			id: 'delver.strings.open',
			title: localize2('delverOpenStrings', 'Strings'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const sessionService = accessor.get(IDelverSessionService);
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);

		const session = sessionService.activeSession;
		if (!session) {
			notificationService.info(localize2('delverStringsNoTarget', "Open a target first.").value);
			return;
		}

		await editorService.openEditor(new DelverStringsInput(session.targetPath), { pinned: true });
	}
}

registerAction2(OpenStringsAction);
