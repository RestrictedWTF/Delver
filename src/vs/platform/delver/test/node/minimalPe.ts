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

/** `mov rax,rbx` / `add rax,1` / `ret` */
export const DEFAULT_CODE = Buffer.from([0x48, 0x89, 0xd8, 0x48, 0x83, 0xc0, 0x01, 0xc3]);

/**
 * Returns the bytes of a single-section x64 PE whose entry point is `code`.
 */
export function buildMinimalPe(code: Buffer = DEFAULT_CODE): Buffer {
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
	headers.writeUInt16LE(1, offset + 2); // NumberOfSections
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
	headers.writeUInt32LE(0, offset + 8); // SizeOfInitializedData
	headers.writeUInt32LE(0, offset + 12); // SizeOfUninitializedData
	headers.writeUInt32LE(SECTION_ALIGNMENT, offset + 16); // AddressOfEntryPoint
	headers.writeUInt32LE(SECTION_ALIGNMENT, offset + 20); // BaseOfCode
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
	headers.writeUInt32LE(SECTION_ALIGNMENT * 2, offset + 56); // SizeOfImage
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
	// The 16 data directories stay zeroed: no imports, exports, or exception data.
	offset += OPTIONAL_HEADER_SIZE;

	// Section header for .text.
	headers.write('.text\0\0\0', offset, 'ascii');
	headers.writeUInt32LE(code.length, offset + 8); // VirtualSize
	headers.writeUInt32LE(SECTION_ALIGNMENT, offset + 12); // VirtualAddress
	headers.writeUInt32LE(FILE_ALIGNMENT, offset + 16); // SizeOfRawData
	headers.writeUInt32LE(FILE_ALIGNMENT, offset + 20); // PointerToRawData
	headers.writeUInt32LE(0, offset + 24); // PointerToRelocations
	headers.writeUInt32LE(0, offset + 28); // PointerToLinenumbers
	headers.writeUInt16LE(0, offset + 32); // NumberOfRelocations
	headers.writeUInt16LE(0, offset + 34); // NumberOfLinenumbers
	headers.writeUInt32LE(0x60000020, offset + 36); // CODE | EXECUTE | READ

	const section = Buffer.alloc(FILE_ALIGNMENT);
	code.copy(section, 0);

	return Buffer.concat([headers, section]);
}
