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

/// Three 16-byte-spaced function bodies, for the RTTI samples.
///
/// Spaced so a method's *interior* has a stable RVA a trailing pointer can aim
/// at: `0x1004` and `0x1014` are both four bytes into an eight-byte body.
const X64_VIRTUAL_METHODS: &[u8] = &[
	0x48, 0x89, 0xD8, 0x48, 0x83, 0xC0, 0x01, 0xC3, // 0x1000 mov rax,rbx / add rax,1 / ret
	0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, // padding
	0x48, 0x89, 0xD8, 0x48, 0x83, 0xC0, 0x02, 0xC3, // 0x1010 mov rax,rbx / add rax,2 / ret
	0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, // padding
	0x31, 0xC0, 0xC3, // 0x1020 xor eax,eax / ret
];

/// A `call` whose displacement lands outside the image, then a `ret`.
///
/// Delver decodes in RVA space, so the rel32 is added to `0x1005` in wrapping
/// `u64` arithmetic: `0x1005 + 0xFFFFFFFFFE000000` is `0xFFFFFFFFFE001005`, an
/// address no section maps. Real bytes that are not code produce exactly this
/// — a large negative displacement read out of data — and the call target must
/// not become a function.
const X64_CALL_OUT_OF_IMAGE: &[u8] = &[
	0xE8, 0x00, 0x00, 0x00, 0xFE, // 0x1000 call rel32 -0x02000000
	0xC3, // 0x1005 ret
];

/// A global's worth of initialised data, for the exported-data sample.
///
/// Contents are irrelevant — what matters is that they sit in a writable,
/// non-executable section that an export names.
const EXPORTED_GLOBAL: &[u8] = &[
	0x2A, 0x00, 0x00, 0x00, // 0x2000 g_counter: u32 = 42
	0x00, 0x00, 0x00, 0x00, // padding
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
			name: "x64-rtti-vftable",
			covers: "complete-object locator validated by its own pSelf, and the vftable slots below it",
			bytes: PeBuilder::new(Machine::Amd64)
				.code(X64_VIRTUAL_METHODS)
				.entry(0x1000)
				// The methods have to be *recovered* function entries, not just
				// executable addresses, or the slot walk refuses them. The
				// exception directory is the authoritative seed source.
				.runtime_function(0x1000, 0x1008)
				.runtime_function(0x1010, 0x1018)
				.runtime_function(0x1020, 0x1023)
				// Two classes, so the first table's walk ends on the zeroed head
				// of the second class's type descriptor — the ordinary "the
				// array ended" ending — rather than on the section running out.
				.rtti_class(".?AVGreeter@@", 0, &[0x1010, 0x1020])
				.rtti_class(".?AVSpeaker@@", 8, &[0x1000, 0x1020])
				.build(),
		},
		Sample {
			name: "x64-rtti-runaway-terminator",
			covers: "the slot walk stops at the first pointer that is executable but not a recovered function entry, instead of running out of the table",
			// Reproduces a defect measured across 70 real images: walking slots
			// "until a non-executable pointer" ran the last RTTI vftable in
			// `.rdata` straight into the pointer array behind it, and reported
			// `std::bad_array_new_length` — a two-method class — with up to
			// 3,166 slots.
			//
			// The trailing pointers here are deliberately mid-body addresses:
			// `0x1004` is inside the entry function and `0x1014` inside the
			// first method. Both are in `.text`, neither is a function start,
			// so the naive rule swallows them and the implemented one must not.
			bytes: PeBuilder::new(Machine::Amd64)
				.code(X64_VIRTUAL_METHODS)
				.entry(0x1000)
				.runtime_function(0x1000, 0x1008)
				.runtime_function(0x1010, 0x1018)
				.runtime_function(0x1020, 0x1023)
				.rtti_class(".?AVBadArrayNewLength@@", 0, &[0x1010, 0x1020])
				.trailing_code_pointers(&[0x1004, 0x1014, 0x1004, 0x1014])
				.build(),
		},
		Sample {
			name: "x64-call-out-of-image",
			covers: "a call target outside every section is refused as a function start",
			bytes: PeBuilder::new(Machine::Amd64)
				.code(X64_CALL_OUT_OF_IMAGE)
				.entry(0x1000)
				.build(),
		},
		Sample {
			name: "x64-exported-data-symbol",
			covers: "an export in a data section is reported as an export but not seeded as a function, while an export in .text is both",
			// A DLL exporting a global is ordinary. The export directory
			// vouches for the *address*, never for it being code, so the
			// section's executable bit is what decides: `Exported` at 0x1010 is
			// a function seed, `g_counter` at 0x2000 is not — and both must
			// still appear in the export list.
			//
			// The exported function sits at 0x1010 rather than at the entry
			// point, so its seed can only have come from the export directory:
			// at 0x1000 the entry-point seed would win the dedupe and the
			// snapshot would prove nothing.
			bytes: PeBuilder::new(Machine::Amd64)
				.code(X64_VIRTUAL_METHODS)
				.entry(0x1000)
				.data(EXPORTED_GLOBAL)
				.export("Exported", 0x1010)
				.export("g_counter", PeBuilder::DATA_RVA)
				.build(),
		},
		Sample {
			name: "x64-export-holes",
			covers: "an empty export-address-table slot is not reported as an export, and does not renumber the exports after it",
			// The export directory declares a contiguous ordinal range, so an
			// ordinal nobody exports still occupies an address-table entry,
			// written as zero. `object` hands those back as
			// `ExportTarget::Address(0)`, and reporting them turned
			// `amdave64.dll` into 5,659 exports of which 5,622 were holes.
			//
			// Two things are pinned. `Second` is present, so the skip is not a
			// blanket refusal of the directory; and it keeps ordinal 3, the
			// number its slot gives it, so dropping the hole at ordinal 2 does
			// not close the gap and slide every later export down by one.
			bytes: PeBuilder::new(Machine::Amd64)
				.code(X64_VIRTUAL_METHODS)
				.entry(0x1000)
				.export("First", 0x1010)
				.export_hole()
				.export("Second", 0x1020)
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
