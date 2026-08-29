/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawn } from 'child_process';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { mkdtempSync, promises, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { isInstructionRow } from '../../common/listingRows.js';
import { FunctionCorrectionKindWire, FunctionSourceWire, IXrefWire } from '../../common/protocol.generated.js';
import { DelverAnalysisSession, waitForListening } from '../../node/analysisSession.js';
import { buildMinimalPe, IPeImportModule, planPeImports, readPeImports } from './minimalPe.js';

/**
 * `call 0x1007` / `call rax` / `ret`.
 *
 * Two detected functions — the entry point and the address it calls — so a
 * structure query has a bounded extent, one named outgoing edge, and one call
 * site whose target the decoder cannot name.
 */
const CALL_AND_INDIRECT_CODE = Buffer.from([0xe8, 0x02, 0x00, 0x00, 0x00, 0xff, 0xd0, 0xc3]);

/**
 * One module carrying both import encodings, because the resolver distinguishes
 * them: a named import produces `symbol`, an ordinal import produces `ordinal`.
 */
const IMPORT_MODULES: readonly IPeImportModule[] = [{
	name: 'KERNEL32.dll',
	symbols: [
		{ name: 'CreateFileW' },
		{ name: 'ExitProcess' },
		{ ordinal: 0x53 },
	],
}];

/**
 * Where the builder put those imports. Reading the slots back from the plan is
 * what keeps the displacements below correct: a layout change moves them
 * together instead of silently breaking the operands.
 */
const IMPORT_LAYOUT = planPeImports(IMPORT_MODULES);
const [CREATE_FILE_W_SLOT, EXIT_PROCESS_SLOT, ORDINAL_SLOT] = IMPORT_LAYOUT.modules[0].iatRvas;

/**
 * `.text` layout of the import fixture, all RVAs, `.text` based at `0x1000`:
 *
 * ```
 *   0x1000  e8 rel32      call 0x1013     — resolves through a thunk
 *   0x1005  ff 15 disp32  call [rip+X]    — resolves through its own operand
 *   0x100B  e8 rel32      call 0x1019     — resolves through a thunk
 *   0x1010  ff d0         call rax        — nothing to resolve it from
 *   0x1012  c3            ret
 *   0x1013  ff 25 disp32  jmp [rip+X]     — thunk for ExitProcess
 *   0x1019  ff 25 disp32  jmp [rip+X]     — thunk for the ordinal import
 *   0x101F  cc cc         int3 padding
 * ```
 *
 * `resolve_import_thunk` accepts a target only when its whole extent is one
 * indirect branch, and a thunk's extent is inferred — from the next detected
 * function, or from the unbroken run of decoded instructions. So the first
 * thunk ends where the second begins, and the second ends where decoding stops.
 * The trailing `int3` is never decoded (the linear sweep reads `0xCC` as
 * padding rather than as a function start), so it cannot extend that run and
 * make the second thunk look like a two-instruction function.
 */
const TEXT_RVA = 0x1000n;
const CALL_NAMED_THUNK_SITE = 0x1000n;
const CALL_IAT_OPERAND_SITE = 0x1005n;
const CALL_ORDINAL_THUNK_SITE = 0x100Bn;
const CALL_REGISTER_SITE = 0x1010n;
const RETURN_SITE = 0x1012n;
const NAMED_THUNK = 0x1013n;
const ORDINAL_THUNK = 0x1019n;
const CODE_END = 0x101Fn;
const PADDED_CODE_END = 0x1021n;

/** Builds the fixture above, deriving every displacement from the real layout. */
function buildImportCallCode(): Buffer {
	const code = Buffer.alloc(Number(PADDED_CODE_END - TEXT_RVA), 0xcc);
	const at = (rva: bigint): number => Number(rva - TEXT_RVA);

	/** `e8 rel32`: five bytes, and rel32 counts from the end of them. */
	const writeCall = (site: bigint, target: bigint): void => {
		code.writeUInt8(0xe8, at(site));
		code.writeInt32LE(Number(target - (site + 5n)), at(site) + 1);
	};

	/**
	 * `ff /op` with ModRM `mod=00 rm=101` — the RIP-relative form. Six bytes,
	 * and disp32 counts from the end of them, so the operand names
	 * `site + 6 + disp`. `0x15` is `/2` (call), `0x25` is `/4` (jmp).
	 */
	const writeRipIndirect = (site: bigint, modrm: number, target: bigint): void => {
		code.writeUInt8(0xff, at(site));
		code.writeUInt8(modrm, at(site) + 1);
		code.writeInt32LE(Number(target - (site + 6n)), at(site) + 2);
	};

	writeCall(CALL_NAMED_THUNK_SITE, NAMED_THUNK);
	writeRipIndirect(CALL_IAT_OPERAND_SITE, 0x15, CREATE_FILE_W_SLOT);
	writeCall(CALL_ORDINAL_THUNK_SITE, ORDINAL_THUNK);
	// `call rax`: an indirect call with no memory operand, so no data xref and
	// nothing the import table could be asked about.
	code.writeUInt8(0xff, at(CALL_REGISTER_SITE));
	code.writeUInt8(0xd0, at(CALL_REGISTER_SITE) + 1);
	code.writeUInt8(0xc3, at(RETURN_SITE));
	writeRipIndirect(NAMED_THUNK, 0x25, EXIT_PROCESS_SLOT);
	writeRipIndirect(ORDINAL_THUNK, 0x25, ORDINAL_SLOT);
	// Bytes from CODE_END on stay 0xCC.
	assert.strictEqual(at(CODE_END) + 2, code.length, 'the fixture fills the buffer it declares');

	return code;
}

/**
 * Collects child-process diagnostics instead of writing them to the console.
 *
 * The unit harness fails any run that produces console output, and the
 * provider and analysis server both announce their endpoint on stderr. Routed
 * to the console these tests aborted in an `afterEach` hook before asserting
 * anything; collected here they stay available for a failure message without
 * failing the run for existing.
 */
const diagnostics: string[] = [];
const collectDiagnostics = (message: string): void => {
	diagnostics.push(message);
};

suite('DelverAnalysisSession', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let path: string;

	/**
	 * A generated PE keeps the test hermetic and fast. Using the Node binary
	 * instead would analyse ~92 MB and 8.8 million instructions per test.
	 */
	setup(() => {
		dir = mkdtempSync(join(tmpdir(), 'delver-test-'));
		path = join(dir, 'minimal.exe');
		writeFileSync(path, buildMinimalPe());
	});

	teardown(async () => {
		// Child-process shutdown is asynchronous. Windows may briefly retain the
		// sample handle after `dispose`, so use the asynchronous remover: its
		// retries yield to the shutdown promise instead of blocking the event loop.
		await promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	test('starts a provider and analysis server and serves listing rows', async function () {
		this.timeout(30_000);

		const session = await DelverAnalysisSession.start({ kind: 'file', path }, collectDiagnostics);
		try {
			assert.ok(
				session.image.instruction_count > 0,
				'a real PE must decode to at least one instruction'
			);

			const window = await session.listingWindow(0, 4);
			assert.strictEqual(window.rows.length, 3, 'the generated PE decodes to three instructions');
			assert.strictEqual(
				window.rows[0].row,
				0,
				'the first requested row must be row zero'
			);
			const first = window.rows[0];
			assert.ok(
				isInstructionRow(first) && first.mnemonic.length > 0,
				'instruction rows carry formatted text'
			);
			assert.ok(
				window.total_rows >= BigInt(window.rows.length) ||
				Number(window.total_rows) >= window.rows.length,
				'total row count is reported so a client can size a scrollbar'
			);
		} finally {
			session.dispose();
		}
	});

	test('re-derives facts against an authored correction, and takes it back', async function () {
		this.timeout(30_000);

		// The whole point of correcting the seed set rather than editing the
		// output: the facts are produced again from the bytes, so a correction
		// and its withdrawal both land on facts nothing had to patch. Undefining
		// what was just defined must return the image to exactly what detection
		// alone concluded.
		const session = await DelverAnalysisSession.start({ kind: 'file', path }, collectDiagnostics);
		try {
			const before = await session.functions();
			// An instruction start that detection did not call a function entry.
			const window = await session.listingWindow(0, 4);
			const rows = window.rows.filter(isInstructionRow);
			const candidate = rows.map(row => row.rva).find(rva => !before.functions.some(fn => fn.rva === rva));
			assert.ok(candidate !== undefined, 'the fixture has an instruction that is not a function entry');

			const defined = await session.setCorrections([{ rva: candidate, kind: FunctionCorrectionKindWire.Define }]);
			const afterDefine = await session.functions();
			const withdrawn = await session.setCorrections([{ rva: candidate, kind: FunctionCorrectionKindWire.Undefine }]);
			const afterUndefine = await session.functions();

			assert.deepStrictEqual({
				definedCount: defined.function_count - defined.function_count_before,
				// An analyst asserting a boundary outranks anything derived.
				definedSource: afterDefine.functions.find(fn => fn.rva === candidate)?.source,
				definedIsAuthoritative: afterDefine.functions.find(fn => fn.rva === candidate)?.authoritative,
				// Undefining the same address removes it again...
				stillPresent: afterUndefine.functions.some(fn => fn.rva === candidate),
				// ...and leaves the rest of detection exactly as it was.
				backToBaseline: afterUndefine.functions.length === before.functions.length,
				correctionsInEffect: withdrawn.corrections_applied,
			}, {
				definedCount: 1,
				definedSource: FunctionSourceWire.Authored,
				definedIsAuthoritative: true,
				stillPresent: false,
				backToBaseline: true,
				correctionsInEffect: 1,
			});
		} finally {
			session.dispose();
		}
	});

	test('refuses a correction set that contradicts itself, leaving the facts alone', async function () {
		this.timeout(30_000);

		// A half-applied set produces facts corresponding to no set anyone
		// recorded. Refusing it whole is what keeps a corrected fact as
		// reproducible as an uncorrected one.
		const session = await DelverAnalysisSession.start({ kind: 'file', path }, collectDiagnostics);
		try {
			const before = await session.functions();
			const refused = await session
				.setCorrections([
					{ rva: '0x1000', kind: FunctionCorrectionKindWire.Define },
					{ rva: '0x1000', kind: FunctionCorrectionKindWire.Undefine },
				])
				.then(() => 'accepted', (error: Error) => error.message);
			const after = await session.functions();

			assert.deepStrictEqual({
				// Named, not merely "something threw": an RPC failure, an
				// unimplemented method or a transport error would all satisfy a
				// bare rejection and none of them is this refusal.
				namesTheConflict: refused.includes('applying corrections') && refused.includes('0x1000'),
				// Compared by identity rather than by count, because a set that
				// defined one function and undefined another would leave the
				// count intact while being exactly the half-application the
				// atomicity rule exists to prevent.
				factsUnchanged: after.functions.map(fn => `${fn.rva}:${fn.source}`),
			}, {
				namesTheConflict: true,
				factsUnchanged: before.functions.map(fn => `${fn.rva}:${fn.source}`),
			});
		} finally {
			session.dispose();
		}
	});

	test('walks the image for strings in bounded windows that meet in the middle', async function () {
		this.timeout(30_000);

		// The property the resumable scan promises: a page walk sees exactly what
		// one unbounded scan sees. Nine of the thirty-five largest binaries in a
		// stock System32 hit the retention cap, so this walk is how anything past
		// it is reachable at all.
		// The import fixture, because its directory carries real module and symbol
		// names; the default fixture is code and nothing else.
		const session = await startImportSession();
		try {
			const whole = await session.scanStrings('0x0', 0);
			assert.ok(whole.strings.length > 0, 'the import fixture carries module and symbol names');

			const walked = [];
			let from: string | undefined = '0x0';
			let windows = 0;
			while (from !== undefined && windows < 64) {
				const page = await session.scanStrings(from, 1);
				walked.push(...page.strings);
				from = page.next_rva;
				windows++;
			}

			assert.deepStrictEqual({
				unboundedIsComplete: whole.next_rva,
				walked: walked.map(entry => `${entry.rva}:${entry.text}`),
				// One window per address group, and the walk ends by running out
				// of image rather than by hitting the loop guard.
				endedNaturally: from === undefined,
			}, {
				unboundedIsComplete: undefined,
				walked: whole.strings.map(entry => `${entry.rva}:${entry.text}`),
				endedNaturally: true,
			});
		} finally {
			session.dispose();
		}
	});

	test('round-trips between rows and addresses', async function () {
		this.timeout(30_000);

		const session = await DelverAnalysisSession.start({ kind: 'file', path }, collectDiagnostics);
		try {
			const address = await session.addressForRow(0);
			assert.ok(address !== undefined, 'row zero has an address');

			const row = await session.rowForAddress(address!, false);
			assert.strictEqual(row, 0, 'an exact instruction boundary maps back to its row');
		} finally {
			session.dispose();
		}
	});

	test('serves image headers alongside analysis, from one session', async function () {
		this.timeout(30_000);

		// One open has to populate everything. Headers come from the provider on
		// a second client rather than through the analysis server, so this also
		// covers a provider serving two clients at once (P1 decision E1).
		const session = await DelverAnalysisSession.start({ kind: 'file', path }, collectDiagnostics);
		try {
			const [info, window] = await Promise.all([
				session.getImageInfo(),
				session.listingWindow(0, 1),
			]);
			assert.match(info.content_hash, /^[0-9a-f]{64}$/);

			assert.deepStrictEqual(
				{
					arch: info.arch,
					// Read from the optional header the fixture writes, not
					// defaulted: it is what tells a caller whether to expect a
					// `main` or a `WinMain` behind the CRT entry point.
					subsystem: info.subsystem,
					sections: info.sections.map(s => s.name),
					rows: window.rows.length,
				},
				{
					arch: 'X86_64',
					subsystem: { kind: 'console' },
					sections: ['.text'],
					rows: 1,
				},
			);
		} finally {
			session.dispose();
		}
	});

	test('serves imports grouped by module', async function () {
		this.timeout(30_000);

		const session = await DelverAnalysisSession.start({ kind: 'file', path }, collectDiagnostics);
		try {
			const { modules } = await session.getImports();
			// The generated PE has no import directory. An empty list is the
			// correct answer and must not be an error — plenty of real images,
			// including shellcode-style payloads, import nothing statically.
			assert.deepStrictEqual(modules, []);
		} finally {
			session.dispose();
		}
	});

	test('reports functions with their confidence', async function () {
		this.timeout(30_000);

		const session = await DelverAnalysisSession.start({ kind: 'file', path }, collectDiagnostics);
		try {
			const { functions } = await session.functions();
			assert.ok(functions.length > 0, 'a real PE yields functions');
			assert.ok(
				functions.some(f => f.authoritative),
				'at least one boundary must come from a source the image vouches for'
			);
		} finally {
			session.dispose();
		}
	});

	test('serves a bounded basic-block graph for one function', async function () {
		this.timeout(30_000);

		const session = await DelverAnalysisSession.start({ kind: 'file', path }, collectDiagnostics);
		try {
			const { functions } = await session.functions();
			const functionRva = BigInt(functions[0].rva);
			const graph = await session.basicBlocks(functionRva, 1);
			assert.deepStrictEqual(graph, {
				function_rva: functions[0].rva,
				blocks: [{ start_rva: functions[0].rva, end_rva: '0x1008', instruction_count: 3 }],
				edges: [],
				truncated: false,
				block_total: 1,
				edge_total: 0,
				// The function's own end was never recorded, so its extent was
				// inferred. Every count above is therefore about an inferred
				// range, and the graph says so rather than reading as measured.
				bounded: false,
			});
		} finally {
			session.dispose();
		}
	});

	/** Opens a second sample beside the default one, written on demand. */
	async function startCallSession(): Promise<DelverAnalysisSession> {
		const callPath = join(dir, 'calls.exe');
		writeFileSync(callPath, buildMinimalPe(CALL_AND_INDIRECT_CODE));
		return DelverAnalysisSession.start({ kind: 'file', path: callPath }, collectDiagnostics);
	}

	/** Opens the sample that carries an import directory. */
	async function startImportSession(): Promise<DelverAnalysisSession> {
		writeFileSync(join(dir, 'imports.exe'), buildMinimalPe(buildImportCallCode(), IMPORT_MODULES));
		return DelverAnalysisSession.start({ kind: 'file', path: join(dir, 'imports.exe') }, collectDiagnostics);
	}

	test('serves a bounded call graph for one function', async function () {
		this.timeout(30_000);

		const session = await startCallSession();
		try {
			const graph = await session.callGraph(0x1000n, 16);
			assert.deepStrictEqual(graph, {
				function_rva: '0x1000',
				callers: [],
				callees: [{
					site: '0x1000',
					target: '0x1007',
					kind: 'call',
					site_function_rva: '0x1000',
					target_function_rva: '0x1007',
					tail_call: false,
				}],
				// The indirect call is the honest part: an agent has to be able to
				// see that one outgoing call exists which the graph cannot name.
				// `call rax` goes through no IAT slot and carries no memory
				// operand, so there is nothing to resolve it from and `resolved`
				// is absent rather than guessed.
				indirect_call_sites: [{ site: '0x1005' }],
				caller_total: 0,
				callee_total: 1,
				indirect_call_site_total: 1,
				unresolved_indirect_call_site_total: 1,
				callers_truncated: false,
				callees_truncated: false,
				indirect_truncated: false,
				bounded: false,
				import_resolution_incomplete: false,
			});
		} finally {
			session.dispose();
		}
	});

	test('refuses to continue an xref walk into a re-derived table', async function () {
		this.timeout(30_000);

		// The retained table is what a `.delverdb` opened without its sample
		// answers "who references this" from, for the life of the project. A walk
		// that spanned a re-derivation would splice rows from two tables into one
		// that matches neither, and nothing downstream could tell.
		const session = await startCallSession();
		try {
			const first = await session.xrefIndex(0, 1);
			assert.ok(first.xrefs.length > 0, 'the call fixture makes at least one reference');

			// An empty correction set still re-derives, which is exactly the
			// point: the generation is about the table being rebuilt, not about
			// the corrections differing.
			const applied = await session.setCorrections([], []);

			let refusal: string | undefined;
			try {
				// Index 0 is valid in either table, so a refusal here can only be
				// about the derivation and not about the index being out of range.
				await session.xrefIndex(0, 1, first.generation);
			} catch (error) {
				refusal = error instanceof Error ? error.message : String(error);
			}
			// Without the generation the same call is answered, from the new
			// table — which is what makes the guard load-bearing rather than
			// decorative.
			const unguarded = await session.xrefIndex(0, 1);

			assert.deepStrictEqual({
				movedOn: applied.generation > first.generation,
				refused: refusal !== undefined,
				namesBothDerivations: refusal?.includes(String(first.generation)) === true
					&& refusal?.includes(String(applied.generation)) === true,
				unguardedAnswered: unguarded.generation,
			}, {
				movedOn: true,
				refused: true,
				namesBothDerivations: true,
				unguardedAnswered: applied.generation,
			});
		} finally {
			await session.dispose();
		}
	});

	test('exports the whole xref table across pages, ending only when it is exhausted', async function () {
		this.timeout(30_000);

		// The property that matters for retention is not what the table holds
		// but that a paged walk sees all of it exactly once. A project that
		// retained a silently short table would answer a later lookup with a
		// confident and wrong zero, which is the failure this export exists to
		// make impossible.
		const session = await startCallSession();
		try {
			const whole = await session.xrefIndex(0, 0);
			assert.ok(whole.xrefs.length > 0, 'the call fixture makes at least one reference');

			const walked: IXrefWire[] = [];
			let start: number | undefined = 0;
			let pages = 0;
			while (start !== undefined) {
				const page = await session.xrefIndex(start, 1);
				walked.push(...page.xrefs);
				start = page.next_start;
				pages++;
			}

			assert.deepStrictEqual({
				unboundedIsComplete: whole.next_start,
				total: whole.total,
				walked,
				// Exactly one page per reference: the page carrying the last one
				// drops `next_start` itself, so the walk never costs an extra
				// empty round trip to learn it has finished.
				pages,
			}, {
				unboundedIsComplete: undefined,
				total: whole.xrefs.length,
				walked: whole.xrefs,
				pages: whole.xrefs.length,
			});
		} finally {
			session.dispose();
		}
	});

	test('profiles one function from the same derivation', async function () {
		this.timeout(30_000);

		const session = await startCallSession();
		try {
			const profile = await session.functionProfile(0x1000n);
			assert.deepStrictEqual(profile, {
				function_rva: '0x1000',
				// Nothing records this function's end, so the extent stops at the
				// next detected function and `bounded` says the extent is inferred.
				bounded: false,
				instruction_count: 2,
				decoded_extent_bytes: 7,
				block_count: 1,
				edge_count: 0,
				incoming_call_site_count: 0,
				incoming_caller_function_count: 0,
				outgoing_call_site_count: 1,
				outgoing_target_function_count: 1,
				indirect_call_site_count: 1,
				// The generated PE carries no import directory, so nothing in it
				// can be named from the IAT.
				resolved_indirect_call_site_count: 0,
				return_count: 0,
			});
		} finally {
			session.dispose();
		}
	});

	test('lays the generated import directory out where the fixture expects it', () => {
		// A self-consistency check on the builder, not a validation of it: the
		// reader navigates the headers independently, but only the analysis
		// server proves the `object` crate accepts the image. Pinning the
		// numbers here means a layout shift fails loudly in one obvious place
		// rather than as an empty import list three tests down.
		assert.deepStrictEqual(readPeImports(buildMinimalPe(buildImportCallCode(), IMPORT_MODULES)), [{
			name: 'KERNEL32.dll',
			symbols: [
				{ name: 'CreateFileW', iatRva: 0x2048n },
				{ name: 'ExitProcess', iatRva: 0x2050n },
				{ ordinal: 0x53, iatRva: 0x2058n },
			],
		}]);
	});

	test('serves an import directory the analysis server parsed', async function () {
		this.timeout(30_000);

		// The resolution tests below are only meaningful if the import table
		// really parsed, so establish that first: an empty list here is what a
		// wrong offset in the generated directory looks like.
		const session = await startImportSession();
		try {
			const { modules } = await session.getImports();
			// Every completeness field is asserted rather than elided. They are the
			// difference between "this module imports three symbols" and "three
			// symbols is all we managed to read", and a test that ignored them
			// would pass just as happily against a parser that had given up.
			assert.deepStrictEqual(modules, [{
				name: 'KERNEL32.dll',
				name_unreadable: false,
				symbols: [
					{ name: 'CreateFileW', iat_rva: '0x2048', name_unreadable: false },
					{ name: 'ExitProcess', iat_rva: '0x2050', name_unreadable: false },
					{ ordinal: 0x53, iat_rva: '0x2058', name_unreadable: false },
				],
				symbol_total: 3,
				symbols_failed: false,
				symbols_truncated: false,
			}]);
		} finally {
			session.dispose();
		}
	});

	test('names indirect calls that go through the import table', async function () {
		this.timeout(30_000);

		const session = await startImportSession();
		try {
			const graph = await session.callGraph(0x1000n, 16);
			assert.deepStrictEqual(graph, {
				function_rva: '0x1000',
				callers: [],
				// Both direct callees are one-instruction thunks. The edge still
				// names the thunk — that is where control goes — and
				// `resolved_import` names what the thunk is for.
				callees: [{
					site: '0x1000',
					target: '0x1013',
					kind: 'call',
					site_function_rva: '0x1000',
					target_function_rva: '0x1013',
					tail_call: false,
					resolved_import: {
						iat_rva: '0x2050',
						module: 'KERNEL32.dll',
						symbol: 'ExitProcess',
						method: 'importThunk',
						confidence: 'exact',
					},
				}, {
					site: '0x100B',
					target: '0x1019',
					kind: 'call',
					site_function_rva: '0x1000',
					target_function_rva: '0x1019',
					tail_call: false,
					// An import by ordinal names no symbol. Absent, not empty:
					// the import table genuinely does not carry a name for it.
					resolved_import: {
						iat_rva: '0x2058',
						module: 'KERNEL32.dll',
						ordinal: 0x53,
						method: 'importThunk',
						confidence: 'exact',
					},
				}],
				indirect_call_sites: [{
					// `call [rip+X]` — the call's own operand names the slot, so
					// nothing had to be followed to name it.
					site: '0x1005',
					resolved: {
						iat_rva: '0x2048',
						module: 'KERNEL32.dll',
						symbol: 'CreateFileW',
						method: 'iatOperand',
						confidence: 'exact',
					},
				}, {
					// `call rax` still resolves to nothing, and has to keep
					// saying so beside the two that did resolve.
					site: '0x1010',
				}],
				caller_total: 0,
				callee_total: 2,
				indirect_call_site_total: 2,
				unresolved_indirect_call_site_total: 1,
				callers_truncated: false,
				callees_truncated: false,
				indirect_truncated: false,
				bounded: false,
				// Both IAT slots resolved, so nothing about this graph's import
				// naming is missing — which is what lets the one unresolved
				// `call rax` stand out as a real gap rather than as a symptom.
				import_resolution_incomplete: false,
			});
		} finally {
			session.dispose();
		}
	});

	test('splits resolved from unresolved indirect call sites in the profile', async function () {
		this.timeout(30_000);

		const session = await startImportSession();
		try {
			const profile = await session.functionProfile(0x1000n);
			assert.deepStrictEqual(profile, {
				function_rva: '0x1000',
				bounded: false,
				instruction_count: 5,
				decoded_extent_bytes: 19,
				block_count: 1,
				edge_count: 0,
				incoming_call_site_count: 0,
				incoming_caller_function_count: 0,
				outgoing_call_site_count: 2,
				outgoing_target_function_count: 2,
				// Two indirect sites, one of which the IAT names. The other is
				// `call rax`, and the difference between the two numbers is the
				// whole point: it is what tells an agent how much of this
				// function's outgoing behaviour is still unaccounted for.
				indirect_call_site_count: 2,
				resolved_indirect_call_site_count: 1,
				return_count: 1,
			});
		} finally {
			session.dispose();
		}
	});

	test('refuses a structure query for an address that is not a function entry', async function () {
		this.timeout(30_000);

		const session = await startCallSession();
		try {
			// Answering for the enclosing function would silently reinterpret the
			// question, so exact resolution fails closed instead.
			await assert.rejects(
				session.callGraph(0x1005n, 16),
				/no detected function starts at 0x1005/,
			);
		} finally {
			session.dispose();
		}
	});

	test('serves verified image and file bytes from provider frames', async function () {
		this.timeout(30_000);

		const session = await DelverAnalysisSession.start({ kind: 'file', path }, collectDiagnostics);
		try {
			const [image, file] = await Promise.all([
				session.readMemory('Image', 0x1000n, 8),
				session.readMemory('File', 0n, 2),
			]);
			assert.deepStrictEqual({ image, file }, {
				image: {
					bytesHex: '4889d84883c001c3',
					valid: [{ start: '0x1000', end: '0x1008' }],
					servedMoment: { kind: 'static', epoch: '0x0' },
				},
				file: {
					bytesHex: '4d5a',
					valid: [{ start: '0x0', end: '0x2' }],
					servedMoment: { kind: 'static', epoch: '0x0' },
				},
			});
		} finally {
			session.dispose();
		}
	});

	test('reports a missing provider immediately instead of as a listening timeout', async () => {
		const missing = spawn(`delver-provider-that-does-not-exist-${process.pid}`);
		await assert.rejects(
			waitForListening(missing, 'provider-file', 10_000),
			/error|ENOENT|failed to start/i,
		);
	});
});
