/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { DELVER_WORKSPACE_EDITOR_ID, DelverWorkspaceInput, DelverWorkspaceInputSerializer } from '../../../services/delver/browser/delverWorkspaceInput.js';
import { DelverWorkspaceEditor } from './delverWorkspaceEditor.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		DelverWorkspaceEditor,
		DELVER_WORKSPACE_EDITOR_ID,
		localize2('delverWorkspaceEditor', "Delver Workspace").value,
	),
	[new SyncDescriptor(DelverWorkspaceInput)],
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(DelverWorkspaceInput.ID, DelverWorkspaceInputSerializer);
