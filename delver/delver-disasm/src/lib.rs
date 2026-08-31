//! x86/x64 disassembly for Delver.
//!
//! Wraps `iced-x86` behind a Delver-owned interface so the rest of the codebase
//! never depends on a specific decoder. Two rules shape the API:
//!
//! - **Structure is never recovered from text.** The formatted string is for
//!   the listing; the flow-control and target information is what
//!   `delver-analysis` builds xrefs from, and it comes from the decoder.
//!   Re-parsing formatted text to recover a branch target would be a parser on
//!   top of a parser. When a caller wants both, one pass yields both — see
//!   [`Disassembler::decode_count`]. When a caller wants only structure, it can
//!   say so ([`Disassembler::decode_facts_at`]) rather than paying for text it
//!   discards: whole-image analysis decodes millions of instructions and
//!   displays none of them.
//! - **Every decode starts from an anchor the caller vouches for.** x86 is
//!   variable-length and not self-synchronising, so decoding from an arbitrary
//!   offset yields plausible garbage. Nothing in this crate can tell an anchor
//!   from an offset — encoded bytes carry no boundary marks — so it does not
//!   claim to check one. The obligation sits with the caller and is discharged
//!   upstream: an anchor is a function seed, a section start, the end of an
//!   instruction this crate just decoded, or an address that
//!   `delver-analysis`'s `InstructionIndex` already records as a boundary. An
//!   address arriving from a user or the wire is resolved through that index
//!   (`ListingIndex::row_containing`) *before* it reaches a decode. The linear
//!   sweep is the one deliberate exception, and it marks everything it finds as
//!   a guess.
//!
//! All addresses are **RVAs**, matching `delver-format`.

#![warn(missing_docs)]
#![forbid(unsafe_code)]

use iced_x86::{
	ConstantOffsets, Decoder, DecoderOptions, Formatter, Instruction, IntelFormatter, OpKind,
};

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
	/// Call through a register or memory operand. The callee is not statically
	/// known from this instruction alone, but control returns to the following
	/// address just as it does for a direct call.
	IndirectCall,
	/// Branch through a register or memory operand — a jump-table dispatch or a
	/// tail call through a thunk. Neither the target nor a fallthrough is known.
	IndirectBranch,
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
			Self::Sequential
				| Self::ConditionalJump
				| Self::Call | Self::IndirectCall
				| Self::Interrupt
		)
	}

	/// Whether this instruction ends a basic block.
	///
	/// A call does not end a block, direct or indirect: control comes back to
	/// the following instruction. Only [`Self::ConditionalJump`] both ends a
	/// block and falls through; every other variant answers "does the next
	/// address belong to this block?" the same way here and in
	/// [`Self::falls_through`]. They must not drift apart — `control_flow`
	/// builds blocks from one and the corpus snapshot from the other, and two
	/// disagreeing answers would cut the same function into different blocks.
	pub fn terminates_block(self) -> bool {
		!matches!(
			self,
			Self::Sequential | Self::Call | Self::IndirectCall | Self::Interrupt
		)
	}
}

/// The longest an x86 instruction can be.
///
/// A decode window never needs more than this, so a caller holding a
/// multi-megabyte section can hand over a bounded slice.
pub const MAX_INSTRUCTION_LEN: usize = 15;

/// One instruction's structure, without formatted text.
///
/// This is what recursive descent and xref building actually consume. It is
/// `Copy` and allocation-free on purpose: analysis decodes every reachable
/// instruction in an image, and at that volume the two `String`s in
/// [`DecodedInstruction`] dominate the cost of the pass that discards them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstructionFacts {
	/// Address of the instruction, as an RVA.
	pub rva: u64,
	/// Encoded length in bytes.
	pub len: u32,
	/// How execution proceeds after this instruction.
	pub flow: FlowKind,
	/// Statically known branch or call target, as an RVA.
	pub branch_target: Option<u64>,
	/// Target of a RIP-relative memory operand, as an RVA.
	pub memory_target: Option<u64>,
	/// Immediate operand encoded in the instruction, zero-extended to 64 bits.
	///
	/// The *encoded* value, not a sign-extended interpretation of it: `cmp
	/// eax, -1` and `cmp eax, 0xFFFFFFFF` assemble to the same bytes and are
	/// the same fact, so both arrive here as `0xFFFFFFFF` and a search for
	/// either finds both. [`Self::immediate_width`] says how many bits were
	/// actually encoded, which is what makes that value interpretable.
	///
	/// Branch displacements are deliberately absent: a `call` or `jmp` encodes
	/// a target, not a constant, and it is already reported as
	/// [`Self::branch_target`]. Reporting it twice would make a search for the
	/// number 0x1000 match every jump that happens to land there.
	pub immediate: Option<u64>,
	/// Encoded width of [`Self::immediate`] in bits — 8, 16, 32 or 64.
	pub immediate_width: Option<u32>,
}

impl InstructionFacts {
	/// Exclusive end of the instruction.
	pub fn end_rva(&self) -> u64 {
		self.rva.saturating_add(self.len as u64)
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
	/// Immediate operand, as encoded. See [`InstructionFacts::immediate`].
	pub immediate: Option<u64>,
	/// Encoded width of [`Self::immediate`] in bits.
	pub immediate_width: Option<u32>,
	/// Encoded address-bearing fields that a relocation-stable byte signature
	/// should mask.
	pub signature_fields: Vec<SignatureField>,
}

/// Why bytes inside one instruction are unstable as a reusable signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignatureFieldKind {
	/// Relative immediate used by a direct branch or call.
	RelativeBranch,
	/// Displacement used by RIP/EIP-relative memory addressing.
	IpRelativeMemory,
}

/// One exact byte range inside an encoded instruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignatureField {
	/// Zero-based byte offset from the instruction start.
	pub offset: u32,
	/// Number of encoded bytes in the field.
	pub len: u32,
	/// Semantic reason these bytes are unstable.
	pub kind: SignatureFieldKind,
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
	/// real instruction boundary — a function seed, a section start, an address
	/// held by the instruction index, or the end of a previously decoded
	/// instruction. Nothing here can verify that; see the module docs for who
	/// owes the guarantee.
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

	/// Decodes the structure of the single instruction at `anchor_rva`.
	///
	/// Returns `None` when nothing decodes there. The caller must vouch for
	/// `anchor_rva` being a real boundary, exactly as for [`Self::decode_from`];
	/// this skips the formatter, not the anchoring rule.
	pub fn decode_facts_at(&self, anchor_rva: u64, bytes: &[u8]) -> Option<InstructionFacts> {
		// One instruction can never need more than `MAX_INSTRUCTION_LEN` bytes,
		// and callers routinely pass the rest of a section.
		let window = &bytes[..bytes.len().min(MAX_INSTRUCTION_LEN)];
		let mut decoder = Decoder::with_ip(
			self.bitness.bits(),
			window,
			anchor_rva,
			DecoderOptions::NONE,
		);
		if !decoder.can_decode() {
			return None;
		}

		let mut instruction = Instruction::default();
		decoder.decode_out(&mut instruction);
		Some(facts(&instruction))
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
			let constant_offsets = decoder.get_constant_offsets(&instruction);
			out.push(convert(&instruction, constant_offsets, &mut formatter));
		}
		out
	}
}

fn convert(
	instruction: &Instruction,
	constant_offsets: ConstantOffsets,
	formatter: &mut IntelFormatter,
) -> DecodedInstruction {
	let mut text = String::new();
	formatter.format(instruction, &mut text);

	// iced formats "mnemonic operands" as one string; split on the first space
	// so the listing can render the columns independently.
	let (mnemonic, operands) = match text.find(' ') {
		Some(idx) => (text[..idx].to_string(), text[idx + 1..].trim().to_string()),
		None => (text, String::new()),
	};

	let facts = facts(instruction);

	DecodedInstruction {
		rva: facts.rva,
		len: facts.len,
		mnemonic,
		operands,
		flow: facts.flow,
		branch_target: facts.branch_target,
		memory_target: facts.memory_target,
		immediate: facts.immediate,
		immediate_width: facts.immediate_width,
		signature_fields: signature_fields(instruction, facts.flow, constant_offsets),
	}
}

fn signature_fields(
	instruction: &Instruction,
	flow: FlowKind,
	offsets: ConstantOffsets,
) -> Vec<SignatureField> {
	let mut fields = Vec::with_capacity(2);
	if matches!(
		flow,
		FlowKind::Jump | FlowKind::ConditionalJump | FlowKind::Call
	) {
		if offsets.has_immediate() {
			fields.push(SignatureField {
				offset: offsets.immediate_offset() as u32,
				len: offsets.immediate_size() as u32,
				kind: SignatureFieldKind::RelativeBranch,
			});
		}
		if offsets.has_immediate2() {
			fields.push(SignatureField {
				offset: offsets.immediate_offset2() as u32,
				len: offsets.immediate_size2() as u32,
				kind: SignatureFieldKind::RelativeBranch,
			});
		}
	}
	if instruction.is_ip_rel_memory_operand() && offsets.has_displacement() {
		fields.push(SignatureField {
			offset: offsets.displacement_offset() as u32,
			len: offsets.displacement_size() as u32,
			kind: SignatureFieldKind::IpRelativeMemory,
		});
	}
	fields
}

/// Extracts everything about an instruction that is not its display text.
///
/// Shared by both decode paths so the two can never disagree about where a
/// branch goes.
fn facts(instruction: &Instruction) -> InstructionFacts {
	let flow = flow_kind(instruction);
	let branch_target = if matches!(
		flow,
		FlowKind::Jump | FlowKind::ConditionalJump | FlowKind::Call
	) && matches!(
		instruction.op0_kind(),
		OpKind::NearBranch16 | OpKind::NearBranch32 | OpKind::NearBranch64
	) {
		Some(instruction.near_branch_target())
	} else {
		None
	};
	let memory_target = if instruction.is_ip_rel_memory_operand() {
		Some(instruction.ip_rel_memory_address())
	} else {
		None
	};

	let (immediate, immediate_width) = immediate_operand(instruction);

	InstructionFacts {
		rva: instruction.ip(),
		len: instruction.len() as u32,
		flow,
		branch_target,
		memory_target,
		immediate,
		immediate_width,
	}
}

/// The immediate an instruction encodes, and how wide it was encoded.
///
/// Returns the first immediate operand. x86 encodes at most one except for
/// `enter`, which is rare enough that taking the first is the honest simple
/// rule rather than a silent choice between two.
///
/// The value is what the bytes hold, zero-extended. iced sign-extends the
/// smaller forms into `immediate32to64` and friends; taking the raw operand
/// keeps `cmp eax, -1` and `cmp eax, 0xFFFFFFFF` identical, which they are.
fn immediate_operand(instruction: &Instruction) -> (Option<u64>, Option<u32>) {
	for index in 0..instruction.op_count() {
		let (value, width) = match instruction.op_kind(index) {
			OpKind::Immediate8 => (instruction.immediate8() as u64, 8),
			OpKind::Immediate8_2nd => (instruction.immediate8_2nd() as u64, 8),
			OpKind::Immediate16 => (instruction.immediate16() as u64, 16),
			OpKind::Immediate32 => (instruction.immediate32() as u64, 32),
			OpKind::Immediate64 => (instruction.immediate64(), 64),
			// The sign-extending forms encode a narrow field and mean a wide
			// value. The encoded field is the fact, so it is reported at its
			// encoded width; sign-extension is an interpretation a caller can
			// apply and this layer must not bake in.
			OpKind::Immediate8to16 => (instruction.immediate8() as u64, 8),
			OpKind::Immediate8to32 => (instruction.immediate8() as u64, 8),
			OpKind::Immediate8to64 => (instruction.immediate8() as u64, 8),
			OpKind::Immediate32to64 => (instruction.immediate32() as u64, 32),
			_ => continue,
		};
		return (Some(value), Some(width));
	}
	(None, None)
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
		FlowControl::IndirectCall => FlowKind::IndirectCall,
		FlowControl::IndirectBranch => FlowKind::IndirectBranch,
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
	fn an_immediate_is_reported_as_encoded_at_its_encoded_width() {
		let disasm = Disassembler::new(Bitness::Bits64);
		// mov eax,0xdeadbeef | cmp eax,0xffffffff | add rax,1 | ret
		let code: &[u8] = &[
			0xB8, 0xEF, 0xBE, 0xAD, 0xDE,
			0x3D, 0xFF, 0xFF, 0xFF, 0xFF,
			0x48, 0x83, 0xC0, 0x01,
			0xC3,
		];

		let decoded: Vec<_> = disasm
			.decode_from(0x1000, code)
			.into_iter()
			.map(|instruction| (instruction.immediate, instruction.immediate_width))
			.collect();

		assert_eq!(
			decoded,
			vec![
				(Some(0xDEAD_BEEF), Some(32)),
				// `cmp eax, -1` assembles to exactly these bytes. Reporting the
				// encoded 0xFFFFFFFF rather than a sign-extended -1 is what
				// makes a search for either value find this instruction.
				(Some(0xFFFF_FFFF), Some(32)),
				// 0x83 encodes an 8-bit field that means a 64-bit value. The
				// encoded field is the fact; sign-extension is an
				// interpretation a caller applies.
				(Some(1), Some(8)),
				(None, None),
			]
		);
	}

	#[test]
	fn a_branch_displacement_is_a_target_and_not_an_immediate() {
		// Searching for the constant 0x1005 must not match every jump that
		// lands there — a branch encodes a destination, not a number.
		let disasm = Disassembler::new(Bitness::Bits64);
		let code: &[u8] = &[0xEB, 0x03, 0x90, 0x90, 0x90, 0xC3];

		let first = &disasm.decode_from(0x1000, code)[0];

		assert_eq!(
			(first.immediate, first.branch_target),
			(None, Some(0x1005))
		);
	}

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
		assert_eq!(
			decoded[0].signature_fields,
			vec![SignatureField {
				offset: 1,
				len: 4,
				kind: SignatureFieldKind::RelativeBranch,
			}]
		);
	}

	#[test]
	fn system_and_far_calls_do_not_invent_a_near_target() {
		let system =
			Disassembler::new(Bitness::Bits64).decode_from(0x1000, &[0x0F, 0x05, 0x0F, 0x34]);
		// CALL FAR 0x9abc:0x12345678. The segmented target cannot be represented
		// as an RVA and must not collapse to RVA 0.
		let far_call = Disassembler::new(Bitness::Bits32)
			.decode_from(0x2000, &[0x9A, 0x78, 0x56, 0x34, 0x12, 0xBC, 0x9A]);

		assert_eq!(
			system
				.iter()
				.map(|instruction| (&*instruction.mnemonic, instruction.branch_target))
				.collect::<Vec<_>>(),
			vec![("syscall", None), ("sysenter", None)]
		);
		assert_eq!(far_call[0].branch_target, None);
	}

	#[test]
	fn resolves_a_rip_relative_memory_target() {
		// mov rax,[rip+0x10] at 0x2000; 7 bytes, so the target is 0x2017.
		let bytes = &[0x48, 0x8B, 0x05, 0x10, 0x00, 0x00, 0x00];
		let disasm = Disassembler::new(Bitness::Bits64);
		let decoded = disasm.decode_from(0x2000, bytes);

		assert_eq!(decoded[0].memory_target, Some(0x2017));
		assert_eq!(decoded[0].branch_target, None);
		assert_eq!(
			decoded[0].signature_fields,
			vec![SignatureField {
				offset: 3,
				len: 4,
				kind: SignatureFieldKind::IpRelativeMemory,
			}]
		);
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
	fn indirect_calls_and_indirect_branches_are_classified_apart() {
		let disasm = Disassembler::new(Bitness::Bits64);
		// call rax at 0x1000, then jmp rax at 0x1002.
		let decoded = disasm.decode_from(0x1000, &[0xFF, 0xD0, 0xFF, 0xE0]);

		assert_eq!(
			decoded
				.iter()
				.map(|instruction| (
					instruction.flow,
					instruction.flow.falls_through(),
					instruction.branch_target
				))
				.collect::<Vec<_>>(),
			// An indirect call returns to the following instruction, so descent
			// must continue past it; an indirect branch never comes back.
			vec![
				(FlowKind::IndirectCall, true, None),
				(FlowKind::IndirectBranch, false, None),
			]
		);
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
	fn decoding_from_a_mid_instruction_offset_yields_plausible_garbage() {
		// Why the anchoring rule exists, and why this crate cannot enforce it:
		// one byte into `mov rax,rbx` decodes cleanly into different, entirely
		// wrong instructions. Nothing in the bytes marks the boundary, so the
		// caller has to supply one it can justify.
		let disasm = Disassembler::new(Bitness::Bits64);
		let anchored = disasm.decode_from(0x1000, SIMPLE);
		let unanchored = disasm.decode_from(0x1001, &SIMPLE[1..]);

		// Both decode cleanly and neither reports a problem. Only the anchor
		// distinguishes them, and the anchor is not in the bytes.
		assert_eq!(
			(
				anchored[0].len,
				anchored[0].flow,
				unanchored[0].len,
				unanchored[0].flow,
			),
			(3, FlowKind::Sequential, 2, FlowKind::Sequential),
		);
		assert_ne!(
			anchored[0].text(),
			unanchored[0].text(),
			"a mid-instruction decode must not be mistaken for the real one"
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
