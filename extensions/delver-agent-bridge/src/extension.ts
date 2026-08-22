/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createModalBootstrapApprovalPrompt, IBootstrapApprovalPrompt } from './approvalUi';
import { describeMcpClientConfiguration, McpConfigurationAvailability } from './clientConfiguration';
import { IDelverAgentGateway } from './connection';
import { DelverAgentBridgeActivation, DelverAgentBridgeRuntime, IWorkspaceRootSource } from './productionBridge';

const CAPABILITIES_COMMAND = '_delver.agent.capabilities';
const INVOKE_COMMAND = '_delver.agent.invoke';
const COPY_CONFIGURATION_COMMAND = 'delver.agent.copyMcpConfiguration';
let activeBridge: DelverAgentBridgeActivation | undefined;

/** Creates the thin extension-host adapter to the canonical workbench gateway. */
export function createDelverCommandGateway(): IDelverAgentGateway {
	return {
		capabilities: () => Promise.resolve(vscode.commands.executeCommand(CAPABILITIES_COMMAND)),
		invoke: (requestId, request) => Promise.resolve(vscode.commands.executeCommand(INVOKE_COMMAND, {
			type: 'invoke',
			requestId,
			request,
		})),
		cancel: async requestId => {
			await vscode.commands.executeCommand(INVOKE_COMMAND, { type: 'cancel', requestId });
		},
	};
}

/** Creates the UI adapter without activating or publishing the bootstrap endpoint. */
export function createVscodeBootstrapApprovalPrompt(): IBootstrapApprovalPrompt {
	return createModalBootstrapApprovalPrompt(
		(message, options, ...items) => vscode.window.showWarningMessage(message, options, ...items),
		{
			message: vscode.l10n.t({
				message: 'Allow a local application to connect to this Delver window?',
				comment: 'Security prompt title for a one-time local Delver agent connection.',
			}),
			verifiedProcessAndUser: (platform, processId, userId) => vscode.l10n.t({
				message: 'Verified by the operating system: platform {0}, process ID {1}, user ID {2}.',
				args: [platform, processId, userId],
				comment: 'The platform, process ID, and user ID were obtained from the operating system, not supplied by the application.',
			}),
			verifiedProcess: (platform, processId) => vscode.l10n.t({
				message: 'Verified by the operating system: platform {0}, process ID {1}.',
				args: [platform, processId],
				comment: 'The platform and process ID were obtained from the operating system, not supplied by the application.',
			}),
			verifiedUser: (platform, userId) => vscode.l10n.t({
				message: 'Verified by the operating system: platform {0}, user ID {1}.',
				args: [platform, userId],
				comment: 'The platform and user ID were obtained from the operating system, not supplied by the application.',
			}),
			untrustedName: displayName => vscode.l10n.t({
				message: 'Application-provided name (not verified): {0}',
				args: [displayName],
				comment: 'The application supplied this display name itself. It is not an OS-attested identity.',
			}),
			access: vscode.l10n.t({
				message: 'Allow Once gives this connection access to this window\'s Delver agent tools. It may expose target-derived pseudocode, disassembly, strings, and metadata, and may perform supported navigation or actions. Approve only if you initiated this connection.',
				comment: 'Security scope shown before granting one-time access to local Delver agent tools.',
			}),
			allowOnce: vscode.l10n.t({ message: 'Allow Once', comment: 'Grants only the current local Delver agent connection.' }),
			deny: vscode.l10n.t({ message: 'Deny', comment: 'Rejects the current local Delver agent connection.' }),
		},
	);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	if (activeBridge) {
		return;
	}
	const workspace = createVscodeWorkspaceRootSource();
	context.subscriptions.push(vscode.commands.registerCommand(
		COPY_CONFIGURATION_COMMAND,
		() => copyMcpClientConfiguration(context.extensionPath, workspace),
	));
	const bridge = new DelverAgentBridgeActivation({
		workspace,
		createRuntime: () => new DelverAgentBridgeRuntime({
			extensionPath: context.extensionPath,
			workspace,
			gateway: createDelverCommandGateway(),
			approvalPrompt: createVscodeBootstrapApprovalPrompt(),
		}),
	});
	activeBridge = bridge;
	context.subscriptions.push({ dispose: () => void bridge.dispose() });
	try {
		await bridge.start();
	} catch {
		if (activeBridge === bridge) {
			activeBridge = undefined;
		}
		await bridge.dispose();
		throw new Error('The Delver agent bridge could not be started safely.');
	}
}

export async function deactivate(): Promise<void> {
	const bridge = activeBridge;
	activeBridge = undefined;
	await bridge?.dispose();
}

/** Copies this window's pasteable stdio MCP recipe, or explains the one reason it has none. */
async function copyMcpClientConfiguration(extensionPath: string, workspace: IWorkspaceRootSource): Promise<void> {
	const availability = describeMcpClientConfiguration({
		extensionPath,
		selection: workspace.getSelection(),
		displayName: vscode.env.appName,
	});
	if (availability.kind !== 'available') {
		await vscode.window.showWarningMessage(describeUnavailableConfiguration(availability));
		return;
	}
	await vscode.env.clipboard.writeText(availability.configuration);
	const show = vscode.l10n.t({ message: 'Show Configuration', comment: 'Opens the copied MCP configuration in an editor.' });
	const chosen = await vscode.window.showInformationMessage(
		vscode.l10n.t({
			message: 'Copied the Delver MCP configuration for {0}. Paste it into your agent client, then run a tool to approve the connection in this window.',
			args: [availability.rootPath],
			comment: 'Confirms the external agent configuration was copied. {0} is the absolute workspace root path.',
		}),
		show,
	);
	if (chosen === show) {
		const document = await vscode.workspace.openTextDocument({ language: 'json', content: availability.configuration });
		await vscode.window.showTextDocument(document, { preview: true });
	}
}

/** Maps each refusal to one localized sentence, so the reason is never guessed. */
function describeUnavailableConfiguration(availability: Exclude<McpConfigurationAvailability, { kind: 'available' }>): string {
	if (availability.kind === 'adapter-missing') {
		return vscode.l10n.t({
			message: 'The Delver MCP adapter is not built or staged with this build, so there is no configuration to copy.',
			comment: 'Shown when the delver-mcp executable cannot be found next to the application.',
		});
	}
	switch (availability.reason) {
		case 'unsupported-platform':
			return vscode.l10n.t({
				message: 'External agent access is available only on supported desktop platforms.',
				comment: 'Shown when the current operating system has no local agent transport.',
			});
		case 'untrusted-workspace':
			return vscode.l10n.t({
				message: 'Trust this workspace before giving an external agent access to it.',
				comment: 'Shown in Restricted Mode, where the agent bridge stays inert.',
			});
		case 'remote-workspace':
			return vscode.l10n.t({
				message: 'External agent access requires a local workspace, not a remote or virtual one.',
				comment: 'Shown when the window is connected to a remote or virtual file system.',
			});
		case 'untitled-workspace':
			return vscode.l10n.t({
				message: 'Save this workspace to a file before giving an external agent access to it.',
				comment: 'Shown for an untitled multi-root workspace, which has no stable identity.',
			});
		case 'no-root':
			return vscode.l10n.t({
				message: 'Open exactly one local folder before copying an external agent configuration.',
				comment: 'Shown when the window has no workspace folder open.',
			});
		case 'multiple-roots':
			return vscode.l10n.t({
				message: 'External agent access requires exactly one workspace folder, and this window has several.',
				comment: 'Shown when the window has more than one workspace folder, which makes routing ambiguous.',
			});
		default:
			return vscode.l10n.t({
				message: 'External agent access requires a local folder on this machine.',
				comment: 'Shown when the single workspace folder is not a local file-system directory.',
			});
	}
}

function createVscodeWorkspaceRootSource(): IWorkspaceRootSource {
	return {
		getSelection: () => ({
			roots: (vscode.workspace.workspaceFolders ?? []).map(folder => ({
				scheme: folder.uri.scheme,
				authority: folder.uri.authority,
				fsPath: folder.uri.fsPath,
			})),
			remoteName: vscode.env.remoteName,
			workspaceFileScheme: vscode.workspace.workspaceFile?.scheme,
			trusted: vscode.workspace.isTrusted,
		}),
		onDidChange: listener => {
			const workspaceFolders = vscode.workspace.onDidChangeWorkspaceFolders(listener);
			const workspaceTrust = vscode.workspace.onDidGrantWorkspaceTrust(listener);
			return () => {
				workspaceFolders.dispose();
				workspaceTrust.dispose();
			};
		},
	};
}
