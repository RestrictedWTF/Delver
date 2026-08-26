/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { DELVER_SIGNATURE_LIMITS, delverNamedSignatureFromWire, DelverSignaturePolicy, DelverSignatureVariant, IDelverNamedSignature } from '../../../../platform/delver/common/delverSignature.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { DelverAgentCapabilityId, IDelverAgentService } from '../../../services/delver/common/delverAgentService.js';
import { DelverAgentError, DelverAgentErrorCode, IDelverAgentResult, toWireAddress } from '../../../services/delver/common/delverAgentTypes.js';
import { MenuDelverSelectionContext, whenSelectionIs } from '../../../services/delver/common/delverSelection.js';
import { DELVER_TARGET_ATTACHED, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { LISTING_ACTIVE } from './delverListingContext.js';
import { activeListing } from './delverActiveListing.js';

interface IGeneratedSignatureVariant {
	readonly variant: DelverSignatureVariant;
	readonly pattern: string;
	readonly byteCount: number;
	readonly fixedByteCount: number;
	readonly confidence: 'low' | 'medium' | 'high';
	readonly unique: boolean;
}

interface IGeneratedCrossRevisionProof {
	readonly revisionCount: number;
	readonly revisions: readonly {
		readonly revisionId: string;
		readonly displayName: string;
		readonly signatureId: string;
	}[];
}

export const DELVER_GENERATE_SIGNATURE_COMMAND = 'delver.listing.generateSignature';

export interface IGeneratedSignaturePresentation {
	readonly functionName: string;
	readonly policy: DelverSignaturePolicy;
	readonly primary: IGeneratedSignatureVariant;
	readonly xrefSite?: IGeneratedSignatureVariant;
	readonly crossRevisionProof?: IGeneratedCrossRevisionProof;
}

export interface ISignaturePolicyPickItem extends IQuickPickItem {
	readonly policy: DelverSignaturePolicy;
}

export interface ISignatureActionPickItem extends IQuickPickItem {
	readonly operation: 'save' | 'copy';
	readonly signature: IGeneratedSignatureVariant;
}

/** Optional policy and retained evidence binding for programmatic signature generation. */
export interface ISignatureGenerationInvocation {
	readonly policy: DelverSignaturePolicy;
	readonly sourceRevisionId?: string;
	readonly sourceSignatureId?: string;
}

/** A durable save completed by the canonical generator command. */
export interface IGeneratedSignatureSaveOutcome {
	readonly operation: 'saved';
	readonly generatedCallId: string;
	readonly signature: IDelverNamedSignature;
}

/** Converts the canonical dispatcher result into the small contract the listing UI needs. */
export function generatedSignaturePresentation(result: IDelverAgentResult): IGeneratedSignaturePresentation {
	const data = record(result.data);
	const target = record(data.target);
	const alternative = data.alternativeXrefSignature;
	const policy = generatedSignaturePolicy(data.policy);
	const primary = generatedVariant(data, 'primary');
	const crossRevisionProof = policy === 'cross-revision-stable'
		? generatedCrossRevisionProof(data.crossRevisionProof, primary.pattern)
		: undefined;
	return {
		functionName: text(target.name),
		policy,
		primary,
		...(isRecord(alternative) && alternative.available === true
			? { xrefSite: generatedVariant(alternative, 'xref-site') }
			: {}),
		...(crossRevisionProof === undefined ? {} : { crossRevisionProof }),
	};
}

/** Generates a signature for the function under the listing cursor. */
export class GenerateSignatureAction extends Action2 {
	constructor() {
		const enabled = ContextKeyExpr.and(LISTING_ACTIVE, DELVER_TARGET_ATTACHED);
		super({
			id: DELVER_GENERATE_SIGNATURE_COMMAND,
			title: localize2('delverGenerateSignature', 'Generate Signature...'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			precondition: enabled,
			icon: Codicon.key,
			menu: [
				{
					id: MenuId.EditorTitle,
					when: enabled,
					group: 'navigation',
					order: 2,
				},
				{
					// Bound to the selected *function*, not to a container.
					// Attaching this to a view title was how it ended up in
					// unrelated title bars with nothing on screen connecting it
					// to what it operates on (`Docs/design/workspace.md` §5).
					id: MenuDelverSelectionContext,
					when: ContextKeyExpr.and(enabled, whenSelectionIs('function')),
					group: 'delver.function',
					order: 2,
				},
			],
		});
	}

	async run(accessor: ServicesAccessor, requestedRva?: unknown, suggestedName?: unknown, requestedGeneration?: unknown): Promise<IGeneratedSignatureSaveOutcome | undefined> {
		// Service accessors are invocation-scoped. Resolve every dependency before
		// the first await so dialogs and analysis cannot outlive the accessor.
		const sessionService = accessor.get(IDelverSessionService);
		const agentService = accessor.get(IDelverAgentService);
		const quickInputService = accessor.get(IQuickInputService);
		const clipboardService = accessor.get(IClipboardService);
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);
		const session = sessionService.activeSession;
		if (!session?.sessionId) {
			return;
		}

		let functionRva = explicitSignatureRva(requestedRva);
		if (requestedRva !== undefined && functionRva === undefined) {
			return;
		}
		if (functionRva === undefined) {
			const listing = activeListing();
			if (!listing) {
				return;
			}
			functionRva = await listing.selectedFunctionRva();
		}
		if (functionRva === undefined) {
			notificationService.info(localize('delverNoFunctionForSignature', "The selected instruction is not inside a detected function."));
			return;
		}
		const invocation = explicitSignatureGenerationInvocation(requestedGeneration);
		let policy = invocation?.policy;
		if (requestedGeneration !== undefined && invocation === undefined) {
			return;
		}
		if (policy === undefined) {
			const pickedPolicy = await quickInputService.pick(signaturePolicyChoices(), {
				title: localize('delverSignaturePolicyTitle', "Choose Signature Policy"),
				placeHolder: localize('delverSignaturePolicyPlaceholder', "Relocation-stable is the recommended default"),
				matchOnDescription: true,
			});
			if (!pickedPolicy) {
				return;
			}
			policy = pickedPolicy.policy;
		}

		const cancellation = new CancellationTokenSource();
		try {
			const generated = await progressService.withProgress({
				location: ProgressLocation.Notification,
				title: policy === 'cross-revision-stable'
					? localize('delverGeneratingCrossRevisionSignature', "Generating and proving a cross-revision Delver signature...")
					: localize('delverGeneratingSignature', "Generating and proving a Delver signature..."),
				cancellable: true,
			}, () => agentService.invoke({
				capability: DelverAgentCapabilityId.MakeSignature,
				args: signatureGenerationArgs(functionRva, { ...invocation, policy }),
				caller: { kind: 'human', id: requestedRva === undefined ? 'delver-listing' : 'delver-signatures-revision-scan' },
			}, cancellation.token), () => cancellation.cancel());
			const presentation = generatedSignaturePresentation(generated);
			const picked = await quickInputService.pick(signatureActions(presentation), {
				title: presentation.crossRevisionProof
					? localize('delverGeneratedCrossRevisionSignatureTitle', "Signature for {0} - {1} Earlier Revision Proofs", presentation.functionName, presentation.crossRevisionProof.revisionCount)
					: localize('delverGeneratedSignatureTitle', "Signature for {0}", presentation.functionName),
				placeHolder: localize('delverGeneratedSignatureChoice', "Save a proven signature or copy its IDA-style byte pattern"),
				matchOnDescription: true,
				matchOnDetail: true,
			});
			if (!picked) {
				return;
			}

			if (picked.operation === 'copy') {
				await clipboardService.writeText(picked.signature.pattern);
				notificationService.info(localize('delverSignatureCopied', "Copied signature: {0}", picked.signature.pattern));
				return;
			}

			const name = await quickInputService.input({
				title: localize('delverSaveSignatureTitle', "Save Delver Signature"),
				prompt: localize('delverSaveSignaturePrompt', "Name this signature. Saving the same name replaces its evidence for this revision."),
				value: (typeof suggestedName === 'string' ? suggestedName : presentation.functionName).slice(0, DELVER_SIGNATURE_LIMITS.nameCharacters),
				validateInput: async value => validateSignatureName(value),
			});
			if (name === undefined) {
				return;
			}

			const saved = await agentService.invoke({
				capability: DelverAgentCapabilityId.SaveSignature,
				args: { name, sourceCallId: generated.callId, variant: picked.signature.variant },
				caller: { kind: 'human', id: 'delver-listing' },
			}, CancellationToken.None);
			const signature = savedSignature(saved);
			notificationService.info(localize('delverSignatureSaved', "Saved signature \"{0}\" for this project revision.", name));
			return {
				operation: 'saved',
				generatedCallId: generated.callId,
				signature,
			};
		} catch (error) {
			if (!(error instanceof DelverAgentError && error.code === DelverAgentErrorCode.Cancelled)) {
				notificationService.error(error instanceof Error ? error.message : String(error));
			}
		} finally {
			cancellation.dispose();
		}
		return undefined;
	}
}

function savedSignature(result: IDelverAgentResult): IDelverNamedSignature {
	return delverNamedSignatureFromWire(record(result.data).signature);
}

export function explicitSignatureRva(value: unknown): bigint | undefined {
	if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) {
		return undefined;
	}
	return BigInt(value);
}

export function explicitSignaturePolicy(value: unknown): DelverSignaturePolicy | undefined {
	if (value === 'unique-now' || value === 'relocation-stable' || value === 'cross-revision-stable') {
		return value;
	}
	return undefined;
}

/** Parses a command invocation while retaining compatibility with the original policy-string argument. */
export function explicitSignatureGenerationInvocation(value: unknown): ISignatureGenerationInvocation | undefined {
	const directPolicy = explicitSignaturePolicy(value);
	if (directPolicy !== undefined) {
		return { policy: directPolicy };
	}
	if (!isRecord(value)) {
		return undefined;
	}
	const policy = explicitSignaturePolicy(value.policy);
	const sourceRevisionId = optionalNonEmptyText(value.sourceRevisionId);
	const sourceSignatureId = optionalNonEmptyText(value.sourceSignatureId);
	if (policy === undefined
		|| (value.sourceRevisionId !== undefined && sourceRevisionId === undefined)
		|| (value.sourceSignatureId !== undefined && sourceSignatureId === undefined)
		|| (sourceRevisionId === undefined) !== (sourceSignatureId === undefined)
		|| (sourceRevisionId !== undefined && policy !== 'cross-revision-stable')) {
		return undefined;
	}
	return {
		policy,
		...(sourceRevisionId === undefined ? {} : { sourceRevisionId, sourceSignatureId }),
	};
}

export function signatureGenerationArgs(functionRva: bigint, invocation: ISignatureGenerationInvocation): Readonly<Record<string, unknown>> {
	return {
		address: toWireAddress(functionRva),
		scope: 'executableSections',
		policy: invocation.policy,
		...(invocation.sourceRevisionId === undefined ? {} : {
			sourceRevisionId: invocation.sourceRevisionId,
			sourceSignatureId: invocation.sourceSignatureId,
		}),
	};
}

export function signaturePolicyChoices(): ISignaturePolicyPickItem[] {
	return [{
		label: localize('delverRelocationStablePolicy', "Relocation-Stable (Recommended)"),
		description: localize('delverRelocationStablePolicyDescription', "Mask decoded relocations and prove uniqueness in the current executable sections"),
		policy: 'relocation-stable',
	}, {
		label: localize('delverCrossRevisionStablePolicy', "Cross-Revision Stable"),
		description: localize('delverCrossRevisionStablePolicyDescription', "Require the same unique masked pattern in retained earlier revision proofs"),
		policy: 'cross-revision-stable',
	}, {
		label: localize('delverUniqueNowPolicy', "Unique Now"),
		description: localize('delverUniqueNowPolicyDescription', "Keep every byte exact and prove uniqueness only in the current executable sections"),
		policy: 'unique-now',
	}];
}

export function signatureActions(presentation: IGeneratedSignaturePresentation): ISignatureActionPickItem[] {
	const signatures = [presentation.primary, ...(presentation.xrefSite ? [presentation.xrefSite] : [])];
	const actions: ISignatureActionPickItem[] = [];
	for (const signature of signatures) {
		const label = signature.variant === 'primary'
			? localize('delverPrimarySignature', "Primary")
			: localize('delverXrefSignature', "Xref-site alternative");
		const crossRevisionProof = signature.variant === 'primary' ? presentation.crossRevisionProof : undefined;
		const stability = crossRevisionProof === undefined
			? ''
			: crossRevisionProof.revisionCount === 1
				? localize('delverSignatureOneRevisionStable', ", stable across 1 earlier revision")
				: localize('delverSignatureManyRevisionsStable', ", stable across {0} earlier revisions", crossRevisionProof.revisionCount);
		const description = localize(
			'delverSignatureSummary',
			"{0} confidence, {1}/{2} fixed bytes{3}{4}",
			signature.confidence,
			signature.fixedByteCount,
			signature.byteCount,
			signature.unique ? localize('delverSignatureUnique', ", unique") : localize('delverSignatureAmbiguous', ", not proven unique"),
			stability,
		);
		const detail = crossRevisionProof === undefined
			? signature.pattern
			: localize(
				'delverSignatureRevisionProofDetail',
				"{0} - Earlier proofs: {1}",
				signature.pattern,
				crossRevisionProofNames(crossRevisionProof),
			);
		if (signature.unique) {
			actions.push({
				label: `$(${Codicon.save.id}) ${localize('delverSaveGeneratedSignature', "Save {0}...", label)}`,
				description,
				detail,
				operation: 'save',
				signature,
			});
		}
		actions.push({
			label: `$(${Codicon.copy.id}) ${localize('delverCopyGeneratedSignature', "Copy {0} Pattern", label)}`,
			description,
			detail,
			operation: 'copy',
			signature,
		});
	}
	return actions;
}

function generatedSignaturePolicy(value: unknown): DelverSignaturePolicy {
	const policy = explicitSignaturePolicy(value);
	if (policy === undefined) {
		throw new Error('Generated signature response has invalid policy metadata.');
	}
	return policy;
}

function generatedCrossRevisionProof(value: unknown, primaryPattern: string): IGeneratedCrossRevisionProof {
	const proof = record(value);
	if (proof.method !== 'retained-exact-primary-signatures') {
		throw new Error('Generated signature response has invalid cross-revision proof metadata.');
	}
	const revisionCount = integer(proof.revisionCount);
	if (!Array.isArray(proof.revisions) || revisionCount === 0 || proof.revisions.length !== revisionCount) {
		throw new Error('Generated signature response has invalid cross-revision proof metadata.');
	}
	const revisions = proof.revisions.map(value => {
		const revision = record(value);
		if (text(revision.pattern).toUpperCase() !== primaryPattern) {
			throw new Error('Generated signature response has a cross-revision pattern mismatch.');
		}
		const contentHash = text(revision.contentHash);
		const functionRva = text(revision.functionRva);
		if (!/^[0-9a-f]{64}$/.test(contentHash) || !/^0x[0-9a-f]+$/.test(functionRva)) {
			throw new Error('Generated signature response has invalid cross-revision proof metadata.');
		}
		text(revision.sourceCallId);
		return {
			revisionId: text(revision.revisionId),
			displayName: text(revision.displayName),
			signatureId: text(revision.signatureId),
		};
	});
	return { revisionCount, revisions };
}

function crossRevisionProofNames(proof: IGeneratedCrossRevisionProof): string {
	const displayed = proof.revisions.slice(0, 3).map(revision => revision.displayName).join(', ');
	const omitted = proof.revisions.length - 3;
	return omitted > 0
		? localize('delverSignatureMoreRevisionProofs', "{0}, and {1} more", displayed, omitted)
		: displayed;
}

function generatedVariant(value: Readonly<Record<string, unknown>>, variant: DelverSignatureVariant): IGeneratedSignatureVariant {
	const quality = record(value.quality);
	const proof = record(value.proof);
	const confidence = quality.confidence;
	if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') {
		throw new Error('Generated signature response has invalid confidence metadata.');
	}
	const pattern = text(value.pattern).toUpperCase();
	const byteCount = integer(value.byteCount);
	const fixedByteCount = integer(value.fixedByteCount);
	const tokens = pattern.split(' ');
	if (byteCount === 0
		|| byteCount > DELVER_SIGNATURE_LIMITS.patternBytes
		|| tokens.length !== byteCount
		|| tokens.some(token => !/^(?:[0-9A-F]{2}|\?\?)$/.test(token))
		|| tokens.filter(token => token !== '??').length !== fixedByteCount) {
		throw new Error('Generated signature response has invalid pattern metadata.');
	}
	return {
		variant,
		pattern,
		byteCount,
		fixedByteCount,
		confidence,
		unique: proof.unique === true && proof.matchCountExact === true && proof.matchCount === 1,
	};
}

export function validateSignatureName(value: string): string | undefined {
	if (value.length === 0) {
		return localize('delverSignatureNameRequired', "Enter a signature name.");
	}
	if (value.trim() !== value) {
		return localize('delverSignatureNameWhitespace', "Remove leading or trailing whitespace.");
	}
	if (value.length > DELVER_SIGNATURE_LIMITS.nameCharacters) {
		return localize('delverSignatureNameTooLong', "Use no more than {0} characters.", DELVER_SIGNATURE_LIMITS.nameCharacters);
	}
	return undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
	if (!isRecord(value)) {
		throw new Error('Generated signature response is malformed.');
	}
	return value;
}

function text(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error('Generated signature response is malformed.');
	}
	return value;
}

function optionalNonEmptyText(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integer(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new Error('Generated signature response is malformed.');
	}
	return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
