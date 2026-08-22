/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { afterEach, describe, it } from 'node:test';
import { DelverDtpConnection, IDelverAgentGateway, IDtpConnectionTransport } from '../connection';
import { DtpErrorCode, DtpFrameDecoder, encodeDtpMessage, IDtpResponse } from '../protocol';

class TestGateway implements IDelverAgentGateway {
	readonly calls: { readonly method: string; readonly requestId?: string; readonly request?: Readonly<Record<string, unknown>> }[] = [];
	pendingInvoke: Promise<unknown> | undefined;
	invokeHandler: ((request: Readonly<Record<string, unknown>>) => Promise<unknown>) | undefined;

	async capabilities(): Promise<unknown> {
		this.calls.push({ method: 'capabilities' });
		return { schemaVersion: 1, ok: true, capability: 'delver_capabilities' };
	}

	async invoke(requestId: string, request: Readonly<Record<string, unknown>>): Promise<unknown> {
		this.calls.push({ method: 'invoke', requestId, request });
		if (this.invokeHandler) {
			return this.invokeHandler(request);
		}
		return this.pendingInvoke ?? { schemaVersion: 1, ok: true, capability: request.capability };
	}

	async cancel(requestId: string): Promise<void> {
		this.calls.push({ method: 'cancel', requestId });
	}
}

class TestTransport implements IDtpConnectionTransport {
	private readonly dataListeners = new Set<(data: Buffer) => void>();
	private readonly closeListeners = new Set<() => void>();
	private readonly responseWaiters: ((response: IDtpResponse) => void)[] = [];
	readonly writes: IDtpResponse[] = [];
	closed = false;

	onData(listener: (data: Buffer) => void): () => void {
		this.dataListeners.add(listener);
		return () => this.dataListeners.delete(listener);
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	write(data: Buffer): void {
		const decoder = new DtpFrameDecoder();
		const frames = decoder.push(data);
		const response = JSON.parse(frames[0].toString('utf8')) as IDtpResponse;
		this.writes.push(response);
		this.responseWaiters.shift()?.(response);
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const listener of [...this.closeListeners]) {
			listener();
		}
	}

	receive(message: Readonly<Record<string, unknown>>): void {
		const data = encodeDtpMessage(message);
		for (const listener of this.dataListeners) {
			listener(data);
		}
	}

	nextResponse(): Promise<IDtpResponse> {
		return new Promise(resolve => this.responseWaiters.push(resolve));
	}
}

describe('Delver DTP connection', () => {
	const connections: DelverDtpConnection[] = [];

	afterEach(() => {
		for (const connection of connections.splice(0)) {
			connection.dispose();
		}
	});

	it('requires authentication before gateway calls', async () => {
		const { transport, gateway } = createConnection(connections);
		const response = send(transport, { id: 1, method: 'agent/capabilities' });

		assert.deepStrictEqual(await response, {
			id: 1,
			error: {
				code: DtpErrorCode.NotInitialized,
				message: 'Authenticate this DTP connection with initialize first.',
			},
		});
		assert.deepStrictEqual(gateway.calls, []);
	});

	it('rejects invalid authentication and closes without gateway calls', async () => {
		const { transport, gateway } = createConnection(connections);
		const response = send(transport, initializeRequest('wrong-token'));

		assert.deepStrictEqual(await response, {
			id: 1,
			error: { code: DtpErrorCode.Unauthorized, message: 'The Delver session token is invalid.' },
		});
		assert.deepStrictEqual({ closed: transport.closed, calls: gateway.calls }, { closed: true, calls: [] });
	});

	it('delegates both methods and binds caller identity to the connection', async () => {
		const { transport, gateway } = createConnection(connections);
		await send(transport, initializeRequest('test-token'));
		const capabilities = send(transport, { id: 2, method: 'agent/capabilities' });
		const invoked = send(transport, {
			id: 3,
			method: 'agent/invoke',
			params: { capability: 'delver_lookup_function', args: { address: '0x1000' }, callerId: 'spoofed' },
		});

		const calls = gateway.calls.map(call => call.requestId
			? { ...call, requestId: call.requestId.replace(/^.+:/, 'connection:') }
			: call);
		assert.deepStrictEqual({ capabilities: await capabilities, invoked: await invoked, calls }, {
			capabilities: { id: 2, result: { schemaVersion: 1, ok: true, capability: 'delver_capabilities' } },
			invoked: { id: 3, result: { schemaVersion: 1, ok: true, capability: 'delver_lookup_function' } },
			calls: [
				{ method: 'capabilities' },
				{
					method: 'invoke',
					requestId: 'connection:3',
					request: { capability: 'delver_lookup_function', args: { address: '0x1000' }, callerId: 'dtp:reference-client' },
				},
			],
		});
	});

	it('rejects duplicate active ids and suppresses writes after disconnect', async () => {
		const { connection, transport, gateway } = createConnection(connections);
		await send(transport, initializeRequest('test-token'));
		let resolveInvoke: ((value: unknown) => void) | undefined;
		gateway.pendingInvoke = new Promise(resolve => resolveInvoke = resolve);

		transport.receive({ id: 2, method: 'agent/invoke', params: { capability: 'delver_focus' } });
		const duplicate = send(transport, { id: 2, method: 'agent/capabilities' });
		assert.deepStrictEqual(await duplicate, {
			id: 2,
			error: { code: DtpErrorCode.InvalidRequest, message: 'The DTP request id is already active.' },
		});

		const invokeRequestId = gateway.calls[0].requestId;
		const writesBeforeClose = transport.writes.length;
		connection.dispose();
		resolveInvoke?.({ schemaVersion: 1, ok: true });
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual({ closed: transport.closed, writes: transport.writes.length, calls: gateway.calls }, {
			closed: true,
			writes: writesBeforeClose,
			calls: [
				{ method: 'invoke', requestId: invokeRequestId, request: { capability: 'delver_focus', callerId: 'dtp:reference-client' } },
				{ method: 'cancel', requestId: invokeRequestId },
			],
		});
	});

	it('routes explicit cancellation to an active gateway invocation', async () => {
		const { transport, gateway } = createConnection(connections);
		await send(transport, initializeRequest('test-token'));
		let resolveInvoke: ((value: unknown) => void) | undefined;
		gateway.pendingInvoke = new Promise(resolve => resolveInvoke = resolve);
		transport.receive({ id: 2, method: 'agent/invoke', params: { capability: 'delver_focus' } });

		assert.deepStrictEqual(await send(transport, { id: 3, method: 'agent/cancel', params: { requestId: 2 } }), {
			id: 3,
			result: { cancelled: true },
		});
		assert.deepStrictEqual(gateway.calls.map(call => call.method), ['invoke', 'cancel']);
		resolveInvoke?.({ schemaVersion: 1, ok: false, error: { code: 'CANCELLED', message: 'Cancelled.' } });
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(transport.writes.at(-1), {
			id: 2,
			result: { schemaVersion: 1, ok: false, error: { code: 'CANCELLED', message: 'Cancelled.' } },
		});
	});

	it('correlates concurrent responses even when they complete out of order', async () => {
		const { transport, gateway } = createConnection(connections);
		await send(transport, initializeRequest('test-token'));
		const resolvers = new Map<string, (value: unknown) => void>();
		gateway.invokeHandler = request => new Promise(resolve => resolvers.set(String(request.capability), resolve));

		transport.receive({ id: 2, method: 'agent/invoke', params: { capability: 'first' } });
		transport.receive({ id: 3, method: 'agent/invoke', params: { capability: 'second' } });
		resolvers.get('second')?.({ capability: 'second' });
		await new Promise(resolve => setImmediate(resolve));
		resolvers.get('first')?.({ capability: 'first' });
		await new Promise(resolve => setImmediate(resolve));

		assert.deepStrictEqual(transport.writes.slice(1), [
			{ id: 3, result: { capability: 'second' } },
			{ id: 2, result: { capability: 'first' } },
		]);
	});

	it('enforces the per-connection concurrency limit', async () => {
		const { transport, gateway } = createConnection(connections, 1);
		await send(transport, initializeRequest('test-token'));
		gateway.pendingInvoke = new Promise(() => { });
		transport.receive({ id: 2, method: 'agent/invoke', params: { capability: 'delver_focus' } });

		assert.deepStrictEqual(await send(transport, { id: 3, method: 'agent/capabilities' }), {
			id: 3,
			error: { code: DtpErrorCode.InvalidRequest, message: 'The DTP connection has too many active requests.' },
		});
		assert.deepStrictEqual(await send(transport, { id: 4, method: 'agent/cancel', params: { requestId: 2 } }), {
			id: 4,
			result: { cancelled: true },
		});
	});
});

function createConnection(connections: DelverDtpConnection[], maxConcurrentRequests?: number): {
	readonly connection: DelverDtpConnection;
	readonly transport: TestTransport;
	readonly gateway: TestGateway;
} {
	const transport = new TestTransport();
	const gateway = new TestGateway();
	const connection = new DelverDtpConnection(transport, 'test-token', gateway, maxConcurrentRequests);
	connections.push(connection);
	return { connection, transport, gateway };
}

function initializeRequest(token: string): Readonly<Record<string, unknown>> {
	return {
		id: 1,
		method: 'initialize',
		params: { protocolVersion: 1, token, clientId: 'reference-client' },
	};
}

function send(transport: TestTransport, request: Readonly<Record<string, unknown>>): Promise<IDtpResponse> {
	const response = transport.nextResponse();
	transport.receive(request);
	return response;
}
