/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

export const DELVER_WORKSPACE_EDITOR_ID = 'delver.editor.workspace';
export const DELVER_WORKSPACE_SCHEME = 'delver-workspace';

/** One target's three-zone Delver workspace. */
export class DelverWorkspaceInput extends EditorInput {

	static readonly ID = 'delver.input.workspace';

	private readonly _resource: URI;

	constructor(readonly targetPath: string) {
		super();
		this._resource = URI.from({ scheme: DELVER_WORKSPACE_SCHEME, path: targetPath });
	}

	override get typeId(): string {
		return DelverWorkspaceInput.ID;
	}

	override get editorId(): string {
		return DELVER_WORKSPACE_EDITOR_ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override get capabilities(): EditorInputCapabilities {
		// Readonly, but deliberately **not** Singleton. Singleton allows one
		// editor of this type in the whole workbench, so opening a second target
		// replaced the first workspace instead of joining it — the editor-layer
		// half of the same mistake ADR 0008 fixes in the session layer. `matches`
		// already keeps one editor *per target*, which is the real requirement.
		return EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		return basename(this.targetPath);
	}

	override getDescription(): string {
		return this.targetPath;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return this === other || other instanceof DelverWorkspaceInput && other.targetPath === this.targetPath;
	}
}

interface ISerializedDelverWorkspaceInput {
	readonly targetPath: string;
}

/** Restores target-keyed workspace tabs across workbench restarts. */
export class DelverWorkspaceInputSerializer implements IEditorSerializer {

	canSerialize(editor: EditorInput): boolean {
		return editor instanceof DelverWorkspaceInput;
	}

	serialize(editor: DelverWorkspaceInput): string {
		return JSON.stringify({ targetPath: editor.targetPath } satisfies ISerializedDelverWorkspaceInput);
	}

	deserialize(_instantiationService: IInstantiationService, serializedEditor: string): DelverWorkspaceInput | undefined {
		try {
			const value = JSON.parse(serializedEditor) as Partial<ISerializedDelverWorkspaceInput>;
			return typeof value.targetPath === 'string' && value.targetPath.length > 0
				? new DelverWorkspaceInput(value.targetPath)
				: undefined;
		} catch {
			return undefined;
		}
	}
}
