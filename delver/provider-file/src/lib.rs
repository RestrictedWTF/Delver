//! File provider for Delver.
//!
//! Exposes two address spaces for PE files:
//! - `File`: raw file offsets.
//! - `Image`: relative virtual addresses (RVA) with sections applied.
//!
//! Reads that extend past the readable region return partial data and valid
//! ranges instead of an error.

#![warn(missing_docs)]

use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{bail, Context, Result};
use delver_format::{parse_pe, ParsedImage, SeedSource};
use delver_protocol::{
	AddressSpaceKindWire, AddressSpaceWire, ExportWire, FrameRef, FunctionSeedWire,
	GetExportsResult, GetFunctionSeedsResult, GetImageInfoResult, GetImportsResult,
	ImportedModuleWire, ImportedSymbolWire, InitializeResult, MomentKindWire, MomentWire,
	RangeWire, ReadMemoryParams, ReadMemoryResult, SectionWire, SeedSourceWire,
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
		let mmap = unsafe { Mmap::map(&file) }.with_context(|| format!("mapping {path:?}"))?;
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
			protocol_version: "0".to_string(),
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
		let import_symbol_count = self
			.image
			.imports
			.iter()
			.map(|m| m.symbols.len() as u64)
			.sum();

		GetImageInfoResult {
			arch: self.image.arch.clone(),
			content_hash: self.content_hash.clone(),
			entry: self.image.entry,
			image_base: self.image.image_base,
			sections: self
				.image
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
					entropy: s.entropy(&self.mmap),
				})
				.collect(),
			import_module_count: self.image.imports.len() as u64,
			import_symbol_count,
			export_count: self.image.exports.len() as u64,
			function_seed_count: self.image.function_seeds.len() as u64,
			relocation_count: self.image.relocations.len() as u64,
			tls: self.image.tls.as_ref().map(|t| TlsWire {
				index_rva: t.index_rva,
				raw_data_rva: t.raw_data_rva,
				raw_data_size: t.raw_data_size,
				callbacks: t.callbacks.clone(),
			}),
		}
	}

	/// Returns imported modules and their symbols.
	pub fn get_imports(&self) -> GetImportsResult {
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
						})
						.collect(),
				})
				.collect(),
		}
	}

	/// Returns exported symbols.
	pub fn get_exports(&self) -> GetExportsResult {
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
		}
	}

	/// Returns candidate function starts, sorted by address.
	pub fn get_function_seeds(&self) -> GetFunctionSeedsResult {
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
		}
	}

	/// Reads memory from the requested space and returns the response payload
	/// plus the binary bytes to send.
	pub fn read_memory(&self, params: ReadMemoryParams) -> Result<(ReadMemoryResult, Vec<u8>)> {
		let space = params.space.as_str();
		let address = params.address;
		let len = params.len;

		let (bytes, valid) = match space {
			"File" => self.read_file(address, len),
			"Image" => self.read_image(address, len),
			_ => bail!("unknown address space: {space}"),
		};

		let frame_id = self.alloc_frame_id();
		let result = ReadMemoryResult {
			data: FrameRef {
				frame_id,
				len: bytes.len() as u64,
			},
			valid,
			served_moment: MomentWire {
				kind: MomentKindWire::Static,
				epoch: 0,
			},
		};
		Ok((result, bytes))
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

		let raw_start = section.raw_offset + section_start;
		let raw_end = raw_start + read_len;
		let raw_end = raw_end.min(section.raw_end());
		let read_len = raw_end.saturating_sub(raw_start);

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
				end: rva + read_len,
			}]
		};
		(bytes, valid)
	}
}

fn seed_source_wire(source: SeedSource) -> SeedSourceWire {
	match source {
		SeedSource::ExceptionDirectory => SeedSourceWire::ExceptionDirectory,
		SeedSource::EntryPoint => SeedSourceWire::EntryPoint,
		SeedSource::Export => SeedSourceWire::Export,
		SeedSource::TlsCallback => SeedSourceWire::TlsCallback,
	}
}

#[cfg(test)]
mod tests {
	use std::thread;

	use delver_core::{AddressSpace, AddressSpaceKind};
	use delver_protocol::ReadMemoryParams;

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
					moment: None,
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
