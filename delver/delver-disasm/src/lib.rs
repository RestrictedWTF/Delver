//! x86/x64 disassembly for Delver.
//!
//! Wraps `iced-x86` behind a Delver-owned interface so the rest of the codebase
//! never depends on a specific decoder. Two rules shape the API:
//!
//! - **One decode pass yields text *and* structure.** The formatted string is
//!   for the listing; the structured flow-control and target information is
//!   what `delver-analysis` builds xrefs from. Re-parsing formatted text to
//!   recover a branch target would be a parser on top of a parser.
//! - **Decoding never starts mid-instruction on its own authority.** x86 is
//!   variable-length and not self-synchronising, so decoding from an arbitrary
//!   offset yields plausible garbage. Callers supply an anchor they vouch for.
//!
//! All addresses are **RVAs**, matching `delver-format`.

#![warn(missing_docs)]
#![forbid(unsafe_code)]

use iced_x86::{Decoder, DecoderOptions, Formatter, Instruction, IntelFormatter};

/// Target architecture width. No default — a 32-bit image decoded as 64-bit
/// produces confident nonsense, which is the worst failure mode available.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bitness {
	/// 32-bit x86.
	Bits32,
	/// 64-bit x86-64.
	Bits64,
}

impl Bitness {
	/// Maps a `delver-format` architecture string, if it is one we can decode.
	pub fn from_arch(arch: &str) -> Option<Self> {
		match arch {
			"I386" | "X86" | "x86" => Some(Self::Bits32),
			"X86_64" | "Amd64" | "x86_64" => Some(Self::Bits64),
			_ => None,
		}
	}

	fn bits(self) -> u32 {
		match self {
			Self::Bits32 => 32,
			Self::Bits64 => 64,
		}
	}
}

/// How execution proceeds after an instruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowKind {
	/// Falls through to the next instruction.
	Sequential,
	/// Unconditional direct branch.
	Jump,
	/// Conditional branch: both the target and the fallthrough are reachable.
	ConditionalJump,
	/// Direct call.
	Call,
	/// Branch or call through a register or memory operand. The target is not
	/// statically known from this instruction alone.
	Indirect,
	/// Returns from the current function.
	Return,
	/// Interrupt or syscall.
	Interrupt,
	/// Not a valid instruction.
	Invalid,
}

impl FlowKind {
	/// Whether execution can continue at the following address.
	///
	/// Recursive descent relies on this: falling through past a `ret` or an
	/// unconditional `jmp` is how a linear sweep invents functions that do not
	/// exist.
	pub fn falls_through(self) -> bool {
		matches!(
			self,
			Self::Sequential | Self::ConditionalJump | Self::Call | Self::Interrupt
		)
	}

	/// Whether this instruction ends a basic block.
	pub fn terminates_block(self) -> bool {
		!matches!(self, Self::Sequential | Self::Call | Self::Interrupt)
	}
}

/// One decoded instruction.
#[derive(Debug, Clone)]
pub struct DecodedInstruction {
	/// Address of the instruction, as an RVA.
	pub rva: u64,
	/// Encoded length in bytes.
	pub len: u32,
	/// Formatted mnemonic, e.g. `mov`.
	pub mnemonic: String,
	/// Formatted operands, e.g. `rax,rbx`. Empty when there are none.
	pub operands: String,
	/// How execution proceeds after this instruction.
	pub flow: FlowKind,
	/// Statically known branch or call target, as an RVA. Absent for indirect
	/// and non-branching instructions.
	pub branch_target: Option<u64>,
	/// Target of a RIP-relative memory operand, as an RVA. This is how data
	/// references are recovered on x64.
	pub memory_target: Option<u64>,
}

impl DecodedInstruction {
	/// Exclusive end of the instruction.
	pub fn end_rva(&self) -> u64 {
		self.rva.saturating_add(self.len as u64)
	}

	/// Display text, mnemonic and operands joined.
	pub fn text(&self) -> String {
		if self.operands.is_empty() {
			self.mnemonic.clone()
		} else {
			format!("{} {}", self.mnemonic, self.operands)
		}
	}
}

/// Why a decode request could not be served as asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
	/// The requested address is not an instruction boundary the caller vouched
	/// for. Carries the supplied anchor so the caller can decide whether to
	/// decode forward from it, rather than being handed a guess.
	UnanchoredAddress {
		/// The address that was requested.
		requested: u64,
		/// The nearest anchor at or below it.
		anchor: u64,
	},
}

/// Decodes instructions from a byte window.
pub struct Disassembler {
	bitness: Bitness,
}

impl Disassembler {
	/// Creates a disassembler for `bitness`.
	pub fn new(bitness: Bitness) -> Self {
		Self { bitness }
	}

	/// The architecture this disassembler decodes.
	pub fn bitness(&self) -> Bitness {
		self.bitness
	}

	/// Decodes forward from `anchor_rva` until `bytes` is exhausted.
	///
	/// `bytes` must begin exactly at `anchor_rva`, and `anchor_rva` must be a
	/// real instruction boundary — a function seed, a section start, or the end
	/// of a previously decoded instruction. See [`Self::decode_at`].
	pub fn decode_from(&self, anchor_rva: u64, bytes: &[u8]) -> Vec<DecodedInstruction> {
		self.decode_bounded(anchor_rva, bytes, usize::MAX)
	}

	/// Decodes forward from `anchor_rva`, returning at most `count`
	/// instructions.
	///
	/// The listing needs a bounded number of rows rather than however many
	/// happen to fit in a byte window.
	pub fn decode_count(
		&self,
		anchor_rva: u64,
		bytes: &[u8],
		count: usize,
	) -> Vec<DecodedInstruction> {
		self.decode_bounded(anchor_rva, bytes, count)
	}

	/// Decodes a window that starts at `requested_rva`.
	///
	/// Succeeds only when `requested_rva` equals `anchor_rva`; otherwise it
	/// reports [`DecodeError::UnanchoredAddress`] rather than decoding from a
	/// position it cannot justify.
	pub fn decode_at(
		&self,
		requested_rva: u64,
		anchor_rva: u64,
		bytes: &[u8],
	) -> Result<Vec<DecodedInstruction>, DecodeError> {
		if requested_rva != anchor_rva {
			return Err(DecodeError::UnanchoredAddress {
				requested: requested_rva,
				anchor: anchor_rva,
			});
		}
		Ok(self.decode_from(anchor_rva, bytes))
	}

	fn decode_bounded(
		&self,
		anchor_rva: u64,
		bytes: &[u8],
		limit: usize,
	) -> Vec<DecodedInstruction> {
		let mut decoder =
			Decoder::with_ip(self.bitness.bits(), bytes, anchor_rva, DecoderOptions::NONE);
		let mut formatter = IntelFormatter::new();
		let mut instruction = Instruction::default();
		let mut out = Vec::new();

		while out.len() < limit && decoder.can_decode() {
			decoder.decode_out(&mut instruction);
			out.push(convert(&instruction, &mut formatter));
		}
		out
	}
}

fn convert(instruction: &Instruction, formatter: &mut IntelFormatter) -> DecodedInstruction {
	let mut text = String::new();
	formatter.format(instruction, &mut text);

	// iced formats "mnemonic operands" as one string; split on the first space
	// so the listing can render the columns independently.
	let (mnemonic, operands) = match text.find(' ') {
		Some(idx) => (text[..idx].to_string(), text[idx + 1..].trim().to_string()),
		None => (text, String::new()),
	};

	let flow = flow_kind(instruction);
	let branch_target = match flow {
		FlowKind::Jump | FlowKind::ConditionalJump | FlowKind::Call => {
			Some(instruction.near_branch_target())
		}
		_ => None,
	};
	let memory_target = if instruction.is_ip_rel_memory_operand() {
		Some(instruction.ip_rel_memory_address())
	} else {
		None
	};

	DecodedInstruction {
		rva: instruction.ip(),
		len: instruction.len() as u32,
		mnemonic,
		operands,
		flow,
		branch_target,
		memory_target,
	}
}

fn flow_kind(instruction: &Instruction) -> FlowKind {
	use iced_x86::FlowControl;

	if instruction.is_invalid() {
		return FlowKind::Invalid;
	}
	match instruction.flow_control() {
		FlowControl::Next => FlowKind::Sequential,
		FlowControl::UnconditionalBranch => FlowKind::Jump,
		FlowControl::ConditionalBranch => FlowKind::ConditionalJump,
		FlowControl::Call => FlowKind::Call,
		FlowControl::IndirectBranch | FlowControl::IndirectCall => FlowKind::Indirect,
		FlowControl::Return => FlowKind::Return,
		FlowControl::Interrupt => FlowKind::Interrupt,
		FlowControl::Exception => FlowKind::Invalid,
		FlowControl::XbeginXabortXend => FlowKind::Sequential,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// `mov rax,rbx` / `add rax,1` / `ret`
	const SIMPLE: &[u8] = &[0x48, 0x89, 0xD8, 0x48, 0x83, 0xC0, 0x01, 0xC3];

	#[test]
	fn decodes_text_and_lengths() {
		let disasm = Disassembler::new(Bitness::Bits64);
		let decoded = disasm.decode_from(0x1000, SIMPLE);

		let summary: Vec<_> = decoded.iter().map(|i| (i.rva, i.len, i.text())).collect();

		assert_eq!(
			summary,
			vec![
				(0x1000, 3, "mov rax,rbx".to_string()),
				(0x1003, 4, "add rax,1".to_string()),
				(0x1007, 1, "ret".to_string()),
			]
		);
	}

	#[test]
	fn resolves_a_relative_call_target() {
		// e8 rel32 at 0x1000; the instruction is 5 bytes, so +0x10 lands at 0x1015.
		let bytes = &[0xE8, 0x10, 0x00, 0x00, 0x00];
		let disasm = Disassembler::new(Bitness::Bits64);
		let decoded = disasm.decode_from(0x1000, bytes);

		assert_eq!(decoded[0].flow, FlowKind::Call);
		assert_eq!(decoded[0].branch_target, Some(0x1015));
	}

	#[test]
	fn resolves_a_rip_relative_memory_target() {
		// mov rax,[rip+0x10] at 0x2000; 7 bytes, so the target is 0x2017.
		let bytes = &[0x48, 0x8B, 0x05, 0x10, 0x00, 0x00, 0x00];
		let disasm = Disassembler::new(Bitness::Bits64);
		let decoded = disasm.decode_from(0x2000, bytes);

		assert_eq!(decoded[0].memory_target, Some(0x2017));
		assert_eq!(decoded[0].branch_target, None);
	}

	#[test]
	fn flow_kinds_drive_fallthrough_and_block_termination() {
		let disasm = Disassembler::new(Bitness::Bits64);
		let decoded = disasm.decode_from(0x1000, SIMPLE);

		assert!(decoded[0].flow.falls_through());
		assert!(!decoded[0].flow.terminates_block());

		let ret = decoded.last().expect("decoded instructions");
		assert_eq!(ret.flow, FlowKind::Return);
		assert!(!ret.flow.falls_through());
		assert!(ret.flow.terminates_block());
	}

	#[test]
	fn same_bytes_decode_differently_per_bitness() {
		// 0x48 is a REX prefix on x64 but `dec eax` on x86 — the clearest
		// demonstration of why bitness must never have a default.
		let bytes = &[0x48, 0x89, 0xD8];

		let as64 = Disassembler::new(Bitness::Bits64).decode_from(0, bytes);
		let as32 = Disassembler::new(Bitness::Bits32).decode_from(0, bytes);

		assert_eq!(as64[0].text(), "mov rax,rbx");
		assert_eq!(as32[0].text(), "dec eax");
		assert_ne!(as64.len(), as32.len());
	}

	#[test]
	fn window_boundary_agrees_with_a_single_pass() {
		let disasm = Disassembler::new(Bitness::Bits64);
		let whole = disasm.decode_from(0x1000, SIMPLE);

		// Decode one instruction, then resume from its end — the only anchor a
		// caller is entitled to vouch for.
		let first = disasm.decode_count(0x1000, SIMPLE, 1);
		let resume_at = first[0].end_rva();
		let offset = (resume_at - 0x1000) as usize;
		let rest = disasm.decode_from(resume_at, &SIMPLE[offset..]);

		let joined: Vec<_> = first
			.iter()
			.chain(rest.iter())
			.map(|i| (i.rva, i.text()))
			.collect();
		let expected: Vec<_> = whole.iter().map(|i| (i.rva, i.text())).collect();

		assert_eq!(joined, expected);
	}

	#[test]
	fn unanchored_address_is_refused_rather_than_guessed() {
		let disasm = Disassembler::new(Bitness::Bits64);
		let err = disasm
			.decode_at(0x1001, 0x1000, SIMPLE)
			.expect_err("decoding mid-instruction must not silently succeed");

		assert_eq!(
			err,
			DecodeError::UnanchoredAddress {
				requested: 0x1001,
				anchor: 0x1000
			}
		);
	}

	#[test]
	fn decode_count_bounds_the_result() {
		let disasm = Disassembler::new(Bitness::Bits64);
		assert_eq!(disasm.decode_count(0x1000, SIMPLE, 2).len(), 2);
		assert_eq!(disasm.decode_count(0x1000, SIMPLE, 99).len(), 3);
	}

	#[test]
	fn bitness_maps_from_delver_format_arch_strings() {
		assert_eq!(Bitness::from_arch("X86_64"), Some(Bitness::Bits64));
		assert_eq!(Bitness::from_arch("I386"), Some(Bitness::Bits32));
		assert_eq!(Bitness::from_arch("Aarch64"), None);
	}

	#[test]
	fn truncated_instruction_decodes_as_invalid() {
		// A lone REX prefix cannot form a complete instruction.
		let disasm = Disassembler::new(Bitness::Bits64);
		let decoded = disasm.decode_from(0x1000, &[0x48]);
		assert_eq!(decoded[0].flow, FlowKind::Invalid);
	}
}
