/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Launches Delver from sources into a throwaway profile.
 *
 * The launcher scripts themselves are plain PowerShell and bash and have no
 * dependency on any agent tooling — they only lived under `.agents/skills/`
 * because that is where they were first written. This wrapper makes them a
 * normal development command (`npm run delver:launch`) so starting an isolated
 * build is not something only an agent knows how to do.
 *
 * All arguments are forwarded verbatim, so
 * `npm run delver:launch -- --full --repo D:\other` reaches the script
 * unchanged.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scriptDirectory = join(repoRoot, '.agents', 'skills', 'launch', 'scripts');

/**
 * Picks the PowerShell that exists.
 *
 * PowerShell 7 is `pwsh` and is not present on a stock Windows install, where
 * the shell is `powershell`. Probing beats assuming: a wrong guess fails with
 * ENOENT, which reads as "the launcher is broken" rather than "install pwsh".
 */
function resolvePowerShell(): string {
	const probe = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
	return probe.error === undefined && probe.status === 0 ? 'pwsh' : 'powershell';
}

function main(): number {
	const forwarded = process.argv.slice(2);
	const windows = process.platform === 'win32';
	const script = join(scriptDirectory, windows ? 'launch.ps1' : 'launch.sh');

	if (!existsSync(script)) {
		console.error(`Delver launcher not found at ${script}.`);
		return 1;
	}

	const [command, args] = windows
		? [resolvePowerShell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...forwarded]]
		: ['bash', [script, ...forwarded]];

	// Inherited stdio keeps the launcher's JSON port report on the caller's
	// stdout, which is the whole point of running it: the ports are what a
	// debugger or Playwright attaches to.
	const result = spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot });
	if (result.error) {
		console.error(`Could not start ${command}: ${result.error.message}`);
		return 1;
	}
	return result.status ?? 1;
}

process.exit(main());
