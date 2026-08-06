/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import * as path from '../../../base/common/path.js';

/**
 * Resolves the directory containing this module's source file.
 */
function getModuleDirname(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Returns the directory that Delver native binaries are staged in for a
 * packaged build.
 */
export function getStagedBinariesDir(): string {
	const platform = process.platform;
	return path.resolve(getModuleDirname(), '..', '..', '..', '..', '..', 'resources', 'delver', 'bin', platform);
}

/**
 * Returns the directory that contains the debug build artifacts in a
 * development checkout.
 */
export function getDevBuildDir(): string {
	return path.resolve(getModuleDirname(), '..', '..', '..', '..', '..', 'delver', 'target', 'debug');
}

/**
 * Resolves the path to a Delver binary.
 *
 * **The development build wins over the staged one.** `delver/target/debug/`
 * only exists in a checkout, and in a checkout it is by definition what the
 * developer just built; `resources/delver/bin/` is a copy made by the last
 * packaging run and goes stale the moment any Rust changes. Preferring the
 * staged copy means `cargo build` appears to do nothing, and the failure looks
 * like a protocol bug rather than a stale binary.
 *
 * A packaged build has no `delver/target/`, so the staged path wins there
 * without needing a mode flag.
 */
export function resolveBinary(name: string): string {
	const ext = process.platform === 'win32' ? '.exe' : '';
	const binaryName = name + ext;

	const dev = path.join(getDevBuildDir(), binaryName);
	if (existsSync(dev)) {
		return dev;
	}

	const staged = path.join(getStagedBinariesDir(), binaryName);
	if (existsSync(staged)) {
		return staged;
	}

	// Fall back to the bare name and let the OS resolve it via PATH.
	return name;
}
