//! Executable format parsing for Delver.
//!
//! Parsing of attacker-controlled bytes lives here, behind a safe API, so that
//! neither the renderer nor a provider's transport layer ever touches a format
//! structure directly.
//!
//! Only PE is implemented today. ELF and Mach-O are P5.
//!
//! All addresses produced by this crate are **RVAs** — relative to the image
//! base, never absolute — so that they can be anchored per
//! `Docs/architecture/data-model.md` §4 without knowing where the image was
//! loaded.

#![warn(missing_docs)]
#![forbid(unsafe_code)]

mod pe;

pub use pe::parse_pe;

/// Parsed image metadata, extracted once when the image is opened.
#[derive(Debug, Clone, Default)]
pub struct ParsedImage {
	/// Architecture string, e.g. "X86_64".
	pub arch: String,
	/// Entry point as an RVA. Zero when the image has no entry point.
	pub entry: u64,
	/// Preferred image base.
	pub image_base: u64,
	/// Loadable sections.
	pub sections: Vec<Section>,
	/// Imported modules, each with its imported symbols.
	pub imports: Vec<ImportedModule>,
	/// Exported symbols.
	pub exports: Vec<Export>,
	/// Candidate function starts, ordered by descending confidence.
	pub function_seeds: Vec<FunctionSeed>,
	/// Base relocation targets as RVAs.
	pub relocations: Vec<u64>,
	/// TLS directory, when present.
	pub tls: Option<TlsInfo>,
}

impl ParsedImage {
	/// Returns the section containing `rva`, if any.
	pub fn section_containing(&self, rva: u64) -> Option<&Section> {
		self.sections
			.iter()
			.find(|s| s.virtual_address <= rva && rva < s.virtual_end())
	}

	/// Returns the file bytes backing `rva`, running to the end of its section's
	/// raw data.
	///
	/// A section's virtual size can exceed its raw size — the loader zero-fills
	/// the tail — so this returns only bytes that actually exist in the file.
	/// `None` means the address is not backed by file data at all, which is a
	/// different answer from "zero bytes" and must stay distinguishable.
	pub fn bytes_at<'a>(&self, file: &'a [u8], rva: u64) -> Option<&'a [u8]> {
		let section = self.section_containing(rva)?;
		let offset_in_section = rva - section.virtual_address;
		if offset_in_section >= section.raw_size {
			return None;
		}
		let start = (section.raw_offset + offset_in_section) as usize;
		let end = (section.raw_end() as usize).min(file.len());
		if start >= end {
			None
		} else {
			Some(&file[start..end])
		}
	}
}

/// A single image section.
#[derive(Debug, Clone)]
pub struct Section {
	/// Section name.
	pub name: String,
	/// RVA of the section start.
	pub virtual_address: u64,
	/// Virtual size in bytes.
	pub virtual_size: u64,
	/// Raw file offset.
	pub raw_offset: u64,
	/// Raw size in bytes.
	pub raw_size: u64,
	/// `IMAGE_SCN_*` characteristics from the section header.
	pub characteristics: u32,
}

impl Section {
	/// Exclusive end of the virtual range.
	pub fn virtual_end(&self) -> u64 {
		self.virtual_address.saturating_add(self.virtual_size)
	}

	/// Exclusive end of the raw range.
	pub fn raw_end(&self) -> u64 {
		self.raw_offset.saturating_add(self.raw_size)
	}

	/// Whether the section is marked executable (`IMAGE_SCN_MEM_EXECUTE`).
	pub fn is_executable(&self) -> bool {
		self.characteristics & 0x2000_0000 != 0
	}
}

/// A module the image imports from.
#[derive(Debug, Clone)]
pub struct ImportedModule {
	/// Module name as written in the import descriptor, e.g. "KERNEL32.dll".
	pub name: String,
	/// Symbols imported from this module.
	pub symbols: Vec<ImportedSymbol>,
}

/// A single imported symbol.
#[derive(Debug, Clone)]
pub struct ImportedSymbol {
	/// Symbol name, absent for imports by ordinal.
	pub name: Option<String>,
	/// Ordinal, present for imports by ordinal.
	pub ordinal: Option<u16>,
	/// RVA of the import address table slot the loader writes the resolved
	/// address into. This is the address a call site indirects through.
	pub iat_rva: u64,
}

/// A single exported symbol.
#[derive(Debug, Clone)]
pub struct Export {
	/// Symbol name, absent for exports by ordinal only.
	pub name: Option<String>,
	/// Export ordinal.
	pub ordinal: u32,
	/// RVA of the export target, absent when the export is forwarded.
	pub rva: Option<u64>,
	/// Forward target string, e.g. "NTDLL.RtlAllocateHeap".
	pub forwarded_to: Option<String>,
}

/// Where a candidate function start came from.
///
/// Ordering matters: the exception directory is authoritative because the
/// compiler emitted it, whereas a linear sweep is a guess. Consumers render
/// guessed boundaries differently from confirmed ones, per
/// `Docs/design/principles.md` §1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SeedSource {
	/// From the exception directory (`RUNTIME_FUNCTION`). Compiler-emitted.
	ExceptionDirectory,
	/// The image entry point.
	EntryPoint,
	/// An exported symbol.
	Export,
	/// A TLS callback. Runs before the entry point, so it matters
	/// disproportionately for anti-analysis code.
	TlsCallback,
}

impl SeedSource {
	/// Whether the seed is compiler-emitted rather than inferred.
	///
	/// Every source currently produced by this crate is authoritative; linear
	/// sweep lives in `delver-analysis` and produces its own lower-confidence
	/// seeds.
	pub fn is_authoritative(self) -> bool {
		true
	}
}

/// A candidate function start.
#[derive(Debug, Clone)]
pub struct FunctionSeed {
	/// Function start as an RVA.
	pub rva: u64,
	/// Exclusive end as an RVA, when the source records one.
	pub end_rva: Option<u64>,
	/// Where this seed came from.
	pub source: SeedSource,
}

/// TLS directory contents.
#[derive(Debug, Clone, Default)]
pub struct TlsInfo {
	/// RVA of the TLS index variable.
	pub index_rva: u64,
	/// RVA of the raw TLS template data.
	pub raw_data_rva: u64,
	/// Size of the raw TLS template data.
	pub raw_data_size: u64,
	/// TLS callback RVAs, in the order the loader invokes them.
	pub callbacks: Vec<u64>,
}
