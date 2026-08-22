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

#![warn(missing_docs)]
#![forbid(unsafe_code)]

pub mod index;
pub mod strings;
pub mod xrefs;

use std::collections::BTreeMap;

use delver_disasm::{Bitness, Disassembler, FlowKind};
use delver_format::{ParsedImage, SeedSource};

mod state;
use state::RvaState;

pub use index::InstructionIndex;
pub use strings::{FoundString, StringEncoding, StringScan};
pub use xrefs::{Xref, XrefKind, XrefTable};

/// Where a function start came from, most authoritative first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum FunctionSource {
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
	/// Whether the image itself vouches for this boundary.
	///
	/// `CallTarget` counts: something in the image calls the address, which is
	/// strong evidence. `LinearSweep` does not.
	pub fn is_authoritative(self) -> bool {
		!matches!(self, Self::LinearSweep)
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
}

/// Everything derived from one image.
#[derive(Debug, Clone, Default)]
pub struct AnalyzedImage {
	/// Every decoded instruction boundary.
	pub instructions: InstructionIndex,
	/// Detected functions, sorted by address.
	pub functions: Vec<Function>,
	/// Cross-references in both directions.
	pub xrefs: XrefTable,
	/// Strings found in the image.
	pub strings: Vec<FoundString>,
	/// Whether the string scan hit its cap and dropped results.
	pub strings_truncated: bool,
}

/// Analyses `image`, reading code from `file`.
///
/// Returns an empty analysis for architectures the disassembler does not
/// support, rather than guessing.
pub fn analyze(image: &ParsedImage, file: &[u8]) -> AnalyzedImage {
	let scan = strings::find_strings(image, file);

	let Some(bitness) = Bitness::from_arch(&image.arch) else {
		return AnalyzedImage {
			strings: scan.strings,
			strings_truncated: scan.truncated,
			..Default::default()
		};
	};

	let disasm = Disassembler::new(bitness);
	let mut state = Descent::new(&disasm, image, file);

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

	let (instructions, functions, xrefs) = state.finish();
	AnalyzedImage {
		instructions,
		functions,
		xrefs,
		strings: scan.strings,
		strings_truncated: scan.truncated,
	}
}

/// Walks control flow from a worklist of addresses.
struct Descent<'a> {
	disasm: &'a Disassembler,
	image: &'a ParsedImage,
	file: &'a [u8],
	/// Which addresses have been walked, and where instructions start.
	state: RvaState,
	/// Best-known source per function address.
	functions: BTreeMap<u64, (Option<u64>, FunctionSource)>,
	xrefs: Vec<Xref>,
	queue: Vec<u64>,
}

impl<'a> Descent<'a> {
	fn new(disasm: &'a Disassembler, image: &'a ParsedImage, file: &'a [u8]) -> Self {
		Self {
			disasm,
			image,
			file,
			state: RvaState::new(image),
			functions: BTreeMap::new(),
			xrefs: Vec::new(),
			queue: Vec::new(),
		}
	}

	fn add_function(&mut self, rva: u64, end_rva: Option<u64>, source: FunctionSource) {
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
			if !self.state.visit(rva) {
				return; // already walked this path
			}
			let Some(bytes) = self.image.bytes_at(self.file, rva) else {
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

			self.state.set_instruction(instruction.rva, instruction.len);

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
		let authoritative_ranges: Vec<_> = self
			.functions
			.iter()
			.filter_map(|(&start, &(end, source))| {
				(source.is_authoritative())
					.then_some(end.map(|end| (start, end)))
					.flatten()
			})
			.collect();
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

				let Some(bytes) = self.image.bytes_at(self.file, rva) else {
					break;
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

	fn finish(self) -> (InstructionIndex, Vec<Function>, XrefTable) {
		let instructions = InstructionIndex::from_pairs(self.state.instructions());

		let functions = self
			.functions
			.into_iter()
			.map(|(rva, (end_rva, source))| Function {
				rva,
				end_rva,
				source,
			})
			.collect();

		(instructions, functions, XrefTable::new(self.xrefs))
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use delver_format::{FunctionSeed, Section};

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
			}],
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
	fn an_unsupported_architecture_yields_no_guesses() {
		let (mut image, file) = image_with_code(&[0xC3]);
		image.arch = "Aarch64".to_string();

		let analysis = analyze(&image, &file);
		assert!(analysis.instructions.is_empty());
		assert!(analysis.functions.is_empty());
		assert!(analysis.xrefs.is_empty());
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
}
