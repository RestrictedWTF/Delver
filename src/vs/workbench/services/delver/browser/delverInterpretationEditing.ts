/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { EditOp, EditValue, IInterpretationAt } from '../../../../platform/delver/common/interpretation.js';
import { placeholderFunctionName } from '../../../../platform/delver/common/naming.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IInputOptions, IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IDelverInterpretationService } from '../common/delverInterpretationService.js';
import { parseTypeDeclaration } from '../common/delverAgentProposalParsing.js';
import { IDelverSessionService } from '../common/delverSessionService.js';
import { loadTypePlacementFacts, typePlacementRefusal } from '../common/delverTypePlacement.js';
import { TreeViewItemHandleArg } from '../../../common/views.js';

/** Prompts for and persists one authored field at an image RVA. */
export async function editInterpretationAt(accessor: ServicesAccessor, rva: bigint, op: EditOp): Promise<boolean> {
	// Every service this function needs is resolved here, before the first
	// `await`. A `ServicesAccessor` is only valid during the synchronous part
	// of the command it was handed to, so reaching for one after the input box
	// throws "service accessor is only valid during the invocation of its
	// target method" — at runtime only, which no unit test calling this
	// helper directly can reach.
	const sessionService = accessor.get(IDelverSessionService);
	const session = sessionService.activeSession;
	const notificationService = accessor.get(INotificationService);
	if (!session) {
		notificationService.info(localize('delverNoInterpretationSession', "Open a target before editing interpretation."));
		return false;
	}

	const interpretationService = accessor.get(IDelverInterpretationService);
	const anchor = { kind: 'image' as const, contentHash: session.contentHash, rva };
	const existing = interpretationService.at(anchor);
	const address = `0x${rva.toString(16).toUpperCase()}`;
	const value = await accessor.get(IQuickInputService).input(inputOptionsFor(op, rva, address, existing));
	if (value === undefined) {
		return false;
	}

	try {
		const edit = interpretationEditValue(op, value);
		const refused = await declarationPlacementRefusal(sessionService, op, rva, edit);
		if (refused !== undefined) {
			notificationService.error(refused);
			return false;
		}
		await interpretationService.edit(anchor, op, edit);
		return true;
	} catch (error) {
		notificationService.error(error instanceof Error ? error : String(error));
		return false;
	}
}

/**
 * The message for a declaration the analyst may not attach here, or
 * `undefined` when the placement is fine.
 *
 * The same two rules the proposal path spends, from the same module. They were
 * only ever enforced against models, which left the palette as the lax door
 * into a log that is append-only for both — an analyst could declare a struct
 * over `.text` and find out when the worker refused it, long after the edit was
 * recorded as theirs.
 */
export async function declarationPlacementRefusal(sessionService: IDelverSessionService, op: EditOp, rva: bigint, value: EditValue): Promise<string | undefined> {
	if (op !== EditOp.DataType && op !== EditOp.FunctionPrototype) {
		return undefined;
	}
	const declaration = typeof value === 'string' ? value : '';
	if (declaration.length === 0) {
		return undefined;
	}
	const address = `0x${rva.toString(16).toUpperCase()}`;
	// A project open without its sample can answer neither question. Refusing
	// is the honest reading: the rule is unchecked, not satisfied.
	let facts;
	try {
		facts = await loadTypePlacementFacts(sessionService, op);
	} catch (error) {
		return localize('delverPlacementUnavailable', "Cannot check where {0} sits in the image, so the declaration was not recorded: {1}", address, error instanceof Error ? error.message : String(error));
	}
	switch (typePlacementRefusal(op, rva, declaration, facts)) {
		case 'not-data-memory':
			return localize('delverNotDataMemory', "{0} is not in mapped, non-executable memory. A data type has to attach to a data address.", address);
		case 'not-function-entry':
			return localize('delverNotFunctionEntry', "{0} is not a detected function entry. A prototype has to attach to the exact entry of a function.", address);
		default:
			return undefined;
	}
}

function inputOptionsFor(op: EditOp, rva: bigint, address: string, existing: IInterpretationAt | undefined): IInputOptions {
	switch (op) {
		case EditOp.Rename:
			return {
				prompt: localize('delverRenamePrompt', "Name for {0}", address),
				value: existing?.name ?? '',
				placeHolder: placeholderFunctionName(rva),
			};
		case EditOp.Comment:
			return {
				prompt: localize('delverCommentPrompt', "Comment for {0}", address),
				value: existing?.comment ?? '',
				placeHolder: localize('delverCommentPlaceholder', "Describe what this instruction does"),
			};
		case EditOp.DataType:
			return {
				prompt: localize('delverDataTypePrompt', "Data type for {0}", address),
				value: existing?.dataType ?? '',
				placeHolder: localize('delverDataTypePlaceholder', "char[32], struct Config *, unsigned int"),
			};
		case EditOp.FunctionPrototype:
			return {
				prompt: localize('delverPrototypePrompt', "Function prototype for {0}", address),
				value: existing?.functionPrototype ?? '',
				placeHolder: localize('delverPrototypePlaceholder', "int __fastcall decode(char *buffer, unsigned int length)"),
			};
		default:
			return {
				prompt: localize('delverTagsPrompt', "Comma-separated tags for {0}", address),
				value: existing?.tags?.join(', ') ?? '',
				placeHolder: localize('delverTagsPlaceholder', "crypto, config, reviewed"),
			};
	}
}

/**
 * The stored value for one authored field, from what the analyst typed.
 *
 * The declaration ops go through the same validator the proposal path uses, so
 * an analyst and a model who write the same declaration store the same string
 * and everything downstream — review, the semantic snapshot, application —
 * cannot tell the two apart. Throws exactly what the proposal path throws for
 * input it would refuse.
 */
export function interpretationEditValue(op: EditOp, value: string): EditValue {
	switch (op) {
		case EditOp.Tags:
			return parseTags(value);
		case EditOp.DataType:
		case EditOp.FunctionPrototype:
			return parseTypeDeclaration(value, localize('delverDeclarationField', "The declaration"));
		default:
			return value.trim();
	}
}

/** Canonical tag array used on disk and during replay. */
export function parseTags(value: string): readonly string[] {
	const tags = [...new Set(value.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0))];
	tags.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
	return tags;
}

/** Extracts the wire-safe RVA suffix embedded in actionable tree handles. */
export function interpretationRvaFromHandle(handle: string): bigint | undefined {
	const match = /\.(0x[0-9a-fA-F]+)$/.exec(handle);
	return match ? BigInt(match[1]) : undefined;
}

export interface IInterpretationViewActions {
	readonly commandPrefix: string;
	readonly viewId: string;
	readonly contextValue: string;
	readonly rvaFromHandle?: (handle: string) => bigint | undefined;
}

/** Adds the standard authored-field actions to an RVA-bearing tree row. */
export function registerInterpretationViewActions(options: IInterpretationViewActions): void {
	const rvaFromHandle = options.rvaFromHandle ?? interpretationRvaFromHandle;
	const menuWhen = ContextKeyExpr.and(
		ContextKeyExpr.equals('view', options.viewId),
		ContextKeyExpr.equals('viewItem', options.contextValue),
	);

	registerAction2(class RenameInterpretationViewItemAction extends Action2 {
		constructor() {
			super({
				id: `${options.commandPrefix}.rename`,
				title: localize('delverRenameViewItem', "Rename"),
				icon: Codicon.edit,
				menu: { id: MenuId.ViewItemContext, when: menuWhen, group: 'inline' },
			});
		}

		async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
			await editViewItem(accessor, handle, rvaFromHandle, EditOp.Rename);
		}
	});

	registerAction2(class CommentInterpretationViewItemAction extends Action2 {
		constructor() {
			super({
				id: `${options.commandPrefix}.comment`,
				title: localize('delverCommentViewItem', "Set Comment"),
				icon: Codicon.comment,
				menu: { id: MenuId.ViewItemContext, when: menuWhen, group: '1_interpretation', order: 1 },
			});
		}

		async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
			await editViewItem(accessor, handle, rvaFromHandle, EditOp.Comment);
		}
	});

	registerAction2(class TagInterpretationViewItemAction extends Action2 {
		constructor() {
			super({
				id: `${options.commandPrefix}.tags`,
				title: localize('delverTagViewItem', "Set Tags"),
				icon: Codicon.tag,
				menu: { id: MenuId.ViewItemContext, when: menuWhen, group: '1_interpretation', order: 2 },
			});
		}

		async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
			await editViewItem(accessor, handle, rvaFromHandle, EditOp.Tags);
		}
	});
}

async function editViewItem(
	accessor: ServicesAccessor,
	handle: TreeViewItemHandleArg,
	rvaFromHandle: (handle: string) => bigint | undefined,
	op: EditOp,
): Promise<void> {
	const rva = rvaFromHandle(handle.$treeItemHandle);
	if (rva !== undefined) {
		await editInterpretationAt(accessor, rva, op);
	}
}
