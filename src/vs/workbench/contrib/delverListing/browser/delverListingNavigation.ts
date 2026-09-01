/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
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
import { MenuDelverSelectionContext, whenSelectionIs } from '../../../services/delver/common/delverSelection.js';
import { IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { EditOp, EditStatus, IAuthor } from '../../../../platform/delver/common/interpretation.js';
import { editInterpretationAt } from '../../../services/delver/browser/delverInterpretationEditing.js';
import { IDelverInterpretationService } from '../../../services/delver/common/delverInterpretationService.js';
import { DelverPseudocodeInput } from '../../../services/delver/browser/delverPseudocodeInput.js';
import {
	DELVER_CAN_GO_BACK,
	DELVER_CAN_GO_FORWARD,
	DELVER_LISTING_PINNED,
	DELVER_NAVIGATION_ORIGIN,
	LISTING_ACTIVE,
} from '../../../services/delver/browser/delverListingContext.js';
import { MenuDelverPrimaryChrome } from '../../../services/delver/browser/delverSurface.js';
import { activeListing } from '../../../services/delver/browser/delverActiveListing.js';

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

/**
 * True unless the analyst is typing somewhere a keystroke would be text.
 *
 * `inputFocus` alone is too broad here: it is set for any focused Monaco editor,
 * including the read-only pseudocode pane, which is where focus sits for much of
 * a reading session. Gating on it meant Ctrl+Z reached the text editor's undo —
 * a no-op on read-only text — instead of taking back the last rename.
 *
 * A read-only editor cannot consume these keys meaningfully, so Delver takes
 * them; a rename box or a search field still wins, which is the case the guard
 * exists for.
 */
const NOT_TYPING = ContextKeyExpr.or(
	ContextKeyExpr.not(InputFocusedContextKey),
	EditorContextKeys.readOnly,
)!;

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
			icon: Codicon.arrowLeft,
			precondition: ContextKeyExpr.and(LISTING_ACTIVE, DELVER_CAN_GO_BACK),
			menu: [{
				id: MenuDelverPrimaryChrome,
				group: 'navigation',
				order: -20,
			}],
			keybinding: {
				when: LISTING_ACTIVE,
				// Above `WorkbenchContrib` deliberately. Upstream's
				// `workbench.action.navigateBack` claims Alt+Left at that weight with
				// no `when` clause, so at `EditorContrib` this binding never fired and
				// the key switched editor tabs instead of moving the address history.
				// Upstream also claims `BrowserBack` — the Mouse4 key event — there,
				// which is why the buttons are additionally handled as raw mouse
				// events rather than left to the keybinding layer.
				weight: KeybindingWeight.WorkbenchContrib + 1,
				primary: KeyMod.Alt | KeyCode.LeftArrow,
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
			icon: Codicon.arrowRight,
			precondition: ContextKeyExpr.and(LISTING_ACTIVE, DELVER_CAN_GO_FORWARD),
			menu: [{
				id: MenuDelverPrimaryChrome,
				group: 'navigation',
				order: -10,
			}],
			keybinding: {
				when: LISTING_ACTIVE,
				// See Navigate Back: upstream owns Alt+Right at `WorkbenchContrib`.
				weight: KeybindingWeight.WorkbenchContrib + 1,
				primary: KeyMod.Alt | KeyCode.RightArrow,
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
		const listing = activeListing();
		if (listing) {
			listing.followSelection();
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
			menu: [{
				id: MenuDelverSelectionContext,
				when: whenSelectionIs('function'),
				group: 'delver.function',
				order: 1,
			}],
			keybinding: {
				when: LISTING_ACTIVE,
				primary: KeyCode.F5,
				// Debug's Continue binding is WorkbenchContrib + 10. The listing's
				// explicit F5 workflow must win even while another target is paused.
				weight: KeybindingWeight.WorkbenchContrib + 20,
			},
		});
	}

	async run(accessor: ServicesAccessor, target?: unknown): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const focusService = accessor.get(IDelverFocusService);
		const interpretationService = accessor.get(IDelverInterpretationService);
		const session = accessor.get(IDelverSessionService).activeSession;
		const notifications = accessor.get(INotificationService);
		if (!session) {
			return;
		}

		// The menu entry is gated on a *function* being selected, so an address
		// forwarded from it is already the entry — no containing-function lookup.
		// Asking the listing instead is what made right-clicking a pseudocode line
		// decompile whatever the listing happened to have selected.
		const functionRva = requestedAddress(target) ?? await selectedFunctionRva();
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
/**
 * The address a context menu named when it was opened.
 *
 * A menu is opened on the object under the cursor, which is not always where the
 * focus bus points: right-clicking a line without selecting it first leaves the
 * bus on the previously selected one, and the pseudocode pane never moves the
 * bus at all while sync is off. Taking the target from the menu keeps what the
 * analyst pointed at and what gets edited the same thing.
 *
 * Absent when the command came from a keybinding or the palette, where the bus
 * is the right answer.
 */
export function requestedAddress(value: unknown): bigint | undefined {
	return typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : undefined;
}

/**
 * The entry of the function containing the listing's selected row.
 *
 * The fallback for the keybinding and palette paths, where no menu named a
 * target and the listing's selection is the right answer.
 */
async function selectedFunctionRva(): Promise<bigint | undefined> {
	return activeListing()?.selectedFunctionRva();
}

export class RenameAction extends Action2 {
	constructor() {
		super({
			id: 'delver.interpretation.rename',
			title: localize2('delverRename', 'Rename'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
			menu: [{
				id: MenuDelverSelectionContext,
				when: whenSelectionIs('function', 'instruction', 'string'),
				group: 'delver.interpretation',
				order: 1,
			}],
			keybinding: {
				when: LISTING_ACTIVE,
				primary: KeyCode.F2,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	async run(accessor: ServicesAccessor, target?: unknown): Promise<void> {
		const focusService = accessor.get(IDelverFocusService);
		const notificationService = accessor.get(INotificationService);

		const address = requestedAddress(target) ?? focusService.focus.location?.address;
		if (address === undefined) {
			notificationService.info(localize('delverNothingToRename', "Select an address to rename."));
			return;
		}
		await editInterpretationAt(accessor, address, EditOp.Rename);
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
			menu: [{
				id: MenuDelverSelectionContext,
				when: whenSelectionIs('function', 'instruction', 'string'),
				group: 'delver.interpretation',
				order: 2,
			}],
			keybinding: {
				when: ContextKeyExpr.and(LISTING_ACTIVE, NOT_TYPING),
				primary: KeyCode.Semicolon,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	async run(accessor: ServicesAccessor, target?: unknown): Promise<void> {
		const address = requestedAddress(target) ?? accessor.get(IDelverFocusService).focus.location?.address;
		if (address === undefined) {
			accessor.get(INotificationService).info(localize('delverNothingToComment', "Select an instruction to comment."));
			return;
		}
		await editInterpretationAt(accessor, address, EditOp.Comment);
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
			menu: [{
				id: MenuDelverSelectionContext,
				when: whenSelectionIs('function', 'instruction', 'string'),
				group: 'delver.interpretation',
				order: 3,
			}],
			keybinding: {
				when: ContextKeyExpr.and(LISTING_ACTIVE, NOT_TYPING),
				primary: KeyCode.KeyT,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	async run(accessor: ServicesAccessor, target?: unknown): Promise<void> {
		const address = requestedAddress(target) ?? accessor.get(IDelverFocusService).focus.location?.address;
		if (address === undefined) {
			accessor.get(INotificationService).info(localize('delverNothingToTag', "Select an instruction to tag."));
			return;
		}
		await editInterpretationAt(accessor, address, EditOp.Tags);
	}
}

/**
 * Declares the authored data type at the selected data address.
 *
 * The human counterpart of the model's type proposal: the declaration goes
 * through the same validator, and the append is the same op with the same
 * value, so review, the semantic snapshot, and application cannot tell an
 * analyst's declaration from a model's.
 */
export class SetDataTypeAction extends Action2 {
	constructor() {
		super({
			id: 'delver.interpretation.dataType',
			title: localize2('delverSetDataType', 'Set Data Type'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
			menu: [{
				id: MenuDelverSelectionContext,
				when: whenSelectionIs('string'),
				group: 'delver.interpretation',
				order: 4,
			}],
		});
	}

	async run(accessor: ServicesAccessor, target?: unknown): Promise<void> {
		const address = requestedAddress(target) ?? accessor.get(IDelverFocusService).focus.location?.address;
		if (address === undefined) {
			accessor.get(INotificationService).info(localize('delverNothingToType', "Select a data address to declare a type for."));
			return;
		}
		await editInterpretationAt(accessor, address, EditOp.DataType);
	}
}

/**
 * Declares the authored prototype of the selected function.
 *
 * Anchored to the entry of the function the cursor is in rather than the row
 * under it: the proposal path refuses a prototype at anything but an exact
 * function entry, and the human path must not be the lax one.
 */
export class SetFunctionPrototypeAction extends Action2 {
	constructor() {
		super({
			id: 'delver.interpretation.functionPrototype',
			title: localize2('delverSetFunctionPrototype', 'Set Function Prototype'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
			menu: [{
				id: MenuDelverSelectionContext,
				when: whenSelectionIs('function'),
				group: 'delver.interpretation',
				order: 5,
			}],
		});
	}

	async run(accessor: ServicesAccessor, target?: unknown): Promise<void> {
		const address = requestedAddress(target) ?? await selectedFunctionRva();
		if (address === undefined) {
			accessor.get(INotificationService).info(localize('delverNothingToPrototype', "Select a function to declare a prototype for."));
			return;
		}
		await editInterpretationAt(accessor, address, EditOp.FunctionPrototype);
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
				when: ContextKeyExpr.and(LISTING_ACTIVE, NOT_TYPING),
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

/** Takes back the newest undo of local interpretation. */
export class RedoInterpretationAction extends Action2 {
	constructor() {
		super({
			id: 'delver.interpretation.redo',
			title: localize2('delverRedoInterpretation', 'Redo Interpretation'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: LISTING_ACTIVE,
			keybinding: {
				// Both spellings, matching upstream's redo, which claims Ctrl+Y with
				// Ctrl+Shift+Z as its secondary. An analyst reaching for either one
				// means the same thing.
				when: ContextKeyExpr.and(LISTING_ACTIVE, NOT_TYPING),
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ,
				secondary: [KeyMod.CtrlCmd | KeyCode.KeyY],
				mac: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ },
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
			const edit = await accessor.get(IDelverInterpretationService).redoLast(session.contentHash);
			if (!edit) {
				notifications.info(localize('delverNothingToRedo', "No undone interpretation edit to redo."));
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
			menu: [
				{
					id: MenuId.EditorTitle,
					when: LISTING_ACTIVE,
					group: 'navigation',
					order: 1,
				},
				{
					// Pin is view *state*, so it is one of the only two things a
					// zone header may carry, and `principles.md` §5 requires it
					// to be visible without hovering — comparing two functions
					// depends on being able to freeze one side.
					id: MenuDelverPrimaryChrome,
					when: LISTING_ACTIVE,
					group: 'navigation',
					order: 1,
				},
			],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const listing = activeListing();
		if (listing) {
			listing.togglePin();
		}
	}
}
