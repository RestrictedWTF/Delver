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
	/// Base relocation targets and their encoded widths.
	pub relocations: Vec<BaseRelocation>,
	/// TLS directory, when present.
	pub tls: Option<TlsInfo>,
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
