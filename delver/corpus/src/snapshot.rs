//! Fact snapshots.
//!
//! A snapshot is the set of facts Delver derives from a sample, serialised
//! deterministically. Committed snapshots are the expected output; `check`
//! recomputes and diffs.
//!
//! Snapshots record **derived facts only** — never raw sample bytes — so the
//! committed files stay reviewable in a diff.

use anyhow::{Context, Result};
use delver_disasm::{Bitness, Disassembler};
use delver_format::parse_pe;
use serde::{Deserialize, Serialize};

/// Facts derived from one sample.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
	/// Sample name.
	pub name: String,
	/// What the sample exists to pin down.
	pub covers: String,
	/// Architecture reported by the loader.
	pub arch: String,
	/// Entry point RVA, hex-encoded for readability in the committed file.
	pub entry: String,
	/// Preferred image base.
	pub image_base: String,
	/// Section summary.
	pub sections: Vec<SectionFact>,
	/// Imported modules and their symbols.
	pub imports: Vec<ImportFact>,
	/// Exported symbols.
	pub exports: Vec<String>,
	/// Function seeds, grouped by the source that supplied them.
	pub seeds: Vec<SeedFact>,
	/// Disassembly of the entry point, when the architecture is decodable.
	pub entry_disassembly: Vec<String>,
	/// Facts derived by `delver-analysis`.
	pub analysis: AnalysisFact,
}

/// What static analysis derived from the sample.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnalysisFact {
	/// Number of decoded instructions — the listing's total row count.
	pub instruction_count: usize,
	/// Detected functions as `rva:Source`, so a confidence change fails the
	/// diff rather than passing silently.
	pub functions: Vec<String>,
	/// Cross-references as `from->to:Kind`.
	pub xrefs: Vec<String>,
	/// Strings as `rva:encoding:text`.
	pub strings: Vec<String>,
	/// Immediate operands as `rva:width:value`, so a decoding change that
	/// widens a field or starts reporting branch displacements fails the diff.
	pub immediates: Vec<String>,
}

/// One section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SectionFact {
	/// Section name.
	pub name: String,
	/// Start RVA.
	pub rva: String,
	/// Virtual size.
	pub virtual_size: u64,
}

/// One imported module.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportFact {
	/// Module name.
	pub module: String,
	/// `symbol@iat_rva` for each import, so a shifted IAT fails the diff.
	pub symbols: Vec<String>,
}

/// One function seed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeedFact {
	/// Seed RVA.
	pub rva: String,
	/// Exclusive end, when the source records one.
	pub end: Option<String>,
	/// Where the seed came from.
	pub source: String,
}

/// Derives a snapshot from sample bytes.
pub fn snapshot_of(name: &str, covers: &str, bytes: &[u8]) -> Result<Snapshot> {
	let image = parse_pe(bytes).with_context(|| format!("parsing sample {name}"))?;

	let sections = image
		.sections
		.iter()
		.map(|s| SectionFact {
			name: s.name.clone(),
			rva: hex(s.virtual_address),
			virtual_size: s.virtual_size,
		})
		.collect();

	let imports = image
		.imports
		.iter()
		.map(|m| ImportFact {
			module: m.name.clone(),
			symbols: m
				.symbols
				.iter()
				.map(|s| {
					let label = match (&s.name, s.ordinal) {
						(Some(name), _) => name.clone(),
						(None, Some(ordinal)) => format!("#{ordinal}"),
						(None, None) => "<unnamed>".to_string(),
					};
					format!("{label}@{}", hex(s.iat_rva))
				})
				.collect(),
		})
		.collect();

	let exports = image
		.exports
		.iter()
		.map(|e| match (&e.name, &e.forwarded_to, e.rva) {
			(Some(n), Some(target), _) => format!("{n} -> {target}"),
			(Some(n), None, Some(rva)) => format!("{n}@{}", hex(rva)),
			(Some(n), None, None) => format!("{n}@<none>"),
			(None, _, _) => format!("#{}", e.ordinal),
		})
		.collect();

	let seeds = image
		.function_seeds
		.iter()
		.map(|s| SeedFact {
			rva: hex(s.rva),
			end: s.end_rva.map(hex),
			source: format!("{:?}", s.source),
		})
		.collect();

	let entry_disassembly = disassemble_entry(&image, bytes);
	let analysis = analysis_facts(&image, bytes);

	Ok(Snapshot {
		name: name.to_string(),
		covers: covers.to_string(),
		arch: image.arch.clone(),
		entry: hex(image.entry),
		image_base: hex(image.image_base),
		sections,
		imports,
		exports,
		seeds,
		entry_disassembly,
		analysis,
	})
}

/// Runs static analysis and flattens the result into diffable strings.
fn analysis_facts(image: &delver_format::ParsedImage, bytes: &[u8]) -> AnalysisFact {
	let analyzed = delver_analysis::analyze(image, bytes, &[0..bytes.len() as u64]);

	AnalysisFact {
		instruction_count: analyzed.instructions.len(),
		functions: analyzed
			.functions
			.iter()
			.map(|f| match f.end_rva {
				Some(end) => format!("{}..{}:{:?}", hex(f.rva), hex(end), f.source),
				None => format!("{}:{:?}", hex(f.rva), f.source),
			})
			.collect(),
		xrefs: analyzed
			.xrefs
			.all()
			.iter()
			.map(|x| format!("{}->{}:{:?}", hex(x.from), hex(x.to), x.kind))
			.collect(),
		strings: analyzed
			.strings
			.iter()
			.map(|s| format!("{}:{:?}:{}", hex(s.rva), s.encoding, s.text))
			.collect(),
		immediates: immediate_facts(image, bytes, &analyzed.instructions),
	}
}

/// Records the immediate encoded by each decoded instruction.
///
/// Walks the instruction index rather than the bytes: an immediate is only
/// meaningful at a boundary the analysis established, and decoding from an
/// arbitrary offset would invent fields.
fn immediate_facts(
	image: &delver_format::ParsedImage,
	bytes: &[u8],
	instructions: &delver_analysis::InstructionIndex,
) -> Vec<String> {
	let Some(bitness) = Bitness::from_arch(&image.arch) else {
		return Vec::new();
	};
	let disasm = Disassembler::new(bitness);
	let mut out = Vec::new();
	for (_row, rva, _len) in instructions.rows(0, instructions.len()) {
		let Some(window) = section_bytes_at(image, bytes, rva) else {
			continue;
		};
		let Some(facts) = disasm.decode_facts_at(rva, window) else {
			continue;
		};
		if let (Some(value), Some(width)) = (facts.immediate, facts.immediate_width) {
			out.push(format!("{}:{}:{}", hex(rva), width, hex(value)));
		}
	}
	out
}

/// Bytes beginning at `rva`, clipped to the raw data of the section holding it.
fn section_bytes_at<'a>(
	image: &delver_format::ParsedImage,
	bytes: &'a [u8],
	rva: u64,
) -> Option<&'a [u8]> {
	let section = image
		.sections
		.iter()
		.find(|s| s.virtual_address <= rva && rva < s.virtual_end())?;
	let start = section.raw_offset as usize + (rva - section.virtual_address) as usize;
	let end = (section.raw_end() as usize).min(bytes.len());
	if start >= end {
		return None;
	}
	Some(&bytes[start..end])
}

/// Decodes the instructions at the entry point.
///
/// The entry point is an anchor the loader itself vouches for, which is exactly
/// the kind of address `delver-disasm` is willing to decode from (decision F2).
///
/// Sections are zero-padded to file alignment, so decoding to the end would
/// produce a long tail of `add [rax],al` from the padding. Stopping at the
/// first block-terminating instruction keeps the snapshot meaningful.
fn disassemble_entry(image: &delver_format::ParsedImage, bytes: &[u8]) -> Vec<String> {
	let Some(bitness) = Bitness::from_arch(&image.arch) else {
		return Vec::new();
	};
	let Some(section) = image
		.sections
		.iter()
		.find(|s| s.virtual_address <= image.entry && image.entry < s.virtual_end())
	else {
		return Vec::new();
	};

	let section_offset = (image.entry - section.virtual_address) as usize;
	let file_start = section.raw_offset as usize + section_offset;
	let file_end = (section.raw_end() as usize).min(bytes.len());
	if file_start >= file_end {
		return Vec::new();
	}
	let window = &bytes[file_start..file_end.min(file_start + 64)];

	let disasm = Disassembler::new(bitness);
	let mut out = Vec::new();
	for instruction in disasm.decode_count(image.entry, window, 16) {
		out.push(format!("{} {}", hex(instruction.rva), instruction.text()));
		if instruction.flow.terminates_block() {
			break;
		}
	}
	out
}

fn hex(value: u64) -> String {
	format!("0x{value:X}")
}

/// Serialises a snapshot deterministically.
pub fn to_json(snapshot: &Snapshot) -> Result<String> {
	let mut json = serde_json::to_string_pretty(snapshot)?;
	json.push('\n');
	Ok(json)
}
