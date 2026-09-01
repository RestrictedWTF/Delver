//! Structured search for constants encoded in instructions.
//!
//! Distinct from searching the formatted operand text, which is what the
//! listing renders: `0x1f4`, `500` and `1F4h` are one constant written three
//! ways, and a textual search finds whichever the formatter happened to choose.
//! This matches the value the bytes encode, so the question it answers is "where
//! is this number used" rather than "where does this string appear".
//!
//! Immediates only. A branch or call encodes a destination rather than a
//! constant and is already recovered as an xref, so including displacements
//! would make a search for `0x1000` match every jump that lands there.

use delver_disasm::Disassembler;

use crate::{covered_bytes_at, InstructionIndex};
use delver_format::ParsedImage;
use std::ops::Range;

/// One instruction whose immediate operand matched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImmediateHit {
	/// RVA of the matching instruction.
	pub rva: u64,
	/// The immediate as encoded, zero-extended.
	pub value: u64,
	/// Encoded width of the field in bits — 8, 16, 32 or 64.
	pub width: u32,
}

/// Everything one immediate search found, and whether it saw everything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImmediateSearch {
	/// Matches in ascending address order.
	pub hits: Vec<ImmediateHit>,
	/// Matches found before the cap was applied.
	///
	/// Reported separately from `hits.len()` because the difference is the part
	/// a caller must not read as absence: a capped search has not shown that no
	/// further use exists.
	pub total: usize,
	/// Whether the cap dropped matches.
	pub truncated: bool,
}

/// Finds every decoded instruction encoding `value` as an immediate.
///
/// Walks the instruction index rather than scanning bytes. Decoding from an
/// arbitrary offset produces plausible garbage that silently differs from the
/// real instruction stream, so every candidate here starts at a boundary the
/// analysis already established.
///
/// A match is by value, not by encoding. An instruction matches when its
/// encoded field equals `value` read either as unsigned or as sign-extended:
/// `cmp eax, -1` and `cmp eax, 0xFFFFFFFF` assemble to the same bytes, so a
/// search for either finds both. `width` narrows to one encoded field size when
/// supplied — `Some(8)` finds the byte form and not the dword one.
// A query is its parameters: what to search, where the search is allowed to
// look, and how much of the answer to keep. Bundling them into a struct would
// move the same eight values behind a name that says less than they do.
#[allow(clippy::too_many_arguments)]
pub fn search_immediates(
	image: &ParsedImage,
	file: &[u8],
	coverage: &[Range<u64>],
	instructions: &InstructionIndex,
	disasm: &Disassembler,
	value: u64,
	width: Option<u32>,
	limit: usize,
) -> ImmediateSearch {
	let mut hits = Vec::new();
	let mut total = 0usize;

	for (_row, rva, _len) in instructions.rows(0, instructions.len()) {
		let Some(bytes) = covered_bytes_at(image, file, coverage, rva) else {
			continue;
		};
		let Some(facts) = disasm.decode_facts_at(rva, bytes) else {
			continue;
		};
		let (Some(encoded), Some(encoded_width)) = (facts.immediate, facts.immediate_width) else {
			continue;
		};
		if width.is_some_and(|requested| requested != encoded_width) {
			continue;
		}
		if !matches_value(encoded, encoded_width, value) {
			continue;
		}
		total += 1;
		if hits.len() < limit {
			hits.push(ImmediateHit {
				rva,
				value: encoded,
				width: encoded_width,
			});
		}
	}

	ImmediateSearch {
		truncated: total > hits.len(),
		total,
		hits,
	}
}

/// Whether an encoded field of `width` bits means `value`.
///
/// Both readings of the field count. The bytes do not record whether the
/// programmer wrote `-1` or `0xFFFFFFFF`, and refusing one of them would answer
/// "this constant is not used here" about an instruction that uses it.
fn matches_value(encoded: u64, width: u32, value: u64) -> bool {
	if encoded == value {
		return true;
	}
	if width >= 64 {
		return false;
	}
	let sign_bit = 1u64 << (width - 1);
	if encoded & sign_bit == 0 {
		return false;
	}
	// Sign-extend the encoded field and compare again.
	let extended = encoded | !((1u64 << width) - 1);
	extended == value
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_field_means_both_its_unsigned_and_its_signed_reading() {
		assert!(matches_value(0xFFFF_FFFF, 32, 0xFFFF_FFFF));
		assert!(matches_value(0xFFFF_FFFF, 32, u64::MAX));
		assert!(matches_value(0xFF, 8, 0xFF));
		assert!(matches_value(0xFF, 8, u64::MAX));
	}

	#[test]
	fn a_positive_field_is_not_stretched_into_a_negative_one() {
		// 0x7F has no sign bit set at 8 bits, so it means 127 and nothing else.
		assert!(!matches_value(0x7F, 8, u64::MAX));
		assert!(matches_value(0x7F, 8, 0x7F));
		// A 64-bit field has no wider reading to take.
		assert!(!matches_value(0xFFFF_FFFF_FFFF_FFFE, 64, 0xFFFF_FFFE));
	}

	#[test]
	fn widths_do_not_bleed_into_each_other() {
		// The byte 0xFF and the dword 0xFFFFFFFF both mean -1, but they are
		// different encodings and a width filter must separate them.
		assert!(matches_value(0xFF, 8, u64::MAX));
		assert!(matches_value(0xFFFF_FFFF, 32, u64::MAX));
		assert!(!matches_value(0xFF, 8, 0xFFFF_FFFF));
	}
}
