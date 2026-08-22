/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { InputFocusedContextKey } from '../../../../platform/contextkey/common/contextkeys.js';
import { IFunctionWire } from '../../../../platform/delver/common/protocol.generated.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import {
	FocusReason,
	IDelverFocusService,
} from '../../../services/delver/common/delverFocusService.js';
import { IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { EditOp, EditStatus, IAuthor } from '../../../../platform/delver/common/interpretation.js';
import { editInterpretationAt } from '../../../services/delver/browser/delverInterpretationEditing.js';
import { IDelverInterpretationService } from '../../../services/delver/common/delverInterpretationService.js';
import { DelverPseudocodeInput } from '../../delverPseudocode/browser/delverPseudocodeInput.js';
import {
	DELVER_LISTING_PINNED,
	DELVER_NAVIGATION_ORIGIN,
	LISTING_ACTIVE,
} from './delverListingContext.js';
import { DelverListingEditor } from './delverListingEditor.js';

const NAVIGATION_ORIGIN = DELVER_NAVIGATION_ORIGIN;

/**
 * Parses an address typed by a user.
 *
 * **Hex is the default with or without a prefix.** Every address in a listing is
 * displayed as hex, so reading `1000` off the screen and typing it back must
 * land in the same place; interpreting it as decimal would silently navigate
 * somewhere plausible and wrong. `0n` is available for the rare decimal case.
 */
export function parseAddress(input: string): bigint | undefined {
	const text = input.trim().replace(/[\s_]/g, '');
	if (!text) {
		return undefined;
	}

	try {
		if (/^0[nN][0-9]+$/.test(text)) {
			return BigInt(text.slice(2));
		}
		const hex = /^0[xX]/.test(text) ? text.slice(2) : text;
		if (!/^[0-9a-fA-F]+$/.test(hex)) {
			return undefined;
		}
		const value = BigInt(`0x${hex}`);
		// Addresses are u64. A longer literal is a typo, not an address, and
		// wrapping it would navigate somewhere unrelated without complaint.
		return value <= 0xFFFFFFFFFFFFFFFFn ? value : undefined;
	} catch {
		return undefined;
	}
}

export class GoToAddressAction extends Action2 {
	constructor() {
		super({
			id: 'delver.navigate.goToAddress',
			title: localize2('delverGoToAddress', 'Go to Address'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
			keybinding: {
				when: LISTING_ACTIVE,
				primary: KeyMod.CtrlCmd | KeyCode.KeyG,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const focusService = accessor.get(IDelverFocusService);
		const sessionService = accessor.get(IDelverSessionService);
		const notificationService = accessor.get(INotificationService);

		if (!sessionService.activeSession) {
			notificationService.info(localize('delverNoSession', "Open a listing before navigating."));
			return;
		}

		const value = await quickInputService.input({
			prompt: localize('delverGoToAddressPrompt', "Address, as an RVA"),
			placeHolder: localize('delverGoToAddressPlaceholder', "0x1000 — hex by default, 0n4096 for decimal"),
			validateInput: async text =>
				text.trim() === '' || parseAddress(text) !== undefined
					? undefined
					: localize('delverGoToAddressInvalid', "Not an address."),
		});

		const address = value === undefined ? undefined : parseAddress(value);
		if (address === undefined) {
			return;
		}

		focusService.setFocus(
			{ location: { space: 'Image', address } },
			NAVIGATION_ORIGIN,
			FocusReason.User,
		);
	}
}

interface IFunctionPickItem extends IQuickPickItem {
	readonly address: bigint;
}

export class GoToFunctionAction extends Action2 {
	constructor() {
		super({
			id: 'delver.navigate.goToFunction',
			title: localize2('delverGoToFunction', 'Go to Function'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const focusService = accessor.get(IDelverFocusService);
		const sessionService = accessor.get(IDelverSessionService);
		const notificationService = accessor.get(INotificationService);

		const session = sessionService.activeSession;
		if (!session) {
			notificationService.info(localize('delverNoSession', "Open a listing before navigating."));
			return;
		}

		const { functions } = await sessionService.functions();

		// Only boundaries the image vouches for. A large module sweeps up
		// hundreds of thousands of guessed starts, which would make this list
		// both unusable and untrustworthy — a swept address is reached by typing
		// it, not by browsing for it.
		const authoritative = functions.filter(f => f.authoritative);
		if (authoritative.length === 0) {
			notificationService.info(localize(
				'delverNoAuthoritativeFunctions',
				"This image has no compiler-vouched function boundaries. Use Go to Address.",
			));
			return;
		}

		const picked = await quickInputService.pick<IFunctionPickItem>(
			authoritative.map(toPickItem),
			{
				placeHolder: localize(
					'delverGoToFunctionPlaceholder',
					"{0} functions the image vouches for",
					authoritative.length,
				),
				matchOnDescription: true,
			},
		);

		if (picked) {
			focusService.setFocus(
				{ location: { space: 'Image', address: picked.address } },
				NAVIGATION_ORIGIN,
				FocusReason.User,
			);
		}
	}
}

function toPickItem(fn: IFunctionWire): IFunctionPickItem {
	// Addresses arrive as "0x..." strings (ADR 0001) and are shown as they
	// arrived; there are no authored names yet, so the address is the label.
	return {
		label: fn.rva,
		description: fn.source,
		address: BigInt(fn.rva),
	};
}

export class NavigateBackAction extends Action2 {
	constructor() {
		super({
			id: 'delver.navigate.back',
			title: localize2('delverNavigateBack', 'Navigate Back'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
			keybinding: {
				when: LISTING_ACTIVE,
				primary: KeyMod.Alt | KeyCode.LeftArrow,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IDelverFocusService).back();
	}
}

export class NavigateForwardAction extends Action2 {
	constructor() {
		super({
			id: 'delver.navigate.forward',
			title: localize2('delverNavigateForward', 'Navigate Forward'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
			keybinding: {
				when: LISTING_ACTIVE,
				primary: KeyMod.Alt | KeyCode.RightArrow,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IDelverFocusService).forward();
	}
}

/**
 * Follows the branch target of the selected row.
 *
 * **This is the primary navigation in a disassembler.** Typing an address is the
 * fallback; following a reference and coming back is the loop an analyst is in
 * for most of a session, so it gets the plainest possible key.
 */
export class FollowAction extends Action2 {
	constructor() {
		super({
			id: 'delver.listing.follow',
			title: localize2('delverFollow', 'Follow Reference'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
			keybinding: {
				when: LISTING_ACTIVE,
				primary: KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const pane = accessor.get(IEditorService).activeEditorPane;
		if (pane instanceof DelverListingEditor) {
			pane.followSelection();
		}
	}
}

/** Decompiles the function containing the selected instruction. */
export class DecompileFunctionAction extends Action2 {
	constructor() {
		super({
			id: 'delver.listing.decompileFunction',
			title: localize2('delverDecompileFunction', 'Decompile Function'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
			keybinding: {
				when: LISTING_ACTIVE,
				primary: KeyCode.F5,
				// Debug's Continue binding is WorkbenchContrib + 10. The listing's
				// explicit F5 workflow must win even while another target is paused.
				weight: KeybindingWeight.WorkbenchContrib + 20,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const focusService = accessor.get(IDelverFocusService);
		const interpretationService = accessor.get(IDelverInterpretationService);
		const pane = editorService.activeEditorPane;
		const session = accessor.get(IDelverSessionService).activeSession;
		const notifications = accessor.get(INotificationService);
		if (!(pane instanceof DelverListingEditor) || !session) {
			return;
		}

		const functionRva = await pane.selectedFunctionRva();
		if (functionRva === undefined) {
			notifications.info(localize('delverNoFunctionAtSelection', "The selected instruction is not inside a detected function."));
			return;
		}

		focusService.setFocus(
			{ location: { space: 'Image', address: functionRva } },
			NAVIGATION_ORIGIN,
			FocusReason.User,
		);
		const name = interpretationService.nameAt({
			kind: 'image',
			contentHash: session.contentHash,
			rva: functionRva,
		});
		await editorService.openEditor(
			new DelverPseudocodeInput(session.targetPath, functionRva, name),
			{ pinned: true },
		);
	}
}

/**
 * Returns to where the last follow started.
 *
 * Bound to Escape as well as Alt+Left because that is the pairing every
 * disassembler uses, and the muscle memory is worth more than the key.
 */
export class ReturnAction extends Action2 {
	constructor() {
		super({
			id: 'delver.listing.return',
			title: localize2('delverReturn', 'Return'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
			keybinding: {
				when: LISTING_ACTIVE,
				primary: KeyCode.Escape,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IDelverFocusService).back();
	}
}

/**
 * Names the address the cursor is on.
 *
 * Recorded as an authored edit against the image's content hash, never against
 * the address alone — a name has to survive the same bytes being loaded
 * somewhere else.
 */
export class RenameAction extends Action2 {
	constructor() {
		super({
			id: 'delver.interpretation.rename',
			title: localize2('delverRename', 'Rename'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
			keybinding: {
				when: LISTING_ACTIVE,
				primary: KeyCode.F2,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const focusService = accessor.get(IDelverFocusService);
		const notificationService = accessor.get(INotificationService);

		const location = focusService.focus.location;
		if (!location) {
			notificationService.info(localize('delverNothingToRename', "Select an address to rename."));
			return;
		}
		await editInterpretationAt(accessor, location.address, EditOp.Rename);
	}
}

/** Adds or clears the inline comment on the selected instruction. */
export class CommentAction extends Action2 {
	constructor() {
		super({
			id: 'delver.interpretation.comment',
			title: localize2('delverSetComment', 'Set Comment'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
			keybinding: {
				when: ContextKeyExpr.and(LISTING_ACTIVE, ContextKeyExpr.not(InputFocusedContextKey)),
				primary: KeyCode.Semicolon,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const location = accessor.get(IDelverFocusService).focus.location;
		if (!location) {
			accessor.get(INotificationService).info(localize('delverNothingToComment', "Select an instruction to comment."));
			return;
		}
		await editInterpretationAt(accessor, location.address, EditOp.Comment);
	}
}

/** Adds or clears the tags on the selected instruction. */
export class TagAction extends Action2 {
	constructor() {
		super({
			id: 'delver.interpretation.tags',
			title: localize2('delverSetTags', 'Set Tags'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
			keybinding: {
				when: ContextKeyExpr.and(LISTING_ACTIVE, ContextKeyExpr.not(InputFocusedContextKey)),
				primary: KeyCode.KeyT,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const location = accessor.get(IDelverFocusService).focus.location;
		if (!location) {
			accessor.get(INotificationService).info(localize('delverNothingToTag', "Select an instruction to tag."));
			return;
		}
		await editInterpretationAt(accessor, location.address, EditOp.Tags);
	}
}

/** Undoes local interpretation by appending a compensating edit. */
export class UndoInterpretationAction extends Action2 {
	constructor() {
		super({
			id: 'delver.interpretation.undo',
			title: localize2('delverUndoInterpretation', 'Undo Interpretation'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
			keybinding: {
				when: ContextKeyExpr.and(LISTING_ACTIVE, ContextKeyExpr.not(InputFocusedContextKey)),
				primary: KeyMod.CtrlCmd | KeyCode.KeyZ,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const session = accessor.get(IDelverSessionService).activeSession;
		const notifications = accessor.get(INotificationService);
		if (!session) {
			return;
		}
		try {
			const edit = await accessor.get(IDelverInterpretationService).undoLast(session.contentHash);
			if (!edit) {
				notifications.info(localize('delverNothingToUndo', "No local interpretation edit to undo."));
			}
		} catch (error) {
			notifications.error(error instanceof Error ? error : String(error));
		}
	}
}

interface IAuthorPickItem extends IQuickPickItem {
	readonly author: IAuthor;
}

/** Reconstructs the active image as if one author had made no accepted edits. */
export class RevertAuthorAction extends Action2 {
	constructor() {
		super({
			id: 'delver.interpretation.revertAuthor',
			title: localize2('delverRevertAuthor', 'Revert Interpretation by Author...'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const session = accessor.get(IDelverSessionService).activeSession;
		if (!session) {
			return;
		}
		const interpretationService = accessor.get(IDelverInterpretationService);
		const quickInputService = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const authors = new Map<string, IAuthor>();
		for (const edit of interpretationService.logFor(session.contentHash)) {
			if (edit.status === EditStatus.Accepted && edit.compensates === undefined) {
				authors.set(`${edit.author.kind}:${edit.author.id}`, edit.author);
			}
		}
		const picked = await quickInputService.pick<IAuthorPickItem>(
			[...authors.values()].map(author => ({
				label: author.id,
				description: author.kind,
				author,
			})),
			{ placeHolder: localize('delverRevertAuthorPlaceholder', "Author whose accepted edits should be compensated") },
		);
		if (!picked) {
			return;
		}

		try {
			const count = await interpretationService.revertAuthor(session.contentHash, picked.author);
			notifications.info(count === 0
				? localize('delverAuthorAlreadyReverted', "No active edits remain for {0}.", picked.author.id)
				: localize('delverAuthorReverted', "Appended {0} compensating interpretation edits for {1}.", count, picked.author.id));
		} catch (error) {
			notifications.error(error instanceof Error ? error : String(error));
		}
	}
}

export class TogglePinAction extends Action2 {
	constructor() {
		super({
			id: 'delver.listing.togglePin',
			title: localize2('delverTogglePin', 'Pin Listing'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
			icon: Codicon.pin,
			toggled: {
				condition: DELVER_LISTING_PINNED,
				icon: Codicon.pinned,
				title: localize('delverUnpinListing', "Unpin Listing"),
			},
			menu: [{
				id: MenuId.EditorTitle,
				when: LISTING_ACTIVE,
				group: 'navigation',
				order: 1,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const pane = accessor.get(IEditorService).activeEditorPane;
		if (pane instanceof DelverListingEditor) {
			pane.togglePin();
		}
	}
}
