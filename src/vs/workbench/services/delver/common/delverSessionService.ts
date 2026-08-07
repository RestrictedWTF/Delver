/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { AnalysisSessionId } from '../../../../platform/delver/common/delverAnalysisService.js';
import { IOpenImageResult } from '../../../../platform/delver/common/protocol.generated.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IDelverSessionService = createDecorator<IDelverSessionService>('delverSessionService');

/** An analysis session that some editor is currently holding open. */
export interface IDelverSession {
	readonly sessionId: AnalysisSessionId;
	readonly targetPath: string;
	readonly image: IOpenImageResult;
}

/**
 * Tracks which analysis session the workbench is currently working in.
 *
 * The editor that opened a session owns its lifetime, but everything else —
 * navigation, quick access, and later the interpretation views — needs to reach
 * it without reaching into that editor. This is the seam between them.
 *
 * There is exactly one writer: whichever editor currently holds a session open.
 */
export interface IDelverSessionService {
	readonly _serviceBrand: undefined;

	readonly activeSession: IDelverSession | undefined;
	readonly onDidChangeActiveSession: Event<IDelverSession | undefined>;

	/**
	 * Publishes the session an editor has opened, or clears it on close.
	 *
	 * Clearing is guarded by identity: an editor closing must not clear a
	 * session another editor has since published, which is exactly what happens
	 * when one listing replaces another and the old one is disposed afterwards.
	 */
	setActiveSession(session: IDelverSession | undefined, previous?: IDelverSession): void;
}

export class DelverSessionService extends Disposable implements IDelverSessionService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveSession = this._register(new Emitter<IDelverSession | undefined>());
	readonly onDidChangeActiveSession = this._onDidChangeActiveSession.event;

	private _activeSession: IDelverSession | undefined;

	get activeSession(): IDelverSession | undefined {
		return this._activeSession;
	}

	setActiveSession(session: IDelverSession | undefined, previous?: IDelverSession): void {
		if (previous && this._activeSession && this._activeSession.sessionId !== previous.sessionId) {
			return; // a later session already took over
		}
		if (this._activeSession?.sessionId === session?.sessionId) {
			return;
		}
		this._activeSession = session;
		this._onDidChangeActiveSession.fire(session);
	}
}

registerSingleton(IDelverSessionService, DelverSessionService, InstantiationType.Delayed);
