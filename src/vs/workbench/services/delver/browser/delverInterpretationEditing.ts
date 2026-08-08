/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { EditOp } from '../../../../platform/delver/common/interpretation.js';
import { placeholderFunctionName } from '../../../../platform/delver/common/naming.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IDelverInterpretationService } from '../common/delverInterpretationService.js';
import { IDelverSessionService } from '../common/delverSessionService.js';

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
		: {
			prompt: localize('delverCommentPrompt', "Comment for {0}", address),
			value: existing?.comment ?? '',
			placeHolder: localize('delverCommentPlaceholder', "Describe what this instruction does"),
		});
	if (value === undefined) {
		return false;
	}

	try {
		await interpretationService.edit(anchor, op, value.trim());
		return true;
	} catch (error) {
		notificationService.error(error instanceof Error ? error : String(error));
		return false;
	}
}
