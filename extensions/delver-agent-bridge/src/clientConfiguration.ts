/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { BOOTSTRAP_DISPLAY_NAME_MAX_LENGTH, containsUnsafeDisplayCharacters } from './bootstrap';
import { BridgeEligibility, describeBridgeEligibility } from './productionBridge';
import { resolveStagedDelverExecutable } from './relayProcess';
import { IWorkspaceRootV1Selection } from './rootFingerprint';

/** The server key every published recipe uses, so a client shows one stable tool prefix. */
export const MCP_SERVER_NAME = 'delver';

export interface IMcpStdioServerEntry {
	readonly command: string;
	readonly args: readonly string[];
}

export interface IMcpClientConfiguration {
	readonly mcpServers: { readonly [name: string]: IMcpStdioServerEntry };
}

export interface IMcpClientConfigurationInput {
	/** Absolute path to the staged `delver-mcp` adapter. Never a bare command name. */
	readonly executable: string;
	/** Absolute path to the single local workspace root this window has open. */
	readonly rootPath: string;
	/** Untrusted label shown in this window's one-time approval prompt. */
	readonly displayName?: string;
	/** The key under `mcpServers`; defaults to {@link MCP_SERVER_NAME}. */
	readonly serverName?: string;
}

/**
 * Builds the client-neutral stdio MCP entry for one Delver window. The adapter is
 * always launched with an explicit absolute root, because a working-directory
 * fallback would let a client reach whichever window happened to start last.
 */
export function buildMcpClientConfiguration(input: IMcpClientConfigurationInput): IMcpClientConfiguration {
	if (!path.isAbsolute(input.executable)) {
		throw new Error('The Delver MCP adapter path must be absolute.');
	}
	if (!path.isAbsolute(input.rootPath)) {
		throw new Error('The Delver MCP workspace root must be absolute.');
	}
	const serverName = input.serverName ?? MCP_SERVER_NAME;
	if (serverName.length === 0 || containsUnsafeDisplayCharacters(serverName)) {
		throw new Error('The Delver MCP server name is invalid.');
	}
	const args = ['--root', input.rootPath];
	const displayName = input.displayName?.trim();
	if (displayName !== undefined && displayName.length > 0) {
		if (displayName.length > BOOTSTRAP_DISPLAY_NAME_MAX_LENGTH || containsUnsafeDisplayCharacters(displayName)) {
			throw new Error('The Delver MCP client display name is invalid.');
		}
		args.push('--display-name', displayName);
	}
	return { mcpServers: { [serverName]: { command: input.executable, args } } };
}

/** Serializes a recipe exactly as it should be pasted into a client's `.mcp.json`. */
export function serializeMcpClientConfiguration(input: IMcpClientConfigurationInput): string {
	return `${JSON.stringify(buildMcpClientConfiguration(input), undefined, 2)}\n`;
}

/** Resolves only the Delver-owned absolute MCP adapter, never a PATH fallback. */
export function resolveMcpAdapterExecutable(
	extensionPath: string,
	platform: NodeJS.Platform = process.platform,
	exists: (candidate: string) => boolean = fs.existsSync,
): string {
	return resolveStagedDelverExecutable(extensionPath, 'delver-mcp', 'MCP adapter', platform, exists);
}

export type McpConfigurationAvailability =
	| { readonly kind: 'available'; readonly configuration: string; readonly rootPath: string; readonly executable: string }
	| { readonly kind: 'adapter-missing' }
	| { readonly kind: 'ineligible'; readonly reason: Exclude<BridgeEligibility['kind'], 'eligible'> };

export interface IMcpConfigurationRequest {
	readonly extensionPath: string;
	readonly selection: IWorkspaceRootV1Selection;
	readonly displayName?: string;
	readonly platform?: NodeJS.Platform;
	readonly exists?: (candidate: string) => boolean;
}

/**
 * Produces the pasteable recipe for this window, or the one reason it cannot be
 * produced. It shares {@link describeBridgeEligibility} with activation so a
 * recipe is never offered for a window whose bridge stays inert.
 */
export function describeMcpClientConfiguration(request: IMcpConfigurationRequest): McpConfigurationAvailability {
	const platform = request.platform ?? process.platform;
	const eligibility = describeBridgeEligibility(request.selection, platform);
	if (eligibility.kind !== 'eligible') {
		return { kind: 'ineligible', reason: eligibility.kind };
	}
	let executable: string;
	try {
		executable = resolveMcpAdapterExecutable(request.extensionPath, platform, request.exists);
	} catch {
		return { kind: 'adapter-missing' };
	}
	return {
		kind: 'available',
		configuration: serializeMcpClientConfiguration({ executable, rootPath: eligibility.rootPath, displayName: request.displayName }),
		rootPath: eligibility.rootPath,
		executable,
	};
}
