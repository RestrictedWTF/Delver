/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { Disposable } from '../../../base/common/lifecycle.js';
import { resolveBinary } from './delverBinaries.js';
import { DelverRpcClient } from './rpc.js';
import {
	IAddressForRowResult,
	IFunctionsResult,
	IGetExportsResult,
	IGetImageInfoResult,
	IGetImportsResult,
	IListingWindowResult,
	IOpenImageResult,
	IRowForAddressResult,
	IStringsResult,
	IXrefsResult,
} from '../common/protocol.generated.js';
import { TargetConfig } from '../common/target.js';

/**
 * Owns the two processes that make up an analysis session.
 *
 * A provider serves bytes; the analysis server interprets them. Per P1 decision
 * E1 the analysis server reads through the provider rather than opening the
 * file itself, so the workbench has to start both and hand the provider's
 * endpoint to the analysis server.
 *
 * Both are children of this process, but they talk to each other directly —
 * bulk image data never crosses the workbench.
 */
export class DelverAnalysisSession extends Disposable {
	private constructor(
		private readonly provider: ChildProcess,
		private readonly analysis: ChildProcess,
		private readonly rpc: DelverRpcClient,
		private readonly providerRpc: DelverRpcClient,
		readonly targetPath: string,
		readonly image: IOpenImageResult,
	) {
		super();
		this._register({ dispose: () => this.shutdown() });
	}

	/**
	 * Starts a provider and an analysis server, then opens the image.
	 */
	static async start(config: TargetConfig): Promise<DelverAnalysisSession> {
		if (config.kind !== 'file') {
			throw new Error(`Unsupported target kind for analysis: ${config.kind}`);
		}

		const providerEndpoint = localEndpoint('provider');
		const analysisEndpoint = localEndpoint('analysis');

		const provider = spawn(
			resolveBinary('provider-file'),
			['--listen', providerEndpoint, config.path],
			{ stdio: ['ignore', 'ignore', 'pipe'] },
		);
		logStderr(provider, 'provider-file');

		let analysis: ChildProcess | undefined;
		try {
			await waitForListening(provider, 'provider-file');

			analysis = spawn(
				resolveBinary('server-analysis'),
				['--provider', providerEndpoint, '--listen', analysisEndpoint],
				{ stdio: ['ignore', 'ignore', 'pipe'] },
			);
			logStderr(analysis, 'server-analysis');
			await waitForListening(analysis, 'server-analysis');

			const rpc = await DelverRpcClient.connect(analysisEndpoint);
			await rpc.call('initialize', null);
			const { json } = await rpc.call('analysis/openImage', null);

			// A second client on the provider, alongside the analysis server's.
			// Headers are a provider capability, not a derived fact — asking the
			// analysis server to proxy them would put a parsing concern in the
			// wrong process. Providers accept multiple clients precisely so this
			// works (P1 decision E1).
			const providerRpc = await DelverRpcClient.connect(providerEndpoint);
			await providerRpc.call('initialize', null);

			return new DelverAnalysisSession(
				provider,
				analysis,
				rpc,
				providerRpc,
				config.path,
				json.result as IOpenImageResult,
			);
		} catch (e) {
			analysis?.kill();
			provider.kill();
			throw e;
		}
	}

	/**
	 * Fetches a window of listing rows.
	 */
	async listingWindow(startRow: number, count: number): Promise<IListingWindowResult> {
		const { json } = await this.rpc.call('analysis/listingWindow', {
			image_id: this.image.image_id,
			start_row: startRow,
			count,
		});
		return json.result as IListingWindowResult;
	}

	/**
	 * Maps an address to a listing row.
	 *
	 * `containing` asks for the row covering an arbitrary address rather than
	 * requiring an exact instruction boundary — what a scroll position needs.
	 */
	async rowForAddress(rva: bigint, containing = true): Promise<number | undefined> {
		const { json } = await this.rpc.call('analysis/rowForAddress', {
			image_id: this.image.image_id,
			rva: `0x${rva.toString(16).toUpperCase()}`,
			containing,
		});
		return (json.result as IRowForAddressResult).row;
	}

	/**
	 * Maps a listing row to its address.
	 */
	async addressForRow(row: number): Promise<bigint | undefined> {
		const { json } = await this.rpc.call('analysis/addressForRow', {
			image_id: this.image.image_id,
			row,
		});
		const rva = (json.result as IAddressForRowResult).rva;
		return rva === undefined ? undefined : BigInt(rva);
	}

	/**
	 * Image headers, read from the provider rather than the analysis server.
	 */
	async getImageInfo(): Promise<IGetImageInfoResult> {
		const { json } = await this.providerRpc.call('getImageInfo', null);
		return json.result as IGetImageInfoResult;
	}

	/**
	 * Imported modules and symbols, read from the provider.
	 */
	async getImports(): Promise<IGetImportsResult> {
		const { json } = await this.providerRpc.call('getImports', null);
		return json.result as IGetImportsResult;
	}

	/**
	 * Exported symbols, read from the provider.
	 */
	async getExports(): Promise<IGetExportsResult> {
		const { json } = await this.providerRpc.call('getExports', null);
		return json.result as IGetExportsResult;
	}

	async functions(): Promise<IFunctionsResult> {
		const { json } = await this.rpc.call('analysis/functions', {
			image_id: this.image.image_id,
		});
		return json.result as IFunctionsResult;
	}

	async strings(): Promise<IStringsResult> {
		const { json } = await this.rpc.call('analysis/strings', {
			image_id: this.image.image_id,
		});
		return json.result as IStringsResult;
	}

	async xrefsTo(rva: bigint): Promise<IXrefsResult> {
		return this.xrefs('analysis/xrefsTo', rva);
	}

	async xrefsFrom(rva: bigint): Promise<IXrefsResult> {
		return this.xrefs('analysis/xrefsFrom', rva);
	}

	private async xrefs(method: string, rva: bigint): Promise<IXrefsResult> {
		const { json } = await this.rpc.call(method, {
			image_id: this.image.image_id,
			rva: `0x${rva.toString(16).toUpperCase()}`,
		});
		return json.result as IXrefsResult;
	}

	private shutdown(): void {
		this.rpc.call('shutdown', null).catch(() => {
			// The server may already be gone; killing below is the backstop.
		}).finally(() => {
			this.analysis.kill();
			this.provider.kill();
		});
	}
}

/**
 * Builds a per-session endpoint name.
 *
 * The random component matters: the endpoint grants read access to whatever is
 * attached, so a predictable name would let any local process connect to it.
 */
function localEndpoint(role: string): string {
	const unique = randomBytes(8).toString('hex');
	return process.platform === 'win32'
		? `pipe://delver-${role}-${unique}`
		: `unix:///tmp/delver-${role}-${unique}.sock`;
}

function logStderr(child: ChildProcess, name: string): void {
	child.stderr?.on('data', (chunk: Buffer) => {
		console.error(`[${name}] ${chunk.toString().trimEnd()}`);
	});
}

/**
 * Waits until a server reports that it is listening.
 *
 * Both servers print a `listening on` line once the endpoint is bound.
 * Connecting before that races and fails intermittently, which is exactly the
 * kind of bug that only shows up on a loaded machine.
 */
export function waitForListening(child: ChildProcess, name: string, timeoutMs = 10_000): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`${name} did not report listening within ${timeoutMs}ms`));
		}, timeoutMs);

		const onData = (chunk: Buffer) => {
			if (chunk.toString().includes('listening on')) {
				cleanup();
				resolve();
			}
		};
		const onExit = (code: number | null) => {
			cleanup();
			reject(new Error(`${name} exited with code ${code} before listening`));
		};
		const onError = (error: Error) => {
			cleanup();
			reject(new Error(`${name} failed to start: ${error.message}`));
		};

		function cleanup() {
			clearTimeout(timer);
			child.stderr?.off('data', onData);
			child.off('exit', onExit);
			child.off('error', onError);
		}

		child.stderr?.on('data', onData);
		child.on('exit', onExit);
		child.on('error', onError);
	});
}
