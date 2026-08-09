/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { EditOp, EditValue } from '../../../../platform/delver/common/interpretation.js';
import { placeholderFunctionName } from '../../../../platform/delver/common/naming.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IDelverInterpretationService } from '../common/delverInterpretationService.js';
import { IDelverSessionService } from '../common/delverSessionService.js';
import { TreeViewItemHandleArg } from '../../../common/views.js';

/** Prompts for and persists one authored field at an image RVA. */
export async function editInterpretationAt(accessor: ServicesAccessor, rva: bigint, op: EditOp): Promise<boolean> {
	const session = accessor.get(IDelverSessionService).activeSession;
	const notificationService = accessor.get(INotificationService);
	if (!session) {
		notificationService.info(localize('delverNoInterpretationSession', "Open a target before editing interpretation."));
		return false;
	}

	const interpretationService = accessor.get(IDelverInterpretationService);
	const anchor = { kind: 'image' as const, contentHash: session.contentHash, rva };
	const existing = interpretationService.at(anchor);
	const address = `0x${rva.toString(16).toUpperCase()}`;
	const value = await accessor.get(IQuickInputService).input(op === EditOp.Rename
		? {
			prompt: localize('delverRenamePrompt', "Name for {0}", address),
			value: existing?.name ?? '',
			placeHolder: placeholderFunctionName(rva),
		}
		: op === EditOp.Comment ? {
			prompt: localize('delverCommentPrompt', "Comment for {0}", address),
			value: existing?.comment ?? '',
			placeHolder: localize('delverCommentPlaceholder', "Describe what this instruction does"),
		} : {
			prompt: localize('delverTagsPrompt', "Comma-separated tags for {0}", address),
			value: existing?.tags?.join(', ') ?? '',
			placeHolder: localize('delverTagsPlaceholder', "crypto, config, reviewed"),
		});
	if (value === undefined) {
		return false;
	}

	try {
		const editValue: EditValue = op === EditOp.Tags ? parseTags(value) : value.trim();
		await interpretationService.edit(anchor, op, editValue);
		return true;
	} catch (error) {
		notificationService.error(error instanceof Error ? error : String(error));
		return false;
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
