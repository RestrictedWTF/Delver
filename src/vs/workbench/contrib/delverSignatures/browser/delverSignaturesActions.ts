/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { basename, dirname, join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDelverNamedSignature } from '../../../../platform/delver/common/delverSignature.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { DelverAgentCapabilityId, IDelverAgentService } from '../../../services/delver/common/delverAgentService.js';
import { DelverAgentError, DelverAgentErrorCode, IDelverAgentResult } from '../../../services/delver/common/delverAgentTypes.js';
import { FocusReason, IDelverFocusService } from '../../../services/delver/common/delverFocusService.js';
import { DELVER_TARGET_ATTACHED, DELVER_TARGET_OPEN, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { IDelverHistoricalSignature, IDelverProjectService } from '../../../services/delver/common/delverProjectService.js';
import { EditorsOrder } from '../../../common/editor.js';
import { TreeViewItemHandleArg } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { DELVER_NAVIGATION_ORIGIN } from '../../delverListing/browser/delverListingContext.js';
import { DelverListingInput } from '../../delverListing/browser/delverListingInput.js';
import { DELVER_GENERATE_SIGNATURE_COMMAND, IGeneratedSignatureSaveOutcome, ISignatureGenerationInvocation, validateSignatureName } from '../../delverListing/browser/delverSignatureActions.js';
import { DELVER_SIGNATURES_COPY_IDAPYTHON_COMMAND, DELVER_SIGNATURES_COPY_PATTERN_COMMAND, DELVER_SIGNATURES_DELETE_COMMAND, DELVER_SIGNATURES_EXPORT_IDAPYTHON_COMMAND, DELVER_SIGNATURES_GO_TO_COMMAND, DELVER_SIGNATURES_REGENERATE_REVISION_COMMAND, DELVER_SIGNATURES_RENAME_COMMAND, DELVER_SIGNATURES_SAVED_HANDLE_PREFIX, DELVER_SIGNATURES_SCAN_REVISIONS_COMMAND, DELVER_SIGNATURES_SEARCH_COMMAND, DELVER_SIGNATURES_VIEW_ID, delverRevisionSignatureHandle, IDelverRevisionSignatureResult, IDelverRevisionSignatureScanState, IDelverSignatureSearchState, IDelverSignaturesStateService } from './delverSignaturesState.js';

const MAX_REVISION_SIGNATURE_SCAN = 100;

const savedSignatureItemWhen = ContextKeyExpr.and(
	ContextKeyExpr.equals('view', DELVER_SIGNATURES_VIEW_ID),
	ContextKeyExpr.or(
		ContextKeyExpr.equals('viewItem', 'delver-saved-signature'),
		ContextKeyExpr.equals('viewItem', 'delver-saved-signature-primary'),
	),
);
const primarySavedSignatureItemWhen = ContextKeyExpr.and(
	ContextKeyExpr.equals('view', DELVER_SIGNATURES_VIEW_ID),
	ContextKeyExpr.equals('viewItem', 'delver-saved-signature-primary'),
);
const uniquePrimaryRevisionSignatureItemWhen = ContextKeyExpr.and(
	ContextKeyExpr.equals('view', DELVER_SIGNATURES_VIEW_ID),
	ContextKeyExpr.equals('viewItem', 'delver-revision-signature-unique-primary'),
);

/** Searches the attached image for an IDA-style byte pattern. */
export class SearchBytePatternAction extends Action2 {
	constructor() {
		super({
			id: DELVER_SIGNATURES_SEARCH_COMMAND,
			title: localize2('delverSearchBytePattern', 'Search Byte Pattern...'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			icon: Codicon.search,
			precondition: DELVER_TARGET_ATTACHED,
			menu: [{
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', DELVER_SIGNATURES_VIEW_ID),
				group: 'navigation',
				order: 1,
			}],
		});
	}

	async run(accessor: ServicesAccessor, requestedPattern?: unknown, requestedCursor?: unknown, append?: unknown): Promise<void> {
		// Resolve invocation-scoped services before the first dialog or analysis await.
		const agentService = accessor.get(IDelverAgentService);
		const stateService = accessor.get(IDelverSignaturesStateService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);
		const viewsService = accessor.get(IViewsService);
		let pattern = typeof requestedPattern === 'string' ? requestedPattern : undefined;
		if (pattern === undefined) {
			pattern = await quickInputService.input({
				title: localize('delverSearchBytePatternTitle', "Search Byte Pattern"),
				prompt: localize('delverSearchBytePatternPrompt', "Enter hexadecimal bytes with ?? or nibble wildcards, for example AB ?? C? E3."),
				placeHolder: '48 8B ?? ?? E8 ?? ?? ?? ??',
				value: stateService.search?.pattern ?? '',
				validateInput: async value => validateByteSearchPattern(value),
			});
		}
		if (pattern === undefined) {
			return;
		}

		const cancellation = new CancellationTokenSource();
		try {
			const result = await progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('delverSearchingBytePattern', "Searching for byte pattern..."),
				cancellable: true,
			}, () => agentService.invoke({
				capability: DelverAgentCapabilityId.SearchBytes,
				args: {
					pattern,
					count: 100,
					...(typeof requestedCursor === 'string' ? { cursor: requestedCursor } : {}),
				},
				caller: { kind: 'human', id: 'delver-signatures' },
			}, cancellation.token), () => cancellation.cancel());
			const search = byteSearchPresentation(result);
			stateService.setSearch(search, append === true);
			await viewsService.openView(DELVER_SIGNATURES_VIEW_ID, true);
			if (search.matches.length === 0 && search.completeness === 'complete') {
				notificationService.info(localize('delverBytePatternNoMatches', "No matches found for {0}.", search.pattern));
			}
		} catch (error) {
			if (!(error instanceof DelverAgentError && error.code === DelverAgentErrorCode.Cancelled)) {
				notificationService.error(error instanceof Error ? error.message : String(error));
			}
		} finally {
			cancellation.dispose();
		}
	}
}

/** Opens the listing at one byte-pattern match. */
export class GoToSignatureMatchAction extends Action2 {
	constructor() {
		super({ id: DELVER_SIGNATURES_GO_TO_COMMAND, title: localize2('delverGoToSignatureMatch', 'Go to Signature Match') });
	}

	async run(accessor: ServicesAccessor, rva: unknown): Promise<void> {
		const sessionService = accessor.get(IDelverSessionService);
		const editorService = accessor.get(IEditorService);
		const focusService = accessor.get(IDelverFocusService);
		const session = sessionService.activeSession;
		if (!session || typeof rva !== 'string' || !/^0x[0-9a-f]+$/i.test(rva)) {
			return;
		}
		const existing = editorService.getEditors(EditorsOrder.SEQUENTIAL)
			.map(identifier => identifier.editor)
			.find((editor): editor is DelverListingInput => editor instanceof DelverListingInput && editor.targetPath === session.targetPath);
		await editorService.openEditor(existing ?? new DelverListingInput(session.targetPath), { pinned: true });
		focusService.setFocus(
			{ location: { space: 'Image', address: BigInt(rva) } },
			DELVER_NAVIGATION_ORIGIN,
			FocusReason.User,
		);
	}
}

/** Copies one persisted IDA-style pattern from the Signatures evidence tree. */
export class CopySignaturePatternAction extends Action2 {
	constructor() {
		super({ id: DELVER_SIGNATURES_COPY_PATTERN_COMMAND, title: localize2('delverCopySignaturePattern', 'Copy Signature Pattern') });
	}

	async run(accessor: ServicesAccessor, pattern: unknown): Promise<void> {
		if (typeof pattern !== 'string' || validateByteSearchPattern(pattern) !== undefined) {
			return;
		}
		const clipboardService = accessor.get(IClipboardService);
		const notificationService = accessor.get(INotificationService);
		await clipboardService.writeText(pattern.toUpperCase());
		notificationService.info(localize('delverSavedSignatureCopied', "Copied signature pattern."));
	}
}

/** Copies a self-contained IDAPython matcher for one saved primary signature. */
export class CopyIdaPythonMatcherAction extends Action2 {
	constructor() {
		super({
			id: DELVER_SIGNATURES_COPY_IDAPYTHON_COMMAND,
			title: localize2('delverCopyIdaPythonMatcher', 'Copy IDAPython Matcher'),
			icon: Codicon.code,
			menu: { id: MenuId.ViewItemContext, when: primarySavedSignatureItemWhen, group: '1_manage', order: 0 },
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const clipboardService = accessor.get(IClipboardService);
		const notificationService = accessor.get(INotificationService);
		const projectService = accessor.get(IDelverProjectService);
		const sessionService = accessor.get(IDelverSessionService);
		const session = sessionService.activeSession;
		const signatureId = signatureIdFromHandle(handle);
		const signature = session && signatureId
			? projectService.signaturesFor(session.contentHash).find(candidate => candidate.id === signatureId)
			: undefined;
		if (!signature || signature.variant !== 'primary') {
			return;
		}
		await clipboardService.writeText(idaPythonMatcher(signature));
		notificationService.info(localize('delverIdaPythonMatcherCopied', "Copied an IDAPython matcher for \"{0}\".", signature.name));
	}
}

/** Exports every saved primary signature in the current revision as one IDAPython script. */
export class ExportIdaPythonMatchersAction extends Action2 {
	constructor() {
		super({
			id: DELVER_SIGNATURES_EXPORT_IDAPYTHON_COMMAND,
			title: localize2('delverExportIdaPythonMatchers', 'Export IDAPython Matchers...'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			icon: Codicon.export,
			precondition: DELVER_TARGET_OPEN,
			menu: [{
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.and(ContextKeyExpr.equals('view', DELVER_SIGNATURES_VIEW_ID), DELVER_TARGET_OPEN),
				group: 'navigation',
				order: 3,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Resolve invocation-scoped services before showing the save dialog.
		const fileDialogService = accessor.get(IFileDialogService);
		const fileService = accessor.get(IFileService);
		const notificationService = accessor.get(INotificationService);
		const projectService = accessor.get(IDelverProjectService);
		const sessionService = accessor.get(IDelverSessionService);
		const session = sessionService.activeSession;
		if (!session) {
			return;
		}
		const signatures = projectService.signaturesFor(session.contentHash).filter(signature => signature.variant === 'primary');
		if (signatures.length === 0) {
			notificationService.info(localize('delverNoPrimarySignaturesToExport', "No saved primary signatures are available in this project revision."));
			return;
		}
		const targetName = basename(session.targetPath).replace(/\.[^.]+$/, '') || 'delver';
		const destination = await fileDialogService.showSaveDialog({
			title: localize('delverExportIdaPythonMatchersTitle', "Export IDAPython Matchers"),
			saveLabel: localize({ key: 'delverExportIdaPythonMatchersLabel', comment: ['&& denotes a mnemonic'] }, "&&Export"),
			defaultUri: URI.file(join(dirname(session.targetPath), `${targetName}-delver-signatures.py`)),
			filters: [{ name: localize('delverPythonFileFilter', "Python"), extensions: ['py'] }],
			availableFileSystems: ['file'],
		});
		if (!destination) {
			return;
		}
		try {
			await fileService.writeFile(destination, VSBuffer.fromString(idaPythonMatcherBundle(signatures)));
			notificationService.info(localize('delverIdaPythonMatchersExported', "Exported {0} IDAPython matchers to {1}.", signatures.length, destination.fsPath));
		} catch (error) {
			notificationService.error(error instanceof Error ? error.message : String(error));
		}
	}
}

/** Tests saved patterns from older project revisions against the attached target. */
export class ScanEarlierSignaturesAction extends Action2 {
	constructor() {
		super({
			id: DELVER_SIGNATURES_SCAN_REVISIONS_COMMAND,
			title: localize2('delverScanEarlierSignatures', 'Scan Earlier Signatures'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			icon: Codicon.history,
			precondition: DELVER_TARGET_ATTACHED,
			menu: [{
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', DELVER_SIGNATURES_VIEW_ID),
				group: 'navigation',
				order: 2,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Resolve invocation-scoped services before the first project or analysis await.
		const agentService = accessor.get(IDelverAgentService);
		const projectService = accessor.get(IDelverProjectService);
		const sessionService = accessor.get(IDelverSessionService);
		const stateService = accessor.get(IDelverSignaturesStateService);
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);
		const viewsService = accessor.get(IViewsService);
		const session = sessionService.activeSession;
		if (!session) {
			return;
		}

		let historical: readonly IDelverHistoricalSignature[];
		try {
			historical = await projectService.historicalSignaturesFor(session.contentHash);
		} catch (error) {
			notificationService.error(error instanceof Error ? error.message : String(error));
			return;
		}
		if (historical.length === 0) {
			notificationService.info(localize('delverNoEarlierSignatures', "No saved signatures were found in earlier project revisions."));
			return;
		}

		const selected = historical.slice(0, MAX_REVISION_SIGNATURE_SCAN);
		const cancellation = new CancellationTokenSource();
		try {
			const results = await progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('delverScanningEarlierSignatures', "Scanning signatures from earlier revisions..."),
				cancellable: true,
			}, async progress => {
				const scanned: IDelverRevisionSignatureResult[] = [];
				const searches = new Map<string, Promise<IDelverAgentResult>>();
				for (const historicalSignature of selected) {
					try {
						const executableOnly = historicalSignature.signature.scope !== 'image';
						const searchKey = `${executableOnly ? 'executable' : 'image'}:${historicalSignature.signature.pattern}`;
						let search = searches.get(searchKey);
						if (!search) {
							search = agentService.invoke({
								capability: DelverAgentCapabilityId.SearchBytes,
								args: {
									pattern: historicalSignature.signature.pattern,
									count: 2,
									...(executableOnly ? { executableOnly: true } : {}),
								},
								caller: { kind: 'human', id: 'delver-signatures-revision-scan' },
							}, cancellation.token);
							searches.set(searchKey, search);
						}
						const result = await search;
						scanned.push(revisionSignaturePresentation(historicalSignature, result));
					} catch (error) {
						if (error instanceof DelverAgentError && error.code === DelverAgentErrorCode.Cancelled) {
							throw error;
						}
						scanned.push({
							...historicalSignature,
							status: 'incomplete',
							matches: [],
							detail: error instanceof Error ? error.message : String(error),
						});
					}
					progress.report({
						increment: 100 / selected.length,
						message: historicalSignature.signature.name,
					});
				}
				return scanned;
			}, () => cancellation.cancel());
			if (sessionService.activeSession?.contentHash !== session.contentHash) {
				return;
			}
			stateService.setRevisionScan({
				targetContentHash: session.contentHash,
				results,
				omittedCount: historical.length - selected.length,
			});
			await viewsService.openView(DELVER_SIGNATURES_VIEW_ID, true);
			const uniqueCount = results.filter(result => result.status === 'unique').length;
			notificationService.info(localize(
				'delverEarlierSignatureScanComplete',
				"Scanned {0} earlier signatures: {1} uniquely located, {2} need attention.",
				results.length,
				uniqueCount,
				results.length - uniqueCount,
			));
		} catch (error) {
			if (!(error instanceof DelverAgentError && error.code === DelverAgentErrorCode.Cancelled)) {
				notificationService.error(error instanceof Error ? error.message : String(error));
			}
		} finally {
			cancellation.dispose();
		}
	}
}

/** Re-runs canonical generation at a uniquely relocated primary signature. */
export class RegenerateRevisionSignatureAction extends Action2 {
	constructor() {
		super({
			id: DELVER_SIGNATURES_REGENERATE_REVISION_COMMAND,
			title: localize2('delverRegenerateRevisionSignature', 'Regenerate for Current Revision...'),
			icon: Codicon.refresh,
			menu: { id: MenuId.ViewItemContext, when: uniquePrimaryRevisionSignatureItemWhen, group: '1_manage', order: 1 },
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);
		const projectService = accessor.get(IDelverProjectService);
		const sessionService = accessor.get(IDelverSessionService);
		const stateService = accessor.get(IDelverSignaturesStateService);
		const session = sessionService.activeSession;
		const scan = stateService.revisionScan;
		if (!session || !scan || scan.targetContentHash !== session.contentHash) {
			return;
		}
		const request = revisionSignatureRegenerationRequest(handle?.$treeItemHandle, scan);
		if (!request) {
			return;
		}
		const outcome = await commandService.executeCommand<IGeneratedSignatureSaveOutcome | undefined>(
			DELVER_GENERATE_SIGNATURE_COMMAND,
			request.rva,
			request.suggestedName,
			revisionSignatureGenerationInvocation(request),
		);
		if (!outcome || outcome.signature.variant !== 'primary' || BigInt(outcome.signature.functionRva) !== BigInt(request.rva)) {
			return;
		}
		try {
			const migration = await projectService.acceptSignatureMigration(session.contentHash, {
				sourceRevisionId: request.sourceRevisionId,
				sourceSignatureId: request.sourceSignatureId,
				searchCallId: request.searchCallId,
				generatedCallId: outcome.generatedCallId,
				targetSignatureId: outcome.signature.id,
			});
			if (migration.proposedCount > 0) {
				notificationService.info(localize(
					'delverSignatureMigrationTransferredWithReview',
					"Accepted the signature match. Transferred {0} annotations and sent {1} conflicts to Review.",
					migration.transferredCount,
					migration.proposedCount,
				));
			} else {
				notificationService.info(localize(
					'delverSignatureMigrationTransferred',
					"Accepted the signature match and transferred {0} annotations.",
					migration.transferredCount,
				));
			}
		} catch (error) {
			notificationService.error(error instanceof Error ? error.message : String(error));
		}
	}
}

/** Renames one durable signature without changing its evidence identity. */
export class RenameSavedSignatureAction extends Action2 {
	constructor() {
		super({
			id: DELVER_SIGNATURES_RENAME_COMMAND,
			title: localize2('delverRenameSavedSignature', 'Rename Signature...'),
			icon: Codicon.edit,
			menu: { id: MenuId.ViewItemContext, when: savedSignatureItemWhen, group: '1_manage', order: 1 },
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const projectService = accessor.get(IDelverProjectService);
		const sessionService = accessor.get(IDelverSessionService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const session = sessionService.activeSession;
		const signatureId = signatureIdFromHandle(handle);
		const signature = session && signatureId ? projectService.signaturesFor(session.contentHash).find(candidate => candidate.id === signatureId) : undefined;
		if (!session || !signature) {
			return;
		}
		const name = await quickInputService.input({
			title: localize('delverRenameSavedSignatureTitle', "Rename Signature"),
			prompt: localize('delverRenameSavedSignaturePrompt', "Enter a unique name for this project revision."),
			value: signature.name,
			validateInput: async value => validateSignatureName(value) ?? (
				projectService.signaturesFor(session.contentHash).some(candidate => candidate.id !== signature.id && candidate.name.toLowerCase() === value.toLowerCase())
					? localize('delverSignatureNameAlreadyExists', "A signature with this name already exists in the project revision.")
					: undefined
			),
		});
		if (name === undefined || name === signature.name) {
			return;
		}
		try {
			await projectService.renameSignature(session.contentHash, signature.id, name);
			if (!sessionService.projectPath) {
				sessionService.markProjectDirty();
			}
			notificationService.info(localize('delverSignatureRenamed', "Renamed signature to \"{0}\".", name));
		} catch (error) {
			notificationService.error(error instanceof Error ? error.message : String(error));
		}
	}
}

/** Permanently removes one durable signature after explicit confirmation. */
export class DeleteSavedSignatureAction extends Action2 {
	constructor() {
		super({
			id: DELVER_SIGNATURES_DELETE_COMMAND,
			title: localize2('delverDeleteSavedSignature', 'Delete Signature...'),
			icon: Codicon.trash,
			menu: { id: MenuId.ViewItemContext, when: savedSignatureItemWhen, group: '1_manage', order: 2 },
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const projectService = accessor.get(IDelverProjectService);
		const sessionService = accessor.get(IDelverSessionService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);
		const session = sessionService.activeSession;
		const signatureId = signatureIdFromHandle(handle);
		const signature = session && signatureId ? projectService.signaturesFor(session.contentHash).find(candidate => candidate.id === signatureId) : undefined;
		if (!session || !signature) {
			return;
		}
		const confirmation = await dialogService.confirm({
			title: localize('delverDeleteSavedSignatureTitle', "Delete Signature"),
			message: localize('delverDeleteSavedSignatureMessage', "Delete signature \"{0}\"?", signature.name),
			detail: localize('delverDeleteSavedSignatureDetail', "This removes its saved pattern and proof from this project revision. This action cannot be undone."),
			primaryButton: localize('delverDeleteSavedSignatureConfirm', "Delete"),
			type: 'warning',
		});
		if (!confirmation.confirmed) {
			return;
		}
		try {
			await projectService.deleteSignature(session.contentHash, signature.id);
			if (!sessionService.projectPath) {
				sessionService.markProjectDirty();
			}
			notificationService.info(localize('delverSignatureDeleted', "Deleted signature \"{0}\".", signature.name));
		} catch (error) {
			notificationService.error(error instanceof Error ? error.message : String(error));
		}
	}
}

function signatureIdFromHandle(handle: TreeViewItemHandleArg): string | undefined {
	const itemHandle = handle?.$treeItemHandle;
	if (typeof itemHandle !== 'string' || !itemHandle.startsWith(DELVER_SIGNATURES_SAVED_HANDLE_PREFIX)) {
		return undefined;
	}
	const signatureId = itemHandle.slice(DELVER_SIGNATURES_SAVED_HANDLE_PREFIX.length);
	return signatureId.length > 0 ? signatureId : undefined;
}

export function validateByteSearchPattern(value: string): string | undefined {
	const tokens = value.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return localize('delverBytePatternRequired', "Enter at least one byte.");
	}
	if (tokens.length > 256) {
		return localize('delverBytePatternTooLong', "Use no more than 256 bytes.");
	}
	if (tokens.some(token => !/^[0-9a-f?]{2}$/i.test(token))) {
		return localize('delverBytePatternInvalid', "Use two hexadecimal or wildcard nibbles per byte, separated by spaces.");
	}
	return undefined;
}

export function byteSearchPresentation(result: IDelverAgentResult): IDelverSignatureSearchState {
	const data = record(result.data);
	const pattern = text(data.pattern).toUpperCase();
	const matchesValue = data.matches;
	if (!Array.isArray(matchesValue) || (result.completeness !== 'complete' && result.completeness !== 'partial')) {
		throw new Error('Byte-search response is malformed.');
	}
	const matches = matchesValue.map(value => {
		const match = record(value);
		const rva = text(match.rva);
		const bytesHex = text(match.bytesHex);
		if (!/^0x[0-9a-f]+$/i.test(rva) || !/^(?:[0-9a-f]{2})+$/i.test(bytesHex)) {
			throw new Error('Byte-search response is malformed.');
		}
		return { rva, section: text(match.section), bytesHex };
	});
	return {
		pattern,
		matches,
		completeness: result.completeness,
		...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
	};
}

export function revisionSignaturePresentation(historical: IDelverHistoricalSignature, result: IDelverAgentResult): IDelverRevisionSignatureResult {
	const search = byteSearchPresentation(result);
	if (search.pattern !== historical.signature.pattern.toUpperCase()) {
		throw new Error('Byte-search response does not match the requested historical signature.');
	}
	return {
		...historical,
		searchCallId: result.callId,
		status: search.completeness === 'partial' || search.matches.length > 1
			? 'ambiguous'
			: search.matches.length === 1 ? 'unique' : 'missing',
		matches: search.matches,
		...(search.completeness === 'partial' ? { detail: localize('delverEarlierSignatureMoreMatches', "More matches remain beyond the displayed evidence.") } : {}),
	};
}

/** Produces a fail-closed IDAPython script for locating and naming one function. */
export function idaPythonMatcher(signature: IDelverNamedSignature): string {
	if (signature.variant !== 'primary') {
		throw new Error('Only primary signatures identify the matched function entry');
	}
	return idaPythonMatcherBundle([signature]);
}

/** Produces one deterministic IDAPython script for every supplied primary signature. */
export function idaPythonMatcherBundle(signatures: readonly IDelverNamedSignature[]): string {
	const entries = signatures
		.filter(signature => signature.variant === 'primary')
		.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
		.map(signature => [signature.name, signature.pattern.toUpperCase()]);
	if (entries.length === 0) {
		throw new Error('At least one primary signature is required');
	}
	return `# Generated by Delver. Each entry is [function name, IDA byte pattern].
import ida_bytes
import ida_funcs
import ida_ida
import ida_idaapi
import ida_kernwin
import ida_name

SIGNATURES = ${JSON.stringify(entries, undefined, 4)}
START_EA = ida_ida.inf_get_min_ea()
END_EA = ida_ida.inf_get_max_ea()

applied = 0
already_named = 0
preserved = 0
missing = 0
ambiguous = 0
non_function = 0
rejected = 0
successful_match_ea = ida_idaapi.BADADDR

for function_name, pattern in SIGNATURES:
    match_ea = ida_bytes.find_bytes(pattern, START_EA, range_end=END_EA)
    if match_ea == ida_idaapi.BADADDR:
        missing += 1
        print(f"Delver: {function_name!r} was not found")
    else:
        next_match_ea = ida_bytes.find_bytes(pattern, match_ea + 1, range_end=END_EA)
        if next_match_ea != ida_idaapi.BADADDR:
            ambiguous += 1
            print(f"Delver: {function_name!r} is ambiguous ({match_ea:#x}, {next_match_ea:#x}, ...)")
        else:
            function = ida_funcs.get_func(match_ea)
            current_name = ida_name.get_name(match_ea)
            if function is None or function.start_ea != match_ea:
                non_function += 1
                print(f"Delver: unique match {match_ea:#x} for {function_name!r} is not an IDA function entry")
            elif current_name == function_name:
                already_named += 1
                successful_match_ea = match_ea
            elif ida_bytes.has_name(ida_bytes.get_flags(match_ea)):
                preserved += 1
                print(f"Delver: preserved existing name {current_name!r} at {match_ea:#x} instead of {function_name!r}")
            elif ida_name.set_name(match_ea, function_name, ida_name.SN_CHECK | ida_name.SN_NOWARN):
                applied += 1
                successful_match_ea = match_ea
            else:
                rejected += 1
                print(f"Delver: IDA rejected name {function_name!r} at {match_ea:#x}")

if len(SIGNATURES) == 1 and successful_match_ea != ida_idaapi.BADADDR:
    ida_kernwin.jumpto(successful_match_ea)

print(
    f"Delver: {applied} applied, {already_named} already named, {preserved} existing names preserved, "
    f"{missing} missing, {ambiguous} ambiguous, {non_function} non-function matches, {rejected} names rejected"
)
`;
}

export interface IRevisionSignatureRegenerationRequest {
	readonly rva: string;
	readonly suggestedName: string;
	readonly sourceRevisionId: string;
	readonly sourceSignatureId: string;
	readonly searchCallId: string;
}

/** Binds regeneration to the exact retained proof selected by Earlier Revision Scan. */
export function revisionSignatureGenerationInvocation(request: IRevisionSignatureRegenerationRequest): ISignatureGenerationInvocation {
	return {
		policy: 'cross-revision-stable',
		sourceRevisionId: request.sourceRevisionId,
		sourceSignatureId: request.sourceSignatureId,
	};
}

export function revisionSignatureRegenerationRequest(itemHandle: unknown, scan: IDelverRevisionSignatureScanState): IRevisionSignatureRegenerationRequest | undefined {
	if (typeof itemHandle !== 'string') {
		return undefined;
	}
	const result = scan.results.find(candidate => delverRevisionSignatureHandle(candidate) === itemHandle);
	if (result?.status !== 'unique' || result.signature.variant !== 'primary' || result.matches.length !== 1 || !result.searchCallId) {
		return undefined;
	}
	return {
		rva: result.matches[0].rva,
		suggestedName: result.signature.name,
		sourceRevisionId: result.revision.revisionId,
		sourceSignatureId: result.signature.id,
		searchCallId: result.searchCallId,
	};
}

function record(value: unknown): Readonly<Record<string, unknown>> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Byte-search response is malformed.');
	}
	return value as Readonly<Record<string, unknown>>;
}

function text(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error('Byte-search response is malformed.');
	}
	return value;
}
