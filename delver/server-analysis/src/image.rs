//! Pulling an image through a provider and analysing it.
//!
//! Per P1 decision E1 the analysis server does **not** open the target file
//! itself. It connects to a provider as an ordinary DTP client and reads bytes
//! through it. That costs a little throughput and buys the thing that matters:
//! the same code path works when the bytes come from a live process or a
//! hypervisor, so the provider abstraction is exercised from the start rather
//! than validated late.

use anyhow::{bail, Context, Result};
use delver_analysis::AnalyzedImage;
use delver_format::ParsedImage;
use delver_protocol::{
	AddressSpaceWire, InitializeResult, ListSpacesResult, ReadMemoryParams, ReadMemoryResult,
	Request, Response,
};
use delver_rpc::Client;
use std::io::{BufReader, Read, Write};

/// Bytes requested per `readMemory` call while pulling an image.
///
/// Large enough that a multi-megabyte image is a handful of round trips, small
/// enough that a single response never becomes an allocation surprise.
const CHUNK: u64 = 1 << 20;

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
	pub bytes: Vec<u8>,
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
	/// Stops early if the provider serves a short read, which is how it reports
	/// that the remaining range is not backed by data — see invariant 7.
	pub fn read_space(&mut self, space: &str) -> Result<Vec<u8>> {
		let size = self
			.spaces
			.iter()
			.find(|s| s.id == space)
			.with_context(|| format!("provider exposes no space named {space}"))?
			.size;

		let mut out = Vec::with_capacity(size as usize);
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
			if bytes.is_empty() {
				break; // nothing further is readable
			}
			let read = bytes.len() as u64;
			out.extend_from_slice(&bytes);
			offset += read;
		}

		Ok(out)
	}

	/// Sends a graceful shutdown.
	pub fn shutdown(&mut self) -> Result<()> {
		let _ = self.call("shutdown", serde_json::Value::Null);
		Ok(())
	}
}

/// Pulls the file space through `connection` and analyses it.
pub fn load(connection: &mut ProviderConnection, space: Option<&str>) -> Result<LoadedImage> {
	connection.spaces()?;
	let space = space.unwrap_or("File");

	let bytes = connection
		.read_space(space)
		.with_context(|| format!("reading space {space}"))?;
	if bytes.is_empty() {
		bail!("provider returned no bytes for space {space}");
	}

	let parsed = delver_format::parse_pe(&bytes).context("parsing image")?;
	let analysis = delver_analysis::analyze(&parsed, &bytes);

	Ok(LoadedImage {
		id: "image-0".to_string(),
		parsed,
		analysis,
		bytes,
	})
}
