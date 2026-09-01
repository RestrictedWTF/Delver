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
	/// Whether the RTTI scan understood this image's shape at all.
	///
	/// False on x86, where the locator has no `pSelf` to validate against and
	/// the scan declines. An empty [`Self::vtables`] with this false says "not
	/// looked for", which is not "none present".
	pub rtti_scanned: bool,
	/// Recovered classes and their vtables, ascending by vftable RVA.
	pub vtables: Vec<VtableFact>,
}

/// One recovered class and the vtable below its locator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VtableFact {
	/// Decorated class name, from the type descriptor.
	pub decorated_name: String,
	/// RVA of the complete-object locator.
	pub locator_rva: String,
	/// RVA of slot zero.
	pub vftable_rva: String,
	/// Offset of this subobject's vftable within the complete object.
	pub base_offset: u32,
	/// `index@function_rva` per slot, so a slot that shifts or disappears fails
	/// the diff rather than passing as a shorter table.
	pub slots: Vec<String>,
	/// Why the walk stopped. Recorded because a short table and a small class
	/// are otherwise indistinguishable.
	pub terminator: String,
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
		// The ordinal leads every line. It is the export directory's own
		// numbering, derived from a slot's index in the address table, so a
		// change in which slots are reported shows up here as a renumbering
		// rather than passing as a shorter list — which is the whole claim
		// `x64-export-holes` exists to make.
		.map(|e| {
			let ordinal = e.ordinal;
			match (&e.name, &e.forwarded_to, e.rva) {
				(Some(n), Some(target), _) => format!("#{ordinal} {n} -> {target}"),
				(Some(n), None, Some(rva)) => format!("#{ordinal} {n}@{}", hex(rva)),
				(Some(n), None, None) => format!("#{ordinal} {n}@<none>"),
				(None, _, Some(rva)) => format!("#{ordinal} @{}", hex(rva)),
				(None, _, None) => format!("#{ordinal}"),
			}
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
	// Analysed once and shared: function recovery is an input to the vtable
	// facts as well as the analysis facts, and running it twice per sample
	// would let the two views drift apart as well as cost twice over.
	let analyzed = delver_analysis::analyze(
		&image,
		bytes,
		std::slice::from_ref(&(0..bytes.len() as u64)),
	);
	let analysis = analysis_facts(&image, bytes, &analyzed);
	let (rtti_scanned, vtables) = vtable_facts(&image, bytes, &analyzed);

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
		rtti_scanned,
		vtables,
	})
}

/// Scans for RTTI and walks each class's vtable.
///
/// Function recovery has to run first: the slot walk admits a pointer only when
/// it names a recovered function entry, so this re-analyses rather than
/// weakening the rule.
fn vtable_facts(
	image: &delver_format::ParsedImage,
	bytes: &[u8],
	analyzed: &delver_analysis::AnalyzedImage,
) -> (bool, Vec<VtableFact>) {
	let scan = delver_format::rtti::scan_rtti(image, bytes);
	if !scan.scanned {
		return (false, Vec::new());
	}
	let vtables =
		delver_analysis::vtables::recover_vtables(image, bytes, &analyzed.functions, &scan.classes);

	let facts = vtables
		.iter()
		.map(|vtable| VtableFact {
			decorated_name: vtable.decorated_name.clone(),
			locator_rva: hex(vtable.locator_rva),
			vftable_rva: hex(vtable.vftable_rva),
			base_offset: vtable.base_offset,
			slots: vtable
				.slots
				.iter()
				.map(|slot| format!("{}@{}", slot.index, hex(slot.function_rva)))
				.collect(),
			terminator: terminator_label(&vtable.terminator),
		})
		.collect();
	(true, facts)
}

/// Names a walk's stopping reason, with addresses in the file's hex style.
fn terminator_label(terminator: &delver_analysis::vtables::SlotTerminator) -> String {
	use delver_analysis::vtables::SlotTerminator;
	match terminator {
		SlotTerminator::NotAFunction {
			rejected_rva: Some(rva),
		} => format!("NotAFunction@{}", hex(*rva)),
		SlotTerminator::NotAFunction { rejected_rva: None } => {
			"NotAFunction:<outside image>".to_string()
		}
		SlotTerminator::NextVtable { vftable_rva } => {
			format!("NextVtable@{}", hex(*vftable_rva))
		}
		SlotTerminator::NotBackedByFile => "NotBackedByFile".to_string(),
		SlotTerminator::Cap => "Cap".to_string(),
	}
}

/// Runs static analysis and flattens the result into diffable strings.
fn analysis_facts(
	image: &delver_format::ParsedImage,
	bytes: &[u8],
	analyzed: &delver_analysis::AnalyzedImage,
) -> AnalysisFact {
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
