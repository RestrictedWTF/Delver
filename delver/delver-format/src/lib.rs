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

use object::pe::{
	IMAGE_SUBSYSTEM_NATIVE, IMAGE_SUBSYSTEM_UNKNOWN, IMAGE_SUBSYSTEM_WINDOWS_CUI,
	IMAGE_SUBSYSTEM_WINDOWS_GUI,
};

pub use pe::parse_pe;

/// Parsed image metadata, extracted once when the image is opened.
#[derive(Debug, Clone, Default)]
pub struct ParsedImage {
	/// Architecture string, e.g. "X86_64".
	pub arch: String,
	/// Entry point as an RVA. Zero when the image has no entry point.
	///
	/// For a linked executable this is the C runtime's startup stub, not the
	/// `main` the analyst is looking for: the CRT initializes and only then
	/// calls user code. Naming which is which is `delver-analysis`'s job; this
	/// field is only the address the image itself declares.
	pub entry: u64,
	/// Windows subsystem the image declares.
	///
	/// Exact, straight out of the optional header, and the cheapest signal there
	/// is for what the user entry point should look like: a console image is
	/// entered through `main`/`wmain`, a GUI image through `WinMain`/`wWinMain`.
	pub subsystem: Subsystem,
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
	/// Base relocation targets and their encoded widths.
	pub relocations: Vec<BaseRelocation>,
	/// TLS directory, when present.
	pub tls: Option<TlsInfo>,
	/// What the parse could not deliver in full.
	///
	/// Read this before reading any list above. An empty list means "the image
	/// has none of these" **only** when the matching signal here is clear.
	pub completeness: ParseCompleteness,
}

/// Windows subsystem an image declares in its optional header.
///
/// Only the values that change how the image is entered are named. Everything
/// else is [`Subsystem::Other`] carrying the raw value rather than a guess:
/// a caller deciding what an entry point should look like must be able to tell
/// "this is a console program" from "this is something I was not taught about",
/// and a catch-all that silently read as `Console` would erase that difference.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subsystem {
	/// `IMAGE_SUBSYSTEM_WINDOWS_CUI` — entered through `main` or `wmain`.
	Console,
	/// `IMAGE_SUBSYSTEM_WINDOWS_GUI` — entered through `WinMain` or `wWinMain`.
	Gui,
	/// A native or driver image. It has no C runtime entry of either family.
	Native,
	/// Anything else, including a value this build does not recognize.
	Other(u16),
}

impl Default for Subsystem {
	/// An image nothing has parsed yet declares nothing, which is `Unknown` —
	/// not `Console`, which would be a claim.
	fn default() -> Self {
		Self::Other(IMAGE_SUBSYSTEM_UNKNOWN)
	}
}

impl Subsystem {
	/// Reads the optional header value.
	fn from_value(value: u16) -> Self {
		match value {
			IMAGE_SUBSYSTEM_WINDOWS_GUI => Self::Gui,
			IMAGE_SUBSYSTEM_WINDOWS_CUI => Self::Console,
			IMAGE_SUBSYSTEM_NATIVE => Self::Native,
			other => Self::Other(other),
		}
	}
}

/// What a parse could not deliver in full.
///
/// Every field answers a question the lists on [`ParsedImage`] cannot answer
/// themselves. An empty `imports` is either "this sample imports nothing" — a
/// strong claim about a binary, and a rare one — or "the import directory is
/// malformed and the parse gave up". Those must never look alike: reporting the
/// second as the first tells an analyst that a packed sample calls no APIs.
///
/// This is the format layer's version of the rule `StringScan::truncated`
/// already states one layer up. A cap is a real defence — a hostile file must
/// not be able to turn parsing into an allocation attack — but a bounded result
/// that does not admit it is worse than no result at all.
///
/// Two signals, kept apart on purpose:
///
/// * `*_failed` — the directory is present but could not be read to the end.
///   The matching list holds whatever was recovered before the parse stopped,
///   and there may be more.
/// * `*_truncated` — the directory parsed cleanly, but one of the parser's
///   caps stopped the walk. The matching `*_total` says how many there were,
///   recorded wherever counting the rest costs one linear pass and no
///   allocation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParseCompleteness {
	/// The import directory is present but could not be parsed to the end.
	///
	/// [`ParsedImage::imports`] then holds only what was recovered first. It is
	/// not the image's import list and must never be presented as one.
	pub imports_failed: bool,
	/// Whether modules were dropped at the module cap.
	pub imports_truncated: bool,
	/// Import descriptors present before the cap was applied.
	pub import_module_total: usize,
	/// The export directory is present but could not be parsed.
	pub exports_failed: bool,
	/// Whether exports were dropped at the export cap.
	pub exports_truncated: bool,
	/// Exports present before the cap was applied.
	pub export_total: usize,
	/// The exception directory is present but could not be read whole.
	///
	/// Either its bytes are not mapped by any section, or its declared size
	/// runs past the data backing it, or that size is not a whole number of
	/// `RUNTIME_FUNCTION` entries. Function starts are missing in every case,
	/// and on x64 those are the compiler-emitted ones.
	pub exception_directory_failed: bool,
	/// Whether exception-directory seeds were dropped at the seed cap.
	///
	/// Names its source rather than [`ParsedImage::function_seeds`], which is a
	/// merge of several sources and so cannot carry one total.
	pub function_seeds_truncated: bool,
	/// The relocation directory is present but could not be parsed to the end.
	///
	/// An empty relocation list reads as "this image cannot be rebased", so a
	/// swallowed failure here is a claim about the sample's behaviour under
	/// ASLR.
	pub relocations_failed: bool,
	/// Whether relocation targets were dropped at the relocation cap.
	pub relocations_truncated: bool,
	/// Relocation targets of a recognized width present before the cap.
	pub relocation_total: usize,
	/// The TLS directory is present but could not be parsed.
	///
	/// [`ParsedImage::tls`] is then `None` for a reason that is not "the image
	/// has no TLS directory" — and TLS callbacks run before the entry point, so
	/// anti-analysis code hides there precisely because it is easy to miss.
	pub tls_failed: bool,
	/// At least one section header carries a name that could not be decoded.
	///
	/// Those sections report an empty name, which is not the name they have.
	pub section_names_unreadable: bool,
}

impl ParseCompleteness {
	/// Whether any directory failed to parse.
	pub fn any_failed(&self) -> bool {
		self.imports_failed
			|| self.exports_failed
			|| self.exception_directory_failed
			|| self.relocations_failed
			|| self.tls_failed
			|| self.section_names_unreadable
	}

	/// Whether any image-level cap dropped results.
	///
	/// Per-module symbol caps live on [`ImportedModule::symbols_truncated`] and
	/// the TLS callback cap on [`TlsInfo::callbacks_truncated`]; use
	/// [`ParsedImage::is_fully_parsed`] to account for all of them at once.
	pub fn any_truncated(&self) -> bool {
		self.imports_truncated
			|| self.exports_truncated
			|| self.function_seeds_truncated
			|| self.relocations_truncated
	}
}

/// One PE base-relocation field that must change when the image is rebased.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BaseRelocation {
	/// Image-relative start of the relocated field.
	pub rva: u64,
	/// Encoded field width in bytes.
	pub width: u8,
}

impl ParsedImage {
	/// Whether the import directory and every retained module parsed completely.
	///
	/// This is narrower than [`Self::is_fully_parsed`]: call-graph consumers use
	/// it to explain when a missing import identity may be parser fallout rather
	/// than a genuinely opaque indirect call.
	pub fn imports_fully_parsed(&self) -> bool {
		!self.completeness.imports_failed
			&& !self.completeness.imports_truncated
			&& self.imports.iter().all(|module| {
				!module.name_unreadable
					&& !module.symbols_failed
					&& !module.symbols_truncated
					&& module.symbol_total.is_some()
					&& module.symbols.iter().all(|symbol| !symbol.name_unreadable)
			})
	}

	/// Whether every directory parsed to the end with no cap applied.
	///
	/// Folds in the per-module and per-TLS signals as well as
	/// [`ParseCompleteness`], so a consumer that wants one question answered —
	/// "may I present these lists as the whole truth?" — asks this and nothing
	/// else.
	pub fn is_fully_parsed(&self) -> bool {
		!self.completeness.any_failed()
			&& !self.completeness.any_truncated()
			&& self.imports_fully_parsed()
			&& !self
				.tls
				.as_ref()
				.is_some_and(|t| t.callbacks_failed || t.callbacks_truncated)
	}

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

/// Shannon entropy of `bytes`, in bits per byte.
///
/// Returns zero for an empty slice: no data carries no information, and any
/// other answer would be an invention.
pub fn shannon_entropy(bytes: &[u8]) -> f64 {
	if bytes.is_empty() {
		return 0.0;
	}

	let mut counts = [0u64; 256];
	for &byte in bytes {
		counts[byte as usize] += 1;
	}

	let len = bytes.len() as f64;
	-counts
		.iter()
		.filter(|&&count| count > 0)
		.map(|&count| {
			let p = count as f64 / len;
			p * p.log2()
		})
		.sum::<f64>()
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

	/// Whether the section is marked readable (`IMAGE_SCN_MEM_READ`).
	pub fn is_readable(&self) -> bool {
		self.characteristics & 0x4000_0000 != 0
	}

	/// Whether the section is marked writable (`IMAGE_SCN_MEM_WRITE`).
	///
	/// Writable **and** executable together is worth surfacing: legitimate
	/// compilers do not emit it, and packers routinely do.
	pub fn is_writable(&self) -> bool {
		self.characteristics & 0x8000_0000 != 0
	}

	/// Shannon entropy of the section's raw bytes, in bits per byte (0..=8).
	///
	/// This is the cheapest signal there is for compressed or encrypted
	/// content: English text sits near 4.5, machine code near 6, and packed or
	/// ciphered data crowds 8. It measures the bytes **as stored**, so a
	/// section with no raw data reports zero rather than guessing.
	pub fn entropy(&self, file: &[u8]) -> f64 {
		let start = (self.raw_offset as usize).min(file.len());
		let end = (self.raw_end() as usize).min(file.len());
		shannon_entropy(&file[start..end])
	}
}

/// A module the image imports from.
///
/// The signals below are per module on purpose: the symbol cap is applied per
/// module, and one unreadable thunk array must not cast doubt on the other four
/// thousand modules that parsed cleanly.
#[derive(Debug, Clone)]
pub struct ImportedModule {
	/// Module name as written in the import descriptor, e.g. "KERNEL32.dll".
	///
	/// Empty when `name_unreadable` is set — check that before showing it.
	pub name: String,
	/// Symbols imported from this module.
	pub symbols: Vec<ImportedSymbol>,
	/// Total symbols in this module before the return cap was applied.
	///
	/// Absent when the thunk walk failed, because the recovered prefix is not a
	/// true total and must not be presented as one.
	pub symbol_total: Option<usize>,
	/// Whether the descriptor's name string could not be read.
	///
	/// A module rendered as `""` is not a module named `""`.
	pub name_unreadable: bool,
	/// Whether the symbol list is incomplete because reading it failed.
	///
	/// Either the thunk array could not be located at all — in which case
	/// `symbols` is empty and this is emphatically not a module the image
	/// imports nothing from — or the walk hit an error partway and stopped.
	pub symbols_failed: bool,
	/// Whether symbols were dropped at the per-module symbol cap.
	pub symbols_truncated: bool,
}

impl Default for ImportedModule {
	fn default() -> Self {
		Self {
			name: String::new(),
			symbols: Vec::new(),
			symbol_total: Some(0),
			name_unreadable: false,
			symbols_failed: false,
			symbols_truncated: false,
		}
	}
}

/// A single imported symbol.
#[derive(Debug, Clone, Default)]
pub struct ImportedSymbol {
	/// Symbol name, absent for imports by ordinal.
	pub name: Option<String>,
	/// Ordinal, present for imports by ordinal.
	pub ordinal: Option<u16>,
	/// RVA of the import address table slot the loader writes the resolved
	/// address into. This is the address a call site indirects through.
	pub iat_rva: u64,
	/// Whether the hint/name entry this thunk points at could not be read.
	///
	/// Both `name` and `ordinal` are then `None`, which no real import is. The
	/// slot exists and the call site indirecting through it is real; only the
	/// symbol's identity is unknown.
	pub name_unreadable: bool,
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
	/// Whether the directory names a callback array that could not be read.
	///
	/// `callbacks` is then empty for a reason that is not "this image has no
	/// TLS callbacks".
	pub callbacks_failed: bool,
	/// Whether callbacks were dropped at the callback cap.
	pub callbacks_truncated: bool,
	/// Callbacks present before the cap was applied.
	pub callback_total: usize,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn entropy_of_nothing_is_zero_not_a_guess() {
		assert_eq!(shannon_entropy(&[]), 0.0);
	}

	#[test]
	fn entropy_spans_zero_to_eight() {
		// One repeated byte carries no information; every byte exactly once
		// carries the maximum a byte can. These are the ends of the scale a
		// reader is judging "is this packed?" against.
		assert_eq!(shannon_entropy(&[0xCC; 4096]), 0.0);

		let every_byte: Vec<u8> = (0..=255).collect();
		assert!((shannon_entropy(&every_byte) - 8.0).abs() < 1e-9);
	}

	#[test]
	fn entropy_of_two_equally_common_bytes_is_one_bit() {
		let bytes: Vec<u8> = (0..1000)
			.map(|i| if i % 2 == 0 { b'a' } else { b'b' })
			.collect();
		assert!((shannon_entropy(&bytes) - 1.0).abs() < 1e-9);
	}

	#[test]
	fn a_section_reports_entropy_of_its_raw_bytes_only() {
		// Virtual size exceeds raw size, so the loader zero-fills the tail. That
		// tail is not in the file and must not drag the measurement down.
		let section = Section {
			name: ".text".to_string(),
			virtual_address: 0x1000,
			virtual_size: 0x2000,
			raw_offset: 4,
			raw_size: 4,
			characteristics: 0x6000_0020,
		};
		let file = vec![0x00, 0x00, 0x00, 0x00, b'a', b'b', b'a', b'b', 0x00, 0x00];

		assert!((section.entropy(&file) - 1.0).abs() < 1e-9);
	}

	/// Completeness is a property of the whole image, not just of the image-level
	/// flags. A module that was cut short is an image that was cut short, and a
	/// consumer asking one question must get the answer that accounts for both.
	#[test]
	fn a_per_module_signal_alone_makes_the_image_incomplete() {
		let mut image = ParsedImage {
			imports: vec![ImportedModule {
				name: "KERNEL32.dll".to_string(),
				..Default::default()
			}],
			..Default::default()
		};
		let clean = image.is_fully_parsed();

		image.imports[0].symbols_truncated = true;

		assert_eq!((clean, image.is_fully_parsed()), (true, false));
	}

	/// "No imports" and "the import table could not be read" must never be the
	/// same value. This is the whole point of the type.
	#[test]
	fn an_empty_list_and_a_failed_parse_are_distinguishable() {
		let nothing_imported = ParsedImage::default();
		let unreadable = ParsedImage {
			completeness: ParseCompleteness {
				imports_failed: true,
				..Default::default()
			},
			..Default::default()
		};

		assert_eq!(
			(
				nothing_imported.imports.is_empty(),
				nothing_imported.is_fully_parsed(),
				unreadable.imports.is_empty(),
				unreadable.is_fully_parsed()
			),
			(true, true, true, false)
		);
	}

	#[test]
	fn permissions_come_from_the_characteristics_bits() {
		let wx = Section {
			name: ".packed".to_string(),
			virtual_address: 0x1000,
			virtual_size: 0x10,
			raw_offset: 0,
			raw_size: 0,
			// READ | WRITE | EXECUTE — what a packer needs and a compiler avoids.
			characteristics: 0x4000_0000 | 0x8000_0000 | 0x2000_0000,
		};

		assert_eq!(
			(wx.is_readable(), wx.is_writable(), wx.is_executable()),
			(true, true, true)
		);
	}
}
