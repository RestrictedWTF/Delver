//! String extraction.
//!
//! Finds printable ASCII and UTF-16LE runs in the image's file-backed bytes.
//!
//! Everything found here is **attacker-controlled text**. Nothing in this
//! module interprets it, and consumers must escape it before display — see
//! `Docs/architecture/security-model.md` §4.

use delver_format::ParsedImage;

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

/// Finds strings in every file-backed section.
pub fn find_strings(image: &ParsedImage, file: &[u8]) -> Vec<FoundString> {
	let mut out = Vec::new();

	for section in &image.sections {
		let start = section.raw_offset as usize;
		let end = (section.raw_end() as usize).min(file.len());
		if start >= end {
			continue;
		}
		let bytes = &file[start..end];
		let base = section.virtual_address;

		scan_ascii(bytes, base, &mut out);
		scan_utf16(bytes, base, &mut out);

		if out.len() >= MAX_STRINGS {
			out.truncate(MAX_STRINGS);
			return out;
		}
	}

	out.sort_by_key(|s| (s.rva, s.text.len()));
	out.dedup_by(|a, b| a.rva == b.rva && a.encoding == b.encoding);
	out
}

fn is_printable(byte: u8) -> bool {
	(0x20..0x7F).contains(&byte) || byte == b'\t'
}

fn scan_ascii(bytes: &[u8], base: u64, out: &mut Vec<FoundString>) {
	let mut run_start = None;

	for (offset, &byte) in bytes.iter().enumerate() {
		if is_printable(byte) {
			run_start.get_or_insert(offset);
			continue;
		}
		if let Some(start) = run_start.take() {
			emit_ascii(bytes, base, start, offset, out);
		}
	}
	if let Some(start) = run_start {
		emit_ascii(bytes, base, start, bytes.len(), out);
	}
}

fn emit_ascii(bytes: &[u8], base: u64, start: usize, end: usize, out: &mut Vec<FoundString>) {
	if end - start < MIN_LENGTH || out.len() >= MAX_STRINGS {
		return;
	}
	out.push(FoundString {
		rva: base + start as u64,
		text: String::from_utf8_lossy(&bytes[start..end]).into_owned(),
		encoding: StringEncoding::Ascii,
	});
}

fn scan_utf16(bytes: &[u8], base: u64, out: &mut Vec<FoundString>) {
	let mut offset = 0usize;

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

		if text.len() >= MIN_LENGTH && out.len() < MAX_STRINGS {
			out.push(FoundString {
				rva: base + start as u64,
				text,
				encoding: StringEncoding::Utf16Le,
			});
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn scan(bytes: &[u8]) -> Vec<FoundString> {
		let mut out = Vec::new();
		scan_ascii(bytes, 0x1000, &mut out);
		scan_utf16(bytes, 0x1000, &mut out);
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
}
