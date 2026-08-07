/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import {
	AnalysisSessionId,
	IAnalysisSessionHandle,
	IDelverAnalysisService,
} from '../common/delverAnalysisService.js';
import {
	IFunctionsResult,
	IGetExportsResult,
	IGetImageInfoResult,
	IGetImportsResult,
	IListingWindowResult,
	IStringsResult,
	IXrefsResult,
} from '../common/protocol.generated.js';
import { TargetConfig } from '../common/target.js';
import { DelverAnalysisSession } from './analysisSession.js';

/**
 * Hosts analysis sessions for the renderer.
 *
 * Sessions are keyed by an opaque id rather than handed out as objects, because
 * the consumer is on the other side of an IPC channel and can only hold values
 * that survive serialization.
 */
export class DelverAnalysisService extends Disposable implements IDelverAnalysisService {
	readonly _serviceBrand: undefined;

	private readonly sessions = new Map<AnalysisSessionId, DelverAnalysisSession>();
	private nextId = 1;

	constructor() {
		super();
		this._register({ dispose: () => this.closeAll() });
	}

	async openImage(config: TargetConfig): Promise<IAnalysisSessionHandle> {
		const session = await DelverAnalysisSession.start(config);
		const sessionId = `analysis-${this.nextId++}`;
		this.sessions.set(sessionId, session);
		return { sessionId, image: session.image };
	}

	async listingWindow(sessionId: AnalysisSessionId, startRow: number, count: number): Promise<IListingWindowResult> {
		return this.session(sessionId).listingWindow(startRow, count);
	}

	async rowForAddress(sessionId: AnalysisSessionId, rva: string, containing: boolean): Promise<number | undefined> {
		return this.session(sessionId).rowForAddress(BigInt(rva), containing);
	}

	async addressForRow(sessionId: AnalysisSessionId, row: number): Promise<string | undefined> {
		const rva = await this.session(sessionId).addressForRow(row);
		// Back to the wire form before this crosses the channel: a bigint here
		// would hang the caller rather than fail (ADR 0001, "Scope").
		return rva === undefined ? undefined : `0x${rva.toString(16).toUpperCase()}`;
	}

	async functions(sessionId: AnalysisSessionId): Promise<IFunctionsResult> {
		return this.session(sessionId).functions();
	}

	async imageInfo(sessionId: AnalysisSessionId): Promise<IGetImageInfoResult> {
		return this.session(sessionId).getImageInfo();
	}

	async imports(sessionId: AnalysisSessionId): Promise<IGetImportsResult> {
		return this.session(sessionId).getImports();
	}

	async exports(sessionId: AnalysisSessionId): Promise<IGetExportsResult> {
		return this.session(sessionId).getExports();
	}

	async strings(sessionId: AnalysisSessionId): Promise<IStringsResult> {
		return this.session(sessionId).strings();
	}

	async xrefsTo(sessionId: AnalysisSessionId, rva: string): Promise<IXrefsResult> {
		return this.session(sessionId).xrefsTo(BigInt(rva));
	}

	async xrefsFrom(sessionId: AnalysisSessionId, rva: string): Promise<IXrefsResult> {
		return this.session(sessionId).xrefsFrom(BigInt(rva));
	}

	async closeImage(sessionId: AnalysisSessionId): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (session) {
			this.sessions.delete(sessionId);
			session.dispose();
		}
	}

	private session(sessionId: AnalysisSessionId): DelverAnalysisSession {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`No analysis session ${sessionId}`);
		}
		return session;
	}

	private closeAll(): void {
		for (const session of this.sessions.values()) {
			session.dispose();
		}
		this.sessions.clear();
	}
}
