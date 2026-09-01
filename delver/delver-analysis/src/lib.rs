//! Static analysis over a parsed image.
//!
//! Produces the **facts** half of the data model: decoded instructions, an
//! instruction index, function starts, and cross-references. All of it is
//! recomputable from the input bytes, so it is a cache — never mixed with the
//! authored interpretation layer (`Docs/architecture/data-model.md` §3).
//!
//! Function detection runs in two passes with different confidence:
//!
//! 1. **Recursive descent** from seeds the image itself vouches for — the
//!    exception directory, entry point, exports, TLS callbacks — following
//!    control flow and adding call targets as it goes.
//! 2. **Linear sweep** over executable bytes the descent never reached, which
//!    finds functions nothing references but cannot prove they are functions.
//!
//! The two are recorded distinctly. A guessed boundary must render differently
//! from a compiler-emitted one (`Docs/design/principles.md` §1), so the data
//! has to carry the difference.
//!
//! The same rule applies one level up: an image whose architecture Delver
//! cannot decode is not an image with no code in it. [`AnalyzedImage::decoding`]
//! carries that distinction, and any caller reporting instruction, function or
//! xref counts owes the reader that field alongside them.
//!
//! Detection can also be wrong, and an analyst who sees that can correct it
//! without ever hand-editing a fact: [`analyze_corrected`] takes an authored
//! change to the *seed set* and re-derives everything from bytes plus the
//! corrected seeds. See [`corrections`].

#![warn(missing_docs)]
#![forbid(unsafe_code)]

pub mod call_graph;
pub mod control_flow;
pub mod corrections;
pub mod globals;
pub mod immediates;
pub mod index;
pub mod listing;
pub mod strings;
pub mod vtables;
pub mod xrefs;

use std::collections::BTreeMap;
use std::ops::Range;

use delver_disasm::{Bitness, Disassembler, FlowKind};
use delver_format::{ParsedImage, SeedSource};

mod state;
use state::RvaState;

pub use call_graph::{
	CallGraph, CallGraphEdge, CallPath, CallPathSinkError, CallPathStep, CallPaths, ExtentError,
	FunctionExtent, FunctionProfile, IndirectCallSite, IndirectResolutionMethod,
	ResolutionConfidence, ResolvedImport,
};
pub use control_flow::{BasicBlock, BasicBlockEdge, BasicBlockEdgeKind};
pub use corrections::{
	CorrectionConflict, CorrectionSet, Corrections, DataRangeCorrection, FunctionCorrection,
	FunctionCorrectionKind,
};
pub use globals::{GlobalAccess, GlobalCandidate};
pub use index::InstructionIndex;
pub use strings::{FoundString, StringEncoding, StringScan};
pub use xrefs::{Xref, XrefKind, XrefTable};

/// Where a function start came from, most authoritative first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum FunctionSource {
	/// An analyst said a function starts here.
	///
	/// The most authoritative source there is. Everything below it is derived
	/// from the image, and a person correcting a derivation outranks the
	/// derivation — that is the whole point of being able to correct it.
	Authored,
	/// From the exception directory. Compiler-emitted.
	ExceptionDirectory,
	/// The image entry point.
	EntryPoint,
	/// An exported symbol.
	Export,
	/// A TLS callback.
	TlsCallback,
	/// Reached by a direct call during recursive descent.
	CallTarget,
	/// Found by linear sweep. Nothing references it — this is a guess.
	LinearSweep,
}

impl FunctionSource {
	/// Whether something vouches for this boundary.
	///
	/// `CallTarget` counts: something in the image calls the address, which is
	/// strong evidence. `Authored` counts because a person said so.
	/// `LinearSweep` does not — nothing vouches for a guess.
	///
	/// Matched exhaustively on purpose. A new source has to be classified
	/// deliberately, and a catch-all would silently make the next one
	/// authoritative.
	pub fn is_authoritative(self) -> bool {
		match self {
			Self::Authored
			| Self::ExceptionDirectory
			| Self::EntryPoint
			| Self::Export
			| Self::TlsCallback
			| Self::CallTarget => true,
			Self::LinearSweep => false,
		}
	}

	fn from_seed(source: SeedSource) -> Self {
		match source {
			SeedSource::ExceptionDirectory => Self::ExceptionDirectory,
			SeedSource::EntryPoint => Self::EntryPoint,
			SeedSource::Export => Self::Export,
			SeedSource::TlsCallback => Self::TlsCallback,
		}
	}
}

/// A detected function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Function {
	/// Entry RVA.
	pub rva: u64,
	/// Exclusive end, when a source records one. Absent when only the start is
	/// known.
	pub end_rva: Option<u64>,
	/// Where the start came from.
	pub source: FunctionSource,
	/// Further ranges of this function that do not adjoin [`Self::end_rva`].
	///
	/// x64 lets a compiler split a function across several ranges; each extra
	/// piece is a chained `RUNTIME_FUNCTION` naming this entry as its primary.
	/// They are kept separate rather than folded into `end_rva` because they are
	/// genuinely discontiguous — a cold piece can sit far from the entry, and
	/// stretching one extent over the gap would swallow every function between.
	///
	/// Ascending by start, and never overlapping `rva..end_rva`.
	pub fragments: Vec<Range<u64>>,
}

/// Whether the code passes ran at all, and why not when they did not.
///
/// Empty instruction, function and xref lists have two incompatible meanings.
/// Only one of them is a fact about the sample, so the analysis has to say
/// which it is: reporting "zero instructions" for an image Delver simply cannot
/// decode is a confident false claim, the failure this codebase ranks worst
/// (`Docs/design/principles.md` §1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodeDecoding {
	/// Every code pass ran. Empty results here mean the image really has no
	/// code the analysis could find.
	Decoded,
	/// Delver has no disassembler for this architecture, so recursive descent,
	/// the linear sweep and xref building were all skipped. Carries the
	/// architecture string the image declared, so a caller can name it.
	///
	/// Everything else on [`AnalyzedImage`] — strings, and whatever the format
	/// layer parsed — is still valid; only the code facts are absent.
	UnsupportedArchitecture(String),
}

/// Everything derived from one image.
///
/// Deliberately not `Default`: an empty analysis is only meaningful alongside
/// [`AnalyzedImage::decoding`], and a default would answer that question by
/// accident.
#[derive(Debug, Clone)]
pub struct AnalyzedImage {
	/// Every decoded instruction boundary.
	pub instructions: InstructionIndex,
	/// Control-flow facts retained for every decoded instruction, sorted by RVA.
	pub instruction_flows: Vec<InstructionFlow>,
	/// Detected functions, sorted by address.
	pub functions: Vec<Function>,
	/// Cross-references in both directions.
	pub xrefs: XrefTable,
	/// Strings found in the image.
	pub strings: Vec<FoundString>,
	/// Whether the string scan hit its cap and dropped results.
	pub strings_truncated: bool,
	/// Whether the code passes ran, and why not when they did not.
	pub decoding: CodeDecoding,
}

impl AnalyzedImage {
	/// Whether the code passes ran.
	///
	/// When this is false the instruction, function and xref lists are empty
	/// because nothing was decoded. Reporting their counts without reporting
	/// this asserts something untrue about the sample.
	pub fn decoded_code(&self) -> bool {
		matches!(self.decoding, CodeDecoding::Decoded)
	}

	/// The architecture that could not be decoded, when that is why the code
	/// facts are empty.
	pub fn undecodable_architecture(&self) -> Option<&str> {
		match &self.decoding {
			CodeDecoding::Decoded => None,
			CodeDecoding::UnsupportedArchitecture(arch) => Some(arch),
		}
	}
}

/// The structure-only facts needed to build basic blocks without decoding again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstructionFlow {
	/// Instruction start RVA.
	pub rva: u64,
	/// Encoded instruction length.
	pub len: u32,
	/// Control-flow classification.
	pub flow: FlowKind,
	/// Direct branch target, when encoded by the instruction.
	pub branch_target: Option<u64>,
}

/// Analyses `image`, reading code from `file`.
///
/// Architectures the disassembler cannot decode are not guessed at. The code
/// facts come back empty and [`AnalyzedImage::decoding`] says why, so a caller
/// can tell "this image has no code" from "Delver cannot read this image's
/// code" — see [`CodeDecoding`]. Strings are scanned either way; they do not
/// need a decoder.
pub fn analyze(image: &ParsedImage, file: &[u8], coverage: &[Range<u64>]) -> AnalyzedImage {
	analyze_with(image, file, coverage, &CorrectionSet::default())
}

/// Analyses `image` with authored corrections to function detection applied.
///
/// The corrections are inputs to the derivation, not edits to its output: the
/// analysis runs from the image bytes plus a corrected seed set, so every fact
/// that comes back is still recomputable from things a caller can point at.
/// Nothing here touches `file` — corrections name addresses, never bytes, and
/// nothing in this crate reads or modifies target bytes to apply one. See
/// [`corrections`] for the reasoning.
///
/// `corrections` is anything that converts into [`Corrections`]: a bare
/// `&[FunctionCorrection]` for function starts alone, or the struct itself to
/// carry [`DataRangeCorrection`]s as well.
///
/// The set is validated as a whole and refused as a whole. A conflicting set
/// yields [`CorrectionConflict`] and no analysis, because facts derived from
/// half of an authored set correspond to nothing anyone recorded.
///
/// An architecture Delver cannot decode still produces no code facts at all —
/// an authored function start does not conjure one, since a lone function
/// beside an empty instruction list would contradict
/// [`AnalyzedImage::decoding`].
pub fn analyze_corrected<'a>(
	image: &ParsedImage,
	file: &[u8],
	coverage: &[Range<u64>],
	corrections: impl Into<Corrections<'a>>,
) -> Result<AnalyzedImage, CorrectionConflict> {
	let corrections = CorrectionSet::new(corrections)?;
	Ok(analyze_with(image, file, coverage, &corrections))
}

/// The single implementation behind [`analyze`] and [`analyze_corrected`].
///
/// Corrections are a modifier on the one detection path rather than a path of
/// their own: a parallel implementation would drift, and the corrected facts
/// would stop being comparable to the uncorrected ones.
fn analyze_with(
	image: &ParsedImage,
	file: &[u8],
	coverage: &[Range<u64>],
	corrections: &CorrectionSet,
) -> AnalyzedImage {
	let scan = strings::find_strings(image, file, coverage);

	let Some(bitness) = Bitness::from_arch(&image.arch) else {
		return AnalyzedImage {
			instructions: InstructionIndex::default(),
			instruction_flows: Vec::new(),
			functions: Vec::new(),
			xrefs: XrefTable::default(),
			strings: scan.strings,
			strings_truncated: scan.truncated,
			decoding: CodeDecoding::UnsupportedArchitecture(image.arch.clone()),
		};
	};

	let disasm = Disassembler::new(bitness);
	let mut state = Descent::new(&disasm, image, file, coverage, corrections);

	// Authored starts seed first, and not only because `Authored` outranks
	// every detected source. `add_function` keeps the first extent it is given,
	// so going first is what lets an explicit `end_rva` pin the extent over a
	// detected one, while an absent `end_rva` still inherits whatever detection
	// infers for the same address.
	for (rva, end_rva) in corrections.defines() {
		state.add_function(rva, end_rva, FunctionSource::Authored);
		state.queue(rva);
	}

	// Seeds the image vouches for, best source first so the strongest wins the
	// dedupe in `functions`.
	for seed in &image.function_seeds {
		state.add_function(
			seed.rva,
			seed.end_rva,
			FunctionSource::from_seed(seed.source),
		);
		state.queue(seed.rva);
	}
	state.run();
	state.linear_sweep();

	let (instructions, instruction_flows, functions, xrefs) = state.finish();
	AnalyzedImage {
		instructions,
		instruction_flows,
		functions,
		xrefs,
		strings: scan.strings,
		strings_truncated: scan.truncated,
		decoding: CodeDecoding::Decoded,
	}
}

/// Walks control flow from a worklist of addresses.
struct Descent<'a> {
	disasm: &'a Disassembler,
	image: &'a ParsedImage,
	file: &'a [u8],
	coverage: &'a [Range<u64>],
	/// Authored corrections, consulted on every function start.
	corrections: &'a CorrectionSet,
	/// Which addresses have been walked, and where instructions start.
	state: RvaState,
	/// Best-known source per function address.
	functions: BTreeMap<u64, (Option<u64>, FunctionSource)>,
	xrefs: Vec<Xref>,
	instruction_flows: Vec<InstructionFlow>,
	queue: Vec<u64>,
}

impl<'a> Descent<'a> {
	fn new(
		disasm: &'a Disassembler,
		image: &'a ParsedImage,
		file: &'a [u8],
		coverage: &'a [Range<u64>],
		corrections: &'a CorrectionSet,
	) -> Self {
		Self {
			disasm,
			image,
			file,
			coverage,
			corrections,
			state: RvaState::new(image, file.len() as u64, coverage),
			functions: BTreeMap::new(),
			xrefs: Vec::new(),
			instruction_flows: Vec::new(),
			queue: Vec::new(),
		}
	}

	/// Records a function start, unless an author has said there is none there.
	///
	/// Every discovery path funnels through here — image seeds, call targets
	/// found by descent, linear-sweep guesses — which is the only reason an
	/// `Undefine` holds. Deleting the address afterwards would not: descent
	/// re-derives it as a `CallTarget` the moment anything calls it, and the
	/// sweep re-guesses it, both of them long after a seed was removed. The
	/// refusal has to sit where addresses *become* functions, not where they
	/// are listed.
	fn add_function(&mut self, rva: u64, end_rva: Option<u64>, source: FunctionSource) {
		// A function has to start somewhere the image actually maps. Descent
		// works in RVA space, so a `call` with a large negative displacement in
		// bytes that were never code wraps below zero and names an address near
		// 2^64 — and every source can name one: a seed from a corrupt header, a
		// sweep guess in a truncated file, a call target from garbage. Same
		// choke point, same reason as an `Undefine`: an address that is in no
		// section is not a function, however it was reached, and a function at
		// an impossible address is a confident false claim about the sample.
		if self.image.section_containing(rva).is_none() {
			return;
		}
		if self.corrections.is_undefined(rva) {
			return;
		}
		// A data range denies its bytes were ever code, so nothing may start a
		// function inside one — not a seed, not a call target, not a guess.
		// Same choke point, same reason as an `Undefine`.
		if self.corrections.data_range_end_at(rva).is_some() {
			return;
		}
		self.functions
			.entry(rva)
			.and_modify(|existing| {
				// A stronger source wins, and an end range is kept if either
				// source knows one.
				if source < existing.1 {
					existing.1 = source;
				}
				if existing.0.is_none() {
					existing.0 = end_rva;
				}
			})
			.or_insert((end_rva, source));
	}

	fn queue(&mut self, rva: u64) {
		if !self.state.is_visited(rva) {
			self.queue.push(rva);
		}
	}

	/// Drains the worklist, following control flow.
	fn run(&mut self) {
		while let Some(start) = self.queue.pop() {
			self.walk(start);
		}
	}

	/// Decodes forward from `start` until the flow stops.
	fn walk(&mut self, start: u64) {
		let mut rva = start;

		loop {
			// Decoding stops at the edge of a data range. Checked before
			// `visit` and before any instruction is recorded, which is what
			// keeps the range's bytes out of the index and keeps every xref
			// this loop pushes from originating inside one. An xref *to* the
			// range, pushed from an instruction outside it, is untouched: the
			// reference is a fact about the image whatever the bytes are.
			//
			// This is the start of an instruction; the overlap check below
			// handles one that begins outside a range and reads into it.
			if self.corrections.data_range_end_at(rva).is_some() {
				return;
			}
			if !self.state.visit(rva) {
				return; // already walked this path
			}
			let Some(bytes) = covered_bytes_at(self.image, self.file, self.coverage, rva) else {
				return;
			};
			// Structure only: this pass decodes every reachable instruction in
			// the image and displays none of them, so formatting each one would
			// be the single largest cost in the analysis.
			let Some(instruction) = self.disasm.decode_facts_at(rva, bytes) else {
				return;
			};
			if instruction.flow == FlowKind::Invalid {
				return;
			}
			// The range check above catches an instruction that *starts* in
			// excluded bytes; this catches one that starts outside and reads
			// into them. Both are the same claim — the author said those bytes
			// are not code — and only the second can manufacture a function,
			// because a `call rel32` whose displacement lies inside the range
			// invents a start at whatever the excluded bytes spell. Checked
			// before anything is recorded, so no instruction, xref, or function
			// survives the overlap.
			if self.corrections.instruction_overlaps_data_range(
				instruction.rva,
				instruction.rva.saturating_add(instruction.len as u64),
			) {
				return;
			}

			self.state.set_instruction(instruction.rva, instruction.len);
			self.instruction_flows.push(InstructionFlow {
				rva: instruction.rva,
				len: instruction.len,
				flow: instruction.flow,
				branch_target: instruction.branch_target,
			});

			if let Some(target) = instruction.branch_target {
				let kind = match instruction.flow {
					FlowKind::Call => XrefKind::Call,
					FlowKind::Jump => XrefKind::Jump,
					FlowKind::ConditionalJump => XrefKind::ConditionalJump,
					_ => XrefKind::Jump,
				};
				self.xrefs.push(Xref {
					from: instruction.rva,
					to: target,
					kind,
				});

				// A called address is a function; a jumped-to address is just
				// more of the current one.
				if instruction.flow == FlowKind::Call {
					self.add_function(target, None, FunctionSource::CallTarget);
				}
				self.queue(target);
			}

			if let Some(target) = instruction.memory_target {
				self.xrefs.push(Xref {
					from: instruction.rva,
					to: target,
					kind: XrefKind::Data,
				});
			}

			// This is the rule that keeps descent honest: never continue past
			// an instruction that does not fall through. Walking past a `ret`
			// is how a sweep invents functions that do not exist.
			if !instruction.flow.falls_through() {
				return;
			}
			rva = instruction.end_rva();
		}
	}

	/// Sweeps executable bytes the descent never reached.
	///
	/// Everything found here is `LinearSweep` — nothing in the image refers to
	/// it, so its status as a function is inferred, not established.
	fn linear_sweep(&mut self) {
		// Compiler-provided ranges may contain unreachable code, jump tables, or
		// embedded data. None of those gaps are evidence for a nested function.
		// Keep the sweep from manufacturing weak starts inside a stronger range.
		let mut authoritative_ranges: Vec<_> = self
			.functions
			.iter()
			.filter_map(|(&start, &(end, source))| {
				(source.is_authoritative())
					.then_some(end.map(|end| (start, end)))
					.flatten()
			})
			.collect();
		// A chained `RUNTIME_FUNCTION` fragment is compiler-declared code inside
		// a function, but its start is not a function start, so it is in no
		// seed and contributes no range above. Without it the sweep walks into
		// the middle of a split function and guesses a start there — which is
		// what excluding authoritative ranges exists to prevent (ADR 0017).
		authoritative_ranges.extend(
			self.image
				.exception_ranges
				.iter()
				.map(|entry| (entry.range.start, entry.range.end)),
		);
		let executable: Vec<_> = self
			.image
			.sections
			.iter()
			.filter(|s| s.is_executable())
			.map(|s| {
				(
					s.virtual_address,
					s.virtual_end().min(s.virtual_address + s.raw_size),
				)
			})
			.collect();

		for (start, end) in executable {
			let mut rva = start;
			while rva < end {
				// Step over the range rather than through it. This is a cost
				// optimisation and **not** the correctness guard: `add_function`
				// refuses every candidate inside a range and `walk` returns
				// before recording anything, so byte-stepping would reach the
				// same empty result — it would just do the work once per
				// excluded byte, and a range can be megabytes. Measured, not
				// assumed: replacing this with `rva += 1` leaves every test in
				// this file passing.
				if let Some(range_end) = self.corrections.data_range_end_at(rva) {
					rva = range_end;
					continue;
				}
				if let Some((_, function_end)) =
					authoritative_ranges
						.iter()
						.find(|&&(function_start, function_end)| {
							function_start <= rva && rva < function_end
						}) {
					rva = *function_end;
					continue;
				}
				if self.state.is_visited(rva) {
					// Skip the whole instruction if we know its length.
					rva += self.state.instruction_len(rva).unwrap_or(1) as u64;
					continue;
				}

				let Some(bytes) = covered_bytes_at(self.image, self.file, self.coverage, rva)
				else {
					rva += 1;
					continue;
				};
				// Alignment padding is not a function start.
				if matches!(bytes.first(), Some(0xCC) | Some(0x90) | Some(0x00)) {
					rva += 1;
					continue;
				}

				let decodes = self
					.disasm
					.decode_facts_at(rva, bytes)
					.is_some_and(|instruction| instruction.flow != FlowKind::Invalid);

				if decodes {
					// An undefined address is refused inside `add_function` but
					// still walked. Skipping the walk instead would leave the
					// bytes unvisited and the sweep would simply guess a
					// function one byte later — undefining a start would
					// manufacture a neighbouring start, which is not what the
					// author asked for. Walking consumes the run instead. The
					// instructions stay: the correction withdraws a function
					// start, it does not claim the bytes are data.
					self.add_function(rva, None, FunctionSource::LinearSweep);
					self.queue(rva);
					self.run();
					// `run` decoded the instruction at `rva`; step over it.
					rva += self.state.instruction_len(rva).unwrap_or(1) as u64;
				} else {
					rva += 1;
				}
			}
		}
	}

	fn finish(
		mut self,
	) -> (
		InstructionIndex,
		Vec<InstructionFlow>,
		Vec<Function>,
		XrefTable,
	) {
		let instructions = InstructionIndex::from_pairs(self.state.instructions());
		self.instruction_flows.sort_unstable_by_key(|fact| fact.rva);
		self.instruction_flows.dedup_by_key(|fact| fact.rva);

		// A fragment belongs to the function its chain names, and only when that
		// function actually exists here: a chain into an address nothing
		// detected is a claim the analysis cannot honour, and inventing an owner
		// for it would be worse than leaving the bytes unattributed.
		let mut fragments_by_primary: BTreeMap<u64, Vec<Range<u64>>> = BTreeMap::new();
		for entry in &self.image.exception_ranges {
			let Some(primary) = entry.chained_to else {
				continue;
			};
			if self.functions.contains_key(&primary) {
				fragments_by_primary
					.entry(primary)
					.or_default()
					.push(entry.range.clone());
			}
		}
		for ranges in fragments_by_primary.values_mut() {
			ranges.sort_by_key(|range| range.start);
		}

		let functions = self
			.functions
			.into_iter()
			.map(|(rva, (end_rva, source))| Function {
				rva,
				end_rva,
				source,
				fragments: fragments_by_primary.remove(&rva).unwrap_or_default(),
			})
			.collect();

		(
			instructions,
			self.instruction_flows,
			functions,
			XrefTable::new(self.xrefs),
		)
	}
}

/// Returns bytes beginning at `rva`, clipped to the contiguous file coverage
/// that actually supplied them.
fn covered_bytes_at<'a>(
	image: &ParsedImage,
	file: &'a [u8],
	coverage: &[Range<u64>],
	rva: u64,
) -> Option<&'a [u8]> {
	let section = image.section_containing(rva)?;
	let offset_in_section = rva.checked_sub(section.virtual_address)?;
	if offset_in_section >= section.raw_size {
		return None;
	}
	let start = section.raw_offset.checked_add(offset_in_section)?;
	let covered_end = coverage
		.iter()
		.filter(|range| range.start <= start && start < range.end)
		.map(|range| range.end)
		.max()?;
	let end = covered_end.min(section.raw_end()).min(file.len() as u64);
	(start < end).then(|| &file[start as usize..end as usize])
}

#[cfg(test)]
mod tests {
	use super::*;
	use delver_format::{FunctionSeed, Section};

	fn analyze(image: &ParsedImage, file: &[u8]) -> AnalyzedImage {
		super::analyze(image, file, std::slice::from_ref(&(0..file.len() as u64)))
	}

	fn analyze_corrected(
		image: &ParsedImage,
		file: &[u8],
		corrections: &[FunctionCorrection],
	) -> Result<AnalyzedImage, CorrectionConflict> {
		super::analyze_corrected(
			image,
			file,
			std::slice::from_ref(&(0..file.len() as u64)),
			corrections,
		)
	}

	fn define(rva: u64, end_rva: Option<u64>) -> FunctionCorrection {
		FunctionCorrection {
			rva,
			kind: FunctionCorrectionKind::Define { end_rva },
		}
	}

	/// Analysis with both correction axes, since `analyze_corrected`'s slice
	/// shorthand only reaches function corrections.
	fn analyze_data_corrected(
		image: &ParsedImage,
		file: &[u8],
		functions: &[FunctionCorrection],
		data_ranges: &[DataRangeCorrection],
	) -> Result<AnalyzedImage, CorrectionConflict> {
		super::analyze_corrected(
			image,
			file,
			std::slice::from_ref(&(0..file.len() as u64)),
			Corrections {
				functions,
				data_ranges,
			},
		)
	}

	fn data(rva: u64, end_rva: u64) -> DataRangeCorrection {
		DataRangeCorrection { rva, end_rva }
	}

	fn undefine(rva: u64) -> FunctionCorrection {
		FunctionCorrection {
			rva,
			kind: FunctionCorrectionKind::Undefine,
		}
	}

	fn starts(analysis: &AnalyzedImage) -> Vec<(u64, FunctionSource)> {
		analysis
			.functions
			.iter()
			.map(|f| (f.rva, f.source))
			.collect()
	}

	const CODE_RVA: u64 = 0x1000;
	const CODE_OFFSET: u64 = 0x200;

	/// Builds a `ParsedImage` directly rather than through a real PE.
	///
	/// The corpus owns end-to-end coverage; these tests are about the descent
	/// algorithm, and hand-building the struct keeps them fast and free of a
	/// dependency cycle (the corpus crate depends on this one).
	fn image_with_code(code: &[u8]) -> (ParsedImage, Vec<u8>) {
		let mut file = vec![0u8; CODE_OFFSET as usize];
		file.extend_from_slice(code);

		let image = ParsedImage {
			arch: "X86_64".to_string(),
			entry: CODE_RVA,
			image_base: 0x1_4000_0000,
			sections: vec![Section {
				name: ".text".to_string(),
				virtual_address: CODE_RVA,
				virtual_size: code.len() as u64,
				raw_offset: CODE_OFFSET,
				raw_size: code.len() as u64,
				characteristics: 0x6000_0020, // CODE | EXECUTE | READ
			}],
			function_seeds: vec![FunctionSeed {
				rva: CODE_RVA,
				end_rva: None,
				source: SeedSource::EntryPoint,
			}],
			..Default::default()
		};
		(image, file)
	}

	fn source_at(analysis: &AnalyzedImage, rva: u64) -> Option<FunctionSource> {
		analysis
			.functions
			.iter()
			.find(|f| f.rva == rva)
			.map(|f| f.source)
	}

	#[test]
	fn descent_follows_a_call_and_records_the_target_as_a_function() {
		// call 0x1008 / ret / padding / mov rax,rbx / ret
		let code = &[
			0xE8, 0x03, 0x00, 0x00, 0x00, // call rel32 -> 0x1008
			0xC3, // ret
			0xCC, 0xCC, // padding
			0x48, 0x89, 0xD8, // mov rax,rbx
			0xC3, // ret
		];
		let (image, file) = image_with_code(code);
		let analysis = analyze(&image, &file);

		assert_eq!(
			source_at(&analysis, 0x1000),
			Some(FunctionSource::EntryPoint)
		);
		assert_eq!(
			source_at(&analysis, 0x1008),
			Some(FunctionSource::CallTarget)
		);

		let calls: Vec<_> = analysis
			.xrefs
			.to(0x1008)
			.iter()
			.map(|x| (x.from, x.kind))
			.collect();
		assert_eq!(calls, vec![(0x1000, XrefKind::Call)]);
	}

	#[test]
	fn syscall_does_not_create_a_function_or_call_at_rva_zero() {
		let (image, file) = image_with_code(&[
			0x0F, 0x05, // syscall
			0xC3, // ret
		]);
		let analysis = analyze(&image, &file);

		assert_eq!(
			(
				source_at(&analysis, 0),
				analysis.xrefs.to(0).to_vec(),
				source_at(&analysis, CODE_RVA),
			),
			(None, Vec::new(), Some(FunctionSource::EntryPoint)),
		);
	}

	#[test]
	fn descent_stops_at_a_ret_and_does_not_decode_past_it() {
		// ret, immediately followed by code that is never reached by flow.
		let code = &[0xC3, 0x48, 0x89, 0xD8, 0xC3];
		let (image, file) = image_with_code(code);

		// Analyse with the sweep disabled by giving the sweep nothing to do:
		// assert on what descent alone reached, via the call-flow xrefs and the
		// fact that 0x1001 is only ever attributed to LinearSweep.
		let analysis = analyze(&image, &file);

		assert_eq!(
			source_at(&analysis, 0x1001),
			Some(FunctionSource::LinearSweep),
			"0x1001 must be reachable only by sweep — descent walking past a \
			 ret would have made it part of the entry function"
		);
	}

	#[test]
	fn linear_sweep_finds_an_unreachable_function_at_lower_confidence() {
		// ret / padding / an unreferenced function
		let code = &[
			0xC3, // ret at 0x1000
			0xCC, 0xCC, 0xCC, // padding
			0x48, 0x89, 0xD8, // mov rax,rbx at 0x1004
			0xC3, // ret
		];
		let (image, file) = image_with_code(code);
		let analysis = analyze(&image, &file);

		assert_eq!(
			source_at(&analysis, 0x1000),
			Some(FunctionSource::EntryPoint)
		);
		assert_eq!(
			source_at(&analysis, 0x1004),
			Some(FunctionSource::LinearSweep)
		);

		assert!(FunctionSource::EntryPoint.is_authoritative());
		assert!(
			!FunctionSource::LinearSweep.is_authoritative(),
			"a swept boundary is a guess and must be marked as one"
		);
	}

	#[test]
	fn linear_sweep_does_not_invent_a_function_inside_an_authoritative_range() {
		// The return leaves unreachable but decodable bytes inside the compiler's
		// recorded function extent. They are not a second function.
		let code = &[0xC3, 0x48, 0x89, 0xD8, 0xC3];
		let (mut image, file) = image_with_code(code);
		image.function_seeds = vec![FunctionSeed {
			rva: 0x1000,
			end_rva: Some(0x1005),
			source: SeedSource::ExceptionDirectory,
		}];

		let analysis = analyze(&image, &file);

		assert_eq!(
			analysis.functions,
			vec![Function {
				rva: 0x1000,
				end_rva: Some(0x1005),
				source: FunctionSource::ExceptionDirectory,
				fragments: Vec::new(),
			}],
		);
	}

	#[test]
	fn linear_sweep_does_not_invent_a_function_inside_a_chained_fragment() {
		// A function the compiler split: `0x1000..0x1005` is the primary and has
		// a seed, `0x1005..0x100A` is a chained fragment that has none because
		// its start is not a function start. The fragment's bytes still decode,
		// so nothing but its declared range keeps the sweep out of them.
		let code = &[0xC3, 0x48, 0x89, 0xD8, 0xC3, 0x48, 0x89, 0xC8, 0xC3, 0x90];
		let (mut image, file) = image_with_code(code);
		image.function_seeds = vec![FunctionSeed {
			rva: 0x1000,
			end_rva: Some(0x1005),
			source: SeedSource::ExceptionDirectory,
		}];
		image.exception_ranges = vec![
			delver_format::ExceptionRange {
				range: 0x1000..0x1005,
				chained_to: None,
			},
			delver_format::ExceptionRange {
				range: 0x1005..0x100A,
				chained_to: Some(0x1000),
			},
		];

		let analysis = analyze(&image, &file);

		// The fragment is not a function, and it is not nothing either: it is
		// this function's other piece, and the chain says so.
		assert_eq!(
			analysis.functions,
			vec![Function {
				rva: 0x1000,
				end_rva: Some(0x1005),
				source: FunctionSource::ExceptionDirectory,
				fragments: std::slice::from_ref(&(0x1005..0x100A)).to_vec(),
			}],
		);
		assert_eq!(
			crate::call_graph::containing_function(&analysis.functions, 0x1007),
			Some(0x1000),
			"an address in a cold piece belongs to the function it was split from"
		);
	}

	#[test]
	fn a_fragment_range_the_directory_never_declared_is_still_swept() {
		// The guard is the declared range, not the absence of a seed. Identical
		// bytes with no `exception_ranges` entry must still be guessed at, or
		// the fix above would be silently suppressing real unreachable code.
		let code = &[0xC3, 0x48, 0x89, 0xD8, 0xC3, 0x48, 0x89, 0xC8, 0xC3, 0x90];
		let (mut image, file) = image_with_code(code);
		image.function_seeds = vec![FunctionSeed {
			rva: 0x1000,
			end_rva: Some(0x1005),
			source: SeedSource::ExceptionDirectory,
		}];
		image.exception_ranges = vec![delver_format::ExceptionRange {
			range: 0x1000..0x1005,
			chained_to: None,
		}];

		let analysis = analyze(&image, &file);

		assert_eq!(
			analysis
				.functions
				.iter()
				.map(|f| (f.rva, f.source))
				.collect::<Vec<_>>(),
			vec![
				(0x1000, FunctionSource::ExceptionDirectory),
				(0x1005, FunctionSource::LinearSweep),
			],
		);
	}

	#[test]
	fn padding_is_not_reported_as_a_function() {
		let code = &[0xC3, 0xCC, 0xCC, 0xCC, 0x90, 0x90];
		let (image, file) = image_with_code(code);
		let analysis = analyze(&image, &file);

		let starts: Vec<_> = analysis.functions.iter().map(|f| f.rva).collect();
		assert_eq!(
			starts,
			vec![0x1000],
			"int3 and nop padding are not functions"
		);
	}

	#[test]
	fn a_conditional_jump_explores_both_paths() {
		// jz +2 / mov rax,rbx / ret  — both the target and the fallthrough run.
		let code = &[
			0x74, 0x03, // jz -> 0x1005
			0x48, 0x89, 0xD8, // mov rax,rbx at 0x1002
			0xC3, // ret at 0x1005
		];
		let (image, file) = image_with_code(code);
		let analysis = analyze(&image, &file);

		for rva in [0x1000, 0x1002, 0x1005] {
			assert!(
				analysis.instructions.row_for_address(rva).is_some(),
				"{rva:#x} should have been decoded"
			);
		}
	}

	#[test]
	fn the_index_round_trips_every_decoded_instruction() {
		let code = &[0x48, 0x89, 0xD8, 0x48, 0x83, 0xC0, 0x01, 0xC3];
		let (image, file) = image_with_code(code);
		let analysis = analyze(&image, &file);

		assert_eq!(analysis.instructions.len(), 3);
		for row in 0..analysis.instructions.len() {
			let rva = analysis.instructions.address_for_row(row).expect("address");
			assert_eq!(analysis.instructions.row_for_address(rva), Some(row));
		}
	}

	#[test]
	fn an_unsupported_architecture_yields_no_guesses_and_says_so() {
		let (mut image, file) = image_with_code(&[0xC3]);
		image.arch = "Aarch64".to_string();

		let analysis = analyze(&image, &file);

		// Empty *and* labelled. Without the label these three counts read as a
		// fact about the sample rather than the absence of a decoder.
		assert_eq!(
			(
				analysis.instructions.is_empty(),
				analysis.functions.is_empty(),
				analysis.xrefs.is_empty(),
				analysis.decoded_code(),
				analysis.undecodable_architecture(),
				&analysis.decoding,
			),
			(
				true,
				true,
				true,
				false,
				Some("Aarch64"),
				&CodeDecoding::UnsupportedArchitecture("Aarch64".to_string()),
			),
		);
	}

	#[test]
	fn a_decodable_image_reports_its_code_as_decoded() {
		let (image, file) = image_with_code(&[0xC3]);
		let analysis = analyze(&image, &file);

		assert_eq!(
			(
				analysis.decoded_code(),
				analysis.undecodable_architecture(),
				&analysis.decoding,
			),
			(true, None, &CodeDecoding::Decoded),
		);
	}

	#[test]
	fn a_stronger_seed_wins_over_a_weaker_one_at_the_same_address() {
		let code = &[0xC3];
		let (mut image, file) = image_with_code(code);
		image.function_seeds = vec![
			FunctionSeed {
				rva: 0x1000,
				end_rva: None,
				source: SeedSource::Export,
			},
			FunctionSeed {
				rva: 0x1000,
				end_rva: Some(0x1001),
				source: SeedSource::ExceptionDirectory,
			},
		];

		let analysis = analyze(&image, &file);
		let function = analysis
			.functions
			.iter()
			.find(|f| f.rva == 0x1000)
			.expect("function");

		assert_eq!(function.source, FunctionSource::ExceptionDirectory);
		assert_eq!(function.end_rva, Some(0x1001));
	}

	#[test]
	fn coverage_holes_do_not_stop_later_sections_or_decode_placeholders() {
		let mut file = vec![0_u8; 0x400];
		file[0x100] = 0xC3;
		file[0x300] = 0xC3;
		let image = ParsedImage {
			arch: "X86_64".to_string(),
			sections: vec![
				Section {
					name: ".text".to_string(),
					virtual_address: 0x1000,
					virtual_size: 0x100,
					raw_offset: 0x100,
					raw_size: 0x100,
					characteristics: 0x6000_0020,
				},
				Section {
					name: ".late".to_string(),
					virtual_address: 0x3000,
					virtual_size: 1,
					raw_offset: 0x300,
					raw_size: 1,
					characteristics: 0x6000_0020,
				},
			],
			function_seeds: vec![
				FunctionSeed {
					rva: 0x1000,
					end_rva: Some(0x1001),
					source: SeedSource::EntryPoint,
				},
				FunctionSeed {
					rva: 0x3000,
					end_rva: Some(0x3001),
					source: SeedSource::Export,
				},
			],
			..Default::default()
		};

		let analysis = super::analyze(&image, &file, &[0..0x180, 0x300..0x301]);

		assert_eq!(
			analysis
				.instructions
				.rows(0, analysis.instructions.len())
				.map(|(_, rva, _)| rva)
				.collect::<Vec<_>>(),
			vec![0x1000, 0x3000],
		);
	}

	/// `ret` at the entry, padding, then an unreferenced function led by a
	/// `nop`.
	///
	/// The sweep treats that `nop` as padding, so it guesses the body at 0x1005
	/// and misses the real start at 0x1004 — the exact mistake an analyst can
	/// see and detection cannot.
	const NOP_LED_FUNCTION: &[u8] = &[
		0xC3, // ret at 0x1000, the entry
		0xCC, 0xCC, 0xCC, // padding
		0x90, // nop at 0x1004 — the real start
		0x48, 0x89, 0xD8, // mov rax,rbx at 0x1005 — what the sweep finds
		0xC3, // ret at 0x1008
	];

	#[test]
	fn a_define_at_an_undetected_address_yields_an_authored_function() {
		let (image, file) = image_with_code(NOP_LED_FUNCTION);

		let baseline = analyze(&image, &file);
		assert_eq!(
			starts(&baseline),
			vec![
				(0x1000, FunctionSource::EntryPoint),
				(0x1005, FunctionSource::LinearSweep),
			],
			"detection on its own starts the function one byte late",
		);

		let corrected =
			analyze_corrected(&image, &file, &[define(0x1004, None)]).expect("no conflict");

		// Descent runs from the authored start before the sweep, so the bytes
		// the sweep would have guessed at are already accounted for and the
		// wrong guess never appears.
		assert_eq!(
			starts(&corrected),
			vec![
				(0x1000, FunctionSource::EntryPoint),
				(0x1004, FunctionSource::Authored),
			],
		);
		assert!(
			FunctionSource::Authored.is_authoritative(),
			"a person saying so is the strongest evidence there is"
		);
		assert!(FunctionSource::Authored < FunctionSource::ExceptionDirectory);
	}

	#[test]
	fn a_define_with_an_explicit_end_pins_the_extent() {
		let (image, file) = image_with_code(NOP_LED_FUNCTION);

		let corrected =
			analyze_corrected(&image, &file, &[define(0x1004, Some(0x1009))]).expect("no conflict");

		assert_eq!(
			corrected.functions,
			vec![
				Function {
					rva: 0x1000,
					end_rva: None,
					source: FunctionSource::EntryPoint,
					fragments: Vec::new(),
				},
				Function {
					rva: 0x1004,
					end_rva: Some(0x1009),
					source: FunctionSource::Authored,
					fragments: Vec::new(),
				},
			],
		);
	}

	#[test]
	fn a_define_on_a_detected_address_upgrades_it_without_duplicating_it() {
		let (image, file) = image_with_code(NOP_LED_FUNCTION);

		// 0x1005 is exactly what the sweep guesses; defining it agrees with the
		// guess and promotes it.
		let corrected =
			analyze_corrected(&image, &file, &[define(0x1005, None)]).expect("no conflict");

		assert_eq!(
			starts(&corrected),
			vec![
				(0x1000, FunctionSource::EntryPoint),
				(0x1005, FunctionSource::Authored),
			],
			"one entry, upgraded — not a second function at the same address",
		);
	}

	#[test]
	fn a_define_inherits_a_detected_extent_when_the_author_pins_none() {
		let code = &[0xC3, 0x48, 0x89, 0xD8, 0xC3];
		let (mut image, file) = image_with_code(code);
		image.function_seeds = vec![FunctionSeed {
			rva: 0x1000,
			end_rva: Some(0x1005),
			source: SeedSource::ExceptionDirectory,
		}];

		let corrected =
			analyze_corrected(&image, &file, &[define(0x1000, None)]).expect("no conflict");

		assert_eq!(
			corrected.functions,
			vec![Function {
				rva: 0x1000,
				end_rva: Some(0x1005),
				source: FunctionSource::Authored,
				fragments: Vec::new(),
			}],
			"an absent end means 'infer it the way a detected one is inferred'",
		);
	}

	#[test]
	fn an_undefine_removes_a_sweep_guess_and_it_stays_gone() {
		let (image, file) = image_with_code(NOP_LED_FUNCTION);

		let corrected = analyze_corrected(&image, &file, &[undefine(0x1005)]).expect("no conflict");

		assert_eq!(
			starts(&corrected),
			vec![(0x1000, FunctionSource::EntryPoint)],
			"the sweep re-guesses 0x1005 after descent; the refusal has to \
			 survive that, not merely precede it",
		);
		assert!(
			corrected.instructions.row_for_address(0x1005).is_some(),
			"the correction withdraws a function start, not the claim that the \
			 bytes decode",
		);
	}

	#[test]
	fn an_undefine_of_a_call_target_stays_gone_though_something_calls_it() {
		// call 0x1008 / ret / padding / mov rax,rbx / ret
		let code = &[
			0xE8, 0x03, 0x00, 0x00, 0x00, // call rel32 -> 0x1008
			0xC3, // ret
			0xCC, 0xCC, // padding
			0x48, 0x89, 0xD8, // mov rax,rbx at 0x1008
			0xC3, // ret
		];
		let (image, file) = image_with_code(code);

		let corrected = analyze_corrected(&image, &file, &[undefine(0x1008)]).expect("no conflict");

		assert_eq!(
			(
				starts(&corrected),
				corrected
					.xrefs
					.to(0x1008)
					.iter()
					.map(|x| (x.from, x.kind))
					.collect::<Vec<_>>(),
			),
			(
				vec![(0x1000, FunctionSource::EntryPoint)],
				// The call is still a fact about the image. The author denied a
				// function start, not the instruction that branches there.
				vec![(0x1000, XrefKind::Call)],
			),
		);
	}

	#[test]
	fn an_undefine_of_an_undetected_address_is_a_no_op() {
		let (image, file) = image_with_code(NOP_LED_FUNCTION);

		let baseline = analyze(&image, &file);
		// 0x1002 is padding; nothing ever called it a function.
		let corrected = analyze_corrected(&image, &file, &[undefine(0x1002)]).expect("no conflict");

		assert_eq!(format!("{corrected:?}"), format!("{baseline:?}"));
	}

	#[test]
	fn a_conflicting_set_is_refused_whole() {
		let (image, file) = image_with_code(NOP_LED_FUNCTION);

		// Each set has a correction that would apply cleanly on its own. None of
		// them may apply: a half-written set describes facts nobody recorded.
		assert_eq!(
			(
				analyze_corrected(&image, &file, &[define(0x1004, None), define(0x1004, None)])
					.err(),
				analyze_corrected(&image, &file, &[undefine(0x1005), undefine(0x1005)]).err(),
				analyze_corrected(&image, &file, &[define(0x1004, None), undefine(0x1004)]).err(),
				analyze_corrected(
					&image,
					&file,
					&[undefine(0x1005), define(0x1004, Some(0x1000))]
				)
				.err(),
			),
			(
				Some(CorrectionConflict::DuplicateAddress { rva: 0x1004 }),
				Some(CorrectionConflict::DuplicateAddress { rva: 0x1005 }),
				Some(CorrectionConflict::DuplicateAddress { rva: 0x1004 }),
				Some(CorrectionConflict::EmptyExtent {
					rva: 0x1004,
					end_rva: 0x1000,
				}),
			),
		);
	}

	/// call 0x100B / ret / padding / mov rax,rbx / ret, entered at a nop so the
	/// call itself can be covered by a data range without hiding the entry.
	const CALL_OVER_PADDING: &[u8] = &[
		0x90, // nop at 0x1000, the entry
		0xE8, 0x05, 0x00, 0x00, 0x00, // call rel32 at 0x1001 -> 0x100B
		0xC3, // ret at 0x1006
		0xCC, 0xCC, 0xCC, 0xCC, // padding
		0x48, 0x89, 0xD8, // mov rax,rbx at 0x100B
		0xC3, // ret at 0x100E
	];

	#[test]
	fn a_data_range_takes_its_instructions_out_of_the_index() {
		let (image, file) = image_with_code(CALL_OVER_PADDING);

		let baseline = analyze(&image, &file);
		let corrected = analyze_data_corrected(&image, &file, &[], &[data(0x100B, 0x100F)])
			.expect("no conflict");

		assert_eq!(
			(
				baseline.instructions.row_for_address(0x100B).is_some(),
				baseline.instructions.row_for_address(0x100E).is_some(),
				corrected.instructions.row_for_address(0x100B).is_some(),
				corrected.instructions.row_for_address(0x100E).is_some(),
				corrected.instructions.row_for_address(0x1001).is_some(),
			),
			(true, true, false, false, true),
			"the range denies its own bytes were code and nothing else",
		);
	}

	#[test]
	fn an_xref_into_a_data_range_survives_while_one_out_of_it_does_not() {
		let (image, file) = image_with_code(CALL_OVER_PADDING);

		// 0x100B is called from outside the range; the call at 0x1001 is inside
		// a second range and so never decodes at all.
		let targeted = analyze_data_corrected(&image, &file, &[], &[data(0x100B, 0x100F)])
			.expect("no conflict");
		let originating = analyze_data_corrected(&image, &file, &[], &[data(0x1001, 0x1006)])
			.expect("no conflict");

		assert_eq!(
			(
				targeted
					.xrefs
					.to(0x100B)
					.iter()
					.map(|x| (x.from, x.kind))
					.collect::<Vec<_>>(),
				originating.xrefs.from(0x1001).len(),
			),
			(
				// A call is a fact about the image whatever lives at the address
				// it names — the same reason an `Undefine` keeps it.
				vec![(0x1001, XrefKind::Call)],
				0,
			),
		);
	}

	#[test]
	fn a_call_target_outside_every_section_is_not_a_function() {
		// call rel32 -0x02000000 / ret. Descent works in RVA space, so the
		// target is `0x1005 + 0xFFFFFFFFFE000000` in wrapping `u64` arithmetic:
		// `0xFFFFFFFFFE001005`, which no section maps. Bytes that are not really
		// code produce this shape whenever a displacement reads back large and
		// negative.
		let code = &[
			0xE8, 0x00, 0x00, 0x00, 0xFE, // 0x1000 call -> 0xFFFFFFFFFE001005
			0xC3, // 0x1005 ret
		];
		let (image, file) = image_with_code(code);

		let analysis = analyze(&image, &file);

		assert_eq!(
			(
				starts(&analysis),
				// The call itself is still a fact about the image, the same reason
				// an `Undefine` keeps one. Only the function start is refused.
				analysis
					.xrefs
					.all()
					.iter()
					.map(|x| (x.from, x.to, x.kind))
					.collect::<Vec<_>>(),
			),
			(
				vec![(0x1000, FunctionSource::EntryPoint)],
				vec![(0x1000, 0xFFFF_FFFF_FE00_1005, XrefKind::Call)],
			),
		);
	}

	#[test]
	fn no_function_starts_inside_a_data_range_from_any_source() {
		// nop / call 0x100B / ret / padding / mov rax,rbx / ret / padding /
		// mov rax,rbx / ret — the last pair is unreferenced, so only the sweep
		// can find it.
		let code = &[
			0x90, // 0x1000 entry
			0xE8, 0x05, 0x00, 0x00, 0x00, // call -> 0x100B
			0xC3, // 0x1006, also an exception-directory seed
			0xCC, 0xCC, 0xCC, 0xCC, //
			0x48, 0x89, 0xD8, // 0x100B, the call target
			0xC3, //
			0xCC, // 0x100F padding
			0x48, 0x89, 0xD8, // 0x1010, reachable only by the sweep
			0xC3, //
		];
		let (mut image, file) = image_with_code(code);
		image.function_seeds.push(FunctionSeed {
			rva: 0x1006,
			end_rva: None,
			source: SeedSource::ExceptionDirectory,
		});

		let baseline = analyze(&image, &file);
		let corrected = analyze_data_corrected(
			&image,
			&file,
			&[],
			&[
				data(0x1006, 0x1007),
				data(0x100B, 0x100F),
				data(0x1010, 0x1014),
			],
		)
		.expect("no conflict");

		assert_eq!(
			(starts(&baseline), starts(&corrected)),
			(
				vec![
					(0x1000, FunctionSource::EntryPoint),
					(0x1006, FunctionSource::ExceptionDirectory),
					(0x100B, FunctionSource::CallTarget),
					(0x1010, FunctionSource::LinearSweep),
				],
				// Seed, call target and sweep guess alike: `add_function` is the
				// one place an address becomes a function, and a data range is
				// refused there.
				vec![(0x1000, FunctionSource::EntryPoint)],
			),
		);
	}

	#[test]
	fn a_range_leaves_no_sweep_guess_inside_it_or_just_past_it() {
		let (image, file) = image_with_code(NOP_LED_FUNCTION);

		let baseline = analyze(&image, &file);
		// 0x1004..0x1009 is the whole tail: the nop, the sweep's guess at
		// 0x1005, and the ret at 0x1008.
		let corrected = analyze_data_corrected(&image, &file, &[], &[data(0x1004, 0x1009)])
			.expect("no conflict");

		assert_eq!(
			(starts(&baseline), starts(&corrected)),
			(
				vec![
					(0x1000, FunctionSource::EntryPoint),
					(0x1005, FunctionSource::LinearSweep),
				],
				// No start at 0x1005. The guard that produces this is in
				// `add_function`, not in the sweep's stride: the stride is a
				// cost optimisation and this test passes without it.
				vec![(0x1000, FunctionSource::EntryPoint)],
			),
		);
	}

	/// A `call rel32` at 0x1000 whose displacement lies inside the range, and
	/// the function that displacement invents at 0x100a.
	const CALL_OVER_A_TABLE: &[u8] = &[
		0xE8, 0x05, 0x00, 0x00, 0x00, // call 0x100a at 0x1000; operand is 0x1001..0x1005
		0xC3, 0xCC, 0xCC, 0xCC, 0xCC, // ret, then padding
		0x48, 0x89, 0xD8, 0xC3, // the invented function at 0x100a
	];

	#[test]
	fn an_instruction_reading_into_a_range_is_excluded_along_with_what_it_invents() {
		let (image, file) = image_with_code(CALL_OVER_A_TABLE);

		// The analyst draws the range at the table's true start — 0x1002 —
		// which is *mid-instruction*, because the bad decode began before it.
		// That is the normal case, not a corner one: the boundary an analyst
		// can see is the data's, not the decoder's mistake's.
		let baseline = analyze(&image, &file);
		let corrected = analyze_data_corrected(&image, &file, &[], &[data(0x1002, 0x1008)])
			.expect("no conflict");

		let derived_from_the_call = |analysis: &AnalyzedImage| {
			starts(analysis)
				.into_iter()
				.filter(|&(_, source)| source == FunctionSource::CallTarget)
				.collect::<Vec<_>>()
		};

		assert_eq!(
			(
				baseline.instructions.row_for_address(0x1000).is_some(),
				baseline.xrefs.from(0x1000).len(),
				derived_from_the_call(&baseline),
				corrected.instructions.row_for_address(0x1000),
				corrected.xrefs.from(0x1000).len(),
				derived_from_the_call(&corrected),
			),
			(
				// Uncorrected: the call is decoded, it pushes an xref, and it
				// names 0x100a as a function — all three read out of bytes the
				// analyst is about to declare data.
				true,
				1,
				vec![(0x100a, FunctionSource::CallTarget)],
				// Corrected: checking only the instruction's *start* would keep
				// every one of them, because the call begins at 0x1000, outside
				// the range, and reaches into it for its displacement.
				None,
				0,
				vec![],
			),
		);
		// What the sweep still guesses over bytes outside the range is a
		// separate and honest matter: 0x100a really does hold code. The claim
		// this pins is that nothing was *derived from reading excluded bytes*.
		assert!(starts(&corrected)
			.iter()
			.all(|&(_, source)| source != FunctionSource::CallTarget));
	}

	#[test]
	fn a_range_abutting_code_leaves_the_neighbouring_instruction_intact() {
		let (image, file) = image_with_code(NOP_LED_FUNCTION);

		// The padding at 0x1001..0x1004 only; the ret before it and the
		// function after it are untouched.
		let corrected = analyze_data_corrected(&image, &file, &[], &[data(0x1001, 0x1004)])
			.expect("no conflict");

		assert_eq!(
			(
				starts(&corrected),
				corrected.instructions.row_for_address(0x1000).is_some(),
				corrected.instructions.row_for_address(0x1005).is_some(),
			),
			(
				vec![
					(0x1000, FunctionSource::EntryPoint),
					(0x1005, FunctionSource::LinearSweep),
				],
				true,
				true,
			),
		);
	}

	#[test]
	fn strings_are_unaffected_by_a_data_range() {
		let code = &[
			0xC3, // ret at 0x1000
			104, 101, 108, 108, 111, 0x00, // "hello" at 0x1001
		];
		let (image, file) = image_with_code(code);

		let baseline = analyze(&image, &file);
		let corrected = analyze_data_corrected(&image, &file, &[], &[data(0x1001, 0x1007)])
			.expect("no conflict");

		// Equality of the string lists means nothing on its own — the scanner
		// takes no correction argument, so it *cannot* differ. What makes this
		// a test is the first pair: the range demonstrably changed the code
		// side, and the strings still did not move. Without that, this asserts
		// a call signature.
		assert_eq!(
			(
				baseline.instructions.row_for_address(0x1001).is_some(),
				corrected.instructions.row_for_address(0x1001),
				format!("{:?}", corrected.strings),
			),
			(true, None, format!("{:?}", baseline.strings),),
			"the scanner reads bytes, not decoded code",
		);
	}

	#[test]
	fn a_conflicting_data_range_set_is_refused_whole() {
		let (image, file) = image_with_code(NOP_LED_FUNCTION);

		assert_eq!(
			(
				analyze_data_corrected(&image, &file, &[], &[data(0x1004, 0x1004)]).err(),
				analyze_data_corrected(&image, &file, &[], &[data(0x1004, 0x1000)]).err(),
				analyze_data_corrected(
					&image,
					&file,
					&[],
					&[data(0x1000, 0x1008), data(0x1004, 0x100C)]
				)
				.err(),
				analyze_data_corrected(
					&image,
					&file,
					&[],
					&[data(0x1004, 0x100C), data(0x1000, 0x1008)]
				)
				.err(),
				analyze_data_corrected(
					&image,
					&file,
					&[define(0x1005, None)],
					&[data(0x1004, 0x1009)]
				)
				.err(),
			),
			(
				Some(CorrectionConflict::EmptyDataRange {
					rva: 0x1004,
					end_rva: 0x1004,
				}),
				Some(CorrectionConflict::EmptyDataRange {
					rva: 0x1004,
					end_rva: 0x1000,
				}),
				Some(CorrectionConflict::OverlappingDataRanges {
					rva: 0x1004,
					overlaps: 0x1000,
				}),
				Some(CorrectionConflict::OverlappingDataRanges {
					rva: 0x1000,
					overlaps: 0x1004,
				}),
				Some(CorrectionConflict::DefineInsideDataRange {
					rva: 0x1005,
					range_rva: 0x1004,
				}),
			),
		);
	}

	#[test]
	fn a_refused_set_applies_nothing() {
		let (image, file) = image_with_code(NOP_LED_FUNCTION);

		// The first range would apply cleanly on its own; it must not, because
		// the set as a whole is not one an author could reproduce.
		let refused = analyze_data_corrected(
			&image,
			&file,
			&[],
			&[data(0x1004, 0x1009), data(0x1008, 0x1009)],
		);
		// Dropping only the offending range makes the same set apply, which is
		// what shows the refusal was about the conflict and not about the first
		// range being unacceptable on its own.
		let without = analyze_data_corrected(&image, &file, &[], &[data(0x1004, 0x1009)])
			.expect("the surviving range is fine on its own");

		assert_eq!(
			(
				matches!(
					refused,
					Err(CorrectionConflict::OverlappingDataRanges { rva: 0x1008, .. })
				),
				starts(&without),
			),
			(true, vec![(0x1000, FunctionSource::EntryPoint)]),
		);
		// Atomicity over an *open image* — a refused set leaving the previous
		// facts in place rather than emptying them — is `server-analysis`'s
		// `reanalyze`, not this crate's. Asserting it here by re-running
		// `analyze` would assert only that `analyze` is a pure function.
	}

	#[test]
	fn a_correction_set_that_changes_nothing_derives_exactly_what_analyze_does() {
		let (image, file) = image_with_code(CALL_OVER_PADDING);

		let baseline = analyze(&image, &file);
		// Deliberately *not* an empty set. An empty one is the same call as
		// `analyze` by construction and cannot fail, so it pins nothing. These
		// are real corrections that happen to bite on nothing: an undefine at
		// an address that holds no function, and a data range over bytes no
		// pass reaches. Both traverse the whole corrected path.
		let corrected =
			analyze_data_corrected(&image, &file, &[undefine(0x1fff)], &[data(0x1ff0, 0x1ff8)])
				.expect("no conflict");

		assert_eq!(format!("{corrected:?}"), format!("{baseline:?}"));
	}

	#[test]
	fn an_empty_correction_set_derives_exactly_what_analyze_does() {
		// Every existing caller reaches the detection path through the corrected
		// one, so an empty set has to be indistinguishable from no set at all.
		let code = &[
			0xE8, 0x03, 0x00, 0x00, 0x00, // call rel32 -> 0x1008
			0xC3, // ret
			0xCC, 0xCC, // padding
			0x48, 0x89, 0xD8, // mov rax,rbx at 0x1008
			0xC3, // ret
			0x90, // nop
			0x48, 0x89, 0xD8, // an unreferenced function for the sweep
			0xC3, // ret
			b'h', b'e', b'l', b'l', b'o', 0x00, // a string to scan
		];
		let (image, file) = image_with_code(code);

		let baseline = analyze(&image, &file);
		let corrected = analyze_corrected(&image, &file, &[]).expect("no conflict");

		assert_eq!(format!("{corrected:?}"), format!("{baseline:?}"));
	}
}
