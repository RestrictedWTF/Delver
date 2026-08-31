/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DELVER_PROTOCOL_VERSION, IInitializeResult } from './protocol.generated.js';

/**
 * Checks the `initialize` handshake and returns the result, or refuses it.
 *
 * Both `provider-file` and `server-analysis` declare the version from one
 * constant in the `delver-protocol` crate, and this is the client half of that
 * agreement. A provider binary can outlive the build that launched it — a stale
 * one on `PATH`, a half-finished rebuild — and the failure that produces is a
 * decoded-wrong response somewhere much later, so the handshake is the only
 * place to catch it.
 *
 * Fails closed: a missing or non-string version is a mismatch, not a pass.
 * Something that cannot say what it speaks is not something to keep talking to.
 * This mirrors what `readHello` does for the decompiler worker handshake.
 */
export function readInitializeResult(result: unknown, processName: string): IInitializeResult {
	const declared = (result as Partial<IInitializeResult> | undefined)?.protocol_version;
	if (typeof declared !== 'string' || declared !== DELVER_PROTOCOL_VERSION) {
		const spoken = typeof declared === 'string' ? `"${declared}"` : 'no version at all';
		throw new Error(
			`Delver protocol version mismatch: ${processName} reported ${spoken}, this build speaks "${DELVER_PROTOCOL_VERSION}". Rebuild or update ${processName}.`
		);
	}
	return result as IInitializeResult;
}
