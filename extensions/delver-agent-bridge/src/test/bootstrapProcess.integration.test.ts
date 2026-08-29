/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { describe, it } from 'node:test';
import { InMemoryBootstrapAuthorizer, IBootstrapAuthorizationRequest } from '../authorization';
import { DelverBootstrapSession, IBootstrapTransport } from '../bootstrap';
import { DelverBootstrapRelayManager, IBootstrapRelayPublicationEntry } from '../bootstrapRelayManager';
import { IDelverAgentGateway } from '../connection';
import { DelverDtpRelayProvision, DelverDtpRelayProvisioner } from '../dtpProvision';
import { DtpFrameDecoder, encodeDtpMessage, IDtpResponse } from '../protocol';
import {
	createBootstrapRelayAttempt,
	IRelayProcess,
	resolveRelayExecutable,
	spawnBootstrapRelayProcess,
	spawnRelayProcess,
} from '../relayProcess';
import { DtpTokenLeaseStore } from '../tokenLease';

const REQUEST_TIMEOUT_MS = 5_000;
const ROOT_FINGERPRINT = 'a'.repeat(64);
const CLAIM = {
	protocolVersion: 1,
	registryEntryId: 'integration-registry',
	windowInstanceId: 'integration-window',
	rootFingerprint: ROOT_FINGERPRINT,
	clientNonce: 'integration_nonce_1234',
	displayName: 'Integration MCP',
} as const;

const extensionPath = path.resolve(__dirname, '..', '..');
const requireRelay = process.env.DELVER_REQUIRE_RELAY_INTEGRATION === '1';
let relayExecutable: string | undefined;
try {
	relayExecutable = resolveRelayExecutable(extensionPath);
} catch {
	// Contributors may run bridge tests without first compiling the Rust workspace.
}

describe('Bootstrap to private DTP process integration', () => {
	it('authorizes one real bootstrap client and cancels a real private DTP connection', {
		skip: !relayExecutable && !requireRelay,
		timeout: 20_000,
	}, async () => {
		assert.ok(relayExecutable, 'DELVER_REQUIRE_RELAY_INTEGRATION requires a staged relay executable.');
		const executable = relayExecutable;
		const trackedProcesses: TrackedRelayProcess[] = [];
		const leases = new DtpTokenLeaseStore();
		const authorizer = new InMemoryBootstrapAuthorizer();
		const gateway = new IntegrationGateway();
		const provisioner = new DelverDtpRelayProvisioner({
			executable,
			leases,
			gateway,
			spawn: (binary, endpoint) => trackProcess(spawnRelayProcess(binary, endpoint), trackedProcesses),
		});
		const authorizationRequests: IBootstrapAuthorizationRequest[] = [];
		const publications: IBootstrapRelayPublicationEntry[] = [];
		const stages: string[] = [];
		let unpublishCount = 0;
		let grantAccepted = false;
		let privateProvision: DelverDtpRelayProvision | undefined;
		let bootstrapClient: FramedSocketClient | undefined;
		let dtpClient: FramedSocketClient | undefined;
		const removeAuthorizationListener = authorizer.onDidRequest(request => {
			stages.push('authorization-requested');
			authorizationRequests.push(request);
			grantAccepted = authorizer.grantOnce(request.authorizationRequestId);
		});

		const manager = new DelverBootstrapRelayManager({
			executable,
			spawn: (binary, endpoint) => trackProcess(spawnBootstrapRelayProcess(binary, endpoint), trackedProcesses),
			createAttempt: () => createBootstrapRelayAttempt(),
			publish: entry => {
				stages.push('published');
				publications.push(entry);
				return { dispose: async () => { unpublishCount++; } };
			},
			createSession: (transport, peer) => {
				stages.push(`session-created:${JSON.stringify(peer)}`);
				transport.onData(() => stages.push('claim-data-received'));
				const observedTransport: IBootstrapTransport = {
					onData: listener => transport.onData(listener),
					onClose: listener => transport.onClose(listener),
					write: async data => {
						const frame = new DtpFrameDecoder().push(data)[0];
						const response = JSON.parse(frame.toString('utf8')) as IDtpResponse;
						stages.push(isResult(response) ? 'bootstrap-write:result' : `bootstrap-write:error:${response.error.code}`);
						await transport.write(data);
					},
					close: () => {
						stages.push('bootstrap-transport-closed');
						transport.close();
					},
				};
				return new DelverBootstrapSession(observedTransport, {
				expectedRegistryEntryId: CLAIM.registryEntryId,
				expectedWindowInstanceId: CLAIM.windowInstanceId,
				expectedRootFingerprint: CLAIM.rootFingerprint,
				peerIdentity: peer,
				authorize: (identity, claim, signal) => authorizer.authorize(identity, claim, signal),
				provisionDtp: async (_claim, signal) => {
					stages.push('provision-started');
					const provision = await provisioner.provision(signal);
					stages.push('provision-ready');
					privateProvision = provision;
					return provision;
				},
				leases,
				});
			},
		});

		try {
			await manager.start();
			assert.strictEqual(publications.length, 1);
			await assertPrivateUnixEndpoint(publications[0].endpoint);

			bootstrapClient = await FramedSocketClient.connect(publications[0].endpoint);
			stages.push('bootstrap-connected');
			let bootstrapResponse: IDtpResponse;
			try {
				bootstrapResponse = await bootstrapClient.request(1, 'bootstrap/claim', CLAIM);
			} catch (error) {
				throw new Error(`Bootstrap credential failed after ${stages.join(', ')} with ${bootstrapClient.receivedBytes} response bytes and relay exits ${trackedProcesses.map(process => process.exited).join(',')}: ${error instanceof Error ? error.message : 'unknown error'}`);
			}
			stages.push('credential-received');
			const credential = bootstrapCredential(bootstrapResponse);
			assert.ok(privateProvision);
			await assertPrivateUnixEndpoint(credential.endpoint);

			assert.deepStrictEqual({
				publication: publications,
				publicationContainsSecret: JSON.stringify(publications).includes(credential.token) || JSON.stringify(publications).includes(CLAIM.clientNonce),
				unpublishCount,
				grantAccepted,
				authorization: authorizationRequests.map(request => ({
					peer: request.peer,
					untrustedDisplayName: request.untrustedDisplayName,
				})),
				privateEndpointDiffers: credential.endpoint !== publications[0].endpoint,
				tokenBytes: Buffer.from(credential.token, 'base64url').length,
			}, {
				publication: [{ endpoint: publications[0].endpoint, expiresAt: publications[0].expiresAt }],
				publicationContainsSecret: false,
				unpublishCount: 1,
				grantAccepted: true,
				authorization: [{
					peer: expectedPeerIdentity(authorizationRequests[0].peer),
					untrustedDisplayName: 'Integration MCP',
				}],
				privateEndpointDiffers: true,
				tokenBytes: 32,
			});

			dtpClient = await FramedSocketClient.connect(credential.endpoint);
			const initialized = await dtpClient.request(1, 'initialize', {
				protocolVersion: 1,
				token: credential.token,
				clientId: 'integration-client',
			});
			assert.strictEqual(isResult(initialized), true);
			assert.strictEqual(leases.consume(credential.token, privateProvision.endpointGeneration), false);

			const capabilities = await dtpClient.request(2, 'agent/capabilities', {});
			assert.deepStrictEqual(capabilities, { id: 2, result: { capabilities: ['integration'] } });

			const invokeResponse = dtpClient.request(3, 'agent/invoke', { capability: 'session.info', arguments: {} });
			const rejectedInvoke = assert.rejects(invokeResponse, /closed/);
			await gateway.whenInvoked();
			dtpClient.destroy();
			dtpClient = undefined;
			await gateway.whenCancelled();
			gateway.completeInvoke();
			await rejectedInvoke;
			await privateProvision.whenClosed();
			await manager.whenClosed();
			await Promise.all(trackedProcesses.map(process => process.whenExited()));

			assert.deepStrictEqual({
				callerId: gateway.invocations[0]?.request.callerId,
				cancelledSameRequest: gateway.cancellations[0] === gateway.invocations[0]?.requestId,
				gatewayContainsToken: JSON.stringify({ invocations: gateway.invocations, cancellations: gateway.cancellations }).includes(credential.token),
				processesExited: trackedProcesses.map(process => process.exited),
			}, {
				callerId: 'dtp:integration-client',
				cancelledSameRequest: true,
				gatewayContainsToken: false,
				processesExited: [true, true],
			});

			await assert.rejects(FramedSocketClient.connect(publications[0].endpoint), /connect|pipe|socket|refused|not found/i);
		} finally {
			bootstrapClient?.destroy();
			dtpClient?.destroy();
			privateProvision?.dispose();
			manager.dispose();
			removeAuthorizationListener();
			authorizer.dispose();
			await provisioner.dispose();
			leases.dispose();
			for (const process of trackedProcesses) {
				process.terminate();
			}
			await Promise.all(trackedProcesses.map(process => process.whenExited().catch(() => undefined)));
			await manager.whenClosed();
		}
	});
});

class IntegrationGateway implements IDelverAgentGateway {
	readonly invocations: { readonly requestId: string; readonly request: Readonly<Record<string, unknown>> }[] = [];
	readonly cancellations: string[] = [];
	private readonly invokedPromise: Promise<void>;
	private resolveInvoked!: () => void;
	private readonly cancelledPromise: Promise<void>;
	private resolveCancelled!: () => void;
	private readonly invokePromise: Promise<unknown>;
	private resolveInvoke!: (value: unknown) => void;

	constructor() {
		this.invokedPromise = new Promise(resolve => this.resolveInvoked = resolve);
		this.cancelledPromise = new Promise(resolve => this.resolveCancelled = resolve);
		this.invokePromise = new Promise(resolve => this.resolveInvoke = resolve);
	}

	async capabilities(): Promise<unknown> {
		return { capabilities: ['integration'] };
	}

	invoke(requestId: string, request: Readonly<Record<string, unknown>>): Promise<unknown> {
		this.invocations.push({ requestId, request });
		this.resolveInvoked();
		return this.invokePromise;
	}

	async cancel(requestId: string): Promise<void> {
		this.cancellations.push(requestId);
		this.resolveCancelled();
	}

	whenInvoked(): Promise<void> {
		return withTimeout(this.invokedPromise, 'The DTP invocation did not reach the gateway.');
	}

	whenCancelled(): Promise<void> {
		return withTimeout(this.cancelledPromise, 'The disconnected DTP invocation was not cancelled.');
	}

	completeInvoke(): void {
		this.resolveInvoke({ completed: true });
	}
}

class TrackedRelayProcess implements IRelayProcess {
	private readonly exitedPromise: Promise<void>;
	private resolveExited!: () => void;
	exited = false;

	constructor(private readonly delegate: IRelayProcess) {
		this.exitedPromise = new Promise(resolve => this.resolveExited = resolve);
		delegate.onExit(() => {
			this.exited = true;
			this.resolveExited();
		});
	}

	write(data: Buffer, callback: (error?: Error | null) => void): boolean { return this.delegate.write(data, callback); }
	onDrain(listener: () => void): () => void { return this.delegate.onDrain(listener); }
	endInput(): void { this.delegate.endInput(); }
	onStdout(listener: (data: Buffer) => void): () => void { return this.delegate.onStdout(listener); }
	onStderr(listener: (data: Buffer) => void): () => void { return this.delegate.onStderr(listener); }
	onExit(listener: (code: number | null) => void): () => void { return this.delegate.onExit(listener); }
	onError(listener: (error: Error) => void): () => void { return this.delegate.onError(listener); }
	terminate(force = false): void { this.delegate.terminate(force); }

	whenExited(): Promise<void> {
		return withTimeout(this.exitedPromise, 'A Delver relay process did not exit.');
	}
}

class FramedSocketClient {
	private readonly decoder = new DtpFrameDecoder();
	private readonly pending = new Map<number, { readonly resolve: (response: IDtpResponse) => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout }>();
	private closed = false;
	receivedBytes = 0;

	private constructor(private readonly socket: net.Socket) {
		socket.on('data', data => this.receive(data));
		socket.on('error', error => this.finish(error));
		socket.on('close', () => this.finish(new Error('The local Delver socket closed.')));
	}

	static async connect(endpoint: string): Promise<FramedSocketClient> {
		const socket = net.createConnection(endpointPath(endpoint));
		await withTimeout(new Promise<void>((resolve, reject) => {
			const handleConnect = () => {
				socket.removeListener('error', handleError);
				resolve();
			};
			const handleError = (error: Error) => {
				socket.removeListener('connect', handleConnect);
				reject(error);
			};
			socket.once('connect', handleConnect);
			socket.once('error', handleError);
		}), `Could not connect to the Delver endpoint ${endpoint}.`);
		return new FramedSocketClient(socket);
	}

	request(id: number, method: string, params: Readonly<Record<string, unknown>>): Promise<IDtpResponse> {
		if (this.closed || this.pending.has(id)) {
			return Promise.reject(new Error('The local Delver socket is closed or the request id is active.'));
		}
		const response = new Promise<IDtpResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for Delver response ${id}.`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
		});
		this.socket.write(encodeDtpMessage({ id, method, params }), error => {
			if (error) {
				this.reject(id, error);
			}
		});
		return response;
	}

	destroy(): void {
		this.socket.destroy();
	}

	private receive(data: Buffer): void {
		this.receivedBytes += data.length;
		let frames: readonly Buffer[];
		try {
			frames = this.decoder.push(data);
		} catch (error) {
			this.finish(error instanceof Error ? error : new Error('The local Delver response was malformed.'));
			return;
		}
		for (const frame of frames) {
			const response = JSON.parse(frame.toString('utf8')) as IDtpResponse;
			if (typeof response.id !== 'number') {
				this.finish(new Error('The local Delver response id is invalid.'));
				return;
			}
			const pending = this.pending.get(response.id);
			if (!pending) {
				this.finish(new Error('The local Delver response id is unexpected.'));
				return;
			}
			this.pending.delete(response.id);
			clearTimeout(pending.timer);
			pending.resolve(response);
		}
	}

	private reject(id: number, error: Error): void {
		const pending = this.pending.get(id);
		if (!pending) {
			return;
		}
		this.pending.delete(id);
		clearTimeout(pending.timer);
		pending.reject(error);
	}

	private finish(error: Error): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const [id] of this.pending) {
			this.reject(id, error);
		}
	}
}

function trackProcess(process: IRelayProcess, tracked: TrackedRelayProcess[]): TrackedRelayProcess {
	const result = new TrackedRelayProcess(process);
	tracked.push(result);
	return result;
}

function endpointPath(endpoint: string): string {
	if (endpoint.startsWith('pipe://')) {
		return `\\\\.\\pipe\\${endpoint.slice('pipe://'.length)}`;
	}
	if (endpoint.startsWith('unix://')) {
		return endpoint.slice('unix://'.length);
	}
	throw new Error('The Delver endpoint scheme is unsupported.');
}

function bootstrapCredential(response: IDtpResponse): {
	readonly endpoint: string;
	readonly leaseId: string;
	readonly token: string;
	readonly expiresAt: number;
} {
	assert.ok(isResult(response) && isRecord(response.result), 'Expected a bootstrap credential response.');
	const result = response.result;
	assert.strictEqual(result.protocolVersion, 1);
	assert.strictEqual(typeof result.endpoint, 'string');
	assert.strictEqual(typeof result.leaseId, 'string');
	assert.strictEqual(typeof result.token, 'string');
	assert.strictEqual(typeof result.expiresAt, 'number');
	return result as {
		readonly endpoint: string;
		readonly leaseId: string;
		readonly token: string;
		readonly expiresAt: number;
	};
}

function isResult(response: IDtpResponse): response is Extract<IDtpResponse, { readonly result: unknown }> {
	return Object.prototype.hasOwnProperty.call(response, 'result');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectedPeerIdentity(peer: IBootstrapAuthorizationRequest['peer']): IBootstrapAuthorizationRequest['peer'] {
	if (process.platform === 'win32') {
		assert.strictEqual(peer.processId, process.pid);
		return { platform: 'win32', processId: process.pid };
	}
	const effectiveUserId = typeof process.geteuid === 'function' ? process.geteuid() : undefined;
	assert.strictEqual(peer.userId, effectiveUserId);
	if (process.platform === 'linux' || process.platform === 'android') {
		assert.strictEqual(peer.processId, process.pid);
		return { platform: process.platform, processId: process.pid, userId: effectiveUserId };
	}
	return { platform: process.platform, userId: effectiveUserId };
}

async function assertPrivateUnixEndpoint(endpoint: string): Promise<void> {
	if (!endpoint.startsWith('unix://')) {
		return;
	}
	const socketPath = endpointPath(endpoint);
	const [socket, directory] = await Promise.all([fs.promises.stat(socketPath), fs.promises.stat(path.dirname(socketPath))]);
	assert.deepStrictEqual({
		socketMode: socket.mode & 0o777,
		directoryMode: directory.mode & 0o777,
		directoryUserId: directory.uid,
	}, {
		socketMode: 0o600,
		directoryMode: 0o700,
		directoryUserId: typeof process.geteuid === 'function' ? process.geteuid() : directory.uid,
	});
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), REQUEST_TIMEOUT_MS);
		void promise.then(value => {
			clearTimeout(timer);
			resolve(value);
		}, error => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
