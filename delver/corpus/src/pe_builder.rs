//! Synthesises minimal but valid PE images for the golden corpus.
//!
//! ## Why synthesise rather than commit real binaries
//!
//! Stage D decision F4 requires corpus samples to be **benign and
//! redistributable**. Windows system DLLs are neither redistributable nor
//! reviewable, and a compiled sample would need a toolchain in CI plus a
//! committed artifact nobody can diff.
//!
//! Generated images are small, deterministic, reviewable as source, trivially
//! redistributable, and — the part that matters most — let the corpus contain
//! edge cases that are hard to find in the wild.
//!
//! These images are deliberately *not* loadable. They exist to be parsed.

use std::collections::BTreeMap;

const FILE_ALIGNMENT: u32 = 0x200;
const SECTION_ALIGNMENT: u32 = 0x1000;

const DIRECTORY_EXPORT: usize = 0;
const DIRECTORY_IMPORT: usize = 1;
const DIRECTORY_EXCEPTION: usize = 3;
const DIRECTORY_COUNT: usize = 16;

/// Which machine the generated image targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Machine {
	/// x86-64. Carries an exception directory.
	Amd64,
	/// 32-bit x86. Has no exception directory, by architecture.
	I386,
}

impl Machine {
	fn value(self) -> u16 {
		match self {
			Self::Amd64 => 0x8664,
			Self::I386 => 0x014C,
		}
	}

	fn is_64(self) -> bool {
		matches!(self, Self::Amd64)
	}
}

/// A section to place in the generated image.
struct SectionSpec {
	name: &'static str,
	characteristics: u32,
	data: Vec<u8>,
}

/// A function range to publish in the exception directory.
#[derive(Debug, Clone, Copy)]
pub struct RuntimeFunction {
	/// Start RVA.
	pub begin: u32,
	/// Exclusive end RVA.
	pub end: u32,
	/// When set, this entry is a fragment of the function starting at that RVA:
	/// its `UNWIND_INFO` carries `UNW_FLAG_CHAININFO` and it is not a function
	/// start. Real compilers emit these whenever they split a function.
	pub chained_to: Option<u32>,
}

/// Bytes each synthetic `UNWIND_INFO` record occupies.
///
/// Fixed so an entry's record address is `xdata_rva + index * stride`, which
/// keeps the directory writable before the records themselves exist.
const UNWIND_RECORD_SIZE: u32 = 16;

/// Builds one synthetic PE image.
pub struct PeBuilder {
	machine: Machine,
	image_base: u64,
	entry_rva: u32,
	code: Vec<u8>,
	runtime_functions: Vec<RuntimeFunction>,
	imports: BTreeMap<&'static str, Vec<&'static str>>,
	exports: Vec<Option<(&'static str, u32)>>,
	data: Vec<u8>,
	rtti_classes: Vec<RttiClassSpec>,
	trailing_code_pointers: Vec<u32>,
}

/// One MSVC RTTI class to synthesise: a type descriptor, a complete-object
/// locator, and the vftable whose slot `-1` names that locator.
///
/// Only the *declaration* lives here. Every RVA in the emitted records — the
/// locator's self-reference above all — is computed by [`PeBuilder::build`],
/// which is the only thing that knows where the section lands.
struct RttiClassSpec {
	decorated_name: &'static str,
	base_offset: i32,
	method_rvas: Vec<u32>,
}

impl PeBuilder {
	/// Starts a builder for `machine`.
	pub fn new(machine: Machine) -> Self {
		Self {
			machine,
			image_base: if machine.is_64() {
				0x1_4000_0000
			} else {
				0x0040_0000
			},
			entry_rva: 0,
			code: Vec::new(),
			runtime_functions: Vec::new(),
			imports: BTreeMap::new(),
			exports: Vec::new(),
			data: Vec::new(),
			rtti_classes: Vec::new(),
			trailing_code_pointers: Vec::new(),
		}
	}

	/// Sets the `.text` contents. The section is placed at RVA 0x1000.
	pub fn code(mut self, bytes: &[u8]) -> Self {
		self.code = bytes.to_vec();
		self
	}

	/// Sets the entry point RVA.
	pub fn entry(mut self, rva: u32) -> Self {
		self.entry_rva = rva;
		self
	}

	/// Publishes a function range in the exception directory.
	pub fn runtime_function(mut self, begin: u32, end: u32) -> Self {
		self.runtime_functions.push(RuntimeFunction {
			begin,
			end,
			chained_to: None,
		});
		self
	}

	/// Publishes a *fragment* of `primary` in the exception directory.
	///
	/// The entry looks exactly like a function to anything that reads only
	/// `BeginAddress`, which is what makes it worth a fixture.
	pub fn runtime_function_fragment(mut self, begin: u32, end: u32, primary: u32) -> Self {
		self.runtime_functions.push(RuntimeFunction {
			begin,
			end,
			chained_to: Some(primary),
		});
		self
	}

	/// Adds an imported symbol.
	pub fn import(mut self, module: &'static str, symbol: &'static str) -> Self {
		self.imports.entry(module).or_default().push(symbol);
		self
	}

	/// Sets the `.data` contents.
	///
	/// The section is writable, readable and **not** executable, and is placed
	/// immediately after `.text` so its RVA is [`PeBuilder::DATA_RVA`] for any
	/// image whose code fits one section alignment. Exports pointed at it are
	/// what a data export looks like on disk.
	pub fn data(mut self, bytes: &[u8]) -> Self {
		self.data = bytes.to_vec();
		self
	}

	/// RVA of the `.data` section, when `.text` fits one section alignment.
	pub const DATA_RVA: u32 = 2 * SECTION_ALIGNMENT;

	/// Publishes `name` in the export directory at `rva`.
	///
	/// The RVA is stored verbatim, with no check on where it lands: an export
	/// naming a global in `.data` is exactly as legal as one naming a function
	/// in `.text`, and telling the two apart is the parser's job, not the
	/// builder's.
	pub fn export(mut self, name: &'static str, rva: u32) -> Self {
		self.exports.push(Some((name, rva)));
		self
	}

	/// Adds an empty slot to the export address table.
	///
	/// The export directory declares one contiguous ordinal range, so an
	/// ordinal nobody exports still takes an entry, written as `0`. That is a
	/// hole, not a symbol at RVA `0`, and it consumes its ordinal: the exports
	/// after it keep the ordinals they would have had. A hole carries no name,
	/// so it appears in neither the name pointer table nor the ordinal table.
	pub fn export_hole(mut self) -> Self {
		self.exports.push(None);
		self
	}

	/// Declares an MSVC x64 RTTI class.
	///
	/// `decorated_name` is stored verbatim in the type descriptor and must
	/// begin `".?A"` to be accepted by the scan. `base_offset` is the locator's
	/// `offset` field — zero for single inheritance. `method_rvas` become the
	/// vftable's slots, in order; each should be a real function start, or the
	/// slot walk will refuse it.
	///
	/// The caller supplies none of the RVAs the records point at. The locator's
	/// `pSelf` has to equal the locator's own RVA, and the vftable holds
	/// absolute VAs, so both depend on where the section is finally placed —
	/// which only `build` knows.
	pub fn rtti_class(
		mut self,
		decorated_name: &'static str,
		base_offset: i32,
		method_rvas: &[u32],
	) -> Self {
		self.rtti_classes.push(RttiClassSpec {
			decorated_name,
			base_offset,
			method_rvas: method_rvas.to_vec(),
		});
		self
	}

	/// Appends absolute code pointers immediately after the last vftable's real
	/// slots, with no gap.
	///
	/// This exists to reproduce a defect: an array of pointers into executable
	/// memory that are *not* function entries, sitting directly behind the last
	/// RTTI vftable in the section. A slot walk that admits any executable
	/// pointer runs straight out of the table and into these.
	pub fn trailing_code_pointers(mut self, rvas: &[u32]) -> Self {
		self.trailing_code_pointers = rvas.to_vec();
		self
	}

	/// Emits the image bytes.
	pub fn build(self) -> Vec<u8> {
		// Section layout is decided before any bytes are written, because the
		// import directory has to embed RVAs for data it is itself part of.
		//
		// A section that ends up empty is not emitted, so every RVA after it
		// must be computed from what is *actually* placed. Deriving them from a
		// speculative layout puts the data directories out of step with the
		// section table — which is how the exception directory silently pointed
		// at the wrong RVA and produced no seeds.
		let text_rva = SECTION_ALIGNMENT;
		let text_size = align(self.code.len() as u32, FILE_ALIGNMENT).max(FILE_ALIGNMENT);

		let data_rva = text_rva + align(text_size, SECTION_ALIGNMENT);
		let data_span = if self.data.is_empty() {
			0
		} else {
			align(
				align(self.data.len() as u32, FILE_ALIGNMENT).max(FILE_ALIGNMENT),
				SECTION_ALIGNMENT,
			)
		};
		let rdata_rva = data_rva + data_span;
		let (mut idata, import_dir_size) = self.build_import_directory(rdata_rva);

		// RTTI shares `.rdata` with the import blob rather than claiming a
		// section of its own. Appending keeps the placement walk below — and
		// every RVA already derived from it — untouched, and it is what a real
		// linker does anyway. The records are emitted at the RVA they actually
		// land on, not a speculative one.
		if !self.rtti_classes.is_empty() {
			while idata.len() % 8 != 0 {
				idata.push(0);
			}
			let rtti_rva = rdata_rva + idata.len() as u32;
			idata.extend_from_slice(&self.build_rtti(rtti_rva));
		}

		// The export directory shares `.rdata` for the same reason RTTI does,
		// and is appended last so its own RVA is whatever is left.
		let mut export_dir = (0u32, 0u32);
		if !self.exports.is_empty() {
			while idata.len() % 4 != 0 {
				idata.push(0);
			}
			let export_rva = rdata_rva + idata.len() as u32;
			let blob = self.build_export_directory(export_rva);
			export_dir = (export_rva, blob.len() as u32);
			idata.extend_from_slice(&blob);
		}

		let mut sections = vec![SectionSpec {
			name: ".text",
			characteristics: 0x6000_0020, // CODE | EXECUTE | READ
			data: self.code.clone(),
		}];
		if !self.data.is_empty() {
			sections.push(SectionSpec {
				name: ".data",
				characteristics: 0xC000_0040, // INITIALIZED_DATA | READ | WRITE
				data: self.data.clone(),
			});
		}

		let mut next_rva = rdata_rva;
		if !idata.is_empty() {
			let raw = align(idata.len() as u32, FILE_ALIGNMENT).max(FILE_ALIGNMENT);
			sections.push(SectionSpec {
				name: ".rdata",
				characteristics: 0x4000_0040, // INITIALIZED_DATA | READ
				data: idata,
			});
			next_rva += align(raw, SECTION_ALIGNMENT);
		}

		// The directory has to name unwind records that do not exist yet, so
		// `.xdata`'s RVA is derived from `.pdata`'s known size rather than from
		// the placement walk below.
		let pdata_rva = next_rva;
		let pdata_size = (self.runtime_functions.len() * 12) as u32;
		let xdata_rva = pdata_rva
			+ align(
				align(pdata_size, FILE_ALIGNMENT).max(FILE_ALIGNMENT),
				SECTION_ALIGNMENT,
			);
		let pdata = self.build_exception_directory(xdata_rva);
		if !pdata.is_empty() {
			sections.push(SectionSpec {
				name: ".pdata",
				characteristics: 0x4000_0040,
				data: pdata,
			});
			sections.push(SectionSpec {
				name: ".xdata",
				characteristics: 0x4000_0040,
				data: self.build_unwind_info(xdata_rva),
			});
		}

		let optional_header_size: u16 = if self.machine.is_64() { 240 } else { 224 };
		let headers_size = 0x80 + 4 + 20 + optional_header_size as u32 + 40 * sections.len() as u32;
		let size_of_headers = align(headers_size, FILE_ALIGNMENT);

		let mut directories = [(0u32, 0u32); DIRECTORY_COUNT];
		if export_dir.1 > 0 {
			directories[DIRECTORY_EXPORT] = export_dir;
		}
		if import_dir_size > 0 {
			directories[DIRECTORY_IMPORT] = (rdata_rva, import_dir_size);
		}
		if !self.runtime_functions.is_empty() {
			directories[DIRECTORY_EXCEPTION] =
				(pdata_rva, (self.runtime_functions.len() * 12) as u32);
		}

		// Walk the sections once to assign file offsets and RVAs.
		let mut placed = Vec::new();
		let mut file_offset = size_of_headers;
		let mut rva = SECTION_ALIGNMENT;
		for section in &sections {
			let raw_size = align(section.data.len() as u32, FILE_ALIGNMENT).max(FILE_ALIGNMENT);
			placed.push((rva, file_offset, raw_size, section.data.len() as u32));
			file_offset += raw_size;
			rva += align(raw_size, SECTION_ALIGNMENT);
		}
		let size_of_image = rva;

		let mut out = Vec::new();
		self.write_dos_header(&mut out);
		self.write_pe_headers(
			&mut out,
			&sections,
			&placed,
			optional_header_size,
			size_of_headers,
			size_of_image,
			&directories,
		);

		out.resize(size_of_headers as usize, 0);
		for (section, (_, offset, raw_size, _)) in sections.iter().zip(placed.iter()) {
			out.resize(*offset as usize, 0);
			out.extend_from_slice(&section.data);
			out.resize((*offset + *raw_size) as usize, 0);
		}
		out
	}

	fn write_dos_header(&self, out: &mut Vec<u8>) {
		out.extend_from_slice(b"MZ");
		out.resize(0x3C, 0);
		out.extend_from_slice(&0x80u32.to_le_bytes()); // e_lfanew
		out.resize(0x80, 0);
	}

	#[allow(clippy::too_many_arguments)]
	fn write_pe_headers(
		&self,
		out: &mut Vec<u8>,
		sections: &[SectionSpec],
		placed: &[(u32, u32, u32, u32)],
		optional_header_size: u16,
		size_of_headers: u32,
		size_of_image: u32,
		directories: &[(u32, u32); DIRECTORY_COUNT],
	) {
		out.extend_from_slice(b"PE\0\0");

		// COFF header.
		out.extend_from_slice(&self.machine.value().to_le_bytes());
		out.extend_from_slice(&(sections.len() as u16).to_le_bytes());
		out.extend_from_slice(&0u32.to_le_bytes()); // TimeDateStamp — zero keeps output deterministic
		out.extend_from_slice(&0u32.to_le_bytes()); // PointerToSymbolTable
		out.extend_from_slice(&0u32.to_le_bytes()); // NumberOfSymbols
		out.extend_from_slice(&optional_header_size.to_le_bytes());
		out.extend_from_slice(&0x0022u16.to_le_bytes()); // EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE

		// Optional header.
		let magic: u16 = if self.machine.is_64() { 0x20B } else { 0x10B };
		out.extend_from_slice(&magic.to_le_bytes());
		out.push(14); // MajorLinkerVersion
		out.push(0); // MinorLinkerVersion
		out.extend_from_slice(&(self.code.len() as u32).to_le_bytes()); // SizeOfCode
		out.extend_from_slice(&0u32.to_le_bytes()); // SizeOfInitializedData
		out.extend_from_slice(&0u32.to_le_bytes()); // SizeOfUninitializedData
		out.extend_from_slice(&self.entry_rva.to_le_bytes());
		out.extend_from_slice(&SECTION_ALIGNMENT.to_le_bytes()); // BaseOfCode

		if self.machine.is_64() {
			out.extend_from_slice(&self.image_base.to_le_bytes());
		} else {
			out.extend_from_slice(&0u32.to_le_bytes()); // BaseOfData
			out.extend_from_slice(&(self.image_base as u32).to_le_bytes());
		}

		out.extend_from_slice(&SECTION_ALIGNMENT.to_le_bytes());
		out.extend_from_slice(&FILE_ALIGNMENT.to_le_bytes());
		out.extend_from_slice(&6u16.to_le_bytes()); // MajorOperatingSystemVersion
		out.extend_from_slice(&0u16.to_le_bytes());
		out.extend_from_slice(&0u16.to_le_bytes()); // MajorImageVersion
		out.extend_from_slice(&0u16.to_le_bytes());
		out.extend_from_slice(&6u16.to_le_bytes()); // MajorSubsystemVersion
		out.extend_from_slice(&0u16.to_le_bytes());
		out.extend_from_slice(&0u32.to_le_bytes()); // Win32VersionValue
		out.extend_from_slice(&size_of_image.to_le_bytes());
		out.extend_from_slice(&size_of_headers.to_le_bytes());
		out.extend_from_slice(&0u32.to_le_bytes()); // CheckSum
		out.extend_from_slice(&3u16.to_le_bytes()); // Subsystem: CONSOLE
		out.extend_from_slice(&0u16.to_le_bytes()); // DllCharacteristics

		if self.machine.is_64() {
			for value in [0x100000u64, 0x1000, 0x100000, 0x1000] {
				out.extend_from_slice(&value.to_le_bytes());
			}
		} else {
			for value in [0x100000u32, 0x1000, 0x100000, 0x1000] {
				out.extend_from_slice(&value.to_le_bytes());
			}
		}
		out.extend_from_slice(&0u32.to_le_bytes()); // LoaderFlags
		out.extend_from_slice(&(DIRECTORY_COUNT as u32).to_le_bytes());

		for (rva, size) in directories.iter() {
			out.extend_from_slice(&rva.to_le_bytes());
			out.extend_from_slice(&size.to_le_bytes());
		}

		// Section headers.
		for (section, (rva, offset, raw_size, virtual_size)) in sections.iter().zip(placed.iter()) {
			let mut name = [0u8; 8];
			let bytes = section.name.as_bytes();
			name[..bytes.len()].copy_from_slice(bytes);
			out.extend_from_slice(&name);
			out.extend_from_slice(&virtual_size.to_le_bytes());
			out.extend_from_slice(&rva.to_le_bytes());
			out.extend_from_slice(&raw_size.to_le_bytes());
			out.extend_from_slice(&offset.to_le_bytes());
			out.extend_from_slice(&0u32.to_le_bytes()); // PointerToRelocations
			out.extend_from_slice(&0u32.to_le_bytes()); // PointerToLinenumbers
			out.extend_from_slice(&0u16.to_le_bytes()); // NumberOfRelocations
			out.extend_from_slice(&0u16.to_le_bytes()); // NumberOfLinenumbers
			out.extend_from_slice(&section.characteristics.to_le_bytes());
		}
	}

	/// Lays out an export directory at `base_rva`: the header, the address
	/// table, the name pointer table, the ordinal table, then the strings.
	///
	/// No export is forwarded, because the thing this fixture exists to pin is
	/// where an export's RVA *lands*. Named exports and holes
	/// ([`PeBuilder::export_hole`]) share the address table in the order they
	/// were added; the name pointer and ordinal tables cover only the named
	/// ones, which is what makes a hole nameless on disk rather than a symbol
	/// with an empty name.
	fn build_export_directory(&self, base_rva: u32) -> Vec<u8> {
		let count = self.exports.len() as u32;
		let named: Vec<(usize, &'static str)> = self
			.exports
			.iter()
			.enumerate()
			.filter_map(|(index, export)| export.map(|(name, _)| (index, name)))
			.collect();
		let name_count = named.len() as u32;
		let header = 40u32;
		let eat_rva = base_rva + header;
		let npt_rva = eat_rva + count * 4;
		let ord_rva = npt_rva + name_count * 4;
		let strings_rva = ord_rva + name_count * 2;

		// Strings, laid out first so the tables can point at them.
		let mut strings = Vec::new();
		let dll_name_rva = strings_rva;
		strings.extend_from_slice(b"sample.dll ");
		let mut name_rvas = Vec::new();
		for (_, name) in &named {
			name_rvas.push(strings_rva + strings.len() as u32);
			strings.extend_from_slice(name.as_bytes());
			strings.push(0);
		}

		let mut out = Vec::new();
		out.extend_from_slice(&0u32.to_le_bytes()); // Characteristics
		out.extend_from_slice(&0u32.to_le_bytes()); // TimeDateStamp — deterministic
		out.extend_from_slice(&0u16.to_le_bytes()); // MajorVersion
		out.extend_from_slice(&0u16.to_le_bytes()); // MinorVersion
		out.extend_from_slice(&dll_name_rva.to_le_bytes());
		out.extend_from_slice(&1u32.to_le_bytes()); // Base ordinal
		out.extend_from_slice(&count.to_le_bytes()); // NumberOfFunctions
		out.extend_from_slice(&name_count.to_le_bytes()); // NumberOfNames
		out.extend_from_slice(&eat_rva.to_le_bytes());
		out.extend_from_slice(&npt_rva.to_le_bytes());
		out.extend_from_slice(&ord_rva.to_le_bytes());
		for export in &self.exports {
			// A hole is a zero entry, which is how PE says "no export here".
			let rva = export.map_or(0, |(_, rva)| rva);
			out.extend_from_slice(&rva.to_le_bytes());
		}
		for rva in &name_rvas {
			out.extend_from_slice(&rva.to_le_bytes());
		}
		for (index, _) in &named {
			out.extend_from_slice(&(*index as u16).to_le_bytes());
		}
		out.extend_from_slice(&strings);
		out
	}

	/// Lays out an import directory: descriptors, thunk arrays, and name blobs.
	///
	/// Returns the section bytes and the directory size, or an empty vector
	/// when the image imports nothing.
	fn build_import_directory(&self, base_rva: u32) -> (Vec<u8>, u32) {
		if self.imports.is_empty() {
			return (Vec::new(), 0);
		}

		let thunk_size = if self.machine.is_64() { 8u32 } else { 4 };
		let descriptor_count = self.imports.len() as u32;
		let descriptors_size = (descriptor_count + 1) * 20;

		// Two parallel thunk arrays per module: names (OriginalFirstThunk) and
		// the IAT (FirstThunk) the loader overwrites.
		let mut thunks_size = 0u32;
		for symbols in self.imports.values() {
			thunks_size += 2 * (symbols.len() as u32 + 1) * thunk_size;
		}

		let names_base = base_rva + descriptors_size + thunks_size;
		let mut names = Vec::new();
		let mut module_name_rva = BTreeMap::new();
		let mut symbol_name_rva = BTreeMap::new();

		for (module, symbols) in &self.imports {
			module_name_rva.insert(*module, names_base + names.len() as u32);
			names.extend_from_slice(module.as_bytes());
			names.push(0);
			for symbol in symbols {
				if names.len() % 2 == 1 {
					names.push(0); // IMAGE_IMPORT_BY_NAME must be even-aligned
				}
				symbol_name_rva.insert(*symbol, names_base + names.len() as u32);
				names.extend_from_slice(&0u16.to_le_bytes()); // Hint
				names.extend_from_slice(symbol.as_bytes());
				names.push(0);
			}
		}

		let mut descriptors = Vec::new();
		let mut thunks = Vec::new();
		let mut thunk_cursor = base_rva + descriptors_size;

		for (module, symbols) in &self.imports {
			let names_thunk_rva = thunk_cursor;
			let iat_rva = thunk_cursor + (symbols.len() as u32 + 1) * thunk_size;
			thunk_cursor = iat_rva + (symbols.len() as u32 + 1) * thunk_size;

			descriptors.extend_from_slice(&names_thunk_rva.to_le_bytes());
			descriptors.extend_from_slice(&0u32.to_le_bytes()); // TimeDateStamp
			descriptors.extend_from_slice(&0u32.to_le_bytes()); // ForwarderChain
			descriptors.extend_from_slice(&module_name_rva[module].to_le_bytes());
			descriptors.extend_from_slice(&iat_rva.to_le_bytes());

			// Both arrays hold the same name RVAs; only the loader tells them
			// apart, and D2 reads the IAT RVA from the descriptor.
			for _ in 0..2 {
				for symbol in symbols {
					let value = symbol_name_rva[symbol] as u64;
					if self.machine.is_64() {
						thunks.extend_from_slice(&value.to_le_bytes());
					} else {
						thunks.extend_from_slice(&(value as u32).to_le_bytes());
					}
				}
				thunks.extend_from_slice(&vec![0u8; thunk_size as usize]); // null terminator
			}
		}
		descriptors.extend_from_slice(&[0u8; 20]); // null descriptor

		let mut out = descriptors;
		out.extend_from_slice(&thunks);
		out.extend_from_slice(&names);
		(out, descriptors_size)
	}

	/// Lays out the RTTI records for a blob whose first byte sits at `base_rva`.
	///
	/// Emitted strictly in dependency order, so every RVA is already known when
	/// it is written: type descriptor, then the locator naming it, then the
	/// vftable whose slot `-1` names the locator. Nothing here is patched
	/// afterwards, which is what keeps `pSelf` honest.
	///
	/// The locator is the 24-byte x64 record `{ u32 signature; i32 offset;
	/// i32 cdOffset; u32 pTypeDescriptor; u32 pClassHierarchyDescriptor;
	/// u32 pSelf }`, and a type descriptor is `{ u64 pVFTable; u64 spare;
	/// char name[] }`. `pClassHierarchyDescriptor` is left zero: nothing parses
	/// the hierarchy graph yet, and a zero there must not be what makes the
	/// record validate.
	fn build_rtti(&self, base_rva: u32) -> Vec<u8> {
		let mut out: Vec<u8> = Vec::new();
		for class in &self.rtti_classes {
			align_to_pointer(&mut out);
			let descriptor_rva = base_rva + out.len() as u32;
			out.extend_from_slice(&[0u8; 16]); // pVFTable, spare
			out.extend_from_slice(class.decorated_name.as_bytes());
			out.push(0);

			align_to_pointer(&mut out);
			let locator_rva = base_rva + out.len() as u32;
			out.extend_from_slice(&1u32.to_le_bytes()); // signature
			out.extend_from_slice(&class.base_offset.to_le_bytes());
			out.extend_from_slice(&0i32.to_le_bytes()); // cd_offset
			out.extend_from_slice(&descriptor_rva.to_le_bytes()); // pTypeDescriptor
			out.extend_from_slice(&0u32.to_le_bytes()); // pClassHierarchyDescriptor
			out.extend_from_slice(&locator_rva.to_le_bytes()); // pSelf

			// Slot `-1`. The vftable proper starts at the next qword, so this
			// has to be pointer-aligned or the scan's aligned sweep misses it.
			align_to_pointer(&mut out);
			out.extend_from_slice(&(self.image_base + u64::from(locator_rva)).to_le_bytes());
			for method_rva in &class.method_rvas {
				out.extend_from_slice(&(self.image_base + u64::from(*method_rva)).to_le_bytes());
			}
		}

		// Deliberately unaligned to nothing and unseparated: these must abut the
		// last vftable's final slot.
		for rva in &self.trailing_code_pointers {
			out.extend_from_slice(&(self.image_base + u64::from(*rva)).to_le_bytes());
		}
		out
	}

	fn build_exception_directory(&self, xdata_rva: u32) -> Vec<u8> {
		let mut out = Vec::new();
		for (index, function) in self.runtime_functions.iter().enumerate() {
			out.extend_from_slice(&function.begin.to_le_bytes());
			out.extend_from_slice(&function.end.to_le_bytes());
			let unwind_rva = xdata_rva + index as u32 * UNWIND_RECORD_SIZE;
			out.extend_from_slice(&unwind_rva.to_le_bytes());
		}
		out
	}

	/// Builds the `.xdata` records the exception directory points at.
	///
	/// A real `UNWIND_INFO` is version 1 with a flags nibble above it; a chained
	/// record follows its (here empty) unwind codes with the `RUNTIME_FUNCTION`
	/// of the primary. Every record is padded to [`UNWIND_RECORD_SIZE`].
	fn build_unwind_info(&self, xdata_rva: u32) -> Vec<u8> {
		let mut out = Vec::new();
		for function in &self.runtime_functions {
			let start = out.len();
			let flags: u8 = if function.chained_to.is_some() {
				0x4
			} else {
				0
			};
			out.push((flags << 3) | 1); // Flags | Version 1
			out.push(0); // SizeOfProlog
			out.push(0); // CountOfCodes
			out.push(0); // FrameRegister | FrameOffset
			if let Some(primary) = function.chained_to {
				// The chained RUNTIME_FUNCTION names the primary, and its
				// UnwindInfoAddress points at the primary's own record so a
				// reader can tell whether the chain continues.
				let primary_index = self
					.runtime_functions
					.iter()
					.position(|candidate| candidate.begin == primary);
				let primary_end = primary_index
					.map(|index| self.runtime_functions[index].end)
					.unwrap_or(primary);
				let primary_unwind = primary_index
					.map(|index| xdata_rva + index as u32 * UNWIND_RECORD_SIZE)
					.unwrap_or(0);
				out.extend_from_slice(&primary.to_le_bytes());
				out.extend_from_slice(&primary_end.to_le_bytes());
				out.extend_from_slice(&primary_unwind.to_le_bytes());
			}
			out.resize(start + UNWIND_RECORD_SIZE as usize, 0);
		}
		out
	}
}

/// Pads to the next 8-byte boundary.
fn align_to_pointer(out: &mut Vec<u8>) {
	while !out.len().is_multiple_of(8) {
		out.push(0);
	}
}

fn align(value: u32, alignment: u32) -> u32 {
	value.div_ceil(alignment) * alignment
}
