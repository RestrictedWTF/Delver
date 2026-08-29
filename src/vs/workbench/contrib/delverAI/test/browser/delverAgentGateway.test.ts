/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { DelverAgentCapabilityId, IDelverAgentService } from '../../../../services/delver/common/delverAgentService.js';
import { DelverAgentError, DelverAgentErrorCode, IDelverAgentRequest, IDelverAgentResult } from '../../../../services/delver/common/delverAgentTypes.js';
import {
	DELVER_AGENT_CAPABILITIES_COMMAND_ID,
	DELVER_AGENT_GATEWAY_SCHEMA_VERSION,
	DELVER_AGENT_INVOKE_COMMAND_ID,
	DelverAgentGatewayController,
	getDelverAgentGatewayCapabilities,
	IDelverAgentGatewayResponse,
	invokeDelverAgentGateway,
} from '../../browser/delverAgentGateway.contribution.js';

const RESULT: IDelverAgentResult = {
	schemaVersion: 1,
	callId: 'call-1',
	capability: DelverAgentCapabilityId.Capabilities,
	provenance: [{ source: 'session', detail: 'Static capability catalog; no analysis performed.' }],
	completeness: 'complete',
	data: { projectOpen: false },
};

class FakeAgentService implements IDelverAgentService {
	declare readonly _serviceBrand: undefined;
	readonly capabilities = [];
	readonly requests: IDelverAgentRequest[] = [];
	error: Error | undefined;

	async invoke(request: IDelverAgentRequest): Promise<IDelverAgentResult> {
		this.requests.push(request);
		if (this.error) {
			throw this.error;
		}
		return { ...RESULT, capability: request.capability };
	}
}

suite('Delver Agent Command Gateway', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('registers exactly the two private bridge entry points', () => {
		assert.deepStrictEqual({
			capabilities: CommandsRegistry.getCommand(DELVER_AGENT_CAPABILITIES_COMMAND_ID)?.id,
			invoke: CommandsRegistry.getCommand(DELVER_AGENT_INVOKE_COMMAND_ID)?.id,
		}, {
			capabilities: '_delver.agent.capabilities',
			invoke: '_delver.agent.invoke',
		});
	});

	test('delegates command calls to the canonical dispatcher', async () => {
		const agent = new FakeAgentService();
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IDelverAgentService, agent);

		const capabilities = await CommandsRegistry.getCommand(DELVER_AGENT_CAPABILITIES_COMMAND_ID)!.handler(instantiationService) as unknown as IDelverAgentGatewayResponse;
		const invoked = await CommandsRegistry.getCommand(DELVER_AGENT_INVOKE_COMMAND_ID)!.handler(instantiationService, {
			capability: DelverAgentCapabilityId.LookupFunction,
			args: { address: '0x1000' },
			callerId: 'mcp:test-client',
		}) as unknown as IDelverAgentGatewayResponse;

		assert.deepStrictEqual({
			capabilities: capabilities.ok && capabilities.result.capability,
			invoked: invoked.ok && invoked.result.capability,
			requests: agent.requests,
			jsonRoundTrip: JSON.parse(JSON.stringify(invoked)),
		}, {
			capabilities: DelverAgentCapabilityId.Capabilities,
			invoked: DelverAgentCapabilityId.LookupFunction,
			requests: [{
				capability: DelverAgentCapabilityId.Capabilities,
				args: {},
				caller: { kind: 'model', id: 'delver.agentBridge' },
			}, {
				capability: DelverAgentCapabilityId.LookupFunction,
				args: { address: '0x1000' },
				caller: { kind: 'model', id: 'mcp:test-client' },
			}],
			jsonRoundTrip: {
				schemaVersion: DELVER_AGENT_GATEWAY_SCHEMA_VERSION,
				ok: true,
				result: { ...RESULT, capability: DelverAgentCapabilityId.LookupFunction },
			},
		});
	});

	test('returns the canonical model-facing schemas with capability discovery', async () => {
		const agent = new FakeAgentService();

		const response = await getDelverAgentGatewayCapabilities(agent);

		assert.deepStrictEqual({
			ok: response.ok,
			capability: response.ok && response.result.capability,
			firstTool: response.tools?.[0],
			toolCount: response.tools?.length,
			// Not a count of tools against capabilities — the tool list is built
			// by mapping the capability list, so comparing their lengths is an
			// identity that cannot fail. What can fail is a capability with no
			// presentation entry: it still ships, but with a beaker icon, no
			// usage text and an empty input schema, so the model is handed a
			// tool it cannot call correctly.
			toolsTakingNoArguments: response.tools?.filter(tool =>
				Object.keys((tool.inputSchema as { properties?: object }).properties ?? {}).length === 0)
				.map(tool => tool.name),
			jsonRoundTrip: JSON.parse(JSON.stringify(response.tools?.[0])),
		}, {
			ok: true,
			capability: DelverAgentCapabilityId.Capabilities,
			firstTool: {
				name: DelverAgentCapabilityId.Capabilities,
				title: 'Delver Capabilities',
				description: 'Lists the analysis capabilities, output limits, and backend state available right now. Starts no analysis and opens no target. Call this first whenever you do not already know what is open. It is the only Delver tool that is useful with nothing open, and it deliberately starts no analysis, opens no target, and never starts a decompiler. Use `available` on each entry to decide what to call next, and `errorCodes` to interpret failures.',
				inputSchema: { type: 'object', properties: {} },
			},
			// A literal, deliberately: it is the assertion a new capability has to
			// walk past, and the previous `DELVER_AGENT_CAPABILITIES.length` was
			// an identity that could never fail, since the tool list is built by
			// mapping that same list.
			toolCount: 35,
			// Pinned rather than counted. A capability with no presentation entry
			// still ships — with a beaker icon, no usage text and an empty input
			// schema — so the model is handed a tool it cannot call correctly.
			// It would land in this list. The three below are deliberate: they
			// genuinely take no arguments.
			toolsTakingNoArguments: [
				DelverAgentCapabilityId.Capabilities,
				DelverAgentCapabilityId.SessionInfo,
				DelverAgentCapabilityId.ImageInfo,
			],
			jsonRoundTrip: {
				name: DelverAgentCapabilityId.Capabilities,
				title: 'Delver Capabilities',
				description: 'Lists the analysis capabilities, output limits, and backend state available right now. Starts no analysis and opens no target. Call this first whenever you do not already know what is open. It is the only Delver tool that is useful with nothing open, and it deliberately starts no analysis, opens no target, and never starts a decompiler. Use `available` on each entry to decide what to call next, and `errorCodes` to interpret failures.',
				inputSchema: { type: 'object', properties: {} },
			},
		});
	});

	test('returns stable dispatcher failures as JSON data', async () => {
		const agent = new FakeAgentService();
		agent.error = new DelverAgentError(DelverAgentErrorCode.TargetNotAttached, 'Locate the matching sample.', 'Expected SHA-256 abc.');

		const response = await invokeDelverAgentGateway(agent, {
			capability: DelverAgentCapabilityId.Disassemble,
			args: { address: '0x1000' },
		});

		assert.deepStrictEqual(response, {
			schemaVersion: DELVER_AGENT_GATEWAY_SCHEMA_VERSION,
			ok: false,
			error: {
				code: 'TARGET_NOT_ATTACHED',
				message: 'Locate the matching sample.',
				diagnostic: 'Expected SHA-256 abc.',
			},
		});
		assert.doesNotThrow(() => JSON.stringify(response));
	});

	test('rejects malformed or non-JSON requests before dispatch', async () => {
		const agent = new FakeAgentService();
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const requests: unknown[] = [
			undefined,
			{},
			{ capability: '' },
			{ capability: ' delver_focus' },
			{ capability: 'x'.repeat(129) },
			{ capability: 'delver_focus', args: [] },
			{ capability: 'delver_focus', args: { address: 0x1000n } },
			{ capability: 'delver_focus', args: { address: Number.POSITIVE_INFINITY } },
			{ capability: 'delver_focus', args: cyclic },
			{ capability: 'delver_focus', unexpected: true },
			{ capability: 'delver_focus', callerId: 'x'.repeat(257) },
		];

		const responses = await Promise.all(requests.map(request => invokeDelverAgentGateway(agent, request)));
		assert.deepStrictEqual({
			codes: responses.map(response => response.ok ? 'RESOLVED' : response.error.code),
			dispatchCalls: agent.requests.length,
			jsonSafe: responses.every(response => {
				JSON.stringify(response);
				return true;
			}),
		}, {
			codes: requests.map(() => 'INVALID_ARGUMENT'),
			dispatchCalls: 0,
			jsonSafe: true,
		});
	});

	test('passes cancellation into the dispatcher seam', async () => {
		let receivedToken: CancellationToken | undefined;
		const agent: Partial<IDelverAgentService> = {
			capabilities: [],
			invoke: async (_request, token) => {
				receivedToken = token;
				throw new DelverAgentError(DelverAgentErrorCode.Cancelled, 'Cancelled.');
			},
		};
		const token = CancellationToken.Cancelled;

		const response = await invokeDelverAgentGateway(agent as IDelverAgentService, { capability: DelverAgentCapabilityId.Capabilities }, token);

		assert.deepStrictEqual({
			receivedSameToken: receivedToken === token,
			code: response.ok ? 'RESOLVED' : response.error.code,
		}, {
			receivedSameToken: true,
			code: 'CANCELLED',
		});
	});

	test('multiplexes invocation cancellation through the existing invoke command', async () => {
		const controller = new DelverAgentGatewayController();
		let startedResolve: (() => void) | undefined;
		const started = new Promise<void>(resolve => startedResolve = resolve);
		const agent: Partial<IDelverAgentService> = {
			capabilities: [],
			invoke: async (_request, token) => {
				startedResolve?.();
				return new Promise((_resolve, reject) => {
					const listener = token.onCancellationRequested(() => {
						listener.dispose();
						reject(new DelverAgentError(DelverAgentErrorCode.Cancelled, 'Cancelled.'));
					});
				});
			},
		};

		const invocation = controller.execute(agent as IDelverAgentService, {
			type: 'invoke',
			requestId: 'connection-1:42',
			request: { capability: DelverAgentCapabilityId.Decompile, callerId: 'dtp:test' },
		});
		await started;
		const cancellation = await controller.execute(agent as IDelverAgentService, {
			type: 'cancel',
			requestId: 'connection-1:42',
		});
		const response = await invocation;
		const repeatedCancellation = await controller.execute(agent as IDelverAgentService, {
			type: 'cancel',
			requestId: 'connection-1:42',
		});

		assert.deepStrictEqual({ cancellation, response, repeatedCancellation }, {
			cancellation: {
				schemaVersion: DELVER_AGENT_GATEWAY_SCHEMA_VERSION,
				ok: true,
				cancelled: true,
			},
			response: {
				schemaVersion: DELVER_AGENT_GATEWAY_SCHEMA_VERSION,
				ok: false,
				error: { code: 'CANCELLED', message: 'Cancelled.' },
			},
			repeatedCancellation: {
				schemaVersion: DELVER_AGENT_GATEWAY_SCHEMA_VERSION,
				ok: true,
				cancelled: false,
			},
		});
	});

	test('rejects malformed multiplexed operations before dispatch', async () => {
		const agent = new FakeAgentService();
		const controller = new DelverAgentGatewayController();
		const responses = await Promise.all([
			controller.execute(agent, { type: 'invoke', requestId: '', request: { capability: 'delver_focus' } }),
			controller.execute(agent, { type: 'invoke', requestId: 'request-1' }),
			controller.execute(agent, { type: 'cancel', requestId: 'request-1', extra: true }),
			controller.execute(agent, { type: 'unknown', requestId: 'request-1' }),
		]);

		assert.deepStrictEqual({
			codes: responses.map(response => response.ok ? 'RESOLVED' : response.error.code),
			dispatchCalls: agent.requests.length,
		}, {
			codes: ['INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'INVALID_ARGUMENT'],
			dispatchCalls: 0,
		});
	});
});
