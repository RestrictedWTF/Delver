//! Per-address bookkeeping for the descent.
//!
//! Recursive descent asks two questions about millions of addresses — *have I
//! been here* and *how long is the instruction here* — and the linear sweep asks
//! the first one about every executable byte in the image. A `BTreeSet`/
//! `BTreeMap` keyed by RVA would answer both in `O(log n)` with a pointer chase
//! per level, and at eight million instructions that lookup cost, not the
//! decoding, would dominate the analysis. So this is a flat byte array instead.
//!
//! Nothing the section table says is trusted to make that array work. Headers
//! may arrive unsorted, may overlap, may alias the same file bytes at several
//! RVAs, and may declare extents the file does not contain — so `new` sorts the
//! bounds itself, trims each one against the region before it, and intersects
//! every declared extent with the bytes that are really on disk. What survives
//! is a short list of disjoint ascending ranges, which a binary search turns
//! into an array index; every query after that is a single byte read.
//!
//! Allocation is at most one byte per byte of the mapped file, aliased headers
//! included. That is a hard cap rather than a claim about the image: when the
//! declared sections do exceed it, the tail of the region that hits the cap and
//! every region after it get no cells at all. Addresses there then behave
//! exactly like addresses outside every section — `visit` reports nothing to
//! walk — so a crafted header can cost analysis coverage, but never memory.

use delver_format::ParsedImage;
use std::ops::Range;

/// Marks an address the descent has already considered.
const VISITED: u8 = 0x80;

/// Mask for the instruction length stored in the low bits.
///
/// An x86 instruction is at most 15 bytes, which is exactly what four bits
/// hold. Zero means "not an instruction start".
const LEN_MASK: u8 = 0x0F;

/// One contiguous run of addresses backed by file data.
struct Region {
	/// First RVA covered.
	start: u64,
	/// Exclusive last RVA covered.
	end: u64,
	/// Index in `cells` corresponding to `start`.
	base: usize,
}

/// Flat per-RVA state over every address backed by file data.
pub(crate) struct RvaState {
	regions: Vec<Region>,
	cells: Vec<u8>,
}

impl RvaState {
	/// Builds state covering the raw-data extent of every section.
	///
	/// Only raw data is covered because that is exactly where `bytes_at` can
	/// return anything: an address in a section's zero-filled tail has no bytes
	/// to decode, so the descent can never mark it.
	pub(crate) fn new(image: &ParsedImage, file_size: u64, coverage: &[Range<u64>]) -> Self {
		let mut regions: Vec<Region> = Vec::with_capacity(image.sections.len());
		let mut base = 0usize;
		let max_cells = usize::try_from(file_size).unwrap_or(usize::MAX);

		let mut bounds: Vec<(u64, u64)> = Vec::new();
		for section in &image.sections {
			let raw_end = section.raw_end().min(file_size);
			for range in coverage {
				let start = section.raw_offset.max(range.start);
				let end = raw_end.min(range.end);
				if start < end {
					let rva = section
						.virtual_address
						.saturating_add(start.saturating_sub(section.raw_offset));
					bounds.push((rva, rva.saturating_add(end - start)));
				}
			}
		}
		bounds.sort_unstable_by_key(|(start, _)| *start);

		for (start, end) in bounds {
			// Sections should not overlap, but nothing in the file format
			// guarantees it. Trimming keeps the index a function rather than
			// letting a crafted header alias two addresses onto one cell.
			let start = match regions.last() {
				Some(previous) => start.max(previous.end),
				None => start,
			};
			if end <= start {
				continue;
			}
			// Multiple hostile section headers can alias the same file bytes at
			// different RVAs. Do not let those aliases multiply the allocation
			// beyond the size of the mapped file.
			let remaining = max_cells.saturating_sub(base);
			let len = usize::try_from(end - start)
				.unwrap_or(usize::MAX)
				.min(remaining);
			if len == 0 {
				break;
			}
			let end = start.saturating_add(len as u64);
			regions.push(Region { start, end, base });
			base += len;
		}

		Self {
			regions,
			cells: vec![0u8; base],
		}
	}

	fn index(&self, rva: u64) -> Option<usize> {
		let found = self
			.regions
			.binary_search_by(|region| {
				if rva < region.start {
					std::cmp::Ordering::Greater
				} else if rva >= region.end {
					std::cmp::Ordering::Less
				} else {
					std::cmp::Ordering::Equal
				}
			})
			.ok()?;
		let region = &self.regions[found];
		Some(region.base + (rva - region.start) as usize)
	}

	/// Marks `rva` visited, returning whether this was the first visit.
	///
	/// An address outside every region reports `false`: there is nothing there
	/// to decode, so treating it as already handled stops the walk exactly where
	/// the byte lookup would have.
	pub(crate) fn visit(&mut self, rva: u64) -> bool {
		let Some(index) = self.index(rva) else {
			return false;
		};
		if self.cells[index] & VISITED != 0 {
			return false;
		}
		self.cells[index] |= VISITED;
		true
	}

	pub(crate) fn is_visited(&self, rva: u64) -> bool {
		self.index(rva)
			.is_some_and(|index| self.cells[index] & VISITED != 0)
	}

	/// Records that a decoded instruction of `len` bytes starts at `rva`.
	pub(crate) fn set_instruction(&mut self, rva: u64, len: u32) {
		let Some(index) = self.index(rva) else {
			return;
		};
		// A length that does not fit is not representable and would alias onto a
		// different one, so it is recorded as "visited, not a start" instead.
		let len = if len <= LEN_MASK as u32 { len as u8 } else { 0 };
		self.cells[index] = VISITED | len;
	}

	/// Length of the instruction starting at `rva`, or `None` if none does.
	pub(crate) fn instruction_len(&self, rva: u64) -> Option<u32> {
		let index = self.index(rva)?;
		match self.cells[index] & LEN_MASK {
			0 => None,
			len => Some(len as u32),
		}
	}

	/// Every decoded instruction as `(rva, len)`, ascending.
	pub(crate) fn instructions(&self) -> Vec<(u64, u32)> {
		let mut out = Vec::new();
		for region in &self.regions {
			let span = (region.end - region.start) as usize;
			for offset in 0..span {
				let len = self.cells[region.base + offset] & LEN_MASK;
				if len != 0 {
					out.push((region.start + offset as u64, len as u32));
				}
			}
		}
		out
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use delver_format::Section;

	fn image_with_sections(sections: Vec<Section>) -> ParsedImage {
		ParsedImage {
			arch: "X86_64".to_string(),
			sections,
			..Default::default()
		}
	}

	fn state(image: &ParsedImage, file_size: u64) -> RvaState {
		RvaState::new(image, file_size, std::slice::from_ref(&(0..file_size)))
	}

	fn section(virtual_address: u64, raw_size: u64) -> Section {
		Section {
			name: ".text".to_string(),
			virtual_address,
			virtual_size: raw_size,
			raw_offset: 0,
			raw_size,
			characteristics: 0x6000_0020,
		}
	}

	#[test]
	fn visits_are_recorded_once_per_address() {
		let mut state = state(&image_with_sections(vec![section(0x1000, 0x100)]), 0x100);

		assert!(state.visit(0x1000), "first visit is new");
		assert!(!state.visit(0x1000), "second visit is not");
		assert!(state.is_visited(0x1000));
		assert!(!state.is_visited(0x1001));
	}

	#[test]
	fn an_address_outside_every_section_is_never_new() {
		let mut state = state(&image_with_sections(vec![section(0x1000, 0x100)]), 0x100);

		assert!(!state.visit(0x0fff), "below the first section");
		assert!(!state.visit(0x1100), "at the exclusive end");
	}

	#[test]
	fn instructions_come_back_sorted_across_sections() {
		let image = image_with_sections(vec![section(0x3000, 0x10), section(0x1000, 0x10)]);
		let mut state = state(&image, 0x20);

		state.set_instruction(0x3000, 4);
		state.set_instruction(0x1000, 3);
		state.set_instruction(0x1004, 15);

		assert_eq!(
			state.instructions(),
			vec![(0x1000, 3), (0x1004, 15), (0x3000, 4)]
		);
		assert_eq!(state.instruction_len(0x1004), Some(15));
		assert_eq!(state.instruction_len(0x1001), None);
	}

	#[test]
	fn overlapping_sections_do_not_alias_onto_one_cell() {
		// Nothing in the PE format prevents this; a crafted image can declare it.
		let image = image_with_sections(vec![section(0x1000, 0x100), section(0x1080, 0x100)]);
		let mut state = state(&image, 0x200);

		state.set_instruction(0x1080, 2);
		assert_eq!(state.instruction_len(0x1080), Some(2));
		assert_eq!(
			state.instructions().len(),
			1,
			"an address must map to exactly one cell"
		);
	}

	#[test]
	fn declared_raw_size_is_clamped_before_allocation() {
		let mut hostile = section(0x1000, u64::MAX);
		hostile.raw_offset = 4;
		let state = state(&image_with_sections(vec![hostile]), 16);

		assert_eq!(state.cells.len(), 12);
		assert!(state.index(0x100b).is_some());
		assert!(state.index(0x100c).is_none());
	}

	#[test]
	fn out_of_file_section_allocates_no_state() {
		let mut hostile = section(0x1000, u64::MAX);
		hostile.raw_offset = 0x4000_0000;
		let state = state(&image_with_sections(vec![hostile]), 4096);

		assert!(state.cells.is_empty());
		assert!(state.regions.is_empty());
	}

	#[test]
	fn aliased_sections_cannot_multiply_the_file_sized_budget() {
		let image = image_with_sections(vec![section(0x1000, 16), section(0x2000, 16)]);
		let mut state = state(&image, 16);

		// The budget is spent on the first region, so the second gets no cells
		// and its addresses are inert — the documented cost of the cap.
		assert_eq!(
			(
				state.cells.len(),
				state.regions.len(),
				state.visit(0x1000),
				state.visit(0x2000),
			),
			(16, 1, true, false),
		);
	}
}
