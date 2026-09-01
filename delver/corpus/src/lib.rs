//! The Delver golden corpus.
//!
//! A set of synthetic PE images plus the facts Delver is expected to derive
//! from them. `delver-corpus check` recomputes those facts and diffs them
//! against committed snapshots, so an analysis regression fails loudly instead
//! of drifting unnoticed.
//!
//! Samples are **generated, not committed binaries** — see
//! [`pe_builder`] for why (Stage D decision F4).

#![warn(missing_docs)]
#![forbid(unsafe_code)]

pub mod pe_builder;
pub mod samples;
pub mod snapshot;

pub use samples::{all_samples, Sample};
pub use snapshot::{snapshot_of, Snapshot};

#[cfg(test)]
mod tests {
	use super::*;
	use crate::snapshot::to_json;
	use std::fs;
	use std::path::Path;

	/// The corpus check, run as a normal test so `cargo test` gates on it too
	/// rather than relying on the npm script alone.
	#[test]
	fn every_sample_matches_its_committed_snapshot() {
		let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("expected");

		for sample in all_samples() {
			let actual = to_json(&snapshot_of(sample.name, sample.covers, &sample.bytes).unwrap())
				.expect("serialise snapshot");
			let path = dir.join(format!("{}.json", sample.name));
			let expected = fs::read_to_string(&path)
				.unwrap_or_else(|_| {
					panic!(
						"missing snapshot {}; run `delver-corpus bless`",
						path.display()
					)
				})
				.replace("\r\n", "\n");

			assert_eq!(
				expected, actual,
				"sample '{}' drifted from its snapshot",
				sample.name
			);
		}
	}

	#[test]
	fn samples_have_unique_names() {
		let mut names: Vec<_> = all_samples().iter().map(|s| s.name).collect();
		names.sort_unstable();
		let count = names.len();
		names.dedup();
		assert_eq!(
			count,
			names.len(),
			"sample names collide in the snapshot dir"
		);
	}

	/// Guards the layout bug the corpus caught on its first run: a data
	/// directory pointing at an RVA where no section was actually placed.
	#[test]
	fn declared_directories_land_inside_a_real_section() {
		for sample in all_samples() {
			let image = delver_format::parse_pe(&sample.bytes)
				.unwrap_or_else(|e| panic!("sample '{}' must parse: {e}", sample.name));

			for seed in &image.function_seeds {
				let inside = image
					.sections
					.iter()
					.any(|s| s.virtual_address <= seed.rva && seed.rva < s.virtual_end());
				assert!(
					inside,
					"sample '{}': seed {:#x} falls outside every section",
					sample.name, seed.rva
				);
			}
		}
	}

	#[test]
	fn exception_directory_sample_actually_yields_exception_seeds() {
		let sample = all_samples()
			.into_iter()
			.find(|s| s.name == "x64-exception-directory")
			.expect("sample present");
		let image = delver_format::parse_pe(&sample.bytes).expect("parse");

		let from_exception = image
			.function_seeds
			.iter()
			.filter(|s| s.source == delver_format::SeedSource::ExceptionDirectory)
			.count();
		assert_eq!(
			from_exception, 2,
			"the sample declares two runtime functions"
		);
	}

	#[test]
	fn a_chained_fragment_is_not_seeded_as_a_function_start() {
		let sample = all_samples()
			.into_iter()
			.find(|s| s.name == "x64-chained-unwind")
			.expect("sample present");
		let image = delver_format::parse_pe(&sample.bytes).expect("parse");

		let from_exception: Vec<u64> = image
			.function_seeds
			.iter()
			.filter(|s| s.source == delver_format::SeedSource::ExceptionDirectory)
			.map(|s| s.rva)
			.collect();
		// Two RUNTIME_FUNCTION entries, one of them a fragment of the other. Only
		// the primary is a function start, and reading `BeginAddress` alone would
		// report both.
		assert_eq!(from_exception, vec![0x1000]);
		assert!(
			!image.completeness.exception_directory_failed,
			"a well-formed chained record is not a parse failure"
		);
	}

	#[test]
	fn a_fragment_names_the_function_it_belongs_to() {
		let sample = all_samples()
			.into_iter()
			.find(|s| s.name == "x64-chained-unwind")
			.expect("sample present");
		let image = delver_format::parse_pe(&sample.bytes).expect("parse");

		// The primary is its own first piece and chains to nothing; the fragment
		// names the primary. Attributing a fragment to itself would be the same
		// false claim as seeding it as a function.
		assert_eq!(
			image
				.exception_ranges
				.iter()
				.map(|entry| (entry.range.start, entry.range.end, entry.chained_to))
				.collect::<Vec<_>>(),
			vec![(0x1000, 0x1005, None), (0x1005, 0x100A, Some(0x1000))],
		);
	}

	/// Immediates are matched by the value the bytes encode, at the width they
	/// were encoded at. Each query below is a way the search has been wrong
	/// before, or would plausibly go wrong.
	#[test]
	fn an_immediate_is_found_at_its_encoded_width_and_a_displacement_is_not_one() {
		let sample = all_samples()
			.into_iter()
			.find(|s| s.name == "x64-immediate-widths")
			.expect("sample present");
		let image = delver_format::parse_pe(&sample.bytes).expect("parse");
		let coverage = std::slice::from_ref(&(0..sample.bytes.len() as u64)).to_vec();
		let analyzed = delver_analysis::analyze(&image, &sample.bytes, &coverage);
		let disasm = delver_disasm::Disassembler::new(
			delver_disasm::Bitness::from_arch(&image.arch).expect("x86-64 decodes"),
		);

		let find = |value: u64, width: Option<u32>| {
			delver_analysis::immediates::search_immediates(
				&image,
				&sample.bytes,
				&coverage,
				&analyzed.instructions,
				&disasm,
				value,
				width,
				64,
			)
			.hits
			.iter()
			.map(|hit| (hit.rva, hit.width))
			.collect::<Vec<_>>()
		};

		assert_eq!(
			vec![
				// `add rax,1` encodes 1 in a byte even though the operand is
				// 64-bit, and the `jmp` two instructions later carries the same
				// 0x01 as a displacement — which is not a constant and must not
				// match.
				find(1, None),
				// So asking for the sign-extended reading finds nothing.
				find(1, Some(32)),
				// `mov ecx,0x12345678` is the only dword field here.
				find(0x1234_5678, None),
				// `mov al,0x2A` — a plain byte immediate.
				find(0x2A, None),
				// `cmp eax,-1` assembles to the byte 0xFF; both readings of that
				// field name the same instruction.
				find(0xFF, None),
				find(u64::MAX, None),
			],
			vec![
				vec![(0x1007, 8)],
				vec![],
				vec![(0x1002, 32)],
				vec![(0x1000, 8)],
				vec![(0x100B, 8)],
				vec![(0x100B, 8)],
			],
		);
	}

	#[test]
	fn x86_sample_yields_no_exception_seeds() {
		let sample = all_samples()
			.into_iter()
			.find(|s| s.name == "x86-minimal")
			.expect("sample present");
		let image = delver_format::parse_pe(&sample.bytes).expect("parse");

		assert!(
			image
				.function_seeds
				.iter()
				.all(|s| s.source != delver_format::SeedSource::ExceptionDirectory),
			"32-bit x86 has no exception directory"
		);
	}
}
