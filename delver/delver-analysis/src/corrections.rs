//! Authored corrections to function detection.
//!
//! Detection is a derivation, and a derivation can be wrong: the linear sweep
//! guesses a function where there is none, and a function nothing references
//! and nothing lands on is missed entirely. An analyst who can see that has to
//! be able to say it.
//!
//! A correction says it **without writing into the fact store**. It is an
//! authored change to the *seed set*, and [`crate::analyze_corrected`] then
//! re-derives every fact from the image bytes plus the corrected seeds. The
//! correction itself lives in the authored log; the facts stay recomputable
//! from their inputs. That is what keeps facts and interpretation in separate
//! stores (`Docs/architecture/data-model.md` §3) rather than leaving a fact
//! store with a hand-edit in it that nothing can reproduce.
//!
//! Two consequences worth stating outright:
//!
//! * **Corrections apply to addresses, not to bytes.** Nothing here reads or
//!   modifies the file. No byte is patched, and the same bytes with the same
//!   corrections always derive the same facts. Patching bytes is a different
//!   operation with a different disclosure and a different recovery story.
//! * **A function correction is about a function start, not about whether
//!   bytes are code.** [`FunctionCorrectionKind::Undefine`] withdraws the claim
//!   that a function begins at an address; it does not claim the bytes there are
//!   data. Saying *that* is [`DataRangeCorrection`], a separate operation on a
//!   separate axis: one names a start, the other denies a run of bytes was ever
//!   code.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Bound;

/// One authored correction to function detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FunctionCorrection {
	/// The corrected address, as an RVA.
	pub rva: u64,
	/// What the author asserts about it.
	pub kind: FunctionCorrectionKind,
}

/// What a [`FunctionCorrection`] asserts about its address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FunctionCorrectionKind {
	/// A function starts here. `end_rva` is exclusive; absent means "infer the
	/// extent the way a detected function's is inferred".
	Define {
		/// Exclusive end of the function, when the author pins one.
		end_rva: Option<u64>,
	},
	/// No function starts here, whatever detection concluded.
	Undefine,
}

/// One authored assertion that a run of bytes is data, not code.
///
/// This is the operation that says "the decoder was wrong about these bytes".
/// Like a [`FunctionCorrection`] it is an *input* to the derivation: analysis
/// re-runs from the image bytes with the range excluded from decoding, so no
/// instruction inside it enters the index, no function starts inside it from
/// any source, and no xref originates inside it.
///
/// **An xref that *targets* the range survives.** Something referencing an
/// address is a fact about the image whatever lives at that address — the same
/// reason [`FunctionCorrectionKind::Undefine`] keeps inbound call xrefs. The
/// author denied that these bytes are code, not that anything points at them;
/// a pointer into a table is exactly the reference worth keeping.
///
/// Strings are untouched. The string scanner reads bytes rather than decoded
/// code, so calling a range data cannot change what it finds — if anything it
/// makes the find more right.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DataRangeCorrection {
	/// Inclusive start.
	pub rva: u64,
	/// Exclusive end.
	pub end_rva: u64,
}

/// The authored corrections one analysis derives from.
///
/// Both axes travel together because they are checked together: a `Define`
/// inside a data range is a contradiction neither list can see on its own.
///
/// A bare `&[FunctionCorrection]` converts into this with no data ranges, which
/// is what keeps [`crate::analyze_corrected`]'s existing callers unchanged.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Corrections<'a> {
	/// Corrections to function detection.
	pub functions: &'a [FunctionCorrection],
	/// Runs of bytes the author says are data.
	pub data_ranges: &'a [DataRangeCorrection],
}

impl<'a> From<&'a [FunctionCorrection]> for Corrections<'a> {
	fn from(functions: &'a [FunctionCorrection]) -> Self {
		Self {
			functions,
			data_ranges: &[],
		}
	}
}

impl<'a, const N: usize> From<&'a [FunctionCorrection; N]> for Corrections<'a> {
	fn from(functions: &'a [FunctionCorrection; N]) -> Self {
		Self::from(functions.as_slice())
	}
}

/// Why a correction set was refused.
///
/// Every variant names the address at fault, because the author has to be able
/// to find the correction to withdraw it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorrectionConflict {
	/// Two corrections name the same address.
	///
	/// Covers both a repeated correction and a `Define`/`Undefine` pair: either
	/// way the set does not say one thing about the address, and guessing which
	/// one the author meant would be inventing an answer.
	DuplicateAddress {
		/// The address named twice.
		rva: u64,
	},
	/// A `Define` whose exclusive end is not after its start, so it describes
	/// no bytes at all.
	EmptyExtent {
		/// The function start.
		rva: u64,
		/// The exclusive end the author gave, which is `<= rva`.
		end_rva: u64,
	},
	/// A data range whose exclusive end is not after its start, so it describes
	/// no bytes at all.
	EmptyDataRange {
		/// The range start.
		rva: u64,
		/// The exclusive end the author gave, which is `<= rva`.
		end_rva: u64,
	},
	/// Two data ranges cover a byte in common.
	///
	/// Overlapping ranges say the same thing twice about the shared bytes, but
	/// there is no reading of the set that makes them one range the author drew;
	/// merging them silently would put bytes under a range nobody recorded.
	OverlappingDataRanges {
		/// The start of the range that overlaps.
		rva: u64,
		/// The start of the range it overlaps.
		overlaps: u64,
	},
	/// A `Define` whose start falls inside a data range.
	///
	/// The set says both "a function begins here" and "these bytes are not
	/// code". Resolving that either way would be inventing an answer, so the
	/// set is refused and the author decides which they meant.
	DefineInsideDataRange {
		/// The authored function start.
		rva: u64,
		/// The start of the data range containing it.
		range_rva: u64,
	},
}

impl std::fmt::Display for CorrectionConflict {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::DuplicateAddress { rva } => {
				write!(f, "two corrections name {rva:#x}")
			}
			Self::EmptyExtent { rva, end_rva } => write!(
				f,
				"the function defined at {rva:#x} ends at {end_rva:#x}, which is not after it",
			),
			Self::EmptyDataRange { rva, end_rva } => write!(
				f,
				"the data range at {rva:#x} ends at {end_rva:#x}, which is not after it",
			),
			Self::OverlappingDataRanges { rva, overlaps } => write!(
				f,
				"the data range at {rva:#x} overlaps the one at {overlaps:#x}",
			),
			Self::DefineInsideDataRange { rva, range_rva } => write!(
				f,
				"a function is defined at {rva:#x}, inside the data range at {range_rva:#x}",
			),
		}
	}
}

impl std::error::Error for CorrectionConflict {}

/// A correction set that has been checked for conflicts and can be analysed
/// with.
///
/// The only way to build a non-empty one is [`CorrectionSet::new`], so holding
/// this value is proof the set was validated as a whole.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CorrectionSet {
	/// Authored function starts, and the extent the author pinned if any.
	defines: BTreeMap<u64, Option<u64>>,
	/// Addresses no function may start at, whatever discovers them.
	undefines: BTreeSet<u64>,
	/// Runs of bytes that are not code, as start -> exclusive end. Disjoint,
	/// which is what lets a lookup consult at most two neighbours.
	data_ranges: BTreeMap<u64, u64>,
}

impl CorrectionSet {
	/// Validates `corrections`, refusing the **whole** set if anything
	/// conflicts.
	///
	/// Atomicity is not fastidiousness here. Analysis with corrections is a
	/// derivation, and the corrections are its inputs; the value of that is
	/// that an analyst can look at the input set and know what the facts mean.
	/// A half-applied set breaks exactly that: the resulting facts correspond
	/// to no set anyone recorded, so the store can neither be reasoned about
	/// nor reproduced, and the author is not told which half survived. Failing
	/// closed leaves the previous analysis intact and the conflict visible.
	///
	/// The first conflict in `corrections` order is the one reported.
	/// Data-range conflicts are reported before function ones, because a
	/// `Define` inside a range can only be judged once the ranges are known.
	pub fn new<'a>(corrections: impl Into<Corrections<'a>>) -> Result<Self, CorrectionConflict> {
		let corrections = corrections.into();
		let mut set = Self::default();

		for range in corrections.data_ranges {
			let (rva, end_rva) = (range.rva, range.end_rva);
			if end_rva <= rva {
				return Err(CorrectionConflict::EmptyDataRange { rva, end_rva });
			}
			// Disjointness is the invariant every lookup below relies on, so it
			// is checked against both neighbours rather than assumed.
			let before = set.data_ranges.range(..=rva).next_back();
			if let Some((&other_rva, &other_end)) = before {
				if other_end > rva {
					return Err(CorrectionConflict::OverlappingDataRanges {
						rva,
						overlaps: other_rva,
					});
				}
			}
			if let Some((&other_rva, _)) = set.data_ranges.range(rva..).next() {
				if other_rva < end_rva {
					return Err(CorrectionConflict::OverlappingDataRanges {
						rva,
						overlaps: other_rva,
					});
				}
			}
			set.data_ranges.insert(rva, end_rva);
		}

		for correction in corrections.functions {
			let rva = correction.rva;
			if let FunctionCorrectionKind::Define {
				end_rva: Some(end_rva),
			} = correction.kind
			{
				if end_rva <= rva {
					return Err(CorrectionConflict::EmptyExtent { rva, end_rva });
				}
			}
			if let FunctionCorrectionKind::Define { .. } = correction.kind {
				if let Some(range_rva) = set.data_range_start_containing(rva) {
					return Err(CorrectionConflict::DefineInsideDataRange { rva, range_rva });
				}
			}
			if set.defines.contains_key(&rva) || set.undefines.contains(&rva) {
				return Err(CorrectionConflict::DuplicateAddress { rva });
			}
			match correction.kind {
				FunctionCorrectionKind::Define { end_rva } => {
					set.defines.insert(rva, end_rva);
				}
				FunctionCorrectionKind::Undefine => {
					set.undefines.insert(rva);
				}
			}
		}

		Ok(set)
	}

	/// Whether the set corrects nothing, in which case analysis is exactly what
	/// it would have been without it.
	pub fn is_empty(&self) -> bool {
		self.defines.is_empty() && self.undefines.is_empty() && self.data_ranges.is_empty()
	}

	/// Authored function starts as `(rva, end_rva)`, ascending.
	pub(crate) fn defines(&self) -> impl Iterator<Item = (u64, Option<u64>)> + '_ {
		self.defines.iter().map(|(&rva, &end_rva)| (rva, end_rva))
	}

	/// Whether the author has said no function starts at `rva`.
	pub(crate) fn is_undefined(&self, rva: u64) -> bool {
		self.undefines.contains(&rva)
	}

	/// The exclusive end of the data range covering `rva`, if one does.
	///
	/// Returning the *end* rather than a yes/no is deliberate: every caller has
	/// to step **over** a data range. Advancing a byte at a time would leave the
	/// far side of the range looking like a fresh run of code and manufacture a
	/// function start just past it.
	pub(crate) fn data_range_end_at(&self, rva: u64) -> Option<u64> {
		self.data_ranges
			.range(..=rva)
			.next_back()
			.and_then(|(_, &end)| (rva < end).then_some(end))
	}

	/// Whether an instruction spanning `[rva, end)` reads any excluded byte.
	///
	/// Checking the *start* of an instruction is not enough, and the gap is not
	/// theoretical: an analyst draws a range at the true start of a jump table,
	/// which is rarely the boundary the bad decode happened to produce. The
	/// instruction before it then reaches into the table for an operand — and
	/// a `call rel32` reading its displacement out of excluded bytes
	/// manufactures a function at whatever address those bytes spell, which is
	/// the exact phantom the correction was authored to remove.
	///
	/// So an instruction is excluded if it *overlaps* a range at all: either it
	/// starts inside one, or a range starts inside it.
	pub(crate) fn instruction_overlaps_data_range(&self, rva: u64, end: u64) -> bool {
		self.data_range_end_at(rva).is_some()
			|| self
				.data_ranges
				.range((Bound::Excluded(rva), Bound::Excluded(end)))
				.next()
				.is_some()
	}

	/// The start of the data range covering `rva`, if one does.
	fn data_range_start_containing(&self, rva: u64) -> Option<u64> {
		self.data_ranges
			.range(..=rva)
			.next_back()
			.and_then(|(&start, &end)| (rva < end).then_some(start))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn define(rva: u64, end_rva: Option<u64>) -> FunctionCorrection {
		FunctionCorrection {
			rva,
			kind: FunctionCorrectionKind::Define { end_rva },
		}
	}

	fn data(rva: u64, end_rva: u64) -> DataRangeCorrection {
		DataRangeCorrection { rva, end_rva }
	}

	fn both<'a>(
		functions: &'a [FunctionCorrection],
		data_ranges: &'a [DataRangeCorrection],
	) -> Corrections<'a> {
		Corrections {
			functions,
			data_ranges,
		}
	}

	fn undefine(rva: u64) -> FunctionCorrection {
		FunctionCorrection {
			rva,
			kind: FunctionCorrectionKind::Undefine,
		}
	}

	#[test]
	fn a_valid_set_records_both_kinds() {
		let set = CorrectionSet::new(&[
			define(0x1000, Some(0x1010)),
			define(0x2000, None),
			undefine(0x3000),
		])
		.expect("no conflict");

		assert_eq!(
			(
				set.is_empty(),
				set.defines().collect::<Vec<_>>(),
				set.is_undefined(0x3000),
				set.is_undefined(0x1000),
			),
			(
				false,
				vec![(0x1000, Some(0x1010)), (0x2000, None)],
				true,
				false,
			),
		);
	}

	#[test]
	fn an_empty_set_is_empty() {
		let set = CorrectionSet::new(&[]).expect("no conflict");

		assert_eq!(
			(set.is_empty(), set.defines().count(), set.is_undefined(0)),
			(true, 0, false),
		);
	}

	#[test]
	fn every_conflict_shape_is_refused() {
		assert_eq!(
			(
				CorrectionSet::new(&[define(0x1000, None), define(0x1000, Some(0x1010))]),
				CorrectionSet::new(&[undefine(0x1000), undefine(0x1000)]),
				CorrectionSet::new(&[define(0x1000, None), undefine(0x1000)]),
				CorrectionSet::new(&[undefine(0x1000), define(0x1000, None)]),
				CorrectionSet::new(&[define(0x1000, Some(0x1000))]),
				CorrectionSet::new(&[define(0x1000, Some(0x0fff))]),
			),
			(
				Err(CorrectionConflict::DuplicateAddress { rva: 0x1000 }),
				Err(CorrectionConflict::DuplicateAddress { rva: 0x1000 }),
				Err(CorrectionConflict::DuplicateAddress { rva: 0x1000 }),
				Err(CorrectionConflict::DuplicateAddress { rva: 0x1000 }),
				Err(CorrectionConflict::EmptyExtent {
					rva: 0x1000,
					end_rva: 0x1000,
				}),
				Err(CorrectionConflict::EmptyExtent {
					rva: 0x1000,
					end_rva: 0x0fff,
				}),
			),
		);
	}

	#[test]
	fn a_data_range_is_recorded_and_looked_up_by_its_exclusive_end() {
		let set = CorrectionSet::new(both(&[], &[data(0x1000, 0x1010), data(0x2000, 0x2004)]))
			.expect("no conflict");

		assert_eq!(
			(
				set.is_empty(),
				set.data_range_end_at(0x0fff),
				set.data_range_end_at(0x1000),
				set.data_range_end_at(0x100f),
				// Exclusive: the byte at the end is code again.
				set.data_range_end_at(0x1010),
				set.data_range_end_at(0x2003),
			),
			(false, None, Some(0x1010), Some(0x1010), None, Some(0x2004)),
		);
	}

	#[test]
	fn an_undefine_inside_a_data_range_is_allowed() {
		// Redundant, not contradictory: both say no function starts there. Only
		// a `Define` disagrees with the range.
		let set = CorrectionSet::new(both(&[undefine(0x1004)], &[data(0x1000, 0x1010)]))
			.expect("no conflict");

		assert_eq!(
			(set.is_undefined(0x1004), set.data_range_end_at(0x1004)),
			(true, Some(0x1010)),
		);
	}

	#[test]
	fn every_data_range_conflict_shape_is_refused() {
		assert_eq!(
			(
				CorrectionSet::new(both(&[], &[data(0x1000, 0x1000)])),
				CorrectionSet::new(both(&[], &[data(0x1000, 0x0fff)])),
				CorrectionSet::new(both(&[], &[data(0x1000, 0x1010), data(0x100f, 0x1020)])),
				CorrectionSet::new(both(&[], &[data(0x100f, 0x1020), data(0x1000, 0x1010)])),
				CorrectionSet::new(both(&[], &[data(0x1000, 0x1020), data(0x1008, 0x1010)])),
				CorrectionSet::new(both(&[define(0x1008, None)], &[data(0x1000, 0x1010)])),
			),
			(
				Err(CorrectionConflict::EmptyDataRange {
					rva: 0x1000,
					end_rva: 0x1000,
				}),
				Err(CorrectionConflict::EmptyDataRange {
					rva: 0x1000,
					end_rva: 0x0fff,
				}),
				Err(CorrectionConflict::OverlappingDataRanges {
					rva: 0x100f,
					overlaps: 0x1000,
				}),
				Err(CorrectionConflict::OverlappingDataRanges {
					rva: 0x1000,
					overlaps: 0x100f,
				}),
				// Nesting is overlap too: one contained in the other.
				Err(CorrectionConflict::OverlappingDataRanges {
					rva: 0x1008,
					overlaps: 0x1000,
				}),
				Err(CorrectionConflict::DefineInsideDataRange {
					rva: 0x1008,
					range_rva: 0x1000,
				}),
			),
		);
	}

	#[test]
	fn abutting_data_ranges_do_not_overlap() {
		let set = CorrectionSet::new(both(&[], &[data(0x1000, 0x1010), data(0x1010, 0x1020)]))
			.expect("touching at an exclusive end is not an overlap");

		assert_eq!(
			(set.data_range_end_at(0x100f), set.data_range_end_at(0x1010)),
			(Some(0x1010), Some(0x1020)),
		);
	}
}
