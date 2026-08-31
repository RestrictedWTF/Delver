//! The corpus samples.
//!
//! Each sample targets a specific behaviour worth locking down. Adding a
//! sample means adding a case here and regenerating snapshots; the snapshot
//! diff is what turns it into a regression test.

use crate::pe_builder::{Machine, PeBuilder};

/// One named corpus sample.
pub struct Sample {
	/// Stable identifier, also the snapshot filename stem.
	pub name: &'static str,
	/// What this sample exists to pin down.
	pub covers: &'static str,
	/// The generated image bytes.
	pub bytes: Vec<u8>,
}

/// `mov rax,rbx` / `add rax,1` / `ret`
const X64_PROLOGUE: &[u8] = &[0x48, 0x89, 0xD8, 0x48, 0x83, 0xC0, 0x01, 0xC3];

/// `call +0x10` / `jmp +2` / `nop` / `nop` / `ret`
const X64_CONTROL_FLOW: &[u8] = &[
	0xE8, 0x10, 0x00, 0x00, 0x00, // call rel32
	0xEB, 0x02, // jmp short
	0x90, 0x90, // nop, nop
	0xC3, // ret
];

/// `mov eax,ebx` / `ret`
const X86_PROLOGUE: &[u8] = &[0x89, 0xD8, 0xC3];

/// `ret`, alignment padding, then a function nothing calls.
///
/// Only a linear sweep reaches `0x1004`, so it must be recorded as a guess.
const X64_UNREACHABLE: &[u8] = &[
	0xC3, // 0x1000 ret
	0xCC, 0xCC, 0xCC, // padding
	0x48, 0x89, 0xD8, // 0x1004 mov rax,rbx
	0xC3, // 0x1007 ret
];

/// `call` / `ret`, immediately followed by non-code.
///
/// Descent must stop at the `ret`. Decoding the bytes after it would attribute
/// data to the entry function and invent instructions that never execute.
const X64_RET_THEN_DATA: &[u8] = &[
	0xE8, 0x06, 0x00, 0x00, 0x00, // 0x1000 call -> 0x100B
	0xC3, // 0x1005 ret
	0xDE, 0xAD, 0xBE, 0xEF, 0xFE, // 0x1006 data, not code
	0x48, 0x89, 0xD8, // 0x100B mov rax,rbx
	0xC3, // 0x100E ret
];

/// Immediates at three encoded widths, plus a branch whose displacement is not one.
///
/// The rel8 displacement is deliberately `0x01`, the same field value as the
/// `add rax,1` above it: if displacements ever leaked into the immediate facts,
/// a search for the number 1 would return this jump as well.
const X64_IMMEDIATE_WIDTHS: &[u8] = &[
	0xB0, 0x2A, // 0x1000 mov al,0x2A          imm8
	0xB9, 0x78, 0x56, 0x34, 0x12, // 0x1002 mov ecx,0x12345678   imm32
	0x48, 0x83, 0xC0, 0x01, // 0x1007 add rax,1            sign-extended imm8
	0x83, 0xF8, 0xFF, // 0x100B cmp eax,-1           imm8, both readings
	0xEB, 0x01, // 0x100E jmp 0x1011           displacement, not an immediate
	0xCC, // 0x1010 padding
	0xC3, // 0x1011 ret
];

/// Builds every sample in the corpus.
pub fn all_samples() -> Vec<Sample> {
	vec![
		Sample {
			name: "x64-minimal",
			covers: "section layout, entry point, RVA-relative addressing",
			bytes: PeBuilder::new(Machine::Amd64)
				.code(X64_PROLOGUE)
				.entry(0x1000)
				.build(),
		},
		Sample {
			name: "x64-exception-directory",
			covers: "exception directory as the authoritative function-seed source",
			bytes: PeBuilder::new(Machine::Amd64)
				.code(X64_CONTROL_FLOW)
				.entry(0x1000)
				.runtime_function(0x1000, 0x1005)
				.runtime_function(0x1005, 0x100A)
				.build(),
		},
		Sample {
			name: "x64-chained-unwind",
			covers: "chained RUNTIME_FUNCTION fragments are not function starts",
			bytes: PeBuilder::new(Machine::Amd64)
				.code(X64_CONTROL_FLOW)
				.entry(0x1000)
				.runtime_function(0x1000, 0x1005)
				.runtime_function_fragment(0x1005, 0x100A, 0x1000)
				.build(),
		},
		Sample {
			name: "x64-imports",
			covers: "import descriptors, IAT RVAs, and multi-module ordering",
			bytes: PeBuilder::new(Machine::Amd64)
				.code(X64_PROLOGUE)
				.entry(0x1000)
				.import("KERNEL32.dll", "ExitProcess")
				.import("KERNEL32.dll", "GetLastError")
				.import("USER32.dll", "MessageBoxW")
				.build(),
		},
		Sample {
			name: "x64-unreachable-function",
			covers: "linear sweep finds a function nothing references, at lower confidence",
			bytes: PeBuilder::new(Machine::Amd64)
				.code(X64_UNREACHABLE)
				.entry(0x1000)
				.build(),
		},
		Sample {
			name: "x64-no-fallthrough-past-ret",
			covers: "recursive descent stops at a ret instead of decoding the bytes after it",
			bytes: PeBuilder::new(Machine::Amd64)
				.code(X64_RET_THEN_DATA)
				.entry(0x1000)
				.build(),
		},
		Sample {
			name: "x64-immediate-widths",
			covers: "immediates recorded at the width they were encoded at, and branch displacements excluded",
			bytes: PeBuilder::new(Machine::Amd64)
				.code(X64_IMMEDIATE_WIDTHS)
				.entry(0x1000)
				.build(),
		},
		Sample {
			name: "x86-minimal",
			covers: "32-bit layout, and that x86 yields no exception-directory seeds",
			bytes: PeBuilder::new(Machine::I386)
				.code(X86_PROLOGUE)
				.entry(0x1000)
				.build(),
		},
	]
}
