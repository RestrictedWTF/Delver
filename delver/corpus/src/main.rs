//! Golden-corpus runner.
//!
//! `delver-corpus check` recomputes every sample's facts and diffs them against
//! the committed snapshots. `delver-corpus bless` rewrites the snapshots after
//! an intentional change — review that diff carefully; it is the whole point of
//! the corpus.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};

use delver_corpus::snapshot::to_json;
use delver_corpus::{all_samples, snapshot_of};

#[derive(Parser, Debug)]
#[command(name = "delver-corpus")]
#[command(about = "Delver golden-corpus regression runner")]
struct Args {
	#[command(subcommand)]
	command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
	/// Recompute facts and diff against committed snapshots.
	Check,
	/// Rewrite committed snapshots to match current output.
	Bless,
	/// Write the generated sample images to a directory, for manual inspection.
	Dump {
		/// Destination directory.
		out: PathBuf,
	},
}

fn main() -> Result<()> {
	match Args::parse().command {
		Command::Check => check(),
		Command::Bless => bless(),
		Command::Dump { out } => dump(&out),
	}
}

fn expected_dir() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR")).join("expected")
}

fn check() -> Result<()> {
	let dir = expected_dir();
	let mut failures = Vec::new();
	let samples = all_samples();
	let total = samples.len();

	for sample in samples {
		let actual = to_json(&snapshot_of(sample.name, sample.covers, &sample.bytes)?)?;
		let path = dir.join(format!("{}.json", sample.name));

		let expected = match fs::read_to_string(&path) {
			Ok(text) => text.replace("\r\n", "\n"),
			Err(_) => {
				failures.push(format!(
					"{}: no committed snapshot at {} — run `delver-corpus bless`",
					sample.name,
					path.display()
				));
				continue;
			}
		};

		if expected != actual {
			failures.push(format!("{}:\n{}", sample.name, diff(&expected, &actual)));
		}
	}

	if !failures.is_empty() {
		for failure in &failures {
			eprintln!("MISMATCH {failure}");
		}
		bail!(
			"{} of {total} corpus samples do not match their snapshots",
			failures.len()
		);
	}

	println!("corpus: {total} samples match");
	Ok(())
}

fn bless() -> Result<()> {
	let dir = expected_dir();
	fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;

	for sample in all_samples() {
		let json = to_json(&snapshot_of(sample.name, sample.covers, &sample.bytes)?)?;
		let path = dir.join(format!("{}.json", sample.name));
		fs::write(&path, json).with_context(|| format!("writing {}", path.display()))?;
		println!("blessed {}", path.display());
	}
	Ok(())
}

fn dump(out: &Path) -> Result<()> {
	fs::create_dir_all(out).with_context(|| format!("creating {}", out.display()))?;
	for sample in all_samples() {
		let path = out.join(format!("{}.bin", sample.name));
		fs::write(&path, &sample.bytes).with_context(|| format!("writing {}", path.display()))?;
		println!("wrote {} ({} bytes)", path.display(), sample.bytes.len());
	}
	Ok(())
}

/// Minimal line diff — enough to see what moved without pulling in a crate.
fn diff(expected: &str, actual: &str) -> String {
	let expected: Vec<_> = expected.lines().collect();
	let actual: Vec<_> = actual.lines().collect();
	let mut out = String::new();

	for i in 0..expected.len().max(actual.len()) {
		match (expected.get(i), actual.get(i)) {
			(Some(e), Some(a)) if e == a => {}
			(Some(e), Some(a)) => {
				out.push_str(&format!("  line {}:\n    - {e}\n    + {a}\n", i + 1));
			}
			(Some(e), None) => out.push_str(&format!("  line {}:\n    - {e}\n", i + 1)),
			(None, Some(a)) => out.push_str(&format!("  line {}:\n    + {a}\n", i + 1)),
			(None, None) => {}
		}
	}
	out
}
