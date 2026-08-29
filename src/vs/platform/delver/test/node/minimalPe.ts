/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Builds a minimal valid PE32+ image for tests.
 *
 * Tests need a *small* real PE. `process.execPath` is one, but Node is ~92 MB
 * and decodes to nearly nine million instructions, which turns a unit test into
 * a ninety-second analysis run. System DLLs are small enough but are neither
 * guaranteed present nor redistributable.
 *
 * Generating one is the same answer the golden corpus reached (Stage D decision
 * F4): small, deterministic, and dependency-free. This image is parseable and
 * deliberately not loadable.
 */

const FILE_ALIGNMENT = 0x200;
const SECTION_ALIGNMENT = 0x1000;
const OPTIONAL_HEADER_SIZE = 240;

/** RVA of the generated `.text` section. */
const TEXT_RVA = 0x1000;

/**
 * RVA of the generated `.idata` section.
 *
 * Fixed rather than derived from the code length so that a fixture can plan the
 * import layout — and therefore compute RIP-relative displacements — *before*
 * the code that uses those displacements exists. The cost is a 4 KB cap on
 * fixture code, enforced in {@link buildMinimalPe}.
 */
const IMPORT_SECTION_RVA = 0x2000;

/** Offset of the first data directory inside a PE32+ optional header. */
const DATA_DIRECTORY_OFFSET = 112;
/** `IMAGE_DIRECTORY_ENTRY_IMPORT`. */
const DIRECTORY_ENTRY_IMPORT = 1;
/** `IMAGE_DIRECTORY_ENTRY_IAT`. */
const DIRECTORY_ENTRY_IAT = 12;
/** Bytes per data directory entry: a `u32` RVA and a `u32` size. */
const DATA_DIRECTORY_ENTRY_SIZE = 8;
/** `sizeof(IMAGE_IMPORT_DESCRIPTOR)`. */
const IMPORT_DESCRIPTOR_SIZE = 20;
/** `sizeof(IMAGE_THUNK_DATA64)`. */
const THUNK_SIZE = 8;
/** Bytes per section header. */
const SECTION_HEADER_SIZE = 40;
/** `IMAGE_ORDINAL_FLAG64` — set in a thunk that imports by ordinal. */
const ORDINAL_FLAG = 0x8000000000000000n;
/** Mask `object`'s `ImageThunkData64::address` applies to a name thunk. */
const THUNK_ADDRESS_MASK = 0x7fffffffn;

/** `CODE | EXECUTE | READ`. */
const TEXT_CHARACTERISTICS = 0x60000020;
/** `INITIALIZED_DATA | READ | WRITE`. */
const IDATA_CHARACTERISTICS = 0xc0000040;

/** `mov rax,rbx` / `add rax,1` / `ret` */
export const DEFAULT_CODE = Buffer.from([0x48, 0x89, 0xd8, 0x48, 0x83, 0xc0, 0x01, 0xc3]);

/**
 * One symbol to import. Exactly one of `name` and `ordinal` must be present:
 * the two are different thunk encodings, and the resolution code in
 * `delver-analysis` distinguishes them.
 */
export interface IPeImportSymbol {
	/** Symbol name, for an import by name. */
	readonly name?: string;
	/** Ordinal, for an import by ordinal. */
	readonly ordinal?: number;
}

/** One module to import from. */
export interface IPeImportModule {
	/** Module name as it appears in the import descriptor, e.g. `KERNEL32.dll`. */
	readonly name: string;
	/** Symbols imported from this module, in table order. */
	readonly symbols: readonly IPeImportSymbol[];
}

/** Where {@link planPeImports} placed one module's import structures. */
export interface IPeImportModuleLayout {
	/** Module name, echoed for readability at the call site. */
	readonly name: string;
	/** RVA of the module's NUL-terminated name string. */
	readonly nameRva: bigint;
	/** RVA of the module's import lookup table (`OriginalFirstThunk`). */
	readonly iltRva: bigint;
	/** RVA of the module's import address table (`FirstThunk`). */
	readonly iatRva: bigint;
	/**
	 * RVA of each IAT slot, in `symbols` order. This is what a `call [rip+X]`
	 * operand has to name for `resolve_iat_operand` to resolve it.
	 */
	readonly iatRvas: readonly bigint[];
	/** RVA of each hint/name entry; `undefined` for an import by ordinal. */
	readonly hintNameRvas: readonly (bigint | undefined)[];
}

/**
 * Where {@link planPeImports} placed the whole import directory.
 *
 * Every RVA is absolute (already offset by {@link IMPORT_SECTION_RVA}), because
 * every consumer — a displacement calculation, a wire assertion — wants it that
 * way.
 */
export interface IPeImportLayout {
	/** RVA of the `.idata` section these structures live in. */
	readonly sectionRva: bigint;
	/** Total bytes the import structures occupy. */
	readonly size: number;
	/** RVA of the `IMAGE_IMPORT_DESCRIPTOR` array — data directory entry 1. */
	readonly directoryRva: bigint;
	/** Size of the descriptor array, terminator included. */
	readonly directorySize: number;
	/** RVA of the first module's IAT — data directory entry 12. */
	readonly iatRva: bigint;
	/** Total bytes every module's IAT occupies, terminators included. */
	readonly iatSize: number;
	/** Per-module placement, in the order the modules were given. */
	readonly modules: readonly IPeImportModuleLayout[];
}

/** Rounds `value` up to the next multiple of `alignment`. */
function alignUp(value: number, alignment: number): number {
	return Math.ceil(value / alignment) * alignment;
}

/** Reads a NUL-terminated ASCII string. */
function readAsciiz(buffer: Buffer, offset: number): string {
	const end = buffer.indexOf(0, offset);
	return buffer.toString('ascii', offset, end === -1 ? buffer.length : end);
}

/**
 * Decides where every import structure goes, without writing a byte.
 *
 * Splitting the plan from the write is what lets a code fixture compute a
 * RIP-relative displacement against the slot it is about to reference. The
 * layout is a single contiguous blob at {@link IMPORT_SECTION_RVA}, emitted in
 * this order so that each group is contiguous and can be described by one data
 * directory entry:
 *
 * ```
 * +0x00  IMAGE_IMPORT_DESCRIPTOR[modules.length + 1]   20 bytes each, zero-terminated
 *        import lookup table, per module               (symbols + 1) * 8, zero-terminated
 *        import address table, per module              (symbols + 1) * 8, zero-terminated
 *        module name strings                           NUL-terminated, padded to 2
 *        hint/name entries, per named symbol           u16 hint + NUL-terminated name, padded to 2
 * ```
 *
 * Everything lives in one section on purpose: the `object` crate resolves an
 * import RVA against the single section *containing the import directory*, so a
 * thunk or name string placed elsewhere would be unreachable.
 */
export function planPeImports(modules: readonly IPeImportModule[]): IPeImportLayout {
	const base = IMPORT_SECTION_RVA;
	const descriptorSize = (modules.length + 1) * IMPORT_DESCRIPTOR_SIZE;
	let cursor = descriptorSize;

	// Import lookup tables, one per module, each with a null terminator.
	const iltOffsets = modules.map(module => {
		const offset = cursor;
		cursor += (module.symbols.length + 1) * THUNK_SIZE;
		return offset;
	});

	// Import address tables, laid out together so data directory entry 12 can
	// describe them all with one range.
	const iatStart = cursor;
	const iatOffsets = modules.map(module => {
		const offset = cursor;
		cursor += (module.symbols.length + 1) * THUNK_SIZE;
		return offset;
	});
	const iatSize = cursor - iatStart;

	// Module name strings. Padded to two so the hint/name entries that follow
	// stay `u16`-aligned.
	const nameOffsets = modules.map(module => {
		const offset = cursor;
		cursor += alignUp(module.name.length + 1, 2);
		return offset;
	});

	// Hint/name entries: `u16` hint, then the NUL-terminated name.
	const hintNameOffsets = modules.map(module => module.symbols.map(symbol => {
		if (symbol.name === undefined) {
			return undefined;
		}
		const offset = cursor;
		cursor += alignUp(2 + symbol.name.length + 1, 2);
		return offset;
	}));

	return {
		sectionRva: BigInt(base),
		size: cursor,
		directoryRva: BigInt(base),
		directorySize: descriptorSize,
		iatRva: BigInt(base + iatStart),
		iatSize,
		modules: modules.map((module, index) => ({
			name: module.name,
			nameRva: BigInt(base + nameOffsets[index]),
			iltRva: BigInt(base + iltOffsets[index]),
			iatRva: BigInt(base + iatOffsets[index]),
			iatRvas: module.symbols.map((_, slot) => BigInt(base + iatOffsets[index] + slot * THUNK_SIZE)),
			hintNameRvas: hintNameOffsets[index].map(offset => offset === undefined ? undefined : BigInt(base + offset)),
		})),
	};
}

/** Writes the bytes {@link planPeImports} planned. */
function buildImportSection(modules: readonly IPeImportModule[], layout: IPeImportLayout): Buffer {
	const blob = Buffer.alloc(layout.size);
	const at = (rva: bigint): number => Number(rva - layout.sectionRva);

	modules.forEach((module, index) => {
		const placed = layout.modules[index];

		// IMAGE_IMPORT_DESCRIPTOR. The trailing all-zero descriptor is the
		// terminator, and the buffer is already zeroed, so it needs no write.
		const descriptor = index * IMPORT_DESCRIPTOR_SIZE;
		blob.writeUInt32LE(Number(placed.iltRva), descriptor); // OriginalFirstThunk
		blob.writeUInt32LE(0, descriptor + 4); // TimeDateStamp — unbound
		blob.writeUInt32LE(0, descriptor + 8); // ForwarderChain
		blob.writeUInt32LE(Number(placed.nameRva), descriptor + 12); // Name
		blob.writeUInt32LE(Number(placed.iatRva), descriptor + 16); // FirstThunk

		module.symbols.forEach((symbol, slot) => {
			const hintName = placed.hintNameRvas[slot];
			if ((symbol.name === undefined) === (symbol.ordinal === undefined)) {
				throw new Error(`import ${module.name}[${slot}] must have exactly one of name and ordinal`);
			}
			// An unbound image holds the same thunks in both tables: the loader
			// overwrites the IAT copy at load time, which never happens here.
			const thunk = hintName !== undefined
				? hintName
				: ORDINAL_FLAG | BigInt(symbol.ordinal ?? 0);
			blob.writeBigUInt64LE(thunk, at(placed.iltRva) + slot * THUNK_SIZE);
			blob.writeBigUInt64LE(thunk, at(placed.iatRva) + slot * THUNK_SIZE);
		});

		blob.write(`${module.name}\0`, at(placed.nameRva), 'ascii');

		module.symbols.forEach((symbol, slot) => {
			const hintName = placed.hintNameRvas[slot];
			const name = symbol.name;
			if (hintName === undefined || name === undefined) {
				return;
			}
			// A zero hint is legal: it is a lookup optimisation for the loader,
			// not part of the identity of the import.
			blob.writeUInt16LE(0, at(hintName));
			blob.write(`${name}\0`, at(hintName) + 2, 'ascii');
		});
	});

	return blob;
}

/** Writes one 40-byte `IMAGE_SECTION_HEADER`. */
function writeSectionHeader(
	headers: Buffer,
	offset: number,
	name: string,
	virtualAddress: number,
	virtualSize: number,
	rawPointer: number,
	rawSize: number,
	characteristics: number,
): void {
	headers.write(name.padEnd(8, '\0'), offset, 'ascii');
	headers.writeUInt32LE(virtualSize, offset + 8);
	headers.writeUInt32LE(virtualAddress, offset + 12);
	headers.writeUInt32LE(rawSize, offset + 16);
	headers.writeUInt32LE(rawPointer, offset + 20);
	headers.writeUInt32LE(0, offset + 24); // PointerToRelocations
	headers.writeUInt32LE(0, offset + 28); // PointerToLinenumbers
	headers.writeUInt16LE(0, offset + 32); // NumberOfRelocations
	headers.writeUInt16LE(0, offset + 34); // NumberOfLinenumbers
	headers.writeUInt32LE(characteristics, offset + 36);
}

/**
 * Returns the bytes of an x64 PE whose entry point is `code`.
 *
 * With no `imports` the result is a single `.text` section and sixteen zeroed
 * data directories — the shape most of the suite depends on. Passing `imports`
 * adds a second `.idata` section at {@link IMPORT_SECTION_RVA} and points data
 * directory entry 1 at it; nothing else about the image changes.
 */
export function buildMinimalPe(code: Buffer = DEFAULT_CODE, imports?: readonly IPeImportModule[]): Buffer {
	if (code.length > SECTION_ALIGNMENT) {
		// `.idata` sits at a fixed RVA one section-alignment past `.text`, so
		// code larger than that would overlap it.
		throw new Error(`fixture code must fit in ${SECTION_ALIGNMENT} bytes, got ${code.length}`);
	}

	const layout = imports !== undefined && imports.length > 0 ? planPeImports(imports) : undefined;
	const importSection = layout !== undefined && imports !== undefined
		? buildImportSection(imports, layout)
		: undefined;

	const sectionCount = importSection !== undefined ? 2 : 1;
	const textRawPointer = FILE_ALIGNMENT;
	const textRawSize = Math.max(alignUp(code.length, FILE_ALIGNMENT), FILE_ALIGNMENT);
	const importRawPointer = textRawPointer + textRawSize;
	const importRawSize = importSection !== undefined
		? Math.max(alignUp(importSection.length, FILE_ALIGNMENT), FILE_ALIGNMENT)
		: 0;
	const sizeOfImage = importSection !== undefined
		? alignUp(IMPORT_SECTION_RVA + importSection.length, SECTION_ALIGNMENT)
		: alignUp(TEXT_RVA + code.length, SECTION_ALIGNMENT);

	const headers = Buffer.alloc(FILE_ALIGNMENT);
	let offset = 0;

	// DOS header: signature plus the offset of the PE header at 0x3C.
	headers.write('MZ', 0, 'ascii');
	headers.writeUInt32LE(0x80, 0x3c);
	offset = 0x80;

	headers.write('PE\0\0', offset, 'ascii');
	offset += 4;

	// COFF header.
	headers.writeUInt16LE(0x8664, offset); // Machine: AMD64
	headers.writeUInt16LE(sectionCount, offset + 2); // NumberOfSections
	headers.writeUInt32LE(0, offset + 4); // TimeDateStamp — zero keeps output stable
	headers.writeUInt32LE(0, offset + 8); // PointerToSymbolTable
	headers.writeUInt32LE(0, offset + 12); // NumberOfSymbols
	headers.writeUInt16LE(OPTIONAL_HEADER_SIZE, offset + 16);
	headers.writeUInt16LE(0x0022, offset + 18); // EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE
	offset += 20;

	// Optional header (PE32+).
	headers.writeUInt16LE(0x20b, offset); // Magic
	headers.writeUInt8(14, offset + 2); // MajorLinkerVersion
	headers.writeUInt8(0, offset + 3);
	headers.writeUInt32LE(code.length, offset + 4); // SizeOfCode
	headers.writeUInt32LE(importRawSize, offset + 8); // SizeOfInitializedData
	headers.writeUInt32LE(0, offset + 12); // SizeOfUninitializedData
	headers.writeUInt32LE(TEXT_RVA, offset + 16); // AddressOfEntryPoint
	headers.writeUInt32LE(TEXT_RVA, offset + 20); // BaseOfCode
	headers.writeBigUInt64LE(0x140000000n, offset + 24); // ImageBase
	headers.writeUInt32LE(SECTION_ALIGNMENT, offset + 32);
	headers.writeUInt32LE(FILE_ALIGNMENT, offset + 36);
	headers.writeUInt16LE(6, offset + 40); // MajorOperatingSystemVersion
	headers.writeUInt16LE(0, offset + 42);
	headers.writeUInt16LE(0, offset + 44); // MajorImageVersion
	headers.writeUInt16LE(0, offset + 46);
	headers.writeUInt16LE(6, offset + 48); // MajorSubsystemVersion
	headers.writeUInt16LE(0, offset + 50);
	headers.writeUInt32LE(0, offset + 52); // Win32VersionValue
	headers.writeUInt32LE(sizeOfImage, offset + 56); // SizeOfImage
	headers.writeUInt32LE(FILE_ALIGNMENT, offset + 60); // SizeOfHeaders
	headers.writeUInt32LE(0, offset + 64); // CheckSum
	headers.writeUInt16LE(3, offset + 68); // Subsystem: CONSOLE
	headers.writeUInt16LE(0, offset + 70); // DllCharacteristics
	headers.writeBigUInt64LE(0x100000n, offset + 72); // SizeOfStackReserve
	headers.writeBigUInt64LE(0x1000n, offset + 80); // SizeOfStackCommit
	headers.writeBigUInt64LE(0x100000n, offset + 88); // SizeOfHeapReserve
	headers.writeBigUInt64LE(0x1000n, offset + 96); // SizeOfHeapCommit
	headers.writeUInt32LE(0, offset + 104); // LoaderFlags
	headers.writeUInt32LE(16, offset + 108); // NumberOfRvaAndSizes
	if (layout !== undefined) {
		// Only entries 1 (import) and 12 (IAT) are filled in; the other fourteen
		// stay zeroed, so there are still no exports, relocations, or exception
		// data to find.
		const directories = offset + DATA_DIRECTORY_OFFSET;
		const importEntry = directories + DIRECTORY_ENTRY_IMPORT * DATA_DIRECTORY_ENTRY_SIZE;
		headers.writeUInt32LE(Number(layout.directoryRva), importEntry);
		headers.writeUInt32LE(layout.directorySize, importEntry + 4);
		const iatEntry = directories + DIRECTORY_ENTRY_IAT * DATA_DIRECTORY_ENTRY_SIZE;
		headers.writeUInt32LE(Number(layout.iatRva), iatEntry);
		headers.writeUInt32LE(layout.iatSize, iatEntry + 4);
	}
	offset += OPTIONAL_HEADER_SIZE;

	// Section headers begin at 0x188 and run 40 bytes each, so two of them end
	// at 0x1D8 — still inside the 0x200 header region declared above.
	writeSectionHeader(
		headers, offset, '.text',
		TEXT_RVA, code.length, textRawPointer, textRawSize, TEXT_CHARACTERISTICS,
	);
	offset += SECTION_HEADER_SIZE;

	if (importSection === undefined) {
		return Buffer.concat([headers, padTo(code, textRawSize)]);
	}

	// VirtualSize is rounded up rather than set to the exact content length. A
	// reader maps `min(VirtualSize, SizeOfRawData)` bytes, so an exact length
	// puts the final hint/name entry flush against the boundary and leaves an
	// off-by-one in any containment check nowhere to fail safely. Real linkers
	// round here too; the padding is zero bytes past the last descriptor and
	// changes no RVA.
	const importVirtualSize = Math.ceil(importSection.length / 16) * 16;
	writeSectionHeader(
		headers, offset, '.idata',
		IMPORT_SECTION_RVA, importVirtualSize, importRawPointer, importRawSize, IDATA_CHARACTERISTICS,
	);
	return Buffer.concat([headers, padTo(code, textRawSize), padTo(importSection, importRawSize)]);
}

/** Copies `content` into a zero-filled buffer of `size` bytes. */
function padTo(content: Buffer, size: number): Buffer {
	const padded = Buffer.alloc(size);
	content.copy(padded, 0);
	return padded;
}

/** One symbol {@link readPeImports} found. */
export interface IPeParsedImportSymbol {
	/** Symbol name, absent for an import by ordinal. */
	readonly name?: string;
	/** Ordinal, absent for an import by name. */
	readonly ordinal?: number;
	/** RVA of the IAT slot this symbol occupies. */
	readonly iatRva: bigint;
}

/** One module {@link readPeImports} found. */
export interface IPeParsedImportModule {
	/** Module name read from the descriptor. */
	readonly name: string;
	/** Symbols in table order. */
	readonly symbols: readonly IPeParsedImportSymbol[];
}

/**
 * Re-reads the import directory out of a built image.
 *
 * This navigates from the DOS header the way a real parser does — PE signature,
 * optional header, data directory 1, section table for every RVA — and shares
 * no offset arithmetic with the writer above. That makes it a useful check on
 * the writer, and only that: agreeing with itself is *not* evidence that the
 * `object` crate accepts the image. Only running the analysis server against it
 * proves that.
 */
export function readPeImports(pe: Buffer): IPeParsedImportModule[] {
	const peOffset = pe.readUInt32LE(0x3c);
	if (pe.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
		throw new Error('not a PE image');
	}
	const coff = peOffset + 4;
	const sectionCount = pe.readUInt16LE(coff + 2);
	const optionalHeaderSize = pe.readUInt16LE(coff + 16);
	const optional = coff + 20;
	if (pe.readUInt16LE(optional) !== 0x20b) {
		throw new Error('not a PE32+ image');
	}
	const sectionTable = optional + optionalHeaderSize;

	/**
	 * Maps an RVA to a file offset the way `object` does: a section covers
	 * `min(VirtualSize, SizeOfRawData)` bytes, never more.
	 */
	const fileOffset = (rva: number): number => {
		for (let index = 0; index < sectionCount; index++) {
			const header = sectionTable + index * SECTION_HEADER_SIZE;
			const virtualAddress = pe.readUInt32LE(header + 12);
			const size = Math.min(pe.readUInt32LE(header + 8), pe.readUInt32LE(header + 16));
			if (rva >= virtualAddress && rva < virtualAddress + size) {
				return pe.readUInt32LE(header + 20) + (rva - virtualAddress);
			}
		}
		throw new Error(`RVA 0x${rva.toString(16)} is in no section`);
	};

	const directory = optional + DATA_DIRECTORY_OFFSET + DIRECTORY_ENTRY_IMPORT * DATA_DIRECTORY_ENTRY_SIZE;
	const directoryRva = pe.readUInt32LE(directory);
	if (directoryRva === 0) {
		return [];
	}

	const modules: IPeParsedImportModule[] = [];
	for (let index = 0; ; index++) {
		const descriptor = fileOffset(directoryRva) + index * IMPORT_DESCRIPTOR_SIZE;
		const originalFirstThunk = pe.readUInt32LE(descriptor);
		const nameRva = pe.readUInt32LE(descriptor + 12);
		const firstThunk = pe.readUInt32LE(descriptor + 16);
		if (originalFirstThunk === 0 && nameRva === 0 && firstThunk === 0) {
			break;
		}

		const symbols: IPeParsedImportSymbol[] = [];
		const thunkRva = originalFirstThunk === 0 ? firstThunk : originalFirstThunk;
		for (let slot = 0; ; slot++) {
			const thunk = pe.readBigUInt64LE(fileOffset(thunkRva + slot * THUNK_SIZE));
			if (thunk === 0n) {
				break;
			}
			const iatRva = BigInt(firstThunk + slot * THUNK_SIZE);
			if ((thunk & ORDINAL_FLAG) !== 0n) {
				symbols.push({ ordinal: Number(thunk & 0xffffn), iatRva });
			} else {
				const hintName = fileOffset(Number(thunk & THUNK_ADDRESS_MASK));
				symbols.push({ name: readAsciiz(pe, hintName + 2), iatRva });
			}
		}

		modules.push({ name: readAsciiz(pe, fileOffset(nameRva)), symbols });
	}
	return modules;
}
