/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { functionDisplayName } from '../../../../platform/delver/common/naming.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

export const DELVER_PSEUDOCODE_EDITOR_ID = 'delver.editor.pseudocode';
export const DELVER_PSEUDOCODE_SCHEME = 'delver-pseudo';

/** Read-only pseudocode for one function in one target. */
export class DelverPseudocodeInput extends EditorInput {

	static readonly ID = 'delver.input.pseudocode';

	private readonly _resource: URI;

	constructor(
		readonly targetPath: string,
		readonly functionRva: bigint,
		readonly functionName?: string,
	) {
		super();
		this._resource = URI.from({
			scheme: DELVER_PSEUDOCODE_SCHEME,
			path: targetPath,
			fragment: `0x${functionRva.toString(16)}`,
		});
	}

	override get typeId(): string {
		return DelverPseudocodeInput.ID;
	}

	override get editorId(): string {
		return DELVER_PSEUDOCODE_EDITOR_ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		return localize('delverPseudocodeName', "Pseudocode: {0}", functionDisplayName(this.functionRva, this.functionName));
	}

	override getDescription(): string {
		return this.targetPath;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (this === other) {
			return true;
		}
		return other instanceof DelverPseudocodeInput
			&& other.targetPath === this.targetPath
			&& other.functionRva === this.functionRva;
	}
}
