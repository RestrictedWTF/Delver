//! PE parsing.
//!
//! Every input here is attacker-controlled. Three rules follow:
//!
//! 1. No `unsafe` (enforced crate-wide by `#![forbid(unsafe_code)]`).
//! 2. Every count read from the file is capped before it is used to size an
//!    allocation. A malformed image claiming four billion exports must produce
//!    a truncated result, not an out-of-memory abort.
//! 3. Every cap that bites and every directory that fails to parse is recorded
//!    in [`ParseCompleteness`]. Nothing here may report an empty list for a
//!    table it could not read: "this sample imports nothing" is a claim about
//!    the binary, and a parser that makes it by accident is worse than one that
//!    refuses to answer.

use anyhow::{bail, Result};
use object::pe::{
	ImageRuntimeFunctionEntry, ImageTlsDirectory32, ImageTlsDirectory64,
	IMAGE_DIRECTORY_ENTRY_EXCEPTION, IMAGE_DIRECTORY_ENTRY_TLS, IMAGE_REL_BASED_DIR64,
	IMAGE_REL_BASED_HIGH, IMAGE_REL_BASED_HIGHADJ, IMAGE_REL_BASED_HIGHLOW, IMAGE_REL_BASED_LOW,
};
use object::read::pe::{
	ExportTarget, ImageNtHeaders, ImageOptionalHeader, ImageThunkData, PeFile, PeFile32, PeFile64,
};
use object::LittleEndian as LE;
use object::{Object, ObjectSection, ReadRef};

use crate::{
	BaseRelocation, ExceptionRange, Export, FunctionSeed, ImportedModule, ImportedSymbol,
	ParseCompleteness, ParsedImage, Section, SeedSource, Subsystem, TlsInfo,
};

/// Upper bounds applied to anything sized by a value read from the file.
///
/// Passed in rather than read from constants so the caps are testable: the
/// shipping parser uses [`Limits::DEFAULT`], and a test shrinks one cap to prove
/// the matching signal fires. `delver_analysis::control_flow` takes its bound
/// the same way and for the same reason — a cap nobody can exercise is a cap
/// nobody can show reports itself.
///
/// Every one of these is reported when it bites. A cap that silently drops
/// results makes the parser lie about the sample, which is worse than the
/// allocation attack the cap exists to stop — see [`crate::ParseCompleteness`].
#[derive(Debug, Clone, Copy)]
struct Limits {
	/// Imported modules.
	modules: usize,
	/// Imported symbols per module.
	symbols_per_module: usize,
	/// Exported symbols.
	exports: usize,
	/// Entries read from the exception directory.
	seeds: usize,
	/// Base relocation targets.
	relocations: usize,
	/// TLS callbacks.
	tls_callbacks: usize,
}

impl Limits {
	/// The bounds the shipping parser applies.
	///
	/// Generous enough that no benign image reaches them, small enough that a
	/// hostile one cannot turn a count it controls into an allocation.
	const DEFAULT: Self = Self {
		modules: 4096,
		symbols_per_module: 65536,
		exports: 262144,
		seeds: 1048576,
		relocations: 4194304,
		tls_callbacks: 1024,
	};
}

/// Parses a PE image, preferring the 64-bit layout and falling back to 32-bit.
pub fn parse_pe(data: &[u8]) -> Result<ParsedImage> {
	parse_pe_bounded(data, Limits::DEFAULT)
}

fn parse_pe_bounded(data: &[u8], limits: Limits) -> Result<ParsedImage> {
	let wide = match PeFile64::parse(data) {
		Ok(file) => return extract(&file, limits),
		Err(error) => error,
	};
	let narrow = match PeFile32::parse(data) {
		Ok(file) => return extract(&file, limits),
		Err(error) => error,
	};
	// Both errors, because either one alone misleads: a valid PE32 image always
	// fails the PE32+ attempt, and a valid PE32+ image always fails the PE32 one.
	bail!("file is not a supported PE image (as PE32+: {wide}; as PE32: {narrow})")
}

fn extract<'data, Pe, R>(file: &PeFile<'data, Pe, R>, limits: Limits) -> Result<ParsedImage>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	let image_base = file.relative_address_base();
	let arch = format!("{:?}", file.architecture());
	let entry = file.entry().saturating_sub(image_base);
	// Straight from the optional header. Both PE32 and PE32+ carry it at the
	// same place in their respective layouts, which `ImageOptionalHeader` is
	// what abstracts over.
	let subsystem = Subsystem::from_value(file.nt_headers().optional_header().subsystem());

	// Every extractor records what it could not deliver here rather than
	// returning a `Result` the caller would have to flatten into an empty list.
	// A partial answer plus an admission beats a whole answer that is false.
	let mut completeness = ParseCompleteness::default();

	let sections = extract_sections(file, image_base, &mut completeness);
	let imports = extract_imports(file, limits, &mut completeness);
	let exports = extract_exports(file, limits, &mut completeness);
	let relocations = extract_relocations(file, limits, &mut completeness);
	let tls = extract_tls(file, image_base, limits, &mut completeness);

	let (mut function_seeds, exception_ranges) =
		extract_exception_seeds(file, limits, &mut completeness);
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
		subsystem,
		image_base,
		sections,
		imports,
		exports,
		function_seeds,
		exception_ranges,
		relocations,
		tls,
		completeness,
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

fn extract_sections<'data, Pe, R>(
	file: &PeFile<'data, Pe, R>,
	image_base: u64,
	completeness: &mut ParseCompleteness,
) -> Vec<Section>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	let mut sections = Vec::new();
	for s in file.sections() {
		// `None` here means the section has no raw data, which the zero size it
		// yields already says. It is not a parse failure.
		let (raw_offset, raw_size) = s.file_range().unwrap_or((0, 0));
		let characteristics = match s.flags() {
			object::SectionFlags::Coff { characteristics } => characteristics,
			// Unreachable for PE. Zero denies every permission, so a consumer
			// reading it errs towards caution rather than towards calling a
			// section harmless.
			_ => 0,
		};
		let name = match s.name() {
			Ok(name) => name.to_string(),
			Err(_) => {
				completeness.section_names_unreadable = true;
				String::new()
			}
		};
		sections.push(Section {
			name,
			virtual_address: s.address().saturating_sub(image_base),
			virtual_size: s.size(),
			raw_offset,
			raw_size,
			characteristics,
		});
	}
	sections
}

/// Reads the import directory.
///
/// The one rule this function exists to keep: an empty return value means the
/// image imports nothing **only** when `completeness.imports_failed` is clear.
/// Every failure path sets it. "This sample calls no APIs" is one of the loudest
/// claims a tool can make about a binary, and it must never be the fallout of a
/// swallowed error.
fn extract_imports<'data, Pe, R>(
	file: &PeFile<'data, Pe, R>,
	limits: Limits,
	completeness: &mut ParseCompleteness,
) -> Vec<ImportedModule>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	let table = match file.import_table() {
		Ok(Some(table)) => table,
		// No import directory at all. The image really does import nothing.
		Ok(None) => return Vec::new(),
		Err(_) => {
			completeness.imports_failed = true;
			return Vec::new();
		}
	};

	let mut descriptors = match table.descriptors() {
		Ok(descriptors) => descriptors,
		Err(_) => {
			completeness.imports_failed = true;
			return Vec::new();
		}
	};

	let thunk_size = core::mem::size_of::<Pe::ImageThunkData>() as u64;
	let mut modules = Vec::new();
	let mut module_total = 0usize;

	loop {
		let descriptor = match descriptors.next() {
			Ok(Some(descriptor)) => descriptor,
			Ok(None) => break,
			Err(_) => {
				// Keep what parsed and admit the walk stopped early. Discarding
				// it would be the same lie in a different shape.
				completeness.imports_failed = true;
				break;
			}
		};

		module_total = module_total.saturating_add(1);
		if modules.len() >= limits.modules {
			// Past the cap, keep counting descriptors so the total is a real
			// number, but do not walk their thunks: one thunk walk is bounded
			// by the file, and one per module past the cap is not.
			continue;
		}

		let (name, name_unreadable) = match table.name(descriptor.name.get(LE)) {
			Ok(name) => (String::from_utf8_lossy(name).into_owned(), false),
			Err(_) => (String::new(), true),
		};

		// The original first thunk holds names; the first thunk is where the
		// loader writes resolved addresses. Fall back to the IAT when the
		// image is bound and the original table is absent.
		let name_thunks_rva = match descriptor.original_first_thunk.get(LE) {
			0 => descriptor.first_thunk.get(LE),
			rva => rva,
		};
		let iat_rva = descriptor.first_thunk.get(LE) as u64;

		let mut symbols = Vec::new();
		let mut symbols_failed = false;
		let mut symbols_truncated = false;
		let mut symbol_total = 0usize;
		match table.thunks(name_thunks_rva) {
			// The module is named but its symbol list is unreachable. An empty
			// `symbols` here is not "imports nothing from this module".
			Err(_) => symbols_failed = true,
			Ok(mut thunks) => {
				let mut index = 0u64;
				loop {
					let thunk = match thunks.next::<Pe>() {
						Ok(Some(thunk)) => thunk,
						Ok(None) => break,
						Err(_) => {
							symbols_failed = true;
							break;
						}
					};
					symbol_total = symbol_total.saturating_add(1);
					// Checked after the read, not before: a list that ends
					// exactly at the cap was not truncated, and claiming it was
					// is its own small falsehood.
					if symbols.len() >= limits.symbols_per_module {
						symbols_truncated = true;
						continue;
					}
					let (sym_name, ordinal, name_unreadable) = if thunk.is_ordinal() {
						(None, Some(thunk.ordinal()), false)
					} else {
						match table.import::<Pe>(thunk) {
							Ok(object::read::pe::Import::Name(_, n)) => {
								(Some(String::from_utf8_lossy(n).into_owned()), None, false)
							}
							Ok(object::read::pe::Import::Ordinal(ordinal)) => {
								(None, Some(ordinal), false)
							}
							Err(_) => (None, None, true),
						}
					};
					symbols.push(ImportedSymbol {
						name: sym_name,
						ordinal,
						iat_rva: iat_rva.saturating_add(index.saturating_mul(thunk_size)),
						name_unreadable,
					});
					index += 1;
				}
			}
		}

		modules.push(ImportedModule {
			name,
			symbols,
			symbol_total: (!symbols_failed).then_some(symbol_total),
			name_unreadable,
			symbols_failed,
			symbols_truncated,
		});
	}

	completeness.import_module_total = module_total;
	completeness.imports_truncated = module_total > modules.len();
	modules
}

/// Reads the export directory.
///
/// As with imports, an empty return value carries a claim — "this DLL exports
/// nothing" — so every failure path sets `completeness.exports_failed`.
fn extract_exports<'data, Pe, R>(
	file: &PeFile<'data, Pe, R>,
	limits: Limits,
	completeness: &mut ParseCompleteness,
) -> Vec<Export>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	let table = match file.export_table() {
		Ok(Some(table)) => table,
		Ok(None) => return Vec::new(),
		Err(_) => {
			completeness.exports_failed = true;
			return Vec::new();
		}
	};

	let all = match table.exports() {
		Ok(all) => all,
		Err(_) => {
			completeness.exports_failed = true;
			return Vec::new();
		}
	};

	completeness.export_total = all.len();
	completeness.exports_truncated = all.len() > limits.exports;

	let mut exports = Vec::new();
	for export in all.into_iter().take(limits.exports) {
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

	exports
}

/// `UNWIND_INFO.Flags` bit marking a `RUNTIME_FUNCTION` as a fragment of a
/// function that starts elsewhere. The chained entry that follows the unwind
/// codes points at the primary, so the fragment's `BeginAddress` is not a
/// function start and must not be seeded as one.
const UNW_FLAG_CHAININFO: u8 = 0x4;

/// Reads `RUNTIME_FUNCTION` entries from the exception directory.
///
/// On x64 PE this is the highest-value function-start source available: the
/// compiler emitted it, so these boundaries are facts rather than inferences.
/// Losing it quietly downgrades every later answer from fact to guess with
/// nothing saying so, which is why the malformed shapes below are reported
/// rather than absorbed.
fn extract_exception_seeds<'data, Pe, R>(
	file: &PeFile<'data, Pe, R>,
	limits: Limits,
	completeness: &mut ParseCompleteness,
) -> (Vec<FunctionSeed>, Vec<ExceptionRange>)
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	let Some(directory) = file.data_directory(IMAGE_DIRECTORY_ENTRY_EXCEPTION) else {
		return (Vec::new(), Vec::new());
	};
	let directory_rva = directory.virtual_address.get(LE);
	let size = directory.size.get(LE) as usize;
	// An empty entry is how a PE says it has no exception directory. That is an
	// absence, and must not be reported as a failure.
	if directory_rva == 0 || size == 0 {
		return (Vec::new(), Vec::new());
	}

	let Some(bytes) = file.section_table().pe_data_at(file.data(), directory_rva) else {
		completeness.exception_directory_failed = true;
		return (Vec::new(), Vec::new());
	};

	// The directory claims more bytes than the section backing it holds.
	if size > bytes.len() {
		completeness.exception_directory_failed = true;
	}
	let bytes = &bytes[..size.min(bytes.len())];
	let entry_size = core::mem::size_of::<ImageRuntimeFunctionEntry>();
	if entry_size == 0 {
		return (Vec::new(), Vec::new());
	}

	// A directory that is not a whole number of entries is malformed, and the
	// odd tail is dropped, so say so.
	if bytes.len() % entry_size != 0 {
		completeness.exception_directory_failed = true;
	}
	completeness.function_seeds_truncated = bytes.len() / entry_size > limits.seeds;

	let mut seeds = Vec::new();
	let mut ranges = Vec::new();
	for chunk in bytes.chunks_exact(entry_size).take(limits.seeds) {
		// chunks_exact guarantees the length, so the slice reads cannot fail.
		let begin = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
		let end = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]);
		let unwind_rva = u32::from_le_bytes([chunk[8], chunk[9], chunk[10], chunk[11]]);
		if begin == 0 {
			continue;
		}
		let flags = unwind_info_flags(file, unwind_rva);
		let chained = flags.is_some_and(|flags| flags & UNW_FLAG_CHAININFO != 0);
		// Recorded before the fragment test, because a fragment's bytes are
		// exactly what a later sweep must not walk into.
		if end > begin {
			ranges.push(ExceptionRange {
				range: begin as u64..end as u64,
				chained_to: if chained {
					resolve_chain_primary(file, unwind_rva).map(u64::from)
				} else {
					None
				},
			});
		}
		match flags {
			Some(_) if chained => {
				// A fragment of a function that starts elsewhere, not a function.
				continue;
			}
			Some(_) => {}
			None => {
				// The entry claims unwind info nothing maps, so whether this is a
				// fragment is unknown. Keeping the seed risks one false start;
				// dropping it loses a real function outright, and a missing start
				// is the more expensive error. Say the directory did not read
				// whole rather than let the guess pass as a compiler-emitted fact.
				completeness.exception_directory_failed = true;
			}
		}
		seeds.push(FunctionSeed {
			rva: begin as u64,
			end_rva: if end > begin { Some(end as u64) } else { None },
			source: SeedSource::ExceptionDirectory,
		});
	}
	ranges.sort_by(|left, right| left.range.start.cmp(&right.range.start));
	(seeds, ranges)
}

/// `UNWIND_INFO.Flags` for the record at `rva`, or `None` when nothing maps it.
fn unwind_info_flags<'data, Pe, R>(file: &PeFile<'data, Pe, R>, rva: u32) -> Option<u8>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	Some(unwind_flags_byte(*unwind_record(file, rva)?.first()?))
}

/// The bytes of the `UNWIND_INFO` record at `rva`.
fn unwind_record<'data, Pe, R>(file: &PeFile<'data, Pe, R>, rva: u32) -> Option<&'data [u8]>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	if rva == 0 {
		return None;
	}
	file.section_table().pe_data_at(file.data(), rva)
}

/// `BeginAddress` of the function a chained record continues.
///
/// The chained `RUNTIME_FUNCTION` sits after the unwind codes, which are two
/// bytes each and padded to an even count. `CountOfCodes` is a single
/// attacker-controlled byte, so the largest offset this can compute is 516 —
/// bounded by the type, with no cap needed.
fn chained_primary<'data, Pe, R>(file: &PeFile<'data, Pe, R>, rva: u32) -> Option<u32>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	let record = unwind_record(file, rva)?;
	let count = *record.get(2)? as usize;
	let offset = 4 + 2 * count.div_ceil(2) * 2;
	let chained = record.get(offset..offset + 12)?;
	Some(u32::from_le_bytes([
		chained[0], chained[1], chained[2], chained[3],
	]))
}

/// How many links of a chain to follow before giving up.
///
/// A chain is normally one link. The bound exists because the file controls
/// where each link points and may point one at another forever; refusing a
/// pathological chain is correct, and following it is a hang.
const MAX_UNWIND_CHAIN: usize = 8;

/// Follows a chain to the function start it ultimately belongs to.
///
/// `None` when the chain cannot be resolved — unmapped unwind info, a truncated
/// record, or more links than [`MAX_UNWIND_CHAIN`]. A caller must treat that as
/// "unknown owner", never as "owns itself".
fn resolve_chain_primary<'data, Pe, R>(
	file: &PeFile<'data, Pe, R>,
	mut unwind_rva: u32,
) -> Option<u32>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	for _ in 0..MAX_UNWIND_CHAIN {
		let begin = chained_primary(file, unwind_rva)?;
		// The primary's own record decides whether this was the last link.
		let Some(next_unwind) = primary_unwind_rva(file, unwind_rva) else {
			return Some(begin);
		};
		if !unwind_info_flags(file, next_unwind)
			.is_some_and(|flags| flags & UNW_FLAG_CHAININFO != 0)
		{
			return Some(begin);
		}
		unwind_rva = next_unwind;
	}
	None
}

/// `UnwindInfoAddress` of the chained `RUNTIME_FUNCTION` inside a record.
fn primary_unwind_rva<'data, Pe, R>(file: &PeFile<'data, Pe, R>, rva: u32) -> Option<u32>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	let record = unwind_record(file, rva)?;
	let count = *record.get(2)? as usize;
	let offset = 4 + 2 * count.div_ceil(2) * 2;
	let chained = record.get(offset..offset + 12)?;
	Some(u32::from_le_bytes([
		chained[8],
		chained[9],
		chained[10],
		chained[11],
	]))
}

/// Splits `UNWIND_INFO`'s first byte into its flags.
///
/// The low three bits are the version and carry no meaning here, so a record
/// from a future version still reports its flags rather than being read as
/// unflagged — which would silently reinstate the fragment as a function start.
fn unwind_flags_byte(first: u8) -> u8 {
	(first >> 3) & 0x1f
}

/// Reads base relocation targets.
///
/// An empty list reads downstream as "this image cannot be rebased", a statement
/// about how the sample behaves under ASLR. It must come from the file saying
/// so, never from a parse that gave up.
fn extract_relocations<'data, Pe, R>(
	file: &PeFile<'data, Pe, R>,
	limits: Limits,
	completeness: &mut ParseCompleteness,
) -> Vec<BaseRelocation>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	let mut blocks = match file
		.data_directories()
		.relocation_blocks(file.data(), &file.section_table())
	{
		Ok(Some(blocks)) => blocks,
		Ok(None) => return Vec::new(),
		Err(_) => {
			completeness.relocations_failed = true;
			return Vec::new();
		}
	};

	let mut out = Vec::new();
	let mut total = 0usize;
	loop {
		let block = match blocks.next() {
			Ok(Some(block)) => block,
			Ok(None) => break,
			Err(_) => {
				completeness.relocations_failed = true;
				break;
			}
		};
		for reloc in block {
			let Some(width) = relocation_width(reloc.typ) else {
				continue;
			};
			// Counting past the cap costs nothing this function was not already
			// paying — the directory is walked end to end regardless — and buys
			// a total that is a fact rather than "at least this many".
			total = total.saturating_add(1);
			if out.len() >= limits.relocations {
				continue;
			}
			out.push(BaseRelocation {
				rva: reloc.virtual_address as u64,
				width,
			});
		}
	}

	completeness.relocation_total = total;
	completeness.relocations_truncated = total > out.len();
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

/// Reads the TLS directory.
///
/// TLS callbacks run before the entry point, so a sample that hides its real
/// work there looks inert to anyone reading the entry point. Losing them
/// quietly is the failure that costs the most.
fn extract_tls<'data, Pe, R>(
	file: &PeFile<'data, Pe, R>,
	image_base: u64,
	limits: Limits,
	completeness: &mut ParseCompleteness,
) -> Option<TlsInfo>
where
	Pe: ImageNtHeaders,
	R: ReadRef<'data>,
{
	let directory = file.data_directory(IMAGE_DIRECTORY_ENTRY_TLS)?;
	let directory_rva = directory.virtual_address.get(LE);
	// A zero address means the image has no TLS directory: an absence. The size
	// field is deliberately not consulted — the directory is a fixed-size
	// structure, and a short size claim should not cost us its contents.
	if directory_rva == 0 {
		return None;
	}

	let Some(bytes) = file.section_table().pe_data_at(file.data(), directory_rva) else {
		completeness.tls_failed = true;
		return None;
	};

	let is_64 = file.nt_headers().is_type_64();
	let fields = if is_64 {
		object::from_bytes::<ImageTlsDirectory64>(bytes)
			.ok()
			.map(|(d, _)| {
				(
					d.address_of_index.get(LE),
					d.start_address_of_raw_data.get(LE),
					d.end_address_of_raw_data.get(LE),
					d.address_of_call_backs.get(LE),
				)
			})
	} else {
		object::from_bytes::<ImageTlsDirectory32>(bytes)
			.ok()
			.map(|(d, _)| {
				(
					d.address_of_index.get(LE) as u64,
					d.start_address_of_raw_data.get(LE) as u64,
					d.end_address_of_raw_data.get(LE) as u64,
					d.address_of_call_backs.get(LE) as u64,
				)
			})
	};
	// The directory is present but too short, misaligned, or otherwise
	// unreadable. `None` on its own would say the image has no TLS at all.
	let Some((index_va, raw_start, raw_end, callbacks_va)) = fields else {
		completeness.tls_failed = true;
		return None;
	};

	let mut info = TlsInfo {
		index_rva: index_va.saturating_sub(image_base),
		raw_data_rva: raw_start.saturating_sub(image_base),
		raw_data_size: raw_end.saturating_sub(raw_start),
		callbacks: Vec::new(),
		callbacks_failed: false,
		callbacks_truncated: false,
		callback_total: 0,
	};

	// The callback array holds absolute VAs terminated by a null entry. A zero
	// pointer means there is no array; anything that cannot be an address inside
	// the image means there is one and it is malformed.
	if callbacks_va != 0 {
		match callback_list_rva(callbacks_va, image_base) {
			None => info.callbacks_failed = true,
			Some(callbacks_rva) => {
				match file.section_table().pe_data_at(file.data(), callbacks_rva) {
					None => info.callbacks_failed = true,
					Some(list) => {
						read_tls_callbacks(&mut info, list, list_width(is_64), image_base, limits);
					}
				}
			}
		}
	}

	Some(info)
}

/// Width in bytes of one entry in the TLS callback array.
fn list_width(is_64: bool) -> usize {
	if is_64 {
		8
	} else {
		4
	}
}

/// Walks the null-terminated TLS callback array into `info`.
///
/// Counting continues past the cap so `callback_total` is the number that is
/// really there. The walk is bounded either way: each step consumes `width`
/// bytes of a slice that ends with its section.
fn read_tls_callbacks(
	info: &mut TlsInfo,
	mut list: &[u8],
	width: usize,
	image_base: u64,
	limits: Limits,
) {
	while list.len() >= width {
		let va = match width {
			8 => {
				let Ok(raw) = <[u8; 8]>::try_from(&list[..8]) else {
					info.callbacks_failed = true;
					break;
				};
				u64::from_le_bytes(raw)
			}
			_ => {
				let Ok(raw) = <[u8; 4]>::try_from(&list[..4]) else {
					info.callbacks_failed = true;
					break;
				};
				u32::from_le_bytes(raw) as u64
			}
		};
		if va == 0 {
			break;
		}
		info.callback_total = info.callback_total.saturating_add(1);
		if info.callbacks.len() < limits.tls_callbacks {
			info.callbacks.push(va.saturating_sub(image_base));
		}
		list = &list[width..];
	}
	info.callbacks_truncated = info.callback_total > info.callbacks.len();
}

/// Converts the absolute VA of the TLS callback array to an RVA.
///
/// `None` when the VA cannot be one: at or below the image base, or more than
/// 4 GiB above it, where the `u32` an RVA is would silently wrap. A wrapped RVA
/// is a real address pointing at the wrong place, which is the worst kind.
fn callback_list_rva(callbacks_va: u64, image_base: u64) -> Option<u32> {
	if callbacks_va <= image_base {
		return None;
	}
	u32::try_from(callbacks_va - image_base).ok()
}

#[cfg(test)]
mod tests {
	use super::*;
	use object::pe::{
		IMAGE_SUBSYSTEM_NATIVE, IMAGE_SUBSYSTEM_WINDOWS_CUI, IMAGE_SUBSYSTEM_WINDOWS_GUI,
	};

	/// The test binary is itself a PE, which makes it a convenient real image.
	fn current_exe_image() -> ParsedImage {
		parse_pe(&current_exe_bytes()).expect("parse current exe")
	}

	/// The bytes behind that image, so a test can corrupt one field and reparse.
	fn current_exe_bytes() -> Vec<u8> {
		let path = std::env::current_exe().expect("current exe");
		std::fs::read(path).expect("read current exe")
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
	fn reads_the_declared_subsystem_rather_than_assuming_one() {
		// A Rust test binary is a console program, so this is a real reading and
		// not a default leaking through — which is the failure worth guarding,
		// since `Subsystem::default()` deliberately is not `Console`.
		let image = current_exe_image();
		assert_eq!(image.subsystem, Subsystem::Console);
		assert_ne!(Subsystem::default(), Subsystem::Console);
	}

	#[test]
	fn an_unrecognized_subsystem_keeps_its_value_instead_of_collapsing() {
		// The distinction that matters to a caller deciding what an entry point
		// should look like: "I was not taught about this" must not read as
		// "console", which is what a catch-all mapping to a named variant does.
		assert_eq!(
			(
				Subsystem::from_value(IMAGE_SUBSYSTEM_WINDOWS_CUI),
				Subsystem::from_value(IMAGE_SUBSYSTEM_WINDOWS_GUI),
				Subsystem::from_value(IMAGE_SUBSYSTEM_NATIVE),
				Subsystem::from_value(0x2a),
			),
			(
				Subsystem::Console,
				Subsystem::Gui,
				Subsystem::Native,
				Subsystem::Other(0x2a),
			)
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
	fn unwind_flags_ignore_the_version_and_report_chaining() {
		// Version lives in the low three bits and must not reach the flags. A
		// record that is chained is chained whatever version wrote it.
		let chained_v1 = unwind_flags_byte(0b0010_0_001);
		let chained_v2 = unwind_flags_byte(0b0010_0_010);
		let plain_v1 = unwind_flags_byte(0b0000_0_001);
		let ehandler_v1 = unwind_flags_byte(0b0000_1_001);

		assert_eq!(
			[
				chained_v1 & UNW_FLAG_CHAININFO != 0,
				chained_v2 & UNW_FLAG_CHAININFO != 0,
				plain_v1 & UNW_FLAG_CHAININFO != 0,
				ehandler_v1 & UNW_FLAG_CHAININFO != 0,
			],
			[true, true, false, false]
		);
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

	/// Byte offset of data directory `index` in a PE this parser accepts.
	///
	/// Walks the headers by hand rather than through `object`, because the point
	/// of these tests is to hand `object` a directory it cannot follow.
	fn data_directory_offset(bytes: &[u8], index: usize) -> usize {
		let e_lfanew = u32::from_le_bytes(bytes[0x3C..0x40].try_into().expect("e_lfanew")) as usize;
		// "PE\0\0" plus the 20-byte COFF file header.
		let optional = e_lfanew + 24;
		let magic = u16::from_le_bytes(bytes[optional..optional + 2].try_into().expect("magic"));
		let directories = match magic {
			0x20B => optional + 112,
			0x10B => optional + 96,
			other => panic!("unexpected optional header magic {other:#x}"),
		};
		directories + index * 8
	}

	/// Minimal PE32+ image with one named export and one forwarded ordinal.
	fn export_fixture() -> Vec<u8> {
		fn put16(bytes: &mut [u8], offset: usize, value: u16) {
			bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
		}
		fn put32(bytes: &mut [u8], offset: usize, value: u32) {
			bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
		}
		fn put64(bytes: &mut [u8], offset: usize, value: u64) {
			bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
		}

		let mut bytes = vec![0_u8; 0x400];
		bytes[0..2].copy_from_slice(b"MZ");
		put32(&mut bytes, 0x3c, 0x80);
		bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
		let coff = 0x84;
		put16(&mut bytes, coff, 0x8664);
		put16(&mut bytes, coff + 2, 1);
		put16(&mut bytes, coff + 16, 0xf0);
		put16(&mut bytes, coff + 18, 0x2022);

		let optional = coff + 20;
		put16(&mut bytes, optional, 0x20b);
		put32(&mut bytes, optional + 20, 0x1000);
		put64(&mut bytes, optional + 24, 0x1_4000_0000);
		put32(&mut bytes, optional + 32, 0x1000);
		put32(&mut bytes, optional + 36, 0x200);
		put16(&mut bytes, optional + 40, 6);
		put16(&mut bytes, optional + 48, 6);
		put32(&mut bytes, optional + 56, 0x2000);
		put32(&mut bytes, optional + 60, 0x200);
		put16(&mut bytes, optional + 68, 3);
		put64(&mut bytes, optional + 72, 0x10_0000);
		put64(&mut bytes, optional + 80, 0x1000);
		put64(&mut bytes, optional + 88, 0x10_0000);
		put64(&mut bytes, optional + 96, 0x1000);
		put32(&mut bytes, optional + 108, 16);
		put32(&mut bytes, optional + 112, 0x1000);
		put32(&mut bytes, optional + 116, 0xa0);

		let section = optional + 0xf0;
		bytes[section..section + 8].copy_from_slice(b".edata\0\0");
		put32(&mut bytes, section + 8, 0x200);
		put32(&mut bytes, section + 12, 0x1000);
		put32(&mut bytes, section + 16, 0x200);
		put32(&mut bytes, section + 20, 0x200);
		put32(&mut bytes, section + 36, 0x4000_0040);

		let export = 0x200;
		put32(&mut bytes, export + 12, 0x1050);
		put32(&mut bytes, export + 16, 1);
		put32(&mut bytes, export + 20, 2);
		put32(&mut bytes, export + 24, 1);
		put32(&mut bytes, export + 28, 0x1040);
		put32(&mut bytes, export + 32, 0x1048);
		put32(&mut bytes, export + 36, 0x104c);
		put32(&mut bytes, 0x240, 0x2000);
		put32(&mut bytes, 0x244, 0x1080);
		put32(&mut bytes, 0x248, 0x1060);
		put16(&mut bytes, 0x24c, 0);
		bytes[0x250..0x25c].copy_from_slice(b"fixture.dll\0");
		bytes[0x260..0x269].copy_from_slice(b"exported\0");
		bytes[0x280..0x28e].copy_from_slice(b"OTHER.forward\0");
		bytes
	}

	#[test]
	fn parses_named_and_forwarded_exports() {
		let image = parse_pe(&export_fixture()).expect("parse export fixture");
		assert_eq!(
			image
				.exports
				.iter()
				.map(|export| (
					export.name.as_deref(),
					export.ordinal,
					export.rva,
					export.forwarded_to.as_deref()
				))
				.collect::<Vec<_>>(),
			vec![
				(Some("exported"), 1, Some(0x2000), None),
				(None, 2, None, Some("OTHER.forward")),
			]
		);
	}

	/// An RVA no benign image maps, used to point a directory into nowhere.
	const UNMAPPED_RVA: u32 = 0x7FFF_0000;

	/// A malformed import directory must read as "could not be parsed", never as
	/// "this image imports nothing".
	///
	/// The second is a confident claim about a sample — that it calls no APIs at
	/// all — and it is the claim an analyst acts on. Producing it from a
	/// swallowed error is the worst failure this crate can have.
	#[test]
	fn a_malformed_import_table_reports_failure_rather_than_an_empty_import_list() {
		let mut bytes = current_exe_bytes();
		let intact = parse_pe(&bytes).expect("parse current exe");
		assert!(
			!intact.imports.is_empty() && !intact.completeness.imports_failed,
			"the unmodified image must import something, or this proves nothing"
		);

		let offset = data_directory_offset(&bytes, object::pe::IMAGE_DIRECTORY_ENTRY_IMPORT);
		bytes[offset..offset + 4].copy_from_slice(&UNMAPPED_RVA.to_le_bytes());

		let image =
			parse_pe(&bytes).expect("one malformed directory must not fail the whole parse");
		assert_eq!(
			(
				image.imports.len(),
				image.completeness.imports_failed,
				image.is_fully_parsed()
			),
			(0, true, false)
		);
	}

	/// The same rule for the exception directory: losing it silently turns every
	/// later function boundary from a compiler-emitted fact into a guess, with
	/// nothing anywhere saying the downgrade happened.
	#[test]
	fn a_malformed_exception_directory_reports_failure_rather_than_no_function_starts() {
		let mut bytes = current_exe_bytes();
		let offset = data_directory_offset(&bytes, IMAGE_DIRECTORY_ENTRY_EXCEPTION);
		bytes[offset..offset + 4].copy_from_slice(&UNMAPPED_RVA.to_le_bytes());

		let image =
			parse_pe(&bytes).expect("one malformed directory must not fail the whole parse");
		assert_eq!(
			(
				image.completeness.exception_directory_failed,
				image
					.function_seeds
					.iter()
					.any(|s| s.source == SeedSource::ExceptionDirectory),
				image.is_fully_parsed()
			),
			(true, false, false)
		);
	}

	/// A directory that claims more entries than the section behind it holds is
	/// malformed, and the entries past the end are lost. Say so.
	#[test]
	fn an_oversized_exception_directory_reports_failure() {
		let mut bytes = current_exe_bytes();
		let offset = data_directory_offset(&bytes, IMAGE_DIRECTORY_ENTRY_EXCEPTION);
		bytes[offset + 4..offset + 8].copy_from_slice(&u32::MAX.to_le_bytes());

		let image = parse_pe(&bytes).expect("parse current exe");
		assert!(image.completeness.exception_directory_failed);
	}

	/// Every cap below is set one short of what the real image needs, so it is
	/// certain to bite. A cap that cannot be exercised is a cap nobody can show
	/// reports itself.
	#[test]
	fn the_module_cap_reports_itself_and_the_untruncated_total() {
		let bytes = current_exe_bytes();
		let whole = parse_pe(&bytes).expect("parse current exe");
		assert!(!whole.imports.is_empty(), "expected imported modules");

		let cap = whole.imports.len() - 1;
		let capped = parse_pe_bounded(
			&bytes,
			Limits {
				modules: cap,
				..Limits::DEFAULT
			},
		)
		.expect("parse current exe");

		assert_eq!(
			(
				capped.imports.len(),
				capped.completeness.imports_truncated,
				capped.completeness.import_module_total,
				capped.is_fully_parsed()
			),
			(cap, true, whole.completeness.import_module_total, false)
		);
	}

	/// The symbol cap is per module, so its signal is too: one module cut short
	/// must not cast doubt on the modules that parsed whole.
	#[test]
	fn the_per_module_symbol_cap_reports_itself_on_the_module_it_cut() {
		let bytes = current_exe_bytes();
		let whole = parse_pe(&bytes).expect("parse current exe");
		let biggest = whole
			.imports
			.iter()
			.map(|m| m.symbols.len())
			.max()
			.expect("expected imported modules");
		assert!(biggest > 0, "expected at least one imported symbol");

		let cap = biggest - 1;
		let capped = parse_pe_bounded(
			&bytes,
			Limits {
				symbols_per_module: cap,
				..Limits::DEFAULT
			},
		)
		.expect("parse current exe");

		let cut = capped
			.imports
			.iter()
			.filter(|m| m.symbols_truncated)
			.count();
		assert_eq!(
			(
				cut > 0,
				capped.imports.iter().all(|m| m.symbols.len() <= cap),
				capped
					.imports
					.iter()
					.filter(|module| module.symbols_truncated)
					.all(|module| module
						.symbol_total
						.is_some_and(|total| total > module.symbols.len())),
				capped.completeness.imports_truncated,
				capped.is_fully_parsed()
			),
			// Modules were all kept; only symbols were dropped. The image-level
			// import signal must stay clear, or it would blame the wrong cap.
			(true, true, true, false, false)
		);
	}

	#[test]
	fn the_relocation_cap_reports_itself_and_the_untruncated_total() {
		let bytes = current_exe_bytes();
		let whole = parse_pe(&bytes).expect("parse current exe");
		assert!(
			!whole.relocations.is_empty(),
			"a dynamic-base image carries base relocations"
		);

		let cap = whole.relocations.len() - 1;
		let capped = parse_pe_bounded(
			&bytes,
			Limits {
				relocations: cap,
				..Limits::DEFAULT
			},
		)
		.expect("parse current exe");

		assert_eq!(
			(
				capped.relocations.len(),
				capped.completeness.relocations_truncated,
				capped.completeness.relocation_total,
				capped.is_fully_parsed()
			),
			(cap, true, whole.completeness.relocation_total, false)
		);
	}

	#[test]
	fn the_exception_seed_cap_reports_itself() {
		let bytes = current_exe_bytes();
		let whole = parse_pe(&bytes).expect("parse current exe");
		let from_exception = whole
			.function_seeds
			.iter()
			.filter(|s| s.source == SeedSource::ExceptionDirectory)
			.count();
		assert!(
			from_exception > 0,
			"an x64 PE carries an exception directory"
		);

		let capped = parse_pe_bounded(
			&bytes,
			Limits {
				seeds: from_exception - 1,
				..Limits::DEFAULT
			},
		)
		.expect("parse current exe");

		assert_eq!(
			(
				capped.completeness.function_seeds_truncated,
				capped.is_fully_parsed()
			),
			(true, false)
		);
	}

	/// The other half of the contract: a signal that fires on every real binary
	/// is a signal a reader learns to ignore.
	#[test]
	fn a_well_formed_image_parses_whole_and_says_so() {
		let image = current_exe_image();
		assert!(
			image.is_fully_parsed(),
			"unmodified image reported as incomplete: {:?}",
			image.completeness
		);
	}

	/// A callback pointer that cannot be an address inside the image is a
	/// malformed directory, not an RVA. Truncating it to `u32` would produce a
	/// plausible address pointing somewhere else entirely.
	#[test]
	fn a_tls_callback_pointer_that_cannot_be_an_rva_is_rejected() {
		let base = 0x1_4000_0000u64;
		assert_eq!(
			(
				callback_list_rva(base + 0x2000, base),
				callback_list_rva(base, base),
				callback_list_rva(base - 1, base),
				callback_list_rva(base + 0x1_0000_0000, base),
			),
			(Some(0x2000), None, None, None)
		);
	}
}
