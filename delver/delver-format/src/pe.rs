//! PE parsing.
//!
//! Every input here is attacker-controlled. Two rules follow:
//!
//! 1. No `unsafe` (enforced crate-wide by `#![forbid(unsafe_code)]`).
//! 2. Every count read from the file is capped before it is used to size an
//!    allocation. A malformed image claiming four billion exports must produce
//!    a truncated result, not an out-of-memory abort.

use anyhow::{bail, Result};
use object::pe::{
	ImageRuntimeFunctionEntry, ImageTlsDirectory32, ImageTlsDirectory64,
	IMAGE_DIRECTORY_ENTRY_EXCEPTION, IMAGE_DIRECTORY_ENTRY_TLS, IMAGE_REL_BASED_DIR64,
	IMAGE_REL_BASED_HIGH, IMAGE_REL_BASED_HIGHADJ, IMAGE_REL_BASED_HIGHLOW, IMAGE_REL_BASED_LOW,
};
use object::read::pe::{ExportTarget, ImageNtHeaders, ImageThunkData, PeFile, PeFile32, PeFile64};
use object::LittleEndian as LE;
use object::{Object, ObjectSection, ReadRef};

use crate::{
	BaseRelocation, Export, FunctionSeed, ImportedModule, ImportedSymbol, ParsedImage, Section,
	SeedSource, TlsInfo,
};

/// Upper bounds applied to anything sized by a value read from the file.
mod limits {
	/// Imported modules.
	pub const MODULES: usize = 4096;
	/// Imported symbols per module.
	pub const SYMBOLS_PER_MODULE: usize = 65536;
	/// Exported symbols.
	pub const EXPORTS: usize = 262144;
	/// Entries read from the exception directory.
	pub const SEEDS: usize = 1048576;
	/// Base relocation targets.
	pub const RELOCATIONS: usize = 4194304;
	/// TLS callbacks.
	pub const TLS_CALLBACKS: usize = 1024;
}

/// Parses a PE image, preferring the 64-bit layout and falling back to 32-bit.
pub fn parse_pe(data: &[u8]) -> Result<ParsedImage> {
	if let Ok(file) = PeFile64::parse(data) {
		return extract(&file);
	}
	if let Ok(file) = PeFile32::parse(data) {
		return extract(&file);
	}
	bail!("file is not a supported PE image")
}

fn extract<'data, Pe, R>(file: &PeFile<'data, Pe, R>) -> Result<ParsedImage>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	let image_base = file.relative_address_base();
	let arch = format!("{:?}", file.architecture());
	let entry = file.entry().saturating_sub(image_base);

	let sections = extract_sections(file, image_base);
	let imports = extract_imports(file).unwrap_or_default();
	let exports = extract_exports(file).unwrap_or_default();
	let relocations = extract_relocations(file);
	let tls = extract_tls(file, image_base);

	let mut function_seeds = extract_exception_seeds(file);
	if entry != 0 {
		function_seeds.push(FunctionSeed {
			rva: entry,
			end_rva: None,
			source: SeedSource::EntryPoint,
		});
	}
	for export in &exports {
		if let Some(rva) = export.rva {
			function_seeds.push(FunctionSeed {
				rva,
				end_rva: None,
				source: SeedSource::Export,
			});
		}
	}
	if let Some(tls) = &tls {
		for &rva in &tls.callbacks {
			function_seeds.push(FunctionSeed {
				rva,
				end_rva: None,
				source: SeedSource::TlsCallback,
			});
		}
	}
	dedupe_seeds(&mut function_seeds);

	Ok(ParsedImage {
		arch,
		entry,
		image_base,
		sections,
		imports,
		exports,
		function_seeds,
		relocations,
		tls,
	})
}

/// Sorts seeds by RVA and keeps the most authoritative source per address.
///
/// `SeedSource` orders from most to least authoritative, so sorting by
/// `(rva, source)` puts the winner first within each address group.
fn dedupe_seeds(seeds: &mut Vec<FunctionSeed>) {
	seeds.sort_by(|a, b| a.rva.cmp(&b.rva).then(a.source.cmp(&b.source)));
	seeds.dedup_by_key(|s| s.rva);
}

fn extract_sections<'data, Pe, R>(file: &PeFile<'data, Pe, R>, image_base: u64) -> Vec<Section>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	file.sections()
		.map(|s| {
			let (raw_offset, raw_size) = s.file_range().unwrap_or((0, 0));
			let characteristics = match s.flags() {
				object::SectionFlags::Coff { characteristics } => characteristics,
				_ => 0,
			};
			Section {
				name: s.name().unwrap_or("").to_string(),
				virtual_address: s.address().saturating_sub(image_base),
				virtual_size: s.size(),
				raw_offset,
				raw_size,
				characteristics,
			}
		})
		.collect()
}

fn extract_imports<'data, Pe, R>(file: &PeFile<'data, Pe, R>) -> Result<Vec<ImportedModule>>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	let Some(table) = file.import_table()? else {
		return Ok(Vec::new());
	};

	let thunk_size = core::mem::size_of::<Pe::ImageThunkData>() as u64;
	let mut modules = Vec::new();
	let mut descriptors = table.descriptors()?;

	while let Some(descriptor) = descriptors.next()? {
		if modules.len() >= limits::MODULES {
			break;
		}

		let name = table
			.name(descriptor.name.get(LE))
			.map(|n| String::from_utf8_lossy(n).into_owned())
			.unwrap_or_default();

		// The original first thunk holds names; the first thunk is where the
		// loader writes resolved addresses. Fall back to the IAT when the
		// image is bound and the original table is absent.
		let name_thunks_rva = match descriptor.original_first_thunk.get(LE) {
			0 => descriptor.first_thunk.get(LE),
			rva => rva,
		};
		let iat_rva = descriptor.first_thunk.get(LE) as u64;

		let mut symbols = Vec::new();
		if let Ok(mut thunks) = table.thunks(name_thunks_rva) {
			let mut index = 0u64;
			while let Ok(Some(thunk)) = thunks.next::<Pe>() {
				if symbols.len() >= limits::SYMBOLS_PER_MODULE {
					break;
				}
				let (sym_name, ordinal) = if thunk.is_ordinal() {
					(None, Some(thunk.ordinal()))
				} else {
					let name = table
						.import::<Pe>(thunk)
						.ok()
						.and_then(|import| match import {
							object::read::pe::Import::Name(_, n) => {
								Some(String::from_utf8_lossy(n).into_owned())
							}
							object::read::pe::Import::Ordinal(_) => None,
						});
					(name, None)
				};
				symbols.push(ImportedSymbol {
					name: sym_name,
					ordinal,
					iat_rva: iat_rva.saturating_add(index.saturating_mul(thunk_size)),
				});
				index += 1;
			}
		}

		modules.push(ImportedModule { name, symbols });
	}

	Ok(modules)
}

fn extract_exports<'data, Pe, R>(file: &PeFile<'data, Pe, R>) -> Result<Vec<Export>>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	let Some(table) = file.export_table()? else {
		return Ok(Vec::new());
	};

	let mut exports = Vec::new();
	for export in table.exports()?.into_iter().take(limits::EXPORTS) {
		let name = export.name.map(|n| String::from_utf8_lossy(n).into_owned());
		let (rva, forwarded_to) = match export.target {
			ExportTarget::Address(addr) => (Some(addr as u64), None),
			ExportTarget::ForwardByName(dll, sym) => (
				None,
				Some(format!(
					"{}.{}",
					String::from_utf8_lossy(dll),
					String::from_utf8_lossy(sym)
				)),
			),
			ExportTarget::ForwardByOrdinal(dll, ordinal) => (
				None,
				Some(format!("{}.#{}", String::from_utf8_lossy(dll), ordinal)),
			),
		};
		exports.push(Export {
			name,
			ordinal: export.ordinal,
			rva,
			forwarded_to,
		});
	}

	Ok(exports)
}

/// Reads `RUNTIME_FUNCTION` entries from the exception directory.
///
/// On x64 PE this is the highest-value function-start source available: the
/// compiler emitted it, so these boundaries are facts rather than inferences.
fn extract_exception_seeds<'data, Pe, R>(file: &PeFile<'data, Pe, R>) -> Vec<FunctionSeed>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	let Some(directory) = file.data_directory(IMAGE_DIRECTORY_ENTRY_EXCEPTION) else {
		return Vec::new();
	};
	let Some(bytes) = file
		.section_table()
		.pe_data_at(file.data(), directory.virtual_address.get(LE))
	else {
		return Vec::new();
	};

	let size = directory.size.get(LE) as usize;
	let bytes = &bytes[..size.min(bytes.len())];
	let entry_size = core::mem::size_of::<ImageRuntimeFunctionEntry>();

	let mut seeds = Vec::new();
	for chunk in bytes.chunks_exact(entry_size).take(limits::SEEDS) {
		// chunks_exact guarantees the length, so the slice reads cannot fail.
		let begin = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
		let end = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]);
		if begin == 0 {
			continue;
		}
		seeds.push(FunctionSeed {
			rva: begin as u64,
			end_rva: if end > begin { Some(end as u64) } else { None },
			source: SeedSource::ExceptionDirectory,
		});
	}
	seeds
}

fn extract_relocations<'data, Pe, R>(file: &PeFile<'data, Pe, R>) -> Vec<BaseRelocation>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	let Ok(blocks) = file
		.data_directories()
		.relocation_blocks(file.data(), &file.section_table())
	else {
		return Vec::new();
	};
	let Some(mut blocks) = blocks else {
		return Vec::new();
	};

	let mut out = Vec::new();
	while let Ok(Some(block)) = blocks.next() {
		for reloc in block {
			if out.len() >= limits::RELOCATIONS {
				return out;
			}
			let Some(width) = relocation_width(reloc.typ) else {
				continue;
			};
			out.push(BaseRelocation {
				rva: reloc.virtual_address as u64,
				width,
			});
		}
	}
	out
}

fn relocation_width(kind: u16) -> Option<u8> {
	match kind {
		IMAGE_REL_BASED_HIGH | IMAGE_REL_BASED_LOW | IMAGE_REL_BASED_HIGHADJ => Some(2),
		IMAGE_REL_BASED_HIGHLOW => Some(4),
		IMAGE_REL_BASED_DIR64 => Some(8),
		_ => None,
	}
}

fn extract_tls<'data, Pe, R>(file: &PeFile<'data, Pe, R>, image_base: u64) -> Option<TlsInfo>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	let directory = file.data_directory(IMAGE_DIRECTORY_ENTRY_TLS)?;
	let bytes = file
		.section_table()
		.pe_data_at(file.data(), directory.virtual_address.get(LE))?;

	let is_64 = file.nt_headers().is_type_64();
	let (index_va, raw_start, raw_end, callbacks_va) = if is_64 {
		let d: &ImageTlsDirectory64 = object::from_bytes(bytes).ok()?.0;
		(
			d.address_of_index.get(LE),
			d.start_address_of_raw_data.get(LE),
			d.end_address_of_raw_data.get(LE),
			d.address_of_call_backs.get(LE),
		)
	} else {
		let d: &ImageTlsDirectory32 = object::from_bytes(bytes).ok()?.0;
		(
			d.address_of_index.get(LE) as u64,
			d.start_address_of_raw_data.get(LE) as u64,
			d.end_address_of_raw_data.get(LE) as u64,
			d.address_of_call_backs.get(LE) as u64,
		)
	};

	let mut info = TlsInfo {
		index_rva: index_va.saturating_sub(image_base),
		raw_data_rva: raw_start.saturating_sub(image_base),
		raw_data_size: raw_end.saturating_sub(raw_start),
		callbacks: Vec::new(),
	};

	// The callback array holds absolute VAs terminated by a null entry.
	if callbacks_va > image_base {
		let callbacks_rva = (callbacks_va - image_base) as u32;
		if let Some(mut list) = file.section_table().pe_data_at(file.data(), callbacks_rva) {
			let width = if is_64 { 8 } else { 4 };
			while list.len() >= width && info.callbacks.len() < limits::TLS_CALLBACKS {
				let va = if is_64 {
					u64::from_le_bytes(list[..8].try_into().ok()?)
				} else {
					u32::from_le_bytes(list[..4].try_into().ok()?) as u64
				};
				if va == 0 {
					break;
				}
				info.callbacks.push(va.saturating_sub(image_base));
				list = &list[width..];
			}
		}
	}

	Some(info)
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The test binary is itself a PE, which makes it a convenient real image.
	fn current_exe_image() -> ParsedImage {
		let path = std::env::current_exe().expect("current exe");
		let bytes = std::fs::read(path).expect("read current exe");
		parse_pe(&bytes).expect("parse current exe")
	}

	#[test]
	fn parses_current_executable() {
		let image = current_exe_image();
		assert!(!image.sections.is_empty(), "expected sections");
		assert!(image.entry > 0, "expected an entry point");
		assert!(
			!image.imports.is_empty(),
			"a Rust test binary always imports from at least one system module"
		);
	}

	#[test]
	fn preserves_base_relocation_field_widths() {
		assert_eq!(relocation_width(IMAGE_REL_BASED_HIGH), Some(2));
		assert_eq!(relocation_width(IMAGE_REL_BASED_HIGHLOW), Some(4));
		assert_eq!(relocation_width(IMAGE_REL_BASED_DIR64), Some(8));
		assert_eq!(relocation_width(0), None);
		assert_eq!(relocation_width(u16::MAX), None);
	}

	#[test]
	fn exception_directory_supplies_function_seeds() {
		let image = current_exe_image();
		let from_exception = image
			.function_seeds
			.iter()
			.filter(|s| s.source == SeedSource::ExceptionDirectory)
			.count();
		assert!(
			from_exception > 0,
			"an x64 PE must carry an exception directory"
		);
	}

	#[test]
	fn seeds_are_sorted_deduped_and_prefer_the_best_source() {
		let mut seeds = vec![
			FunctionSeed {
				rva: 0x2000,
				end_rva: None,
				source: SeedSource::Export,
			},
			FunctionSeed {
				rva: 0x1000,
				end_rva: None,
				source: SeedSource::EntryPoint,
			},
			FunctionSeed {
				rva: 0x1000,
				end_rva: Some(0x1100),
				source: SeedSource::ExceptionDirectory,
			},
		];
		dedupe_seeds(&mut seeds);

		let summary: Vec<_> = seeds.iter().map(|s| (s.rva, s.source)).collect();
		assert_eq!(
			summary,
			vec![
				(0x1000, SeedSource::ExceptionDirectory),
				(0x2000, SeedSource::Export),
			]
		);
	}

	/// A TLS callback that shares an address with a compiler-emitted function
	/// loses the dedupe — the exception directory is the better source for
	/// *where the function starts*. It must still survive at its own address,
	/// and `TlsInfo::callbacks` records the callback role either way.
	#[test]
	fn tls_callback_seeds_survive_unless_a_better_source_shares_the_address() {
		let mut seeds = vec![
			FunctionSeed {
				rva: 0x1000,
				end_rva: Some(0x1100),
				source: SeedSource::ExceptionDirectory,
			},
			FunctionSeed {
				rva: 0x1000,
				end_rva: None,
				source: SeedSource::TlsCallback,
			},
			FunctionSeed {
				rva: 0x3000,
				end_rva: None,
				source: SeedSource::TlsCallback,
			},
		];
		dedupe_seeds(&mut seeds);

		let summary: Vec<_> = seeds.iter().map(|s| (s.rva, s.source)).collect();
		assert_eq!(
			summary,
			vec![
				(0x1000, SeedSource::ExceptionDirectory),
				(0x3000, SeedSource::TlsCallback),
			]
		);
	}

	#[test]
	fn rejects_non_pe_input() {
		assert!(parse_pe(b"not a pe file at all").is_err());
	}

	#[test]
	fn all_addresses_are_relative_to_the_image_base() {
		let image = current_exe_image();
		let last_section = image.sections.last().expect("sections");
		assert!(
			last_section.virtual_end() < image.image_base,
			"RVAs must be far below a typical image base; found {:#x}",
			last_section.virtual_end()
		);
	}
}
