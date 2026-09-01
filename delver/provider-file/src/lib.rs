//! File provider for Delver.
//!
//! Exposes two address spaces for PE files:
//! - `File`: raw file offsets.
//! - `Image`: relative virtual addresses (RVA) with sections applied.
//!
//! Reads that extend past the readable region return partial data and valid
//! ranges instead of an error.
//!
//! The target file is attacker-controlled, so per CLAUDE.md invariant 13 this
//! crate denies `unsafe`. `map_target_read_only` carries the single scoped
//! exemption, on the same terms ADR 0003 set for the transport listener:
//! bounded, documented, and outside every path that interprets target bytes.
//! Parsing runs in `delver-format`, which forbids `unsafe` outright.

#![deny(unsafe_code)]
#![warn(missing_docs)]

use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result};
use delver_core::{Moment, MomentKind};
use delver_format::{parse_pe, ParsedImage, SeedSource, Subsystem};
use delver_protocol::{
	AddressSpaceKindWire, AddressSpaceWire, ErrorKind, ExportWire, FrameRef, FunctionSeedWire,
	GetExportsResult, GetFunctionSeedsResult, GetImageInfoResult, GetImportsResult,
	ImportedModuleWire, ImportedSymbolWire, InitializeResult, MomentWire, RangeWire,
	ReadMemoryParams, ReadMemoryResult, RpcError, SectionWire, SeedSourceWire, SubsystemWire,
	TargetCapabilityWire, TargetDescriptorWire, TlsWire,
};
use memmap2::Mmap;
use sha2::{Digest, Sha256};

/// Provider state for a single target file.
pub struct FileProvider {
	mmap: Mmap,
	image: ParsedImage,
	file_size: u64,
	/// SHA-256 of the file bytes, lowercase hex. Computed once at open.
	content_hash: String,
	next_frame_id: AtomicU64,
}

impl FileProvider {
	/// Opens and maps the file at `path`.
	pub fn open(path: &Path) -> Result<Self> {
		let file = File::open(path).with_context(|| format!("opening {path:?}"))?;
		let mmap = map_target_read_only(&file).with_context(|| format!("mapping {path:?}"))?;
		let file_size = mmap.len() as u64;
		let image = parse_pe(&mmap)?;
		// Over the file bytes, per the data model: an in-memory image hashes a
		// normalized form so a loaded module still matches its on-disk
		// counterpart, but a file target is already that counterpart.
		let content_hash = hex_digest(&Sha256::digest(&mmap[..]));
		Ok(Self {
			mmap,
			image,
			file_size,
			content_hash,
			next_frame_id: AtomicU64::new(1),
		})
	}

	/// The image's content hash, lowercase hex SHA-256.
	pub fn content_hash(&self) -> &str {
		&self.content_hash
	}

	/// Allocates the next binary frame id.
	fn alloc_frame_id(&self) -> u64 {
		self.next_frame_id.fetch_add(1, Ordering::Relaxed)
	}

	/// Returns the initialize response payload.
	pub fn initialize(&self) -> InitializeResult {
		InitializeResult {
			protocol_version: delver_protocol::PROTOCOL_VERSION.to_string(),
			capabilities: vec![
				TargetCapabilityWire::ListSpaces,
				TargetCapabilityWire::GetImageInfo,
				TargetCapabilityWire::ReadMemory,
				TargetCapabilityWire::GetImports,
				TargetCapabilityWire::GetExports,
				TargetCapabilityWire::GetFunctionSeeds,
			],
			spaces: self.list_spaces(),
			target: TargetDescriptorWire {
				name: "file".to_string(),
				kind: "file".to_string(),
			},
		}
	}

	/// Returns the address spaces.
	pub fn list_spaces(&self) -> Vec<AddressSpaceWire> {
		// The image space extends to the end of the last section, which is
		// where a client sizing a scrollbar or pulling the whole image needs it
		// to stop.
		let image_size = self
			.image
			.sections
			.iter()
			.map(|s| s.virtual_end())
			.max()
			.unwrap_or(0);

		vec![
			AddressSpaceWire {
				id: "File".to_string(),
				kind: AddressSpaceKindWire::File,
				pointer_width: 64,
				size: self.file_size,
				translates_to: None,
			},
			AddressSpaceWire {
				id: "Image".to_string(),
				kind: AddressSpaceKindWire::Image,
				pointer_width: 64,
				size: image_size,
				translates_to: Some("File".to_string()),
			},
		]
	}

	/// Returns image metadata.
	///
	/// A summary only: imports, exports, and function seeds have their own
	/// methods so that opening a large system DLL does not drag thousands of
	/// symbols along with it.
	pub fn get_image_info(&self) -> GetImageInfoResult {
		image_info(&self.image, &self.content_hash, &self.mmap)
	}

	/// Returns imported modules and their symbols.
	pub fn get_imports(&self) -> GetImportsResult {
		let completeness = &self.image.completeness;
		GetImportsResult {
			modules: self
				.image
				.imports
				.iter()
				.map(|m| ImportedModuleWire {
					name: m.name.clone(),
					symbols: m
						.symbols
						.iter()
						.map(|s| ImportedSymbolWire {
							name: s.name.clone(),
							ordinal: s.ordinal,
							iat_rva: s.iat_rva,
							name_unreadable: s.name_unreadable,
						})
						.collect(),
					symbol_total: m.symbol_total.map(|total| total as u64),
					name_unreadable: m.name_unreadable,
					symbols_failed: m.symbols_failed,
					symbols_truncated: m.symbols_truncated,
				})
				.collect(),
			failed: completeness.imports_failed,
			truncated: completeness.imports_truncated,
			module_total: completeness.import_module_total as u64,
		}
	}

	/// Returns exported symbols.
	pub fn get_exports(&self) -> GetExportsResult {
		let completeness = &self.image.completeness;
		GetExportsResult {
			exports: self
				.image
				.exports
				.iter()
				.map(|e| ExportWire {
					name: e.name.clone(),
					ordinal: e.ordinal,
					rva: e.rva,
					forwarded_to: e.forwarded_to.clone(),
				})
				.collect(),
			failed: completeness.exports_failed,
			truncated: completeness.exports_truncated,
			total: completeness.export_total as u64,
		}
	}

	/// Returns candidate function starts, sorted by address.
	pub fn get_function_seeds(&self) -> GetFunctionSeedsResult {
		let completeness = &self.image.completeness;
		GetFunctionSeedsResult {
			seeds: self
				.image
				.function_seeds
				.iter()
				.map(|s| FunctionSeedWire {
					rva: s.rva,
					end_rva: s.end_rva,
					source: seed_source_wire(s.source),
				})
				.collect(),
			exception_directory_failed: completeness.exception_directory_failed,
			truncated: completeness.function_seeds_truncated,
		}
	}

	/// Reads memory from the requested space and returns the response payload
	/// plus the binary bytes to send.
	///
	/// The Moment is part of the request, not decoration (CLAUDE.md invariant
	/// 1). A file on disk has exactly one moment — [`Moment::STATIC`] — so this
	/// provider can serve that and nothing else. A request naming a snapshot or
	/// a live target is a request for data this provider does not have, and
	/// answering it with file bytes would hand back the wrong observation under
	/// the right shape. It is refused as `UnsupportedCapability` instead.
	///
	/// An *absent* moment means "the current moment", which for a static target
	/// is the static moment: there is no other, and a client that omits the
	/// field is not asking for something this provider cannot do. Refusing it
	/// would only force every caller to spell out the single possible answer.
	/// The response still names the moment served, so nothing has to infer it.
	pub fn read_memory(
		&self,
		params: ReadMemoryParams,
	) -> Result<(ReadMemoryResult, Vec<u8>), RpcError> {
		let served_moment = self.resolve_moment(params.moment)?;
		let space = params.space.as_str();
		let address = params.address;
		let len = params.len;

		let (bytes, valid) = match space {
			"File" => self.read_file(address, len),
			"Image" => self.read_image(address, len),
			_ => {
				return Err(RpcError::domain(
					ErrorKind::InvalidAddress,
					format!("unknown address space: {space}"),
				))
			}
		};

		let frame_id = self.alloc_frame_id();
		let result = ReadMemoryResult {
			data: FrameRef {
				frame_id,
				len: bytes.len() as u64,
			},
			valid,
			served_moment,
		};
		Ok((result, bytes))
	}

	/// Resolves a requested moment to the one this provider can serve.
	fn resolve_moment(&self, requested: MomentWire) -> Result<MomentWire, RpcError> {
		match Moment::from(requested).kind {
			MomentKind::Static => Ok(Moment::STATIC.into()),
			kind => Err(RpcError::domain(
				ErrorKind::UnsupportedCapability,
				format!("file provider serves only the static moment; {kind:?} was requested"),
			)),
		}
	}

	fn read_file(&self, offset: u64, len: u64) -> (Vec<u8>, Vec<RangeWire>) {
		let end = offset.saturating_add(len).min(self.file_size);
		let actual_len = end.saturating_sub(offset);
		let bytes = if actual_len == 0 {
			Vec::new()
		} else {
			self.mmap[offset as usize..end as usize].to_vec()
		};
		let valid = if actual_len == 0 {
			Vec::new()
		} else {
			vec![RangeWire { start: offset, end }]
		};
		(bytes, valid)
	}

	fn read_image(&self, rva: u64, len: u64) -> (Vec<u8>, Vec<RangeWire>) {
		// Find the section that contains the start address.
		let section = match self
			.image
			.sections
			.iter()
			.find(|s| s.virtual_address <= rva && rva < s.virtual_end())
		{
			Some(s) => s,
			None => return (Vec::new(), Vec::new()),
		};

		// Readable range is the intersection of the request and the section's
		// virtual size, mapped to raw file offsets.
		let section_start = rva - section.virtual_address;
		let requested_end = rva.saturating_add(len);
		let section_end_va = section.virtual_end();
		let read_end_va = requested_end.min(section_end_va);
		let read_len = read_end_va.saturating_sub(rva);

		// Two separate limits, and both are attacker-controlled: a section's raw
		// data can stop short of its virtual size (the loader zero-fills the
		// tail), and `PointerToRawData`/`SizeOfRawData` are header fields that
		// nothing validates against the real file length. Clamping to
		// `file_size` as well as to `raw_end()` is what keeps a header pointing
		// a section at offset 0x4000_0000 in a four-kilobyte file from slicing
		// past the end of the map. Bytes outside that clamp are simply not
		// read: per the data model they are *not valid*, never zeroes.
		let Some((raw_start, raw_end)) = clamped_raw_range(
			section.raw_offset,
			section.raw_size,
			section_start,
			read_len,
			self.file_size,
		) else {
			return (Vec::new(), Vec::new());
		};
		let read_len = raw_end - raw_start;

		let bytes = if read_len == 0 {
			Vec::new()
		} else {
			self.mmap[raw_start as usize..raw_end as usize].to_vec()
		};

		let valid = if read_len == 0 {
			Vec::new()
		} else {
			vec![RangeWire {
				start: rva,
				end: rva.saturating_add(read_len),
			}]
		};
		(bytes, valid)
	}
}

/// Builds the `getImageInfo` summary from a parsed image.
///
/// Free-standing so the count and completeness mapping can be asserted against
/// a hand-built [`ParsedImage`]; the provider owns only the mmap those sections
/// take their entropy from.
/// Carries the declared subsystem across, including one nothing recognizes.
fn subsystem_wire(subsystem: Subsystem) -> SubsystemWire {
	match subsystem {
		Subsystem::Console => SubsystemWire::Console,
		Subsystem::Gui => SubsystemWire::Gui,
		Subsystem::Native => SubsystemWire::Native,
		Subsystem::Other(value) => SubsystemWire::Other { value },
	}
}

fn image_info(image: &ParsedImage, content_hash: &str, bytes: &[u8]) -> GetImageInfoResult {
	let completeness = &image.completeness;
	// An image total exists only when every module was walked and every thunk
	// walk reached its terminator. A recovered prefix is useful in getImports,
	// but it is not an image count and must not be promoted into this summary.
	let import_symbol_count = image.imports_fully_parsed().then(|| {
		image
			.imports
			.iter()
			.filter_map(|module| module.symbol_total)
			.sum::<usize>() as u64
	});

	GetImageInfoResult {
		arch: image.arch.clone(),
		content_hash: content_hash.to_owned(),
		entry: image.entry,
		subsystem: subsystem_wire(image.subsystem),
		image_base: image.image_base,
		sections: image
			.sections
			.iter()
			.map(|s| SectionWire {
				name: s.name.clone(),
				virtual_address: s.virtual_address,
				raw_offset: s.raw_offset,
				virtual_size: s.virtual_size,
				raw_size: s.raw_size,
				readable: s.is_readable(),
				writable: s.is_writable(),
				executable: s.is_executable(),
				entropy: s.entropy(bytes),
			})
			.collect(),
		// These are counts of the *image*, not of the lists `getImports` and
		// `getExports` return. A capped or failed parse recovers fewer entries
		// than the sample declares, so counting the recovered list here would
		// state a page size as a property of the sample — a confident wrong
		// number, and the one thing a summary must never produce. The totals
		// come from the parser, which counted before it capped; the truncation
		// flags say whether the list a client fetches is shorter than this.
		import_module_count: completeness.import_module_total as u64,
		import_symbol_count,
		export_count: completeness.export_total as u64,
		// No total exists for seeds by design: `function_seeds` merges several
		// sources, so `function_seeds_truncated` names the one source that was
		// capped rather than a total this list could carry.
		function_seed_count: image.function_seeds.len() as u64,
		relocation_count: completeness.relocation_total as u64,
		imports_failed: completeness.imports_failed,
		imports_truncated: completeness.imports_truncated,
		exports_failed: completeness.exports_failed,
		exports_truncated: completeness.exports_truncated,
		exception_directory_failed: completeness.exception_directory_failed,
		function_seeds_truncated: completeness.function_seeds_truncated,
		relocations_failed: completeness.relocations_failed,
		relocations_truncated: completeness.relocations_truncated,
		tls_failed: completeness.tls_failed,
		section_names_unreadable: completeness.section_names_unreadable,
		fully_parsed: image.is_fully_parsed(),
		tls: image.tls.as_ref().map(|t| TlsWire {
			index_rva: t.index_rva,
			raw_data_rva: t.raw_data_rva,
			raw_data_size: t.raw_data_size,
			callbacks: t.callbacks.clone(),
			callbacks_failed: t.callbacks_failed,
			callbacks_truncated: t.callbacks_truncated,
			callback_total: t.callback_total as u64,
		}),
	}
}

/// Intersects a section-relative read with both the declared raw extent and
/// the actual mapped file. All inputs except `file_size` came from the sample.
fn clamped_raw_range(
	raw_offset: u64,
	raw_size: u64,
	section_start: u64,
	read_len: u64,
	file_size: u64,
) -> Option<(u64, u64)> {
	let raw_start = raw_offset.saturating_add(section_start);
	let raw_limit = raw_offset.saturating_add(raw_size).min(file_size);
	let raw_end = raw_start.saturating_add(read_len).min(raw_limit);
	(raw_start < raw_end).then_some((raw_start, raw_end))
}

fn seed_source_wire(source: SeedSource) -> SeedSourceWire {
	match source {
		SeedSource::ExceptionDirectory => SeedSourceWire::ExceptionDirectory,
		SeedSource::EntryPoint => SeedSourceWire::EntryPoint,
		SeedSource::Export => SeedSourceWire::Export,
		SeedSource::TlsCallback => SeedSourceWire::TlsCallback,
	}
}

/// Maps a target file read-only.
///
/// The single `unsafe` in this crate. `memmap2` cannot offer a safe version:
/// a mapping is not a snapshot, so another process truncating or replacing the
/// file while it is mapped can fault a read. Nothing about the file's *content*
/// is trusted here — the bytes go straight to `delver-format`, which forbids
/// `unsafe` — and no other code path in this crate uses `unsafe` at all.
#[allow(unsafe_code)]
fn map_target_read_only(file: &File) -> std::io::Result<Mmap> {
	// SAFETY: `Mmap::map` requires that the backing file not be mutated for as
	// long as the mapping lives. That cannot be enforced from inside this
	// process, and it is the accepted cost of mapping an on-disk target rather
	// than copying it; the mapping is read-only and is owned for its whole life
	// by the `FileProvider` that created it.
	unsafe { Mmap::map(file) }
}

/// Formats a digest as lowercase hex.
fn hex_digest(bytes: &[u8]) -> String {
	use std::fmt::Write;
	bytes
		.iter()
		.fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
			let _ = write!(out, "{b:02x}");
			out
		})
}

#[cfg(test)]
mod tests {
	use std::thread;

	use delver_core::{AddressSpace, AddressSpaceKind};
	use delver_format::{ImportedModule, ParseCompleteness};
	use delver_protocol::{MomentKindWire, ReadMemoryParams};

	use super::*;

	#[test]
	fn file_provider_api_types_exist() {
		let space = AddressSpace::new(
			"Image",
			AddressSpaceKind::Image,
			64,
			0x1000,
			Option::<&str>::None,
		);
		assert_eq!(space.pointer_width, 64);
	}

	#[test]
	fn concurrent_read_memory_is_safe() {
		// Use the test binary itself as a PE target.
		let exe = std::env::current_exe().expect("current exe");
		let provider = FileProvider::open(&exe).expect("open current exe");
		let info = provider.get_image_info();
		let first_section = info
			.sections
			.first()
			.expect("test binary has at least one section");
		let address = first_section.virtual_address;

		let provider = std::sync::Arc::new(provider);
		let mut handles = Vec::new();

		for _ in 0..2 {
			let provider = std::sync::Arc::clone(&provider);
			handles.push(thread::spawn(move || {
				let params = ReadMemoryParams {
					space: "Image".to_string(),
					address,
					len: 16,
					moment: Moment::STATIC.into(),
				};
				let (result, bytes) = provider.read_memory(params).expect("read memory");
				assert_eq!(bytes.len(), 16);
				assert_eq!(result.data.len, 16);
			}));
		}

		for handle in handles {
			handle.join().expect("thread join");
		}
	}

	#[test]
	fn a_moment_the_file_cannot_be_read_at_is_refused() {
		let exe = std::env::current_exe().expect("current exe");
		let provider = FileProvider::open(&exe).expect("open current exe");
		let address = provider
			.get_image_info()
			.sections
			.first()
			.expect("test binary has at least one section")
			.virtual_address;

		let read_at = |moment: MomentWire| {
			provider
				.read_memory(ReadMemoryParams {
					space: "Image".to_string(),
					address,
					len: 16,
					moment,
				})
				.map(|(result, bytes)| (result.served_moment.kind, bytes.len()))
				.map_err(|error| error.data.expect("domain error").kind)
		};

		let live = MomentWire {
			kind: MomentKindWire::Live,
			epoch: 7,
		};
		let snapshot = MomentWire {
			kind: MomentKindWire::Snapshot,
			epoch: 7,
		};

		// There is no "omitted" case to test: the field is required, so a read
		// with no moment does not compile. That is the point of it being
		// required — the invariant is enforced by the type rather than by every
		// caller remembering.
		assert_eq!(
			(
				read_at(Moment::STATIC.into()),
				read_at(live),
				read_at(snapshot),
			),
			(
				Ok((MomentKindWire::Static, 16)),
				Err(ErrorKind::UnsupportedCapability),
				Err(ErrorKind::UnsupportedCapability),
			),
			"a moment a file has no way to observe is refused rather than answered with file bytes"
		);
	}

	#[test]
	fn both_responders_declare_the_same_protocol_version() {
		let exe = std::env::current_exe().expect("current exe");
		let provider = FileProvider::open(&exe).expect("open current exe");
		assert_eq!(
			provider.initialize().protocol_version,
			delver_protocol::PROTOCOL_VERSION,
			"the provider declares the shared constant, not a literal of its own"
		);
	}

	#[test]
	fn summary_counts_describe_the_image_not_the_recovered_page() {
		// One module and no exports survived a parse that saw nine modules and
		// four exports. Counting the recovered lists would report "imports 1
		// module, exports nothing" about a sample that does neither.
		let image = ParsedImage {
			imports: vec![ImportedModule {
				name: "KERNEL32.dll".to_string(),
				..Default::default()
			}],
			completeness: ParseCompleteness {
				imports_truncated: true,
				import_module_total: 9,
				exports_failed: true,
				export_total: 4,
				relocations_truncated: true,
				relocation_total: 77,
				..Default::default()
			},
			..Default::default()
		};

		let info = image_info(&image, "abc", &[]);

		assert_eq!(
			(
				info.import_module_count,
				info.import_symbol_count,
				info.export_count,
				info.relocation_count,
				info.exports_failed,
				info.fully_parsed
			),
			(9, None, 4, 77, true, false),
			"summary counts come from the parser's totals, not from list lengths"
		);
	}

	#[test]
	fn image_reads_are_clamped_to_the_real_file() {
		assert_eq!(
			clamped_raw_range(0x10, 0x1000, 4, 0x40, 0x20),
			Some((0x14, 0x20)),
			"the file end, not SizeOfRawData, bounds the mmap slice"
		);
		assert_eq!(
			clamped_raw_range(0x4000_0000, 0x1000, 0, 0x40, 0x1000),
			None,
			"an out-of-file PointerToRawData has no valid bytes"
		);
	}
}
