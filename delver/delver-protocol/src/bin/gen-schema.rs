//! Emits `delver/schema/protocol.schema.json`.
//!
//! Every wire type must be listed in [`register_definitions`]. `Request::params`
//! and `Response::result` are opaque `serde_json::Value` on the wire, so payload
//! types are *not* reachable by reference from the envelope — they have to be
//! named explicitly, or they silently never reach TypeScript and the two sides
//! drift (see ADR 0002).

use std::fs;
use std::path::PathBuf;

use schemars::gen::SchemaGenerator;

use delver_protocol::{
	AddressForRowParams, AddressForRowResult, AddressSpaceKindWire, AddressSpaceWire, ErrorData,
	ErrorKind, ExportWire, FlowKindWire, FrameRef, FunctionSeedWire, FunctionSourceWire,
	FunctionWire, FunctionsResult, GetExportsResult, GetFunctionSeedsResult, GetImageInfoResult,
	GetImportsResult, ImageQueryParams, ImportedModuleWire, ImportedSymbolWire, InitializeResult,
	ListSpacesResult, ListingRowWire, ListingWindowParams, ListingWindowResult, MomentKindWire,
	MomentWire, OpenImageParams, OpenImageResult, RangeWire, ReadMemoryParams, ReadMemoryResult,
	Request, Response, RowForAddressParams, RowForAddressResult, RpcError, SectionWire,
	SeedSourceWire, StringEncodingWire, StringWire, StringsResult, TargetCapabilityWire,
	TargetDescriptorWire, TlsWire, XrefKindWire, XrefWire, XrefsParams, XrefsResult,
};

/// Registers every type that must appear in the schema.
///
/// Adding a wire type without adding it here means it will not be generated
/// into `protocol.generated.ts`.
fn register_definitions(generator: &mut SchemaGenerator) {
	macro_rules! register {
		($($ty:ty),* $(,)?) => {
			$( let _ = generator.subschema_for::<$ty>(); )*
		};
	}

	register!(
		// Envelope.
		Request,
		Response,
		RpcError,
		ErrorData,
		ErrorKind,
		// Method payloads.
		InitializeResult,
		ListSpacesResult,
		GetImageInfoResult,
		GetImportsResult,
		GetExportsResult,
		GetFunctionSeedsResult,
		ReadMemoryParams,
		ReadMemoryResult,
		// Analysis server (v1).
		OpenImageParams,
		OpenImageResult,
		ListingWindowParams,
		ListingWindowResult,
		ListingRowWire,
		FlowKindWire,
		RowForAddressParams,
		RowForAddressResult,
		AddressForRowParams,
		AddressForRowResult,
		ImageQueryParams,
		FunctionsResult,
		FunctionWire,
		FunctionSourceWire,
		XrefsParams,
		XrefsResult,
		XrefWire,
		XrefKindWire,
		StringsResult,
		StringWire,
		StringEncodingWire,
		// Shared shapes.
		FrameRef,
		RangeWire,
		MomentWire,
		MomentKindWire,
		AddressSpaceWire,
		AddressSpaceKindWire,
		TargetCapabilityWire,
		TargetDescriptorWire,
		SectionWire,
		ImportedModuleWire,
		ImportedSymbolWire,
		ExportWire,
		FunctionSeedWire,
		SeedSourceWire,
		TlsWire,
	);
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
	let mut generator = SchemaGenerator::default();
	register_definitions(&mut generator);
	let definitions = generator.take_definitions();
	let count = definitions.len();

	let combined = serde_json::json!({
		"$schema": "http://json-schema.org/draft-07/schema#",
		"title": "Delver Protocol v0",
		"description": "Request, response, and payload types for the Delver provider protocol.",
		"definitions": definitions,
	});

	let out_dir = PathBuf::from("schema");
	fs::create_dir_all(&out_dir)?;
	let out_path = out_dir.join("protocol.schema.json");
	fs::write(&out_path, serde_json::to_string_pretty(&combined)?)?;

	println!("Wrote {} ({count} definitions)", out_path.display());
	Ok(())
}
