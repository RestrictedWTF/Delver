/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IBootstrapAuthorizationRequest, InMemoryBootstrapAuthorizer } from './authorization';

export type BootstrapApprovalDecision = 'allow' | 'deny' | undefined;

export interface IBootstrapApprovalPrompt {
	show(request: IBootstrapAuthorizationRequest, signal: AbortSignal): Promise<BootstrapApprovalDecision>;
}

export interface IBootstrapApprovalMessageItem {
	readonly title: string;
	readonly isCloseAffordance?: boolean;
}

export interface IBootstrapApprovalMessageOptions {
	readonly modal: true;
	readonly detail: string;
}

export interface IBootstrapApprovalPromptContent {
	readonly message: string;
	readonly detail: string;
	readonly allowOnce: string;
	readonly deny: string;
}

export interface IBootstrapApprovalStrings {
	readonly message: string;
	readonly verifiedProcessAndUser: (platform: string, processId: number, userId: number) => string;
	readonly verifiedProcess: (platform: string, processId: number) => string;
	readonly verifiedUser: (platform: string, userId: number) => string;
	readonly untrustedName: (displayName: string) => string;
	readonly access: string;
	readonly allowOnce: string;
	readonly deny: string;
}

export type BootstrapApprovalShowWarningMessage = (
	message: string,
	options: IBootstrapApprovalMessageOptions,
	...items: readonly IBootstrapApprovalMessageItem[]
) => PromiseLike<IBootstrapApprovalMessageItem | undefined>;

/** Connects one-shot authorization requests to a user approval prompt. */
export class BootstrapApprovalController {
	private readonly removeRequestListener: () => void;
	private readonly busyListeners = new Set<(busy: boolean) => void>();
	private activeRequestId: string | undefined;
	private disposed = false;

	constructor(
		private readonly authorizer: InMemoryBootstrapAuthorizer,
		private readonly prompt: IBootstrapApprovalPrompt,
	) {
		this.removeRequestListener = authorizer.onDidRequest((request, signal) => {
			void this.handleRequest(request, signal);
		});
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.removeRequestListener();
		if (this.activeRequestId !== undefined) {
			const requestId = this.activeRequestId;
			this.activeRequestId = undefined;
			this.authorizer.deny(requestId);
			this.emitBusy(false);
		}
		this.busyListeners.clear();
	}

	isBusy(): boolean {
		return this.activeRequestId !== undefined;
	}

	onDidChangeBusy(listener: (busy: boolean) => void): () => void {
		if (this.disposed) {
			return () => { };
		}
		this.busyListeners.add(listener);
		return () => this.busyListeners.delete(listener);
	}

	private async handleRequest(request: IBootstrapAuthorizationRequest, signal: AbortSignal): Promise<void> {
		if (this.disposed || this.activeRequestId !== undefined) {
			this.authorizer.deny(request.authorizationRequestId);
			return;
		}

		const requestId = request.authorizationRequestId;
		this.activeRequestId = requestId;
		this.emitBusy(true);
		let decision: BootstrapApprovalDecision;
		try {
			decision = await this.prompt.show(request, signal);
		} catch {
			decision = 'deny';
		}

		if (this.activeRequestId !== requestId) {
			return;
		}
		this.activeRequestId = undefined;
		this.emitBusy(false);
		if (decision === 'allow' && !signal.aborted) {
			this.authorizer.grantOnce(requestId);
		} else {
			this.authorizer.deny(requestId);
		}
	}

	private emitBusy(busy: boolean): void {
		for (const listener of [...this.busyListeners]) {
			try {
				listener(busy);
			} catch {
				// Prompt state remains authoritative when an observer fails.
			}
		}
	}
}

/** Creates the inactive VS Code modal adapter through testable UI and localization seams. */
export function createModalBootstrapApprovalPrompt(
	showWarningMessage: BootstrapApprovalShowWarningMessage,
	strings: IBootstrapApprovalStrings,
): IBootstrapApprovalPrompt {
	return {
		async show(request): Promise<BootstrapApprovalDecision> {
			const content = formatBootstrapApprovalPrompt(request, strings);
			const allowOnce = Object.freeze<IBootstrapApprovalMessageItem>({ title: content.allowOnce });
			const deny = Object.freeze<IBootstrapApprovalMessageItem>({ title: content.deny, isCloseAffordance: true });
			const result = await showWarningMessage(content.message, { modal: true, detail: content.detail }, allowOnce, deny);
			return result === allowOnce ? 'allow' : 'deny';
		},
	};
}

export function formatBootstrapApprovalPrompt(
	request: IBootstrapAuthorizationRequest,
	strings: IBootstrapApprovalStrings,
): IBootstrapApprovalPromptContent {
	const verifiedIdentity = formatVerifiedIdentity(request, strings);
	const untrustedName = request.untrustedDisplayName === undefined ? undefined : strings.untrustedName(request.untrustedDisplayName);
	return {
		message: strings.message,
		detail: [verifiedIdentity, untrustedName, strings.access].filter((part): part is string => part !== undefined).join('\n\n'),
		allowOnce: strings.allowOnce,
		deny: strings.deny,
	};
}

function formatVerifiedIdentity(request: IBootstrapAuthorizationRequest, strings: IBootstrapApprovalStrings): string {
	const { platform, processId, userId } = request.peer;
	if (processId !== undefined && userId !== undefined) {
		return strings.verifiedProcessAndUser(platform, processId, userId);
	}
	if (processId !== undefined) {
		return strings.verifiedProcess(platform, processId);
	}
	if (userId === undefined) {
		throw new Error('The bootstrap approval request has no OS-attested process or user identity.');
	}
	return strings.verifiedUser(platform, userId);
}
