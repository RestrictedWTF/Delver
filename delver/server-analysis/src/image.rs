//! Pulling an image through a provider and analysing it.
//!
//! Per P1 decision E1 the analysis server does **not** open the target file
//! itself. It connects to a provider as an ordinary DTP client and reads bytes
//! through it. That costs a little throughput and buys the thing that matters:
//! the same code path works when the bytes come from a live process or a
//! hypervisor, so the provider abstraction is exercised from the start rather
//! than validated late.

use anyhow::{anyhow, bail, Context, Result};
use delver_analysis::listing::ListingIndex;
use delver_analysis::{AnalyzedImage, Corrections, DataRangeCorrection, FunctionCorrection};
use delver_format::{BaseRelocation, ParsedImage};
use delver_protocol::{
	AddressSpaceWire, InitializeResult, ListSpacesResult, RangeWire, ReadMemoryParams,
	ReadMemoryResult, Request, Response,
};
use delver_rpc::Client;
use std::io::{BufReader, Read, Write};
use std::ops::Range;

/// Bytes requested per `readMemory` call while pulling an image.
///
/// Large enough that a multi-megabyte image is a handful of round trips, small
/// enough that a single response never becomes an allocation surprise.
const CHUNK: u64 = 1 << 20;

/// What a provider actually served for one address space.
///
/// Kept separate from the bytes because the two answer different questions: a
/// caller needs the bytes to analyse, and needs [`Self::unreadable`] to know
/// what its analysis is silent about.
pub struct SpaceRead {
	/// Logical address-space bytes; unreadable holes contain placeholders and
	/// are never trusted unless covered by [`Self::coverage`].
	pub bytes: Vec<u8>,
	/// Disjoint file-offset ranges actually supplied by the provider.
	pub coverage: Vec<Range<u64>>,
	/// Disjoint ranges of the space that were not read. Empty when the whole
	/// space was served.
	pub unreadable: Vec<RangeWire>,
}

/// An analysed image plus the bytes it came from.
pub struct LoadedImage {
	/// Identifier handed back to clients.
	pub id: String,
	/// Parsed headers.
	pub parsed: ParsedImage,
	/// Derived facts.
	pub analysis: AnalyzedImage,
	/// The bytes the image was read from, retained so listing rows can be
	/// re-formatted on demand without another provider round trip.
	///
	/// This preserves logical offsets across holes. Placeholder bytes in those
	/// holes are never parsed, decoded, or scanned because [`Self::coverage`] is
	/// the authority for which bytes came from the provider.
	pub bytes: Vec<u8>,
	/// Disjoint file-offset ranges whose bytes are real provider data.
	pub coverage: Vec<Range<u64>>,
	/// Ranges of the analysed space that were never read, and which therefore
	/// contributed no instruction, function, xref, or string to `analysis`.
	pub unreadable: Vec<RangeWire>,
	/// The image's base relocations, sorted by RVA.
	///
	/// Sorted once here so that formatting a listing row is a binary search
	/// rather than a scan of the whole table. The parse order is whatever the
	/// sample's relocation blocks were written in, which nothing validates.
	pub relocations: Vec<BaseRelocation>,
	/// Which derivation the facts above are.
	///
	/// Incremented by every re-analysis. An index into a table — the xref export
	/// and the globals list both hand one out — is only meaningful against the
	/// derivation it was taken from, and the image handle cannot say so because
	/// it deliberately survives a re-derivation.
	pub generation: u64,
	/// Authored corrections the facts above were derived against.
	///
	/// Retained so a caller can be told what its answers already account for,
	/// and so a re-analysis can report what changed.
	pub corrections: AuthoredCorrections,
	/// Instructions and strings merged into one address-ordered row space.
	///
	/// Built once here rather than per request: it is a few vectors sized by the
	/// string count, and rebuilding it on every window fetch would binary-search
	/// the instruction index once per string on each scroll.
	pub listing: ListingIndex,
}

type ProviderClient = Client<BufReader<Box<dyn Read + Send>>, Box<dyn Write + Send>>;

/// A live connection to a provider.
pub struct ProviderConnection {
	client: ProviderClient,
	spaces: Vec<AddressSpaceWire>,
	next_id: u64,
}

impl ProviderConnection {
	/// Connects to `endpoint` and completes the handshake.
	pub fn connect(endpoint: &str) -> Result<Self> {
		let (reader, writer) = delver_rpc::connect(endpoint)
			.with_context(|| format!("connecting to provider at {endpoint}"))?;
		let mut client = Client::new(BufReader::new(reader), writer);

		client.send_request(&Request {
			id: 0,
			method: "initialize".to_string(),
			params: serde_json::Value::Null,
		})?;
		let response = client.read_response()?;
		if let Some(error) = response.error {
			bail!("provider initialize failed: {}", error.message);
		}
		let init: InitializeResult = serde_json::from_value(
			response
				.result
				.context("initialize returned no result payload")?,
		)?;

		Ok(Self {
			client,
			spaces: init.spaces,
			next_id: 1,
		})
	}

	fn call(&mut self, method: &str, params: serde_json::Value) -> Result<Response> {
		let id = self.next_id;
		self.next_id += 1;
		self.client.send_request(&Request {
			id,
			method: method.to_string(),
			params,
		})?;
		let response = self.client.read_response()?;
		if let Some(error) = response.error {
			bail!("{method} failed: {}", error.message);
		}
		Ok(response)
	}

	/// Refreshes and returns the provider's address spaces.
	pub fn spaces(&mut self) -> Result<&[AddressSpaceWire]> {
		let response = self.call("listSpaces", serde_json::Value::Null)?;
		let result: ListSpacesResult =
			serde_json::from_value(response.result.context("listSpaces returned no result")?)?;
		self.spaces = result.spaces;
		Ok(&self.spaces)
	}

	/// Reads an entire address space through the provider.
	///
	/// Stops at the first byte the provider will not serve, which is how it
	/// reports that a range is not backed by data — see invariant 7 — and
	/// reports the range it stopped at rather than letting a short read pass for
	/// a whole space. What is returned is exactly what the provider vouched for:
	/// a `readMemory` answer is trusted only as far as its `valid` ranges reach,
	/// never as far as its frame happens to be long.
	pub fn read_space(&mut self, space: &str) -> Result<SpaceRead> {
		let size = self
			.spaces
			.iter()
			.find(|s| s.id == space)
			.with_context(|| format!("provider exposes no space named {space}"))?
			.size;

		let size = usize::try_from(size).context("address space is too large for this host")?;
		let mut out = Vec::new();
		out.try_reserve_exact(size)
			.context("reserving address-space buffer")?;
		out.resize(size, 0);
		let size = size as u64;
		let mut coverage = Vec::new();
		let mut offset = 0u64;

		while offset < size {
			let want = CHUNK.min(size - offset);
			let params = ReadMemoryParams {
				space: space.to_string(),
				address: offset,
				len: want,
				moment: None,
			};
			let response = self.call("readMemory", serde_json::to_value(params)?)?;
			let result: ReadMemoryResult =
				serde_json::from_value(response.result.context("readMemory returned no result")?)?;

			let (frame_id, bytes) = self.client.read_frame()?;
			if frame_id != result.data.frame_id {
				bail!(
					"frame id mismatch: expected {}, got {frame_id}",
					result.data.frame_id
				);
			}
			apply_read_frame(&mut out, offset, want, &result.valid, &bytes, &mut coverage)?;
			offset += want;
		}

		let coverage = merge_ranges(coverage);
		let unreadable = uncovered_ranges(size, &coverage);

		Ok(SpaceRead {
			bytes: out,
			coverage,
			unreadable,
		})
	}

	/// Sends a graceful shutdown.
	pub fn shutdown(&mut self) -> Result<()> {
		let _ = self.call("shutdown", serde_json::Value::Null);
		Ok(())
	}
}

/// Copies one provider frame into its logical positions and records coverage.
///
/// Providers may send a dense frame (one byte per requested position) or a
/// packed frame (only bytes named by `valid`, concatenated in range order).
fn apply_read_frame(
	out: &mut [u8],
	request_start: u64,
	request_len: u64,
	valid: &[RangeWire],
	bytes: &[u8],
	coverage: &mut Vec<Range<u64>>,
) -> Result<()> {
	let request_end = request_start.saturating_add(request_len);
	let mut previous_end = request_start;
	let mut valid_bytes = 0usize;
	for range in valid {
		if range.start < request_start
			|| range.end > request_end
			|| range.start < previous_end
			|| range.start >= range.end
		{
			bail!("provider returned invalid or unordered coverage");
		}
		valid_bytes = valid_bytes
			.checked_add((range.end - range.start) as usize)
			.context("provider coverage length overflow")?;
		previous_end = range.end;
	}

	let dense = bytes.len() == request_len as usize;
	if !dense && bytes.len() != valid_bytes {
		bail!(
			"provider frame length {} disagrees with {} valid bytes",
			bytes.len(),
			valid_bytes
		);
	}

	let mut packed_offset = 0usize;
	for range in valid {
		let len = (range.end - range.start) as usize;
		let source_start = if dense {
			(range.start - request_start) as usize
		} else {
			packed_offset
		};
		let destination_start = range.start as usize;
		out[destination_start..destination_start + len]
			.copy_from_slice(&bytes[source_start..source_start + len]);
		packed_offset += len;
		coverage.push(range.start..range.end);
	}
	Ok(())
}

fn merge_ranges(mut ranges: Vec<Range<u64>>) -> Vec<Range<u64>> {
	ranges.sort_unstable_by_key(|range| range.start);
	let mut merged: Vec<Range<u64>> = Vec::new();
	for range in ranges {
		if let Some(previous) = merged.last_mut() {
			if range.start <= previous.end {
				previous.end = previous.end.max(range.end);
				continue;
			}
		}
		merged.push(range);
	}
	merged
}

fn uncovered_ranges(size: u64, coverage: &[Range<u64>]) -> Vec<RangeWire> {
	let mut unreadable = Vec::new();
	let mut at = 0u64;
	for range in coverage {
		if at < range.start {
			unreadable.push(RangeWire {
				start: at,
				end: range.start,
			});
		}
		at = at.max(range.end);
	}
	if at < size {
		unreadable.push(RangeWire {
			start: at,
			end: size,
		});
	}
	unreadable
}

/// The complete authored correction set an image was derived against.
///
/// Owned rather than borrowed, because it outlives every call that supplies it:
/// a re-analysis reports what changed against it, and a caller asks what its
/// answers already account for. [`Corrections`] is the borrowed view the
/// analysis crate takes, and `as_ref` is the only place the two are joined.
#[derive(Debug, Clone, Default)]
pub struct AuthoredCorrections {
	/// Corrections to function detection.
	pub functions: Vec<FunctionCorrection>,
	/// Runs of bytes the author says are data.
	pub data_ranges: Vec<DataRangeCorrection>,
}

impl AuthoredCorrections {
	fn as_ref(&self) -> Corrections<'_> {
		Corrections {
			functions: &self.functions,
			data_ranges: &self.data_ranges,
		}
	}
}

/// Pulls the file space through `connection` and analyses it.
///
/// A space the provider serves only in part is analysed in part. The counts on
/// [`LoadedImage`] then describe the bytes that were read and nothing else,
/// which is what [`LoadedImage::unreadable`] exists to say out loud.
pub fn load(
	connection: &mut ProviderConnection,
	space: Option<&str>,
	corrections: &AuthoredCorrections,
) -> Result<LoadedImage> {
	connection.spaces()?;
	let space = space.unwrap_or("File");

	let read = connection
		.read_space(space)
		.with_context(|| format!("reading space {space}"))?;
	let SpaceRead {
		bytes,
		coverage,
		unreadable,
	} = read;
	if coverage.is_empty() {
		bail!("provider returned no bytes for space {space}");
	}

	let parsed = delver_format::parse_pe(&bytes).context("parsing image")?;
	let (analysis, listing) = derive(&parsed, &bytes, &coverage, corrections)?;
	let mut relocations = parsed.relocations.clone();
	relocations.sort_unstable_by_key(|relocation| relocation.rva);

	Ok(LoadedImage {
		id: "image-0".to_string(),
		parsed,
		analysis,
		bytes,
		coverage,
		unreadable,
		relocations,
		listing,
		generation: 0,
		corrections: corrections.clone(),
	})
}

/// Everything that has to be rebuilt when the correction set changes.
///
/// `load` and [`reanalyze`] both go through here rather than each assembling
/// their own: the listing index is derived from the analysis it was built
/// against, and a re-analysis that forgot to rebuild it would serve rows for
/// instructions that no longer exist.
fn derive(
	parsed: &ParsedImage,
	bytes: &[u8],
	coverage: &[Range<u64>],
	corrections: &AuthoredCorrections,
) -> Result<(AnalyzedImage, ListingIndex)> {
	let analysis =
		delver_analysis::analyze_corrected(parsed, bytes, coverage, corrections.as_ref())
			.map_err(|error| anyhow!("{error}"))?;
	let listing = ListingIndex::new(
		analysis.instructions.clone(),
		analysis
			.strings
			.iter()
			.enumerate()
			.map(|(slot, found)| (found.rva, slot))
			.collect(),
	);
	Ok((analysis, listing))
}

/// Re-derives every fact for an open image against a new correction set.
///
/// The provider is not consulted: the bytes and their coverage are already
/// held, and re-reading them would cost a round trip to learn nothing. Nothing
/// is replaced until the new analysis succeeds, so a correction set the analysis
/// crate refuses leaves the image exactly as it was rather than emptied.
pub fn reanalyze(image: &mut LoadedImage, corrections: AuthoredCorrections) -> Result<()> {
	let (analysis, listing) = derive(&image.parsed, &image.bytes, &image.coverage, &corrections)?;
	image.analysis = analysis;
	image.listing = listing;
	image.corrections = corrections;
	// Every cursor handed out against the previous facts is now stale. The
	// handle deliberately survives this, so the generation is what lets a walk
	// be refused instead of quietly continuing into a different table.
	image.generation = image.generation.saturating_add(1);
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::{apply_read_frame, uncovered_ranges};
	use delver_protocol::RangeWire;

	fn range(start: u64, end: u64) -> RangeWire {
		RangeWire { start, end }
	}

	#[test]
	fn packed_frames_preserve_holes_and_later_coverage() {
		let mut out = vec![0_u8; 12];
		let mut coverage = Vec::new();
		apply_read_frame(
			&mut out,
			0,
			12,
			&[range(0, 4), range(8, 12)],
			b"headtail",
			&mut coverage,
		)
		.expect("apply packed frame");

		let unreadable = uncovered_ranges(12, &coverage);
		assert_eq!(
			(
				out,
				unreadable
					.iter()
					.map(|range| (range.start, range.end))
					.collect::<Vec<_>>()
			),
			(b"head\0\0\0\0tail".to_vec(), vec![(4, 8)])
		);
	}
}
