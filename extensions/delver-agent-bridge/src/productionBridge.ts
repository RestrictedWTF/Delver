/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import { BootstrapApprovalController, IBootstrapApprovalPrompt } from './approvalUi';
import { InMemoryBootstrapAuthorizer } from './authorization';
import { DelverBootstrapSession } from './bootstrap';
import { DelverBootstrapRelayManager } from './bootstrapRelayManager';
import { IDelverAgentGateway } from './connection';
import { DelverDtpRelayProvisioner } from './dtpProvision';
import { DelverWindowRendezvousLifecycle, IRendezvousLifecycleManagerContext } from './rendezvousLifecycle';
import {
	createBootstrapRelayAttempt,
	IBootstrapRelayAttempt,
	IRelayProcess,
	prepareWindowsRendezvousRegistryDirectory,
	resolveRelayExecutable,
	spawnBootstrapRelayProcess,
	spawnRelayProcess,
} from './relayProcess';
import { FileRendezvousRegistry, IRendezvousRegistry, resolveRendezvousRegistryDirectory } from './rendezvousRegistry';
import { computeWorkspaceRootFingerprintV1, isPermittedRootV1FileAuthority, IWorkspaceRootV1Selection, RootFingerprintError } from './rootFingerprint';
import { DtpTokenLeaseStore } from './tokenLease';

export interface IWorkspaceRootSource {
	getSelection(): IWorkspaceRootV1Selection;
	onDidChange(listener: () => void): () => void;
}

export interface IWorkspaceRendezvousLifecycle {
	start(): void;
	setRoot(rootFingerprint: string | undefined): void;
	dispose(): void;
	whenDisposed(): Promise<void>;
}

export interface IAgentBridgeRuntime {
	start(): Promise<void>;
	dispose(): Promise<void>;
}

export interface IDelverAgentBridgeActivationOptions {
	readonly workspace: IWorkspaceRootSource;
	readonly platform?: NodeJS.Platform;
	readonly createRuntime: () => IAgentBridgeRuntime;
}

/** Lazily constructs the native bridge only after a supported local root exists. */
export class DelverAgentBridgeActivation {
	private removeWorkspaceListener: () => void = () => { };
	private runtime: IAgentBridgeRuntime | undefined;
	private started = false;
	private disposed = false;

	constructor(private readonly options: IDelverAgentBridgeActivationOptions) { }

	async start(): Promise<void> {
		if (this.disposed) {
			throw new Error('The Delver agent bridge activation owner is disposed.');
		}
		if (this.started) {
			return;
		}
		this.started = true;
		this.removeWorkspaceListener = this.options.workspace.onDidChange(() => void this.reconcile().catch(() => undefined));
		await this.reconcile();
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			await this.runtime?.dispose();
			return;
		}
		this.disposed = true;
		this.removeWorkspaceListener();
		this.removeWorkspaceListener = () => { };
		await this.runtime?.dispose();
	}

	private async reconcile(): Promise<void> {
		if (this.disposed || this.runtime || !isWorkspaceSelectionEligibleForBridge(this.options.workspace.getSelection(), this.options.platform ?? process.platform)) {
			return;
		}
		const runtime = this.options.createRuntime();
		this.runtime = runtime;
		try {
			await runtime.start();
		} catch (error) {
			await runtime.dispose();
			if (this.runtime === runtime) {
				this.runtime = undefined;
			}
			throw error;
		}
	}
}

/** The single reason a window can or cannot expose an external agent endpoint. */
export type BridgeEligibility =
	| { readonly kind: 'eligible'; readonly rootPath: string }
	| { readonly kind: 'unsupported-platform' }
	| { readonly kind: 'untrusted-workspace' }
	| { readonly kind: 'remote-workspace' }
	| { readonly kind: 'untitled-workspace' }
	| { readonly kind: 'no-root' }
	| { readonly kind: 'multiple-roots' }
	| { readonly kind: 'non-local-root' };

/** Performs the filesystem-free activation gate before resolving native assets. */
export function describeBridgeEligibility(selection: IWorkspaceRootV1Selection, platform: NodeJS.Platform): BridgeEligibility {
	if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux' && platform !== 'freebsd' && platform !== 'openbsd') {
		return { kind: 'unsupported-platform' };
	}
	if (selection.trusted !== true) {
		return { kind: 'untrusted-workspace' };
	}
	if (selection.remoteName !== undefined) {
		return { kind: 'remote-workspace' };
	}
	if (selection.workspaceFileScheme === 'untitled') {
		return { kind: 'untitled-workspace' };
	}
	if (selection.roots.length === 0) {
		return { kind: 'no-root' };
	}
	if (selection.roots.length > 1) {
		return { kind: 'multiple-roots' };
	}
	const [root] = selection.roots;
	const local = root.scheme === 'file'
		&& root.fsPath.length > 0
		&& isPermittedRootV1FileAuthority(root, platform);
	return local ? { kind: 'eligible', rootPath: root.fsPath } : { kind: 'non-local-root' };
}

/** Performs the filesystem-free activation gate before resolving native assets. */
export function isWorkspaceSelectionEligibleForBridge(selection: IWorkspaceRootV1Selection, platform: NodeJS.Platform): boolean {
	return describeBridgeEligibility(selection, platform).kind === 'eligible';
}

export interface IDelverAgentBridgeRuntimeOptions {
	readonly extensionPath: string;
	readonly workspace: IWorkspaceRootSource;
	readonly gateway: IDelverAgentGateway;
	readonly approvalPrompt: IBootstrapApprovalPrompt;
	readonly platform?: NodeJS.Platform;
	readonly environment?: NodeJS.ProcessEnv;
	readonly homeDirectory?: string;
	readonly executable?: string;
	readonly registry?: IRendezvousRegistry;
	readonly spawnBootstrap?: (executable: string, endpoint: string) => IRelayProcess;
	readonly spawnPrivate?: (executable: string, endpoint: string) => IRelayProcess;
	readonly createBootstrapAttempt?: () => IBootstrapRelayAttempt;
	readonly createPrivateAttempt?: () => IBootstrapRelayAttempt;
	readonly createId?: () => string;
	readonly now?: () => number;
}

/** Composes the production rendezvous pieces without importing the VS Code API. */
export class DelverAgentBridgeRuntime {
	private readonly leases: DtpTokenLeaseStore;
	private readonly authorizer: InMemoryBootstrapAuthorizer;
	private readonly approvalController: BootstrapApprovalController;
	private readonly provisioner: DelverDtpRelayProvisioner;
	private readonly lifecycle: DelverWindowRendezvousLifecycle;
	private readonly workspaceController: DelverWorkspaceRendezvousController;
	private startPromise: Promise<void> | undefined;
	private disposePromise: Promise<void> | undefined;

	constructor(options: IDelverAgentBridgeRuntimeOptions) {
		const platform = options.platform ?? process.platform;
		const environment = options.environment ?? process.env;
		const executable = options.executable ?? resolveRelayExecutable(options.extensionPath, platform);
		const now = options.now ?? Date.now;
		const registry = options.registry ?? createFileRegistry(executable, platform, environment, options.homeDirectory);
		const createId = options.createId ?? randomUUID;
		this.leases = new DtpTokenLeaseStore({ now });
		this.authorizer = new InMemoryBootstrapAuthorizer({ now });
		this.approvalController = new BootstrapApprovalController(this.authorizer, options.approvalPrompt);
		this.provisioner = new DelverDtpRelayProvisioner({
			executable,
			leases: this.leases,
			gateway: options.gateway,
			spawn: options.spawnPrivate ?? spawnRelayProcess,
			createAttempt: options.createPrivateAttempt ?? (() => createBootstrapRelayAttempt(platform)),
			createEndpointGeneration: createId,
		});
		this.lifecycle = new DelverWindowRendezvousLifecycle({
			registry,
			leases: this.leases,
			approvalBusyGate: this.approvalController,
			createManager: context => this.createManager(context, {
				executable,
				platform,
				spawn: options.spawnBootstrap ?? spawnBootstrapRelayProcess,
				createAttempt: options.createBootstrapAttempt ?? (() => createBootstrapRelayAttempt(platform)),
			}),
			createWindowInstanceId: createId,
			createRegistryEntryId: createId,
			ownerProcessId: process.pid,
			now,
		});
		this.workspaceController = new DelverWorkspaceRendezvousController(
			options.workspace,
			registry,
			this.lifecycle,
			platform,
			now,
			() => this.provisioner.closeAll(),
		);
	}

	start(): Promise<void> {
		if (!this.startPromise) {
			this.startPromise = this.workspaceController.start();
		}
		return this.startPromise;
	}

	dispose(): Promise<void> {
		if (!this.disposePromise) {
			this.disposePromise = this.disposeCore();
		}
		return this.disposePromise;
	}

	private createManager(
		context: IRendezvousLifecycleManagerContext,
		relay: {
			readonly executable: string;
			readonly platform: NodeJS.Platform;
			readonly spawn: (executable: string, endpoint: string) => IRelayProcess;
			readonly createAttempt: () => IBootstrapRelayAttempt;
		},
	): DelverBootstrapRelayManager {
		return new DelverBootstrapRelayManager({
			executable: relay.executable,
			platform: relay.platform,
			spawn: relay.spawn,
			createAttempt: relay.createAttempt,
			publish: context.publish,
			createSession: (transport, peer) => new DelverBootstrapSession(transport, {
				expectedRegistryEntryId: context.registryEntryId,
				expectedWindowInstanceId: context.windowInstanceId,
				expectedRootFingerprint: context.rootFingerprint,
				peerIdentity: peer,
				authorize: (identity, claim, signal) => this.authorizer.authorize(identity, claim, signal),
				provisionDtp: (_claim, signal) => this.provisioner.provision(signal),
				leases: this.leases,
			}),
		});
	}

	private async disposeCore(): Promise<void> {
		await this.workspaceController.dispose();
		this.approvalController.dispose();
		this.authorizer.dispose();
		await this.provisioner.dispose();
		this.leases.dispose();
	}
}

/** Maps asynchronous workspace identity changes into serialized lifecycle epochs. */
export class DelverWorkspaceRendezvousController {
	private removeWorkspaceListener: () => void = () => { };
	private registryReadyPromise: Promise<void> | undefined;
	private refreshEpoch = 0;
	private started = false;
	private disposed = false;

	constructor(
		private readonly workspace: IWorkspaceRootSource,
		private readonly registry: IRendezvousRegistry,
		private readonly lifecycle: IWorkspaceRendezvousLifecycle,
		private readonly platform: NodeJS.Platform,
		private readonly now: () => number,
		private readonly beforeRootChange: () => Promise<void> = async () => { },
		private readonly computeFingerprint: (selection: IWorkspaceRootV1Selection, platform: NodeJS.Platform) => Promise<string> = (selection, platform) => computeWorkspaceRootFingerprintV1(selection, { platform }),
	) { }

	async start(): Promise<void> {
		if (this.disposed) {
			throw new Error('The Delver workspace rendezvous controller is disposed.');
		}
		if (this.started) {
			return;
		}
		this.started = true;
		this.lifecycle.start();
		this.removeWorkspaceListener = this.workspace.onDidChange(() => void this.refresh(false).catch(() => undefined));
		await this.refresh(true);
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			await this.lifecycle.whenDisposed();
			return;
		}
		this.disposed = true;
		this.refreshEpoch++;
		this.removeWorkspaceListener();
		this.removeWorkspaceListener = () => { };
		this.lifecycle.setRoot(undefined);
		const rootCleanup = this.beforeRootChange();
		this.lifecycle.dispose();
		await Promise.all([this.lifecycle.whenDisposed(), rootCleanup]);
	}

	private async refresh(propagateFailure: boolean): Promise<void> {
		const epoch = ++this.refreshEpoch;
		this.lifecycle.setRoot(undefined);
		const rootCleanup = this.beforeRootChange();
		let fingerprint: string;
		try {
			const fingerprintPromise = this.computeFingerprint(this.workspace.getSelection(), this.platform);
			[fingerprint] = await Promise.all([fingerprintPromise, rootCleanup]);
			await this.ensureRegistryReady();
		} catch (error) {
			await rootCleanup.catch(() => undefined);
			if (!this.disposed && epoch === this.refreshEpoch) {
				this.lifecycle.setRoot(undefined);
			}
			if (propagateFailure && !isUnsupportedWorkspace(error)) {
				throw error;
			}
			return;
		}
		if (!this.disposed && epoch === this.refreshEpoch) {
			this.lifecycle.setRoot(fingerprint);
		}
	}

	private ensureRegistryReady(): Promise<void> {
		return this.registryReadyPromise ??= this.registry.prune(this.now()).then(() => undefined);
	}
}

function createFileRegistry(executable: string, platform: NodeJS.Platform, environment: NodeJS.ProcessEnv, homeDirectory?: string): FileRendezvousRegistry {
	const directory = resolveRendezvousRegistryDirectory(platform, environment, homeDirectory);
	if (platform !== 'win32') {
		return new FileRendezvousRegistry({ directory, platform });
	}
	let preparation: Promise<void> | undefined;
	return new FileRendezvousRegistry({
		directory,
		platform,
		prepareDirectory: () => preparation ??= prepareWindowsRendezvousRegistryDirectory(executable, directory, { platform, environment }),
	});
}

function isUnsupportedWorkspace(error: unknown): boolean {
	return error instanceof RootFingerprintError;
}
