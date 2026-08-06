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
