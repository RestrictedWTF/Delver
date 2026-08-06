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

use anyhow::{Context, Result, bail};
use delver_protocol::{
	AddressSpaceKindWire, AddressSpaceWire, FrameRef, GetImageInfoResult, InitializeResult,
	MomentKindWire, MomentWire, RangeWire, ReadMemoryParams, ReadMemoryResult, SectionWire,
	TargetCapabilityWire, TargetDescriptorWire,
};
use memmap2::Mmap;

/// Parsed image metadata extracted once at open time.
#[derive(Debug, Clone)]
pub struct ParsedImage {
	/// Architecture string, e.g. "x86_64".
	pub arch: String,
	/// Image entry point as an RVA.
	pub entry: u64,
	/// Preferred image base.
	pub image_base: u64,
	/// Loadable sections.
	pub sections: Vec<Section>,
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
}

/// Provider state for a single target file.
pub struct FileProvider {
	mmap: Mmap,
	image: ParsedImage,
	file_size: u64,
	next_frame_id: u64,
}

impl FileProvider {
	/// Opens and maps the file at `path`.
	pub fn open(path: &Path) -> Result<Self> {
		let file = File::open(path).with_context(|| format!("opening {path:?}"))?;
		let mmap = unsafe { Mmap::map(&file) }.with_context(|| format!("mapping {path:?}"))?;
		let file_size = mmap.len() as u64;
		let image = parse_pe(&mmap)?;
		Ok(Self {
			mmap,
			image,
			file_size,
			next_frame_id: 1,
		})
	}

	/// Allocates the next binary frame id.
	fn alloc_frame_id(&mut self) -> u64 {
		let id = self.next_frame_id;
		self.next_frame_id += 1;
		id
	}

	/// Returns the initialize response payload.
	pub fn initialize(&self) -> InitializeResult {
		InitializeResult {
			protocol_version: "0".to_string(),
			capabilities: vec![
				TargetCapabilityWire::ListSpaces,
				TargetCapabilityWire::GetImageInfo,
				TargetCapabilityWire::ReadMemory,
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
		vec![
			AddressSpaceWire {
				id: "File".to_string(),
				kind: AddressSpaceKindWire::File,
				pointer_width: 64,
				translates_to: None,
			},
			AddressSpaceWire {
				id: "Image".to_string(),
				kind: AddressSpaceKindWire::Image,
				pointer_width: 64,
				translates_to: Some("File".to_string()),
			},
		]
	}

	/// Returns image metadata.
	pub fn get_image_info(&self) -> GetImageInfoResult {
		GetImageInfoResult {
			arch: self.image.arch.clone(),
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
				})
				.collect(),
		}
	}

	/// Reads memory from the requested space and returns the response payload
	/// plus the binary bytes to send.
	pub fn read_memory(&mut self, params: ReadMemoryParams) -> Result<(ReadMemoryResult, Vec<u8>)> {
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

fn parse_pe(data: &[u8]) -> Result<ParsedImage> {
	// Prefer the 64-bit PE parser; fall back to 32-bit.
	if let Ok(file) = object::read::pe::PeFile64::parse(data) {
		return extract_image(&file);
	}
	if let Ok(file) = object::read::pe::PeFile32::parse(data) {
		return extract_image(&file);
	}
	bail!("file is not a supported PE image")
}

fn extract_image<'data, File>(file: &File) -> Result<ParsedImage>
where
	File: object::read::Object<'data>,
{
	use object::read::ObjectSection;

	let image_base = file.relative_address_base();
	let arch = format!("{:?}", file.architecture());
	let entry = file.entry().saturating_sub(image_base);

	let sections = file
		.sections()
		.map(|s| {
			let va = s.address();
			let size = s.size();
			let (raw_offset, raw_size) = s.file_range().unwrap_or((0, 0));
			Section {
				name: s.name().unwrap_or("").to_string(),
				virtual_address: va.saturating_sub(image_base),
				virtual_size: size,
				raw_offset,
				raw_size,
			}
		})
		.collect();

	Ok(ParsedImage {
		arch,
		entry,
		image_base,
		sections,
	})
}

#[cfg(test)]
mod tests {
	use delver_core::{AddressSpace, AddressSpaceKind};

	#[test]
	fn file_provider_api_types_exist() {
		let space = AddressSpace::new("Image", AddressSpaceKind::Image, 64, Option::<&str>::None);
		assert_eq!(space.pointer_width, 64);
	}
}
