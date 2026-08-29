/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

export const DELVER_LISTING_EDITOR_ID = 'delver.editor.listing';
export const DELVER_LISTING_SCHEME = 'delver-listing';

/**
 * Input for the disassembly listing of one target.
 *
 * The URI identifies the *target*, not a file on disk: opening the same binary
 * twice must reuse one editor and one analysis session, and two different
 * binaries must never collide.
 */
export class DelverListingInput extends EditorInput {

	static readonly ID = 'delver.input.listing';

	private readonly _resource: URI;

	constructor(readonly targetPath: string) {
		super();
		this._resource = URI.from({ scheme: DELVER_LISTING_SCHEME, path: targetPath });
	}

	override get typeId(): string {
		return DelverListingInput.ID;
	}

	override get editorId(): string {
		return DELVER_LISTING_EDITOR_ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override get capabilities(): EditorInputCapabilities {
		// Nothing here is saved, and the analysis session belongs to the editor
		// rather than to a workspace file.
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('delverListingName', "Listing: {0}", basename(this.targetPath));
	}

	override getDescription(): string {
		return this.targetPath;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (this === other) {
			return true;
		}
		return other instanceof DelverListingInput && other.targetPath === this.targetPath;
	}
}

function basename(path: string): string {
	const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return separator === -1 ? path : path.slice(separator + 1);
}
