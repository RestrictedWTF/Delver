/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	AnalysisSessionId,
	IDelverAnalysisService,
} from '../../../../platform/delver/common/delverAnalysisService.js';
import { IOpenImageResult } from '../../../../platform/delver/common/protocol.generated.js';
import { isContentHash } from '../../../../platform/delver/common/delverInterpretationStoreService.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IDelverInterpretationService } from './delverInterpretationService.js';

export const IDelverSessionService = createDecorator<IDelverSessionService>('delverSessionService');

/**
 * True while a target is open.
 *
 * Views need this to tell "nothing is open" from "this image has none of those".
 * An empty Exports pane saying "No target open" while a target is plainly open
 * is not a cosmetic problem — it reports the tool's state wrongly, and the
 * honest answer, that the binary exports nothing, is a real finding.
 */
export const DELVER_TARGET_OPEN = new RawContextKey<boolean>('delverTargetOpen', false);

/** An analysis session that some editor is currently holding open. */
export interface IDelverSession {
	readonly sessionId: AnalysisSessionId;
	readonly targetPath: string;
	readonly image: IOpenImageResult;
	/**
	 * SHA-256 of the image's file bytes, lowercase hex.
	 *
	 * The identity interpretation anchors to. It is carried on the session
	 * because every pane that wants to show an authored name needs it, and it
	 * must not be re-derived per pane.
	 */
	readonly contentHash: string;
}

/**
 * Owns the analysis session for the target the workbench has open.
 *
 * **The session belongs to the target, not to an editor.** It used to be owned
 * by whichever editor opened it, which meant switching from the listing to the
 * strings tab evicted the listing, tore its session down, and left every pane
 * asking for a target that was still open. A session outlives any one view of
 * it, exactly as the open file does.
 */
export interface IDelverSessionService {
	readonly _serviceBrand: undefined;

	readonly activeSession: IDelverSession | undefined;
	readonly onDidChangeActiveSession: Event<IDelverSession | undefined>;

	/**
	 * Opens `targetPath` for analysis, replacing whatever was open.
	 *
	 * Returns the existing session unchanged when the same target is already
	 * open, so switching between the listing and strings tabs costs nothing.
	 */
	openTarget(targetPath: string): Promise<IDelverSession>;

	/** Closes the open target, if any. */
	closeTarget(): Promise<void>;
}

export class DelverSessionService extends Disposable implements IDelverSessionService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveSession = this._register(new Emitter<IDelverSession | undefined>());
	readonly onDidChangeActiveSession = this._onDidChangeActiveSession.event;

	private _activeSession: IDelverSession | undefined;

	/** Tail of in-flight opens, so concurrent requests cannot race. */
	private opening: Promise<IDelverSession | undefined> = Promise.resolve(undefined);

	get activeSession(): IDelverSession | undefined {
		return this._activeSession;
	}

	private readonly targetOpenContext: IContextKey<boolean>;

	constructor(
		@IDelverAnalysisService private readonly analysisService: IDelverAnalysisService,
		@IDelverInterpretationService private readonly interpretationService: IDelverInterpretationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.targetOpenContext = DELVER_TARGET_OPEN.bindTo(contextKeyService);
		this._register({ dispose: () => { void this.closeTarget(); } });
	}

	async openTarget(targetPath: string): Promise<IDelverSession> {
		const existing = this._activeSession;
		if (existing?.targetPath === targetPath) {
			return existing;
		}

		// Serialized: two editors restoring at once must not each start a
		// provider pair for the same file.
		const result = this.opening.then(() => this.doOpen(targetPath), () => this.doOpen(targetPath));
		// A failed open must not poison the queue for the next target.
		this.opening = result.then(session => session, () => undefined);
		return result;
	}

	private async doOpen(targetPath: string): Promise<IDelverSession> {
		const existing = this._activeSession;
		if (existing?.targetPath === targetPath) {
			return existing;
		}
		await this.closeTarget();

		const handle = await this.analysisService.openImage({ kind: 'file', path: targetPath });
		let contentHash: string;
		try {
			const info = await this.analysisService.imageInfo(handle.sessionId);
			if (!isContentHash(info.content_hash)) {
				throw new Error('The target provider did not return a valid content hash. Rebuild or update provider-file.');
			}
			contentHash = info.content_hash;
			await this.interpretationService.load(contentHash);
		} catch (error) {
			await this.analysisService.closeImage(handle.sessionId).catch(() => undefined);
			throw error;
		}
		const session: IDelverSession = {
			sessionId: handle.sessionId,
			targetPath,
			image: handle.image,
			contentHash,
		};

		this._activeSession = session;
		this.targetOpenContext.set(true);
		this._onDidChangeActiveSession.fire(session);
		return session;
	}

	async closeTarget(): Promise<void> {
		const session = this._activeSession;
		if (!session) {
			return;
		}
		this._activeSession = undefined;
		this.targetOpenContext.set(false);
		this._onDidChangeActiveSession.fire(undefined);
		await this.analysisService.closeImage(session.sessionId).catch(() => undefined);
	}
}

registerSingleton(IDelverSessionService, DelverSessionService, InstantiationType.Delayed);
