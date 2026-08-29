/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Private extension-host gateway to the canonical Delver agent dispatcher.
 *
 * The built-in bridge extension reaches the renderer through VS Code's existing
 * command RPC. This file translates that boundary and nothing else: capability
 * behavior, session selection, limits, and provenance remain owned by
 * `IDelverAgentService`.
 */

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { IJSONSchema } from '../../../../base/common/jsonSchema.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { DelverAgentCapabilityId, IDelverAgentService } from '../../../services/delver/common/delverAgentService.js';
import {
	DELVER_AGENT_LIMITS,
	DelverAgentError,
	DelverAgentErrorCode,
	IDelverAgentRequest,
	IDelverAgentResult,
	serializedByteLength,
} from '../../../services/delver/common/delverAgentTypes.js';
import { getDelverAgentToolData } from './delverAIToolDefinitions.js';

export const DELVER_AGENT_CAPABILITIES_COMMAND_ID = '_delver.agent.capabilities';
export const DELVER_AGENT_INVOKE_COMMAND_ID = '_delver.agent.invoke';
export const DELVER_AGENT_GATEWAY_SCHEMA_VERSION = 1;

const DEFAULT_GATEWAY_CALLER_ID = 'delver.agentBridge';
const MAX_CAPABILITY_ID_LENGTH = 128;
const MAX_CALLER_ID_LENGTH = 256;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ACTIVE_GATEWAY_INVOCATIONS = 32;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_VALUES = 50_000;

export interface IDelverAgentGatewayRequest {
	readonly capability: string;
	readonly args?: Readonly<Record<string, unknown>>;
	readonly expectedProject?: IDelverAgentRequest['expectedProject'];
	/** Bounded connection/client label used for later proposal attribution. */
	readonly callerId?: string;
}

export interface IDelverAgentGatewayError {
	readonly code: string;
	readonly message: string;
	readonly diagnostic?: string;
}

export type IDelverAgentGatewayResponse = {
	readonly schemaVersion: typeof DELVER_AGENT_GATEWAY_SCHEMA_VERSION;
	readonly ok: true;
	readonly result: IDelverAgentResult;
} | {
	readonly schemaVersion: typeof DELVER_AGENT_GATEWAY_SCHEMA_VERSION;
	readonly ok: false;
	readonly error: IDelverAgentGatewayError;
};

export interface IDelverAgentGatewayCancellationResponse {
	readonly schemaVersion: typeof DELVER_AGENT_GATEWAY_SCHEMA_VERSION;
	readonly ok: true;
	readonly cancelled: boolean;
}

export type IDelverAgentGatewayCommandResponse = IDelverAgentGatewayResponse | IDelverAgentGatewayCancellationResponse;

/** JSON-safe model-facing tool metadata consumed by transport adapters. */
export interface IDelverAgentGatewayTool {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: IJSONSchema;
}

export type IDelverAgentGatewayCapabilitiesResponse = IDelverAgentGatewayResponse & {
	readonly tools?: readonly IDelverAgentGatewayTool[];
};

interface IDelverAgentGatewayInvokeOperation {
	readonly type: 'invoke';
	readonly requestId: string;
	readonly request: unknown;
}

interface IDelverAgentGatewayCancelOperation {
	readonly type: 'cancel';
	readonly requestId: string;
}

/**
 * Invokes the dispatcher through a strictly JSON-safe request/response seam.
 *
 * Errors are returned as data because throwing them through extension command
 * RPC would collapse the stable Delver code into an opaque remote exception.
 */
export async function invokeDelverAgentGateway(
	agentService: IDelverAgentService,
	request: unknown,
	token: CancellationToken = CancellationToken.None,
): Promise<IDelverAgentGatewayResponse> {
	try {
		const validated = validateGatewayRequest(request);
		const result = await agentService.invoke({
			capability: validated.capability,
			args: validated.args,
			...(validated.expectedProject === undefined ? {} : { expectedProject: validated.expectedProject }),
			caller: { kind: 'model', id: validated.callerId },
		}, token);
		return {
			schemaVersion: DELVER_AGENT_GATEWAY_SCHEMA_VERSION,
			ok: true,
			result,
		};
	} catch (error) {
		return gatewayErrorResponse(error);
	}
}

/** Multiplexes cancellable bridge invocations without adding a third command. */
export class DelverAgentGatewayController {
	private readonly activeInvocations = new Map<string, CancellationTokenSource>();

	async execute(agentService: IDelverAgentService, value: unknown): Promise<IDelverAgentGatewayCommandResponse> {
		if (!isPlainObject(value) || !Object.hasOwn(value, 'type')) {
			return invokeDelverAgentGateway(agentService, value);
		}

		try {
			const operation = validateGatewayOperation(value);
			if (operation.type === 'cancel') {
				const active = this.activeInvocations.get(operation.requestId);
				active?.cancel();
				return {
					schemaVersion: DELVER_AGENT_GATEWAY_SCHEMA_VERSION,
					ok: true,
					cancelled: active !== undefined,
				};
			}

			if (this.activeInvocations.has(operation.requestId)) {
				throw invalidArgument('The gateway request id is already active.');
			}
			if (this.activeInvocations.size >= MAX_ACTIVE_GATEWAY_INVOCATIONS) {
				throw invalidArgument('The gateway has too many active requests.');
			}
			const source = new CancellationTokenSource();
			this.activeInvocations.set(operation.requestId, source);
			try {
				return await invokeDelverAgentGateway(agentService, operation.request, source.token);
			} finally {
				this.activeInvocations.delete(operation.requestId);
				source.dispose();
			}
		} catch (error) {
			return gatewayErrorResponse(error);
		}
	}
}

function validateGatewayOperation(value: Record<string, unknown>): IDelverAgentGatewayInvokeOperation | IDelverAgentGatewayCancelOperation {
	const requestId = validateRequestId(value.requestId);
	if (value.type === 'cancel') {
		if (Object.keys(value).some(key => key !== 'type' && key !== 'requestId')) {
			throw invalidArgument('The gateway cancel operation contains unsupported fields.');
		}
		return { type: 'cancel', requestId };
	}
	if (value.type === 'invoke') {
		if (Object.keys(value).some(key => key !== 'type' && key !== 'requestId' && key !== 'request') || !Object.hasOwn(value, 'request')) {
			throw invalidArgument('The gateway invoke operation requires request and contains no other fields.');
		}
		return { type: 'invoke', requestId, request: value.request };
	}
	throw invalidArgument('The gateway operation type must be invoke or cancel.');
}

function validateRequestId(value: unknown): string {
	if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim() || value.length > MAX_REQUEST_ID_LENGTH) {
		throw invalidArgument(`requestId must be a non-empty string no longer than ${MAX_REQUEST_ID_LENGTH} characters.`);
	}
	return value;
}

interface IValidatedGatewayRequest {
	readonly capability: string;
	readonly args: Readonly<Record<string, unknown>>;
	readonly expectedProject?: IDelverAgentRequest['expectedProject'];
	readonly callerId: string;
}

function validateGatewayRequest(value: unknown): IValidatedGatewayRequest {
	if (!isPlainObject(value)) {
		throw invalidArgument('The gateway request must be a JSON object.');
	}
	const unknownKeys = Object.keys(value).filter(key => key !== 'capability' && key !== 'args' && key !== 'expectedProject' && key !== 'callerId');
	if (unknownKeys.length > 0) {
		throw invalidArgument('The gateway request contains unsupported fields.');
	}
	if (typeof value.capability !== 'string' || value.capability.trim().length === 0 || value.capability !== value.capability.trim() || value.capability.length > MAX_CAPABILITY_ID_LENGTH) {
		throw invalidArgument(`The gateway request requires a non-empty capability string no longer than ${MAX_CAPABILITY_ID_LENGTH} characters.`);
	}
	if (value.args !== undefined && !isPlainObject(value.args)) {
		throw invalidArgument('Gateway args must be a JSON object when supplied.');
	}
	const callerId = value.callerId ?? DEFAULT_GATEWAY_CALLER_ID;
	if (typeof callerId !== 'string' || callerId.trim().length === 0 || callerId.length > MAX_CALLER_ID_LENGTH) {
		throw invalidArgument(`callerId must be a non-empty string no longer than ${MAX_CALLER_ID_LENGTH} characters.`);
	}

	const args = value.args ?? {};
	const expectedProject = value.expectedProject === undefined ? undefined : validateExpectedProject(value.expectedProject);
	assertJsonSafe(args);
	if (serializedByteLength(args) > DELVER_AGENT_LIMITS.serializedBytes) {
		throw invalidArgument(`Gateway args exceed the ${DELVER_AGENT_LIMITS.serializedBytes} byte request limit.`);
	}
	return { capability: value.capability, args, expectedProject, callerId: callerId.trim() };
}

function validateExpectedProject(value: unknown): IDelverAgentRequest['expectedProject'] {
	if (value === null) {
		return null;
	}
	if (!isPlainObject(value) || Object.keys(value).some(key => key !== 'contentHash' && key !== 'revisionId')) {
		throw invalidArgument('expectedProject must be null or a project identity with no unsupported fields.');
	}
	if (typeof value.contentHash !== 'string' || !/^[0-9a-f]{64}$/i.test(value.contentHash)) {
		throw invalidArgument('expectedProject.contentHash must be a SHA-256 hex digest.');
	}
	if (value.revisionId !== undefined && (typeof value.revisionId !== 'string' || value.revisionId.length === 0 || value.revisionId.length > 256)) {
		throw invalidArgument('expectedProject.revisionId must be a non-empty string no longer than 256 characters.');
	}
	return {
		contentHash: value.contentHash.toLowerCase(),
		...(value.revisionId === undefined ? {} : { revisionId: value.revisionId }),
	};
}

function assertJsonSafe(value: unknown): void {
	const ancestors = new Set<object>();
	let values = 0;

	const visit = (current: unknown, depth: number): void => {
		values++;
		if (values > MAX_JSON_VALUES || depth > MAX_JSON_DEPTH) {
			throw invalidArgument('Gateway args exceed the JSON structure limit.');
		}
		if (current === null || typeof current === 'string' || typeof current === 'boolean') {
			return;
		}
		if (typeof current === 'number') {
			if (!Number.isFinite(current)) {
				throw invalidArgument('Gateway args contain a non-finite number.');
			}
			return;
		}
		if (typeof current !== 'object') {
			throw invalidArgument(`Gateway args contain a non-JSON ${typeof current} value.`);
		}
		if (!Array.isArray(current) && !isPlainObject(current)) {
			throw invalidArgument('Gateway args contain a non-JSON object.');
		}
		if (ancestors.has(current)) {
			throw invalidArgument('Gateway args contain a cyclic value.');
		}
		ancestors.add(current);
		for (const child of Array.isArray(current) ? current : Object.values(current)) {
			visit(child, depth + 1);
		}
		ancestors.delete(current);
	};

	visit(value, 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function invalidArgument(message: string): DelverAgentError {
	return new DelverAgentError(DelverAgentErrorCode.InvalidArgument, message);
}

function gatewayErrorResponse(error: unknown): IDelverAgentGatewayResponse {
	const agentError = error instanceof DelverAgentError
		? error
		: new DelverAgentError(
			DelverAgentErrorCode.InternalError,
			'Delver could not complete the gateway request.',
			error instanceof Error ? error.message : String(error),
		);
	return {
		schemaVersion: DELVER_AGENT_GATEWAY_SCHEMA_VERSION,
		ok: false,
		error: {
			code: agentError.code,
			message: agentError.message,
			...(agentError.diagnostic === undefined ? {} : { diagnostic: agentError.diagnostic }),
		},
	};
}

const gatewayController = new DelverAgentGatewayController();

/** Returns runtime capability state together with the canonical model-facing schemas. */
export async function getDelverAgentGatewayCapabilities(agentService: IDelverAgentService): Promise<IDelverAgentGatewayCapabilitiesResponse> {
	const response = await invokeDelverAgentGateway(agentService, {
		capability: DelverAgentCapabilityId.Capabilities,
	});
	if (!response.ok) {
		return response;
	}
	return {
		...response,
		tools: getDelverAgentToolData().map(tool => ({
			name: tool.id,
			title: tool.displayName,
			description: tool.modelDescription,
			inputSchema: tool.inputSchema ?? { type: 'object' },
		})),
	};
}

CommandsRegistry.registerCommand({
	id: DELVER_AGENT_CAPABILITIES_COMMAND_ID,
	handler: accessor => getDelverAgentGatewayCapabilities(accessor.get(IDelverAgentService)),
	metadata: {
		description: 'Returns the JSON-safe Delver agent capability envelope for the built-in bridge extension.',
		returns: 'A versioned IDelverAgentGatewayResponse.',
	},
});

CommandsRegistry.registerCommand({
	id: DELVER_AGENT_INVOKE_COMMAND_ID,
	handler: (accessor, request: unknown) => gatewayController.execute(accessor.get(IDelverAgentService), request),
	metadata: {
		description: 'Invokes or cancels one JSON-safe Delver agent capability for the built-in bridge extension.',
		args: [{
			name: 'request',
			description: 'A legacy capability request or a bounded invoke/cancel operation envelope.',
			schema: {
				type: 'object',
			},
		}],
		returns: 'A versioned invocation or cancellation response. Structured Delver failures are returned as data.',
	},
});
