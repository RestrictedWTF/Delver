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
	IDelverReadMemoryWire,
} from '../common/delverAnalysisService.js';
import { IAddressForRowResult, IBasicBlocksResult, ICallGraphResult, ICallPathsResult, IDataRangeCorrectionWire,
	IFunctionCorrectionWire, IFunctionProfileResult, IFunctionsResult, IGetExportsResult, IGetImageInfoResult, IGetImportsResult, IGlobalAccessesResult, IGlobalsResult, IListingWindowResult, IOpenImageResult, IReadMemoryResult, IRowForAddressResult, IScanStringsResult,
	ISearchImmediatesResult, ISetCorrectionsResult, IStringsResult, IVtablesResult, IXrefIndexResult, IXrefsResult } from '../common/protocol.generated.js';
import { IMoment, STATIC_MOMENT } from '../common/moment.js';
import { readInitializeResult } from '../common/protocolVersion.js';
import { momentToWire } from '../common/wire.js';
import { TargetConfig } from '../common/target.js';

/**
 * Where a child process's diagnostics go.
 *
 * A provider's stderr is the only place a spawn or parse failure is explained,
 * so it cannot simply be dropped. It also cannot be written to the console
 * unconditionally: the unit-test harness fails any test run that produces
 * console output, which silently turned the integration tests below into a
 * suite that aborted before it asserted anything. Injecting the sink keeps the
 * diagnostics in production and lets a test collect them instead.
 */
export type DelverProcessLogSink = (message: string) => void;

/** Writes child diagnostics where a developer will actually see them. */
export const consoleProcessLogSink: DelverProcessLogSink = message => console.error(message);

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
	static async start(config: TargetConfig, log: DelverProcessLogSink = consoleProcessLogSink): Promise<DelverAnalysisSession> {
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
		logStderr(provider, 'provider-file', log);

		let analysis: ChildProcess | undefined;
		try {
			await waitForListening(provider, 'provider-file');

			analysis = spawn(
				resolveBinary('server-analysis'),
				['--provider', providerEndpoint, '--listen', analysisEndpoint],
				{ stdio: ['ignore', 'ignore', 'pipe'] },
			);
			logStderr(analysis, 'server-analysis', log);
			await waitForListening(analysis, 'server-analysis');

			const rpc = await DelverRpcClient.connect(analysisEndpoint);
			readInitializeResult((await rpc.call('initialize', null)).json.result, 'server-analysis');
			const { json } = await rpc.call('analysis/openImage', null);

			// A second client on the provider, alongside the analysis server's.
			// Headers are a provider capability, not a derived fact — asking the
			// analysis server to proxy them would put a parsing concern in the
			// wrong process. Providers accept multiple clients precisely so this
			// works (P1 decision E1).
			const providerRpc = await DelverRpcClient.connect(providerEndpoint);
			readInitializeResult((await providerRpc.call('initialize', null)).json.result, 'provider-file');

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
	 * Reads one binary frame from the provider and verifies its JSON reference.
	 *
	 * The Moment is sent, not left out: a read names when it observed the target
	 * (CLAUDE.md invariant 1), and the provider decides whether it can serve
	 * that. The only target behind this session is a file, so the default is the
	 * static moment.
	 */
	async readMemory(space: 'Image' | 'File', address: bigint, count: number, moment: IMoment = STATIC_MOMENT): Promise<IDelverReadMemoryWire> {
		const { json, frames } = await this.providerRpc.call('readMemory', {
			space,
			address: `0x${address.toString(16).toUpperCase()}`,
			len: count,
			moment: momentToWire(moment),
		}, 1);
		const result = json.result as IReadMemoryResult;
		const frame = frames?.[0];
		if (!frame) {
			throw new Error('Provider readMemory response did not include its binary frame');
		}
		if (frame.frameId !== result.data.$frame || frame.data.byteLength !== result.data.len) {
			throw new Error('Provider readMemory binary frame did not match its response metadata');
		}
		return {
			bytesHex: frame.data.toString('hex'),
			valid: result.valid,
			servedMoment: result.served_moment,
		};
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

	async basicBlocks(functionRva: bigint, maxBlocks: number): Promise<IBasicBlocksResult> {
		const { json } = await this.rpc.call('analysis/basicBlocks', {
			image_id: this.image.image_id,
			function_rva: `0x${functionRva.toString(16).toUpperCase()}`,
			max_blocks: maxBlocks,
		});
		return json.result as IBasicBlocksResult;
	}

	async callGraph(functionRva: bigint, maxEdges: number): Promise<ICallGraphResult> {
		const { json } = await this.rpc.call('analysis/callGraph', {
			image_id: this.image.image_id,
			function_rva: `0x${functionRva.toString(16).toUpperCase()}`,
			max_edges: maxEdges,
		});
		return json.result as ICallGraphResult;
	}

	async callPaths(fromRva: bigint, toRva: bigint, maxDepth: number, maxPaths: number, maxVisited: number): Promise<ICallPathsResult> {
		const { json } = await this.rpc.call('analysis/callPaths', {
			image_id: this.image.image_id,
			from_rva: `0x${fromRva.toString(16).toUpperCase()}`,
			to_rva: `0x${toRva.toString(16).toUpperCase()}`,
			max_depth: maxDepth,
			max_paths: maxPaths,
			max_visited: maxVisited,
		});
		return json.result as ICallPathsResult;
	}

	async functionProfile(functionRva: bigint): Promise<IFunctionProfileResult> {
		const { json } = await this.rpc.call('analysis/functionProfile', {
			image_id: this.image.image_id,
			function_rva: `0x${functionRva.toString(16).toUpperCase()}`,
		});
		return json.result as IFunctionProfileResult;
	}

	async globals(start: number, maxGlobals: number): Promise<IGlobalsResult> {
		const { json } = await this.rpc.call('analysis/globals', {
			image_id: this.image.image_id,
			start,
			max_globals: maxGlobals,
		});
		return json.result as IGlobalsResult;
	}

	async vtables(start: number, maxVtables: number, maxSlotsPerVtable: number): Promise<IVtablesResult> {
		const { json } = await this.rpc.call('analysis/vtables', {
			image_id: this.image.image_id,
			start,
			max_vtables: maxVtables,
			max_slots_per_vtable: maxSlotsPerVtable,
		});
		return json.result as IVtablesResult;
	}

	async globalAccesses(rva: bigint, maxAccesses: number): Promise<IGlobalAccessesResult> {
		const { json } = await this.rpc.call('analysis/globalAccesses', {
			image_id: this.image.image_id,
			rva: `0x${rva.toString(16).toUpperCase()}`,
			max_accesses: maxAccesses,
		});
		return json.result as IGlobalAccessesResult;
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

	/**
	 * One page of the whole cross-reference table.
	 *
	 * Unlike `xrefsTo`/`xrefsFrom` this asks nothing about an address; it walks
	 * the table so a project can keep it. The result's `next_start` is returned
	 * exactly as the server sent it — absent means the table ended, and putting a
	 * number there would erase that signal.
	 */
	/**
	 * Re-derives every fact against a new authored correction set.
	 *
	 * The whole set is sent, never a delta: the server replaces what is in
	 * effect, and a caller that could send partial updates would have no way to
	 * say what the facts it is reading were derived against.
	 */
	async setCorrections(
		corrections: readonly IFunctionCorrectionWire[],
		dataRanges: readonly IDataRangeCorrectionWire[] = [],
	): Promise<ISetCorrectionsResult> {
		const { json } = await this.rpc.call('analysis/setCorrections', {
			image_id: this.image.image_id,
			corrections,
			data_ranges: dataRanges,
		});
		return json.result as ISetCorrectionsResult;
	}

	/**
	 * Re-scans a bounded window of the image for strings.
	 *
	 * Distinct from `strings()`, which serves the list retained at analysis
	 * time and stops at the scanner's cap. This produces them on demand, so a
	 * caller can walk past that cap instead of being stopped by it.
	 */
	async scanStrings(fromRva: string, maxStrings: number): Promise<IScanStringsResult> {
		const { json } = await this.rpc.call('analysis/scanStrings', {
			image_id: this.image.image_id,
			from_rva: fromRva,
			max_strings: maxStrings,
		});
		return json.result as IScanStringsResult;
	}

	/**
	 * Every decoded instruction encoding one constant as an immediate.
	 *
	 * Structured rather than textual: the same number reaches the listing as
	 * `0x1f4`, `500` or `1F4h` depending on the formatter, and matching the
	 * encoded value asks "where is this number used" instead of "where does this
	 * string appear".
	 */
	async searchImmediates(value: string, width: number | undefined, maxMatches: number): Promise<ISearchImmediatesResult> {
		const { json } = await this.rpc.call('analysis/searchImmediates', {
			image_id: this.image.image_id,
			value,
			...(width === undefined ? {} : { width }),
			max_matches: maxMatches,
		});
		return json.result as ISearchImmediatesResult;
	}

	async xrefIndex(start: number, maxXrefs: number, generation?: number): Promise<IXrefIndexResult> {
		const { json } = await this.rpc.call('analysis/xrefIndex', {
			image_id: this.image.image_id,
			start,
			max_xrefs: maxXrefs,
			// Sent from the second page on. A `start` index only means anything
			// against the derivation it was taken from, and this walk spans many
			// round trips during which an accepted correction can land.
			...(generation === undefined ? {} : { generation }),
		});
		return json.result as IXrefIndexResult;
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

function logStderr(child: ChildProcess, name: string, log: DelverProcessLogSink): void {
	child.stderr?.on('data', (chunk: Buffer) => {
		log(`[${name}] ${chunk.toString().trimEnd()}`);
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
