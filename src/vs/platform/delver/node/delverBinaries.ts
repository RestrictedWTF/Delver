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
 * In a packaged build, binaries are expected under
 * `resources/delver/bin/<platform>/`. During development, binaries are taken
 * from `delver/target/debug/`.
 */
export function resolveBinary(name: string): string {
	const ext = process.platform === 'win32' ? '.exe' : '';
	const binaryName = name + ext;

	const staged = path.join(getStagedBinariesDir(), binaryName);
	if (existsSync(staged)) {
		return staged;
	}

	const dev = path.join(getDevBuildDir(), binaryName);
	if (existsSync(dev)) {
		return dev;
	}

	// Fall back to the bare name and let the OS resolve it via PATH.
	return name;
}
