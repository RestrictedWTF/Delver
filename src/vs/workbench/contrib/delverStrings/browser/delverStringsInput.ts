/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

export const DELVER_STRINGS_EDITOR_ID = 'delver.editor.strings';
export const DELVER_STRINGS_SCHEME = 'delver-strings';

/**
 * Input for the strings table of one target.
 *
 * A sibling tab to the listing rather than a sidebar pane: string hunting is
 * something you go and do, not a question asked while reading code, and it
 * wants the width the editor area has.
 */
export class DelverStringsInput extends EditorInput {

	static readonly ID = 'delver.input.strings';

	private readonly _resource: URI;

	constructor(readonly targetPath: string) {
		super();
		this._resource = URI.from({ scheme: DELVER_STRINGS_SCHEME, path: targetPath });
	}

	override get typeId(): string {
		return DelverStringsInput.ID;
	}

	override get editorId(): string {
		return DELVER_STRINGS_EDITOR_ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('delverStringsName', "Strings: {0}", basename(this.targetPath));
	}

	override getDescription(): string {
		return this.targetPath;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (this === other) {
			return true;
		}
		return other instanceof DelverStringsInput && other.targetPath === this.targetPath;
	}
}

function basename(path: string): string {
	const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return separator === -1 ? path : path.slice(separator + 1);
}
