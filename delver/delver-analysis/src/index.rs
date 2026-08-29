//! The instruction index.
//!
//! Backs P1 decision E4: a virtualized listing needs an exact total row count
//! and an O(log n) mapping between row ordinal and address, in both directions.
//!
//! x86 instructions are variable-length, so row ordinal cannot be computed from
//! an address arithmetically — the index has to exist. It is a pair of parallel
//! arrays rather than a `Vec<Instruction>`: at ~1.5M instructions per module,
//! one object per row is the difference between a workable heap and a dead one
//! (`Docs/architecture/data-model.md` §1).

/// Sorted index of decoded instruction boundaries.
#[derive(Debug, Clone, Default)]
pub struct InstructionIndex {
	/// Instruction start RVAs, strictly ascending.
	rvas: Vec<u64>,
	/// Encoded length of each instruction, parallel to `rvas`.
	lens: Vec<u32>,
}

impl InstructionIndex {
	/// Builds an index from `(rva, len)` pairs in any order.
	///
	/// Duplicates are collapsed: recursive descent reaches the same address by
	/// several paths, and a row must appear exactly once.
	pub fn from_pairs(mut pairs: Vec<(u64, u32)>) -> Self {
		pairs.sort_unstable_by_key(|(rva, _)| *rva);
		pairs.dedup_by_key(|(rva, _)| *rva);

		let mut rvas = Vec::with_capacity(pairs.len());
		let mut lens = Vec::with_capacity(pairs.len());
		for (rva, len) in pairs {
			rvas.push(rva);
			lens.push(len);
		}
		Self { rvas, lens }
	}

	/// Total number of rows.
	pub fn len(&self) -> usize {
		self.rvas.len()
	}

	/// Whether the index holds no instructions.
	pub fn is_empty(&self) -> bool {
		self.rvas.is_empty()
	}

	/// Address of row `row`. O(1).
	pub fn address_for_row(&self, row: usize) -> Option<u64> {
		self.rvas.get(row).copied()
	}

	/// Encoded length of row `row`.
	pub fn len_for_row(&self, row: usize) -> Option<u32> {
		self.lens.get(row).copied()
	}

	/// Row ordinal for an exact instruction start. O(log n).
	///
	/// Returns `None` for an address that is not an instruction boundary — an
	/// address in the middle of an instruction is not a row, and reporting the
	/// neighbouring row would be a guess.
	pub fn row_for_address(&self, rva: u64) -> Option<usize> {
		self.rvas.binary_search(&rva).ok()
	}

	/// Row containing `rva`, whether or not it is a boundary. O(log n).
	///
	/// Use when the caller has an arbitrary address — a scroll position or a
	/// branch target into the middle of an instruction — and needs the row that
	/// covers it.
	pub fn row_containing(&self, rva: u64) -> Option<usize> {
		let row = match self.rvas.binary_search(&rva) {
			Ok(exact) => return Some(exact),
			Err(0) => return None,
			Err(next) => next - 1,
		};
		let start = self.rvas[row];
		let end = start + self.lens[row] as u64;
		if rva < end {
			Some(row)
		} else {
			None
		}
	}

	/// How many instructions start strictly before `rva`. O(log n).
	///
	/// This is the insertion point for a non-instruction row at `rva`, which is
	/// what the unified listing index needs to interleave data by address.
	pub fn rows_before(&self, rva: u64) -> usize {
		self.rvas.partition_point(|start| *start < rva)
	}

	/// Iterates `(row, rva, len)` over a half-open row range.
	pub fn rows(&self, start: usize, count: usize) -> impl Iterator<Item = (usize, u64, u32)> + '_ {
		let end = start.saturating_add(count).min(self.len());
		(start..end).map(move |row| (row, self.rvas[row], self.lens[row]))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn sample() -> InstructionIndex {
		// 0x1000 (3 bytes), 0x1003 (4), 0x1007 (1)
		InstructionIndex::from_pairs(vec![(0x1003, 4), (0x1000, 3), (0x1007, 1)])
	}

	#[test]
	fn maps_rows_to_addresses_and_back() {
		let index = sample();
		assert_eq!(index.len(), 3);
		assert_eq!(index.address_for_row(1), Some(0x1003));
		assert_eq!(index.row_for_address(0x1003), Some(1));
		assert_eq!(index.row_for_address(0x1007), Some(2));
	}

	#[test]
	fn round_trips_every_row() {
		let index = sample();
		for row in 0..index.len() {
			let rva = index.address_for_row(row).expect("address");
			assert_eq!(index.row_for_address(rva), Some(row));
		}
	}

	#[test]
	fn a_mid_instruction_address_is_not_a_row() {
		let index = sample();
		// 0x1001 is inside the 3-byte instruction at 0x1000.
		assert_eq!(index.row_for_address(0x1001), None);
		assert_eq!(index.row_containing(0x1001), Some(0));
	}

	#[test]
	fn addresses_outside_the_index_have_no_row() {
		let index = sample();
		assert_eq!(index.row_containing(0x0FFF), None);
		assert_eq!(index.row_containing(0x1008), None);
	}

	#[test]
	fn duplicate_addresses_collapse_to_one_row() {
		let index = InstructionIndex::from_pairs(vec![(0x1000, 3), (0x1000, 3), (0x1003, 1)]);
		assert_eq!(index.len(), 2);
	}

	#[test]
	fn rows_yields_a_bounded_window() {
		let index = sample();
		let window: Vec<_> = index.rows(1, 99).map(|(_, rva, _)| rva).collect();
		assert_eq!(window, vec![0x1003, 0x1007]);
	}
}
