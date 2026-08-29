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
//! * **A correction is about a function start, not about whether bytes are
//!   code.** [`FunctionCorrectionKind::Undefine`] withdraws the claim that a
//!   function begins at an address; it does not claim the bytes there are data.
//!   Undefining *code* is a separate operation.

use std::collections::{BTreeMap, BTreeSet};

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
	pub fn new(corrections: &[FunctionCorrection]) -> Result<Self, CorrectionConflict> {
		let mut set = Self::default();

		for correction in corrections {
			let rva = correction.rva;
			if let FunctionCorrectionKind::Define {
				end_rva: Some(end_rva),
			} = correction.kind
			{
				if end_rva <= rva {
					return Err(CorrectionConflict::EmptyExtent { rva, end_rva });
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
		self.defines.is_empty() && self.undefines.is_empty()
	}

	/// Authored function starts as `(rva, end_rva)`, ascending.
	pub(crate) fn defines(&self) -> impl Iterator<Item = (u64, Option<u64>)> + '_ {
		self.defines.iter().map(|(&rva, &end_rva)| (rva, end_rva))
	}

	/// Whether the author has said no function starts at `rva`.
	pub(crate) fn is_undefined(&self, rva: u64) -> bool {
		self.undefines.contains(&rva)
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
}
