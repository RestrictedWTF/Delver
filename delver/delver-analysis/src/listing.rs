//! The unified listing row space.
//!
//! A listing is one address-ordered sequence over the whole image, not a block
//! of code followed by a block of data. An analyst reading `.text` scrolls into
//! `.rdata` where `.rdata` actually begins, and a string reached from the
//! strings view lands at its own address rather than in a table appended after
//! the last instruction.
//!
//! Built on [`InstructionIndex`] rather than replacing it: instructions remain
//! the dominant row kind and keep their two-parallel-array representation, and
//! strings are folded in with three small vectors sized by the string count —
//! thousands of entries, not the millions that a merged row array would need
//! (`Docs/architecture/data-model.md` §1).

use crate::index::InstructionIndex;

/// What a unified listing row holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListingRow {
	/// Instruction `index` of the underlying [`InstructionIndex`].
	Instruction(usize),
	/// String `index` of the image's string table, in ascending-RVA order.
	String(usize),
}

/// Address-ordered row space over an image's instructions and strings.
///
/// Strings are placed by address and never filtered, including ones that fall
/// inside a decoded instruction. A scanner hit inside real code is usually a
/// false positive, but dropping it here would make it unreachable from the
/// strings view that still lists it — an inconsistency the analyst cannot see
/// or explain. Both rows exist and the analyst judges.
#[derive(Debug, Clone, Default)]
pub struct ListingIndex {
	instructions: InstructionIndex,
	/// String RVAs, strictly ascending, parallel to `string_rows`.
	string_rvas: Vec<u64>,
	/// Slot of each string in the caller's string table, parallel to
	/// `string_rvas`. Present because sorting by RVA reorders that table.
	string_slots: Vec<usize>,
	/// Count of instructions preceding each string, ascending.
	instructions_before: Vec<usize>,
	/// Unified row ordinal of each string, strictly ascending.
	string_rows: Vec<usize>,
}

impl ListingIndex {
	/// Merges an instruction index with `(rva, slot)` pairs for every string.
	pub fn new(instructions: InstructionIndex, mut strings: Vec<(u64, usize)>) -> Self {
		strings.sort_by_key(|(rva, _)| *rva);

		let mut string_rvas = Vec::with_capacity(strings.len());
		let mut string_slots = Vec::with_capacity(strings.len());
		let mut instructions_before = Vec::with_capacity(strings.len());
		let mut string_rows = Vec::with_capacity(strings.len());

		for (position, (rva, slot)) in strings.into_iter().enumerate() {
			let before = instructions.rows_before(rva);
			string_rvas.push(rva);
			string_slots.push(slot);
			instructions_before.push(before);
			// The strings already placed shift this one down by exactly their
			// count, which is what makes the mapping invertible below.
			string_rows.push(before + position);
		}

		Self {
			instructions,
			string_rvas,
			string_slots,
			instructions_before,
			string_rows,
		}
	}

	/// The instruction index this was built from.
	pub fn instructions(&self) -> &InstructionIndex {
		&self.instructions
	}

	/// Total rows.
	pub fn len(&self) -> usize {
		self.instructions.len() + self.string_rvas.len()
	}

	/// Whether the listing has no rows at all.
	pub fn is_empty(&self) -> bool {
		self.len() == 0
	}

	/// Slot in the caller's string table for string `index`.
	pub fn string_slot(&self, index: usize) -> Option<usize> {
		self.string_slots.get(index).copied()
	}

	/// What row `row` holds.
	pub fn row(&self, row: usize) -> Option<ListingRow> {
		match self.string_rows.binary_search(&row) {
			Ok(index) => Some(ListingRow::String(index)),
			Err(preceding) => {
				let index = row.checked_sub(preceding)?;
				(index < self.instructions.len()).then_some(ListingRow::Instruction(index))
			}
		}
	}

	/// Address of row `row`.
	pub fn address_for_row(&self, row: usize) -> Option<u64> {
		match self.row(row)? {
			ListingRow::Instruction(index) => self.instructions.address_for_row(index),
			ListingRow::String(index) => self.string_rvas.get(index).copied(),
		}
	}

	/// Unified row for instruction `index`.
	fn row_for_instruction(&self, index: usize) -> usize {
		// Every string placed at or before this instruction shifts it down one.
		index
			+ self
				.instructions_before
				.partition_point(|before| *before <= index)
	}

	/// Row for an address that starts a string or an instruction.
	///
	/// A string start wins over an instruction covering the same address: the
	/// caller asking for it came from somewhere that named it a string, and
	/// answering with the instruction would move them somewhere they cannot
	/// relate to what they clicked.
	pub fn row_for_address(&self, rva: u64) -> Option<usize> {
		if let Ok(index) = self.string_rvas.binary_search(&rva) {
			return self.string_rows.get(index).copied();
		}
		self.instructions
			.row_for_address(rva)
			.map(|index| self.row_for_instruction(index))
	}

	/// Row covering `rva`, whether or not it starts one.
	pub fn row_containing(&self, rva: u64) -> Option<usize> {
		if let Some(row) = self.row_for_address(rva) {
			return Some(row);
		}
		self.instructions
			.row_containing(rva)
			.map(|index| self.row_for_instruction(index))
	}

	/// Iterates `(row, content)` over a half-open row range.
	pub fn rows(
		&self,
		start: usize,
		count: usize,
	) -> impl Iterator<Item = (usize, ListingRow)> + '_ {
		let end = start.saturating_add(count).min(self.len());
		(start..end).filter_map(move |row| self.row(row).map(|content| (row, content)))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// 0x1000 (3 bytes), 0x1003 (4), 0x1007 (1), 0x2000 (2).
	fn instructions() -> InstructionIndex {
		InstructionIndex::from_pairs(vec![(0x1000, 3), (0x1003, 4), (0x1007, 1), (0x2000, 2)])
	}

	#[test]
	fn strings_sit_at_their_address_rather_than_after_the_last_instruction() {
		// Slots are deliberately out of RVA order: the string table is not sorted.
		let index = ListingIndex::new(instructions(), vec![(0x3000, 0), (0x1005, 1)]);

		let rows: Vec<_> = index.rows(0, index.len()).collect();
		assert_eq!(
			rows,
			vec![
				(0, ListingRow::Instruction(0)), // 0x1000
				(1, ListingRow::Instruction(1)), // 0x1003
				(2, ListingRow::String(0)),      // 0x1005, between two instructions
				(3, ListingRow::Instruction(2)), // 0x1007
				(4, ListingRow::Instruction(3)), // 0x2000
				(5, ListingRow::String(1)),      // 0x3000, past the last instruction
			]
		);
		assert_eq!(index.len(), 6);
		assert_eq!(index.string_slot(0), Some(1));
		assert_eq!(index.string_slot(1), Some(0));
	}

	#[test]
	fn addresses_round_trip_through_rows_in_both_directions() {
		let index = ListingIndex::new(instructions(), vec![(0x3000, 0), (0x1005, 1)]);

		for row in 0..index.len() {
			let rva = index
				.address_for_row(row)
				.expect("every row has an address");
			assert_eq!(index.row_for_address(rva), Some(row), "row {row}");
		}
	}

	#[test]
	fn an_address_inside_an_instruction_resolves_to_that_instruction() {
		let index = ListingIndex::new(instructions(), vec![(0x1005, 0)]);

		// 0x1004 is inside the 4-byte instruction at 0x1003, which is row 1.
		assert_eq!(index.row_containing(0x1004), Some(1));
		// 0x1005 starts a string, so it is a row of its own.
		assert_eq!(index.row_containing(0x1005), Some(2));
		// Nothing covers this address at all.
		assert_eq!(index.row_containing(0x8000), None);
	}

	#[test]
	fn a_string_overlapping_decoded_code_keeps_its_own_row() {
		// 0x1003 starts an instruction *and* is reported as a string. Dropping
		// the string would make it unreachable from the strings view.
		let index = ListingIndex::new(instructions(), vec![(0x1003, 0)]);

		assert_eq!(index.len(), 5);
		assert_eq!(
			index.row_for_address(0x1003),
			Some(1),
			"the string wins the address"
		);
		assert_eq!(index.row(1), Some(ListingRow::String(0)));
		assert_eq!(index.row(2), Some(ListingRow::Instruction(1)));
	}

	#[test]
	fn an_empty_string_table_leaves_instruction_rows_untouched() {
		let index = ListingIndex::new(instructions(), vec![]);

		assert_eq!(index.len(), 4);
		assert_eq!(index.row(3), Some(ListingRow::Instruction(3)));
		assert_eq!(index.row(4), None);
		assert_eq!(index.row_for_address(0x2000), Some(3));
	}

	#[test]
	fn an_image_with_only_strings_still_indexes() {
		let index = ListingIndex::new(InstructionIndex::default(), vec![(0x40, 0), (0x10, 1)]);

		assert_eq!(index.len(), 2);
		assert_eq!(index.address_for_row(0), Some(0x10));
		assert_eq!(index.address_for_row(1), Some(0x40));
		assert!(!index.is_empty());
	}
}
