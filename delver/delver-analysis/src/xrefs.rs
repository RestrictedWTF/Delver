//! Cross-reference tables.
//!
//! Stored as two sorted arrays — one ordered by source, one by target — and
//! answered by binary search. An xref is a row, not an object: at the scale of
//! a real module there are millions of them, and materialising each as a graph
//! node is the storage mistake described in
//! `Docs/architecture/data-model.md` §1.

/// What kind of reference one address makes to another.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum XrefKind {
	/// A direct call.
	Call,
	/// An unconditional direct branch.
	Jump,
	/// A conditional branch.
	ConditionalJump,
	/// A RIP-relative memory operand — how data references surface on x64.
	Data,
}

/// A single reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Xref {
	/// Address of the referencing instruction.
	pub from: u64,
	/// Address referred to.
	pub to: u64,
	/// Kind of reference.
	pub kind: XrefKind,
}

/// Bidirectional xref index.
#[derive(Debug, Clone, Default)]
pub struct XrefTable {
	by_from: Vec<Xref>,
	by_to: Vec<Xref>,
}

impl XrefTable {
	/// Builds the table, sorting and deduplicating both orderings.
	pub fn new(mut xrefs: Vec<Xref>) -> Self {
		xrefs.sort_unstable();
		xrefs.dedup();

		let by_from = xrefs.clone();
		let mut by_to = xrefs;
		by_to.sort_unstable_by_key(|x| (x.to, x.from, x.kind));

		Self { by_from, by_to }
	}

	/// Total number of references.
	pub fn len(&self) -> usize {
		self.by_from.len()
	}

	/// Whether the table is empty.
	pub fn is_empty(&self) -> bool {
		self.by_from.is_empty()
	}

	/// References made *by* the instruction at `rva`.
	pub fn from(&self, rva: u64) -> &[Xref] {
		let start = self.by_from.partition_point(|x| x.from < rva);
		let end = self.by_from.partition_point(|x| x.from <= rva);
		&self.by_from[start..end]
	}

	/// References made *to* `rva`.
	///
	/// This is the direction that answers "who calls this function", which is
	/// why the table is stored twice rather than scanned.
	pub fn to(&self, rva: u64) -> &[Xref] {
		let start = self.by_to.partition_point(|x| x.to < rva);
		let end = self.by_to.partition_point(|x| x.to <= rva);
		&self.by_to[start..end]
	}

	/// Every reference, ordered by source address.
	pub fn all(&self) -> &[Xref] {
		&self.by_from
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn table() -> XrefTable {
		XrefTable::new(vec![
			Xref {
				from: 0x1010,
				to: 0x2000,
				kind: XrefKind::Call,
			},
			Xref {
				from: 0x1000,
				to: 0x2000,
				kind: XrefKind::Call,
			},
			Xref {
				from: 0x1000,
				to: 0x3000,
				kind: XrefKind::Data,
			},
			Xref {
				from: 0x1020,
				to: 0x1000,
				kind: XrefKind::Jump,
			},
		])
	}

	#[test]
	fn finds_references_in_both_directions() {
		let table = table();

		let from_1000: Vec<_> = table.from(0x1000).iter().map(|x| x.to).collect();
		assert_eq!(from_1000, vec![0x2000, 0x3000]);

		let to_2000: Vec<_> = table.to(0x2000).iter().map(|x| x.from).collect();
		assert_eq!(to_2000, vec![0x1000, 0x1010]);
	}

	#[test]
	fn unreferenced_addresses_yield_nothing() {
		let table = table();
		assert!(table.from(0x9999).is_empty());
		assert!(table.to(0x9999).is_empty());
	}

	#[test]
	fn duplicates_collapse() {
		let xref = Xref {
			from: 0x1000,
			to: 0x2000,
			kind: XrefKind::Call,
		};
		let table = XrefTable::new(vec![xref, xref, xref]);
		assert_eq!(table.len(), 1);
	}

	#[test]
	fn distinct_kinds_between_the_same_pair_are_kept() {
		let table = XrefTable::new(vec![
			Xref {
				from: 0x1000,
				to: 0x2000,
				kind: XrefKind::Call,
			},
			Xref {
				from: 0x1000,
				to: 0x2000,
				kind: XrefKind::Data,
			},
		]);
		assert_eq!(table.len(), 2);
	}
}
