//! String extraction.
//!
//! Finds printable ASCII and UTF-16LE runs in the image's file-backed bytes.
//!
//! The scan is **resumable**. A single pass is bounded — a hostile file must
//! not be able to turn string extraction into an allocation attack — but a
//! bound that simply discards everything past it makes the tail of a large
//! image unreachable, which is a silent loss on exactly the samples an analyst
//! cares about. [`find_strings_from`] therefore reports where a continuation
//! should resume, and [`find_strings`] is the whole-image call expressed in
//! terms of it.
//!
//! Everything found here is **attacker-controlled text**. Nothing in this
//! module interprets it, and consumers must escape it before display — see
//! `Docs/architecture/security-model.md` §4.

use delver_format::{ParsedImage, Section};
use std::ops::Range;

/// Shortest run worth reporting. Below this the noise swamps the signal.
const MIN_LENGTH: usize = 4;

/// Upper bound on how many strings a single image may yield, so a hostile file
/// cannot turn string extraction into an allocation attack.
const MAX_STRINGS: usize = 200_000;

/// How a string was encoded in the image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StringEncoding {
	/// Printable single-byte characters.
	Ascii,
	/// UTF-16, little-endian.
	Utf16Le,
}

/// A string located in the image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundString {
	/// RVA of the first character.
	pub rva: u64,
	/// Decoded text. Untrusted — escape before display.
	pub text: String,
	/// How it was encoded.
	pub encoding: StringEncoding,
}

/// The result of scanning an image for strings.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StringScan {
	/// Strings found, sorted by address.
	pub strings: Vec<FoundString>,
	/// Whether the scan's bound was reached and results were left unemitted.
	///
	/// The bound is a real defence — a hostile file must not be able to turn
	/// string extraction into an allocation attack — but a truncated list that
	/// does not admit it is worse than no list at all. A consumer cannot tell
	/// "this image has 200,000 strings" from "this image has more than we will
	/// tell you about" without being told.
	///
	/// Exactly equivalent to `next_rva.is_some()`.
	pub truncated: bool,
	/// RVA a continuation resumes at; absent when the scan reached the end of
	/// the image rather than its bound.
	///
	/// This is one past the RVA of the last string in [`Self::strings`]. That
	/// is only a safe cursor because the scan emits in **address order** and
	/// never splits an RVA: every string at or below the last emitted address
	/// is already in this batch, and every string not in it starts strictly
	/// above that address. So a caller that keeps calling
	/// [`find_strings_from`] with this value neither loses a string nor sees
	/// one twice, and — because the value strictly increases on every call —
	/// terminates.
	pub next_rva: Option<u64>,
}

/// Finds strings in every file-backed section.
///
/// The whole-image scan, bounded at [`MAX_STRINGS`]. Anything past that bound
/// is reachable through [`find_strings_from`] and [`StringScan::next_rva`].
pub fn find_strings(image: &ParsedImage, file: &[u8], coverage: &[Range<u64>]) -> StringScan {
	find_strings_from(image, file, coverage, 0, MAX_STRINGS)
}

/// Finds up to `max` strings at or above `from_rva`, in address order.
///
/// The single implementation behind [`find_strings`]. Sections are visited in
/// virtual-address order and every chunk is ordered as it is produced, so
/// partial output is address-ordered — which is what makes
/// [`StringScan::next_rva`] a cursor rather than a guess.
///
/// `from_rva` is a skip, not a filter: sections that end at or below it are
/// never opened, and a section containing it is scanned from that address
/// rather than from its start. A run that reaches back across `from_rva` was
/// already emitted at its true start, so it is not emitted again as a fragment.
///
/// Always makes progress. If a single chunk yields more than `max` strings the
/// scan still emits the first address group and advances past it, so a caller
/// looping on `next_rva` cannot spin.
pub fn find_strings_from(
	image: &ParsedImage,
	file: &[u8],
	coverage: &[Range<u64>],
	from_rva: u64,
	max: usize,
) -> StringScan {
	// Address order is the whole contract, and neither input is required to
	// arrive sorted: section headers are only conventionally in virtual-address
	// order, and a caller may hand coverage over in any order at all.
	let mut sections: Vec<&Section> = image
		.sections
		.iter()
		.filter(|section| section.virtual_end() > from_rva)
		.collect();
	sections.sort_by_key(|section| (section.virtual_address, section.virtual_end()));

	let mut ranges: Vec<Range<u64>> = coverage.to_vec();
	ranges.sort_by_key(|range| (range.start, range.end));

	let mut out: Vec<FoundString> = Vec::new();

	for section in sections {
		for range in &ranges {
			let start = section.raw_offset.max(range.start);
			let end = section.raw_end().min(range.end).min(file.len() as u64);
			if start >= end {
				continue;
			}
			let bytes = &file[start as usize..end as usize];
			let base = section
				.virtual_address
				.saturating_add(start.saturating_sub(section.raw_offset));

			let scan_from = from_rva.saturating_sub(base);
			if scan_from >= bytes.len() as u64 {
				continue;
			}
			let scan_from = scan_from as usize;

			// Each encoding gets the same allowance rather than sharing one:
			// a shared allowance spent by the ASCII pass would leave the UTF-16
			// pass with nothing, and the UTF-16 strings it never looked at sit
			// at *lower* addresses than the cut, which no cursor could recover.
			let budget = max.saturating_sub(out.len()).saturating_add(1);

			let mut ascii = Vec::new();
			let ascii_complete = scan_ascii(bytes, base, scan_from, budget, &mut ascii);
			let mut utf16 = Vec::new();
			let utf16_complete = scan_utf16(bytes, base, scan_from, budget, &mut utf16);

			// Where this chunk stops being exhaustively known. A pass that ran
			// out of budget guarantees completeness only through the last
			// address it emitted.
			let scanned_through = match (ascii_complete, utf16_complete) {
				(true, true) => None,
				(false, true) => ascii.last().map(|s| s.rva),
				(true, false) => utf16.last().map(|s| s.rva),
				(false, false) => match (ascii.last(), utf16.last()) {
					(Some(a), Some(u)) => Some(a.rva.min(u.rva)),
					(a, u) => a.or(u).map(|s| s.rva),
				},
			};

			let mut chunk = ascii;
			chunk.append(&mut utf16);
			order(&mut chunk);
			out.append(&mut chunk);

			if out.len() > max || scanned_through.is_some() {
				order(&mut out);
				return truncate_at_address_boundary(out, max, scanned_through);
			}
		}
	}

	order(&mut out);
	StringScan {
		strings: out,
		truncated: false,
		next_rva: None,
	}
}

/// Puts results in address order and drops duplicates.
///
/// `dedup_by` removes the *later* of two equal neighbours, so sorting by
/// `(rva, text length)` first keeps the shortest string at each
/// `(rva, encoding)` — the behaviour every caller of this module has had since
/// it was written, preserved here deliberately.
fn order(strings: &mut Vec<FoundString>) {
	strings.sort_by_key(|s| (s.rva, s.text.len()));
	strings.dedup_by(|a, b| a.rva == b.rva && a.encoding == b.encoding);
}

/// Cuts `out` down to the bound and reports where to resume.
///
/// `out` must already be in address order. The cut never falls inside an RVA:
/// `next_rva` is one past the last emitted address, so a string left behind at
/// that same address could never be reached again.
fn truncate_at_address_boundary(
	mut out: Vec<FoundString>,
	max: usize,
	scanned_through: Option<u64>,
) -> StringScan {
	let len = out.len();
	if len == 0 {
		// Nothing was emitted, so there is no address to resume from. Reachable
		// only if a pass reports itself bounded without having produced
		// anything; claiming a cursor here would invent one.
		return StringScan::default();
	}

	let mut keep = max.min(len);
	if let Some(limit) = scanned_through {
		keep = keep.min(out.partition_point(|s| s.rva <= limit));
	}
	if keep > 0 && keep < len && out[keep].rva == out[keep - 1].rva {
		let split = out[keep - 1].rva;
		keep = out.partition_point(|s| s.rva < split);
	}
	if keep == 0 {
		// The first address group alone is over the bound. Emitting it whole is
		// the only way a continuation can ever get past it.
		let first = out[0].rva;
		keep = out.partition_point(|s| s.rva <= first);
	}

	// `saturating_add` cannot actually saturate: a string occupies at least
	// `MIN_LENGTH` bytes above its RVA, so no emitted RVA can be `u64::MAX`.
	// Were it to, the resume would find no section above it and return empty
	// rather than looping.
	let next_rva = out[keep - 1].rva.saturating_add(1);
	out.truncate(keep);
	StringScan {
		strings: out,
		truncated: true,
		next_rva: Some(next_rva),
	}
}

fn is_printable(byte: u8) -> bool {
	(0x20..0x7F).contains(&byte) || matches!(byte, b'\t' | b'\n' | b'\r')
}

/// Scans `bytes[from..]` for ASCII runs. Returns whether it reached the end.
///
/// `bytes` is the whole chunk even when `from` is not zero: the bytes before
/// `from` are never scanned, but the one immediately before a run start is read
/// to tell a genuine run from the tail of one an earlier batch already emitted.
fn scan_ascii(
	bytes: &[u8],
	base: u64,
	from: usize,
	budget: usize,
	out: &mut Vec<FoundString>,
) -> bool {
	let mut run_start = None;

	for offset in from..bytes.len() {
		if is_printable(bytes[offset]) {
			run_start.get_or_insert(offset);
			continue;
		}
		if let Some(start) = run_start.take() {
			if !emit_ascii(bytes, base, start, offset, budget, out) {
				return false;
			}
		}
	}
	if let Some(start) = run_start {
		return emit_ascii(bytes, base, start, bytes.len(), budget, out);
	}
	true
}

/// Emits one ASCII run. Returns whether there is budget left to continue.
fn emit_ascii(
	bytes: &[u8],
	base: u64,
	start: usize,
	end: usize,
	budget: usize,
	out: &mut Vec<FoundString>,
) -> bool {
	if out.len() >= budget {
		return false;
	}
	if end - start < MIN_LENGTH {
		return true;
	}
	// A run whose printable bytes reach back before `start` began earlier in
	// the chunk, so a whole-chunk scan reports it at that earlier address and
	// never at this one. Only a resumed scan can land here, and re-emitting the
	// tail would invent a string the image does not contain.
	if start > 0 && is_printable(bytes[start - 1]) {
		return true;
	}
	out.push(FoundString {
		rva: base + start as u64,
		text: String::from_utf8_lossy(&bytes[start..end]).into_owned(),
		encoding: StringEncoding::Ascii,
	});
	out.len() < budget
}

/// Scans `bytes[from..]` for UTF-16LE runs. Returns whether it reached the end.
fn scan_utf16(
	bytes: &[u8],
	base: u64,
	from: usize,
	budget: usize,
	out: &mut Vec<FoundString>,
) -> bool {
	let mut offset = from;

	while offset + 1 < bytes.len() {
		// A UTF-16LE printable character is a printable low byte and a zero
		// high byte, which is what makes the encoding cheap to spot.
		if !(is_printable(bytes[offset]) && bytes[offset + 1] == 0) {
			offset += 1;
			continue;
		}

		let start = offset;
		let mut text = String::new();
		while offset + 1 < bytes.len() && is_printable(bytes[offset]) && bytes[offset + 1] == 0 {
			text.push(bytes[offset] as char);
			offset += 2;
		}

		if text.len() < MIN_LENGTH {
			continue;
		}
		// The same look-back as `emit_ascii`, one character wide: a preceding
		// printable/zero pair means this run began before `start`, so a
		// whole-chunk scan would have consumed it there.
		if start >= 2 && is_printable(bytes[start - 2]) && bytes[start - 1] == 0 {
			continue;
		}
		if out.len() >= budget {
			return false;
		}
		out.push(FoundString {
			rva: base + start as u64,
			text,
			encoding: StringEncoding::Utf16Le,
		});
		if out.len() >= budget {
			return false;
		}
	}
	true
}

#[cfg(test)]
mod tests {
	use super::*;

	fn scan(bytes: &[u8]) -> Vec<FoundString> {
		let mut out = Vec::new();
		scan_ascii(bytes, 0x1000, 0, usize::MAX, &mut out);
		scan_utf16(bytes, 0x1000, 0, usize::MAX, &mut out);
		out
	}

	#[test]
	fn finds_ascii_runs_and_records_their_rva() {
		let found = scan(b"\x00\x00hello\x00\x00");
		assert_eq!(found.len(), 1);
		assert_eq!(found[0].text, "hello");
		assert_eq!(found[0].rva, 0x1002);
		assert_eq!(found[0].encoding, StringEncoding::Ascii);
	}

	#[test]
	fn ignores_runs_below_the_minimum_length() {
		assert!(scan(b"\x00ab\x00").is_empty());
	}

	#[test]
	fn finds_utf16_runs() {
		let bytes = b"\x00\x00h\x00e\x00l\x00l\x00o\x00\x00\x00";
		let utf16: Vec<_> = scan(bytes)
			.into_iter()
			.filter(|s| s.encoding == StringEncoding::Utf16Le)
			.collect();
		assert_eq!(utf16.len(), 1);
		assert_eq!(utf16[0].text, "hello");
	}

	#[test]
	fn a_run_at_the_very_end_is_not_dropped() {
		let found = scan(b"\x00\x00trailing");
		assert_eq!(found.len(), 1);
		assert_eq!(found[0].text, "trailing");
	}

	#[test]
	fn control_characters_terminate_a_run() {
		let found = scan(b"first\x01second");
		let texts: Vec<_> = found.iter().map(|s| s.text.as_str()).collect();
		assert_eq!(texts, vec!["first", "second"]);
	}

	#[test]
	fn leading_line_breaks_remain_part_of_the_literal_address() {
		let found = scan(b"\0\r\nhello\0");
		assert_eq!(
			found
				.iter()
				.find(|string| string.encoding == StringEncoding::Ascii),
			Some(&FoundString {
				rva: 0x1001,
				text: "\r\nhello".to_owned(),
				encoding: StringEncoding::Ascii,
			}),
		);
	}

	// --- Resumable scanning -------------------------------------------------

	const RDATA_RAW: u64 = 0x40;
	const DATA_RAW: u64 = 0x100;

	/// Two file-backed sections, mixing both encodings within one of them.
	///
	/// Hand-built rather than parsed from a real PE: the corpus owns end-to-end
	/// coverage, and these tests are about the scan's ordering contract.
	fn fixture() -> (ParsedImage, Vec<u8>, Vec<Range<u64>>) {
		let mut file = vec![0u8; 0x200];

		// .rdata — ASCII only.
		let rdata = b"alpha\0bravo\0charlie\0";
		file[RDATA_RAW as usize..RDATA_RAW as usize + rdata.len()].copy_from_slice(rdata);

		// .data — ASCII and UTF-16LE interleaved, so address order can only be
		// produced by merging the two passes rather than concatenating them.
		let data: &[u8] = &[
			b'm', b'i', b'k', b'e', 0, 0, // +0x00  ascii "mike"
			b'd', 0, b'e', 0, b'l', 0, b't', 0, b'a', 0, // +0x06  utf16 "delta"
			0, 0, // +0x10
			b'n', b'o', b'v', b'e', b'm', b'b', b'e', b'r', 0, 0, // +0x12  ascii
			b'e', 0, b'c', 0, b'h', 0, b'o', 0, // +0x1C  utf16 "echo"
		];
		file[DATA_RAW as usize..DATA_RAW as usize + data.len()].copy_from_slice(data);

		let image = ParsedImage {
			arch: "X86_64".to_string(),
			sections: vec![
				Section {
					name: ".rdata".to_string(),
					virtual_address: 0x1000,
					virtual_size: 0x40,
					raw_offset: RDATA_RAW,
					raw_size: 0x40,
					characteristics: 0x4000_0040,
				},
				Section {
					name: ".data".to_string(),
					virtual_address: 0x2000,
					virtual_size: 0x40,
					raw_offset: DATA_RAW,
					raw_size: 0x40,
					characteristics: 0xC000_0040,
				},
			],
			..Default::default()
		};

		let coverage = std::slice::from_ref(&(0..file.len() as u64)).to_vec();
		(image, file, coverage)
	}

	fn expected() -> Vec<(u64, &'static str, StringEncoding)> {
		vec![
			(0x1000, "alpha", StringEncoding::Ascii),
			(0x1006, "bravo", StringEncoding::Ascii),
			(0x100C, "charlie", StringEncoding::Ascii),
			(0x2000, "mike", StringEncoding::Ascii),
			(0x2006, "delta", StringEncoding::Utf16Le),
			(0x2012, "november", StringEncoding::Ascii),
			(0x201C, "echo", StringEncoding::Utf16Le),
		]
	}

	fn summarize(strings: &[FoundString]) -> Vec<(u64, &str, StringEncoding)> {
		strings
			.iter()
			.map(|s| (s.rva, s.text.as_str(), s.encoding))
			.collect()
	}

	#[test]
	fn an_unbounded_scan_reports_every_string_in_address_order() {
		let (image, file, coverage) = fixture();
		let scan = find_strings(&image, &file, &coverage);

		assert_eq!(
			(summarize(&scan.strings), scan.truncated, scan.next_rva),
			(expected(), false, None),
		);
	}

	#[test]
	fn a_bounded_scan_stops_at_the_bound_and_says_where_to_resume() {
		let (image, file, coverage) = fixture();
		let first = find_strings_from(&image, &file, &coverage, 0, 3);

		assert_eq!(
			(summarize(&first.strings), first.truncated, first.next_rva),
			(expected()[..3].to_vec(), true, Some(0x100D)),
		);

		let rest = find_strings_from(&image, &file, &coverage, first.next_rva.unwrap(), 100);
		assert_eq!(
			(summarize(&rest.strings), rest.truncated, rest.next_rva),
			(expected()[3..].to_vec(), false, None),
		);
	}

	/// The property the whole feature promises.
	fn page_walk(
		image: &ParsedImage,
		file: &[u8],
		coverage: &[Range<u64>],
		page: usize,
	) -> Vec<(u64, String, StringEncoding)> {
		let mut all = Vec::new();
		let mut cursor = Some(0u64);

		while let Some(from) = cursor {
			let scan = find_strings_from(image, file, coverage, from, page);
			assert_eq!(scan.truncated, scan.next_rva.is_some());
			for found in &scan.strings {
				assert!(
					found.rva >= from,
					"{found:?} is behind the cursor {from:#x}"
				);
			}
			all.extend(
				scan.strings
					.iter()
					.map(|s| (s.rva, s.text.clone(), s.encoding)),
			);
			cursor = scan.next_rva;
		}
		all
	}

	#[test]
	fn walking_the_image_in_pages_yields_exactly_one_whole_scan() {
		let (image, file, coverage) = fixture();
		let whole: Vec<_> = find_strings(&image, &file, &coverage)
			.strings
			.iter()
			.map(|s| (s.rva, s.text.clone(), s.encoding))
			.collect();

		for page in 1..=8 {
			assert_eq!(
				page_walk(&image, &file, &coverage, page),
				whole,
				"page {page}"
			);
		}
	}

	#[test]
	fn an_oversized_chunk_still_makes_progress() {
		let (image, file, coverage) = fixture();
		let scan = find_strings_from(&image, &file, &coverage, 0, 0);

		assert_eq!(
			(summarize(&scan.strings), scan.next_rva),
			(expected()[..1].to_vec(), Some(0x1001)),
		);
		// And a caller looping on that bound still sees the whole image.
		let whole: Vec<_> = find_strings(&image, &file, &coverage)
			.strings
			.iter()
			.map(|s| (s.rva, s.text.clone(), s.encoding))
			.collect();
		assert_eq!(page_walk(&image, &file, &coverage, 0), whole);
	}

	#[test]
	fn resuming_inside_a_string_does_not_emit_its_tail() {
		let (image, file, coverage) = fixture();

		// 0x1002 is inside "alpha"; 0x2008 is inside the UTF-16 "delta".
		let ascii = find_strings_from(&image, &file, &coverage, 0x1002, 100);
		let utf16 = find_strings_from(&image, &file, &coverage, 0x2008, 100);

		assert_eq!(
			(summarize(&ascii.strings), summarize(&utf16.strings)),
			(expected()[1..].to_vec(), expected()[5..].to_vec()),
		);
	}

	#[test]
	fn a_cursor_past_the_last_section_returns_nothing_and_stops() {
		let (image, file, coverage) = fixture();
		let scan = find_strings_from(&image, &file, &coverage, 0x9000, 100);

		assert_eq!(scan, StringScan::default());
	}

	#[test]
	fn sections_out_of_virtual_address_order_still_scan_in_address_order() {
		let (mut image, file, coverage) = fixture();
		image.sections.reverse();

		let scan = find_strings(&image, &file, &coverage);
		assert_eq!(summarize(&scan.strings), expected());
		assert_eq!(
			page_walk(&image, &file, &coverage, 2).len(),
			expected().len()
		);
	}

	#[test]
	fn coverage_holes_are_skipped_and_do_not_shift_addresses() {
		let (image, file, _) = fixture();
		// Everything but the .rdata section.
		let coverage = vec![0..RDATA_RAW, DATA_RAW..file.len() as u64];

		let scan = find_strings(&image, &file, &coverage);
		assert_eq!(summarize(&scan.strings), expected()[3..].to_vec());
	}

	/// A pseudo-random, printable-heavy image across several sections.
	///
	/// The tidy fixture above says what the scan finds; this says the ordering
	/// contract survives data that is not laid out helpfully — overlapping
	/// ASCII and UTF-16 candidates, runs that straddle every page boundary a
	/// cursor could land on.
	fn noisy_image(
		seed: u64,
		sections: usize,
		size: usize,
	) -> (ParsedImage, Vec<u8>, Vec<Range<u64>>) {
		let mut state = seed | 1;
		let mut next = move || {
			state ^= state << 13;
			state ^= state >> 7;
			state ^= state << 17;
			state
		};
		let total = sections * size;
		let mut file = vec![0u8; 0x40 + total];
		for byte in file.iter_mut().skip(0x40) {
			let r = next();
			*byte = match r % 5 {
				0 | 1 => 0,
				_ => (0x20 + (r >> 8) % 0x5F) as u8,
			};
		}
		let image = ParsedImage {
			arch: "X86_64".to_string(),
			sections: (0..sections)
				.map(|i| Section {
					name: format!(".s{i}"),
					virtual_address: 0x1000 + (i as u64) * 0x2000,
					virtual_size: size as u64,
					raw_offset: 0x40 + (i * size) as u64,
					raw_size: size as u64,
					characteristics: 0x4000_0040,
				})
				.collect(),
			..Default::default()
		};
		let coverage = std::slice::from_ref(&(0..file.len() as u64)).to_vec();
		(image, file, coverage)
	}

	#[test]
	fn page_walks_over_noisy_data_match_a_whole_scan() {
		for seed in 1..12u64 {
			let (image, file, coverage) = noisy_image(seed, 4, 4096);
			let whole = find_strings(&image, &file, &coverage);
			assert!(!whole.strings.is_empty() && !whole.truncated);

			for page in [0usize, 1, 2, 7, 33, 250] {
				let mut walked = Vec::new();
				let mut cursor = Some(0u64);
				while let Some(from) = cursor {
					let scan = find_strings_from(&image, &file, &coverage, from, page);
					assert_eq!(scan.truncated, scan.next_rva.is_some());
					assert!(scan.strings.iter().all(|s| s.rva >= from));
					walked.extend(scan.strings);
					cursor = scan.next_rva;
				}
				assert_eq!(walked, whole.strings, "seed {seed} page {page}");
			}
		}
	}
}
