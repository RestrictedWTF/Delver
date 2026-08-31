//! Delver analysis server.
//!
//! Owns the fact store for one target and serves the `analysis/*` methods.
//! Connects to a provider as a client (P1 decision E1) rather than opening any
//! file itself — a provider serves bytes and target state, the analysis server
//! interprets them, and the two never link each other's crates.

mod image;

use std::io;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use clap::Parser;
use delver_analysis::listing::ListingRow;
use delver_analysis::{
	CallPathSinkError, DataRangeCorrection, ExtentError, FoundString, FunctionCorrection,
	FunctionCorrectionKind, FunctionExtent, FunctionSource,
};
use delver_disasm::{FlowKind, SignatureFieldKind};
use delver_format::BaseRelocation;
use delver_protocol::{
	AddressForRowParams, AddressForRowResult, BasicBlockEdgeKindWire, BasicBlockEdgeWire,
	BasicBlockWire, BasicBlocksParams, BasicBlocksResult, CallGraphEdgeWire, CallGraphParams,
	CallGraphResult, CallPathStepWire, CallPathWire, CallPathsParams, CallPathsResult,
	CodeDecodingWire, DataRangeCorrectionWire, ErrorKind, FlowKindWire, FunctionCorrectionKindWire,
	FunctionCorrectionWire, FunctionFingerprintWire, FunctionProfileParams, FunctionProfileResult,
	FunctionSourceWire, FunctionWire, FunctionsResult, GlobalAccessWire, GlobalAccessesParams,
	GlobalAccessesResult, GlobalWire, GlobalsParams, GlobalsResult, ImageQueryParams,
	IndirectCallSiteWire, IndirectResolutionMethodWire, InitializeResult, ListingRowWire,
	ListingStringRowWire, ListingWindowParams, ListingWindowResult, ListingWindowRowWire,
	OpenImageParams, OpenImageResult, RangeWire, Request, ResolutionConfidenceWire,
	ResolvedImportWire,
	Response, RowForAddressParams, RowForAddressResult, RpcError, ScanStringsParams,
	SearchImmediatesParams, SearchImmediatesResult, ImmediateMatchWire,
	ScanStringsResult, SetCorrectionsParams, SetCorrectionsResult, SignatureFieldReasonWire,
	SignatureFieldWire, StringEncodingWire, StringWire, StringsResult, TargetCapabilityWire,
	TargetDescriptorWire, XrefIndexParams, XrefIndexResult, XrefKindWire, XrefWire, XrefsParams,
	XrefsResult,
};
use delver_rpc::framed::MAX_JSON_FRAME_BYTES;
use delver_rpc::{Listener, Server};
use sha2::{Digest, Sha256};

use crate::image::{load, reanalyze, AuthoredCorrections, LoadedImage, ProviderConnection};

/// Hard cap on rows per `listingWindow` response.
///
/// Bounded output is a protocol rule, not a nicety: an unbounded request must
/// fail usefully rather than serialise a million rows into one message.
const MAX_ROWS: u64 = 4096;

/// JSON bytes available to the `strings` array itself.
///
/// The remainder covers the fixed result fields and the outer RPC response.
/// Keeping this below the transport ceiling makes one megabyte-long printable
/// run a bounded omission instead of a frame-write failure after analysis.
const STRING_LIST_JSON_BUDGET: usize = MAX_JSON_FRAME_BYTES - 4096;

#[derive(Parser, Debug)]
#[command(name = "server-analysis")]
#[command(about = "Delver analysis server")]
struct Args {
	/// Provider endpoint to pull bytes from.
	#[arg(long)]
	provider: String,
	/// Listen on a local endpoint instead of using stdio.
	#[arg(long)]
	listen: Option<String>,
}

/// Server state shared across connections.
struct State {
	provider: ProviderConnection,
	image: Option<LoadedImage>,
	/// How many images this process has opened.
	///
	/// The handle has to differ between opens, not just between processes.
	/// `analysis/openImage` replaces the image and starts its generation at
	/// zero, so a constant handle let a cursor minted against the *previous*
	/// image — different corrections, a different table — pass the
	/// `(image_id, generation)` guard and be answered from the new one. Re-open
	/// became a real operation the moment `data_ranges` could differ between
	/// two of them.
	opens: u64,
}

fn main() -> Result<()> {
	let args = Args::parse();
	let provider = ProviderConnection::connect(&args.provider)?;
	let state = Arc::new(Mutex::new(State {
		provider,
		image: None,
		opens: 0,
	}));

	if let Some(endpoint) = args.listen {
		let listener = Listener::bind(&endpoint)?;
		eprintln!(
			"server-analysis listening on {}",
			listener.endpoint().client_string()
		);
		loop {
			let (reader, writer) = listener.accept()?;
			let state = Arc::clone(&state);
			std::thread::spawn(move || {
				let mut server = Server::new(reader, writer);
				if let Err(e) = serve(&mut server, state) {
					eprintln!("client handler error: {e}");
				}
			});
		}
	} else {
		let stdin = io::stdin();
		let stdout = io::stdout();
		let mut server = Server::new(stdin.lock(), stdout.lock());
		serve(&mut server, state)
	}
}

fn serve<R: io::Read, W: io::Write>(
	server: &mut Server<R, W>,
	state: Arc<Mutex<State>>,
) -> Result<()> {
	loop {
		let request = match server.read_request() {
			Ok(request) => request,
			// EOF on the transport is a graceful disconnect, not an error.
			Err(delver_rpc::TransportError::Io(e)) if e.kind() == io::ErrorKind::UnexpectedEof => {
				return Ok(());
			}
			Err(e) => {
				eprintln!("read error: {e}");
				return Ok(());
			}
		};

		let shutdown = request.method == "shutdown";
		let response = handle(&request, &state);
		server.send_response(&response)?;

		if shutdown {
			let mut state = state.lock().expect("state lock");
			let _ = state.provider.shutdown();
			return Ok(());
		}
	}
}

fn handle(request: &Request, state: &Arc<Mutex<State>>) -> Response {
	let result = match request.method.as_str() {
		"initialize" => Ok(serde_json::to_value(initialize()).unwrap_or_default()),
		"shutdown" => Ok(serde_json::Value::Null),
		"analysis/openImage" => open_image(request, state),
		"analysis/listingWindow" => listing_window(request, state),
		"analysis/rowForAddress" => row_for_address(request, state),
		"analysis/addressForRow" => address_for_row(request, state),
		"analysis/functions" => functions(request, state),
		"analysis/basicBlocks" => basic_blocks_query(request, state),
		"analysis/callGraph" => call_graph_query(request, state),
		"analysis/callPaths" => call_paths_query(request, state),
		"analysis/functionProfile" => function_profile_query(request, state),
		"analysis/globals" => globals_query(request, state),
		"analysis/globalAccesses" => global_accesses_query(request, state),
		"analysis/xrefsTo" => xrefs(request, state, true),
		"analysis/xrefsFrom" => xrefs(request, state, false),
		"analysis/xrefIndex" => xref_index(request, state),
		"analysis/setCorrections" => set_corrections(request, state),
		"analysis/scanStrings" => scan_strings(request, state),
		"analysis/searchImmediates" => search_immediates(request, state),
		"analysis/strings" => strings(request, state),
		other => Err(RpcError::domain(
			ErrorKind::UnsupportedCapability,
			format!("method {other} is not supported"),
		)),
	};

	match result {
		Ok(value) => Response {
			id: request.id,
			result: Some(value),
			error: None,
		},
		Err(error) => Response {
			id: request.id,
			result: None,
			error: Some(error),
		},
	}
}

/// Hard cap on blocks per `analysis/basicBlocks` response.
const MAX_BASIC_BLOCKS: usize = 4096;

/// Hard cap on edges per list in one `analysis/callGraph` response.
const MAX_CALL_GRAPH_EDGES: usize = 4096;

/// Hard cap on global candidates or accesses in one response.
const MAX_GLOBAL_RESULTS: usize = 65_536;

/// Hard cap on steps in one `analysis/callPaths` path.
const MAX_CALL_PATH_DEPTH: usize = 16;

/// Hard cap on paths in one `analysis/callPaths` response.
const MAX_CALL_PATHS: usize = 64;

/// Hard cap on references per `analysis/xrefsTo` or `analysis/xrefsFrom`
/// response.
///
/// A hot address — a shared string constant, a runtime helper — is referenced
/// tens of thousands of times, and one message carrying all of them exceeds the
/// transport's JSON frame limit and kills the connection instead of answering.
const MAX_XREFS: usize = 4096;

/// Hard cap on references per `analysis/xrefIndex` page.
///
/// Far larger than [`MAX_XREFS`] because the two answer different questions.
/// The per-address cap protects a caller who asked about one hot address from a
/// reply it did not expect; this one bounds a caller who asked for the *whole*
/// table and is walking it deliberately. At roughly 60 encoded bytes per
/// reference a full page is a few megabytes, well inside the transport's 16 MB
/// JSON frame, and a smaller page would only multiply the round trips needed to
/// retain a table with millions of rows.
const MAX_XREF_INDEX_PAGE: usize = 65_536;

/// Hard cap on entries per image-scoped list response.
///
/// Larger than the per-function caps because these lists are the whole image's:
/// a real binary has tens of thousands of functions and strings, and a bound
/// that cut an ordinary sample in half would be a defect of its own. It exists
/// for the sample that declares a million.
const MAX_LIST_RESULTS: usize = 65_536;

/// Hard cap on frontier expansions in one `analysis/callPaths` search.
///
/// The search bound, not an output bound: it is what keeps a question about a
/// densely connected function from walking the whole program graph.
const MAX_CALL_PATH_VISITS: usize = 100_000;

/// Resolves a client-supplied bound against the server's own cap.
///
/// Zero asks for the cap, and zero is also what an older client's omitted field
/// deserialises to — so a client that has never heard of the bound gets a
/// bounded answer with a truncation flag rather than a dead connection.
fn resolve_limit(requested: u32, cap: usize) -> usize {
	if requested == 0 {
		cap
	} else {
		(requested as usize).min(cap)
	}
}

/// Runs `f` against the open image and one exactly-resolved function extent.
///
/// Every structure query needs the same four checks — the state lock, an open
/// image, a matching handle, and a detected function starting exactly at the
/// requested RVA — and every one of them fails closed. Answering for the
/// enclosing function instead would quietly change the question that was asked.
fn with_function<T>(
	state: &Arc<Mutex<State>>,
	image_id: &str,
	function_rva: u64,
	f: impl FnOnce(&LoadedImage, FunctionExtent) -> Result<T, RpcError>,
) -> Result<T, RpcError> {
	let state = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;
	let image = state.image.as_ref().ok_or_else(|| {
		RpcError::domain(
			ErrorKind::NotAttached,
			"no image is open; call analysis/openImage first",
		)
	})?;
	if image.id != image_id {
		return Err(RpcError::domain(
			ErrorKind::InvalidAddress,
			format!("unknown image id {image_id}"),
		));
	}

	let extent = delver_analysis::call_graph::function_extent(
		&image.analysis.functions,
		&image.analysis.instruction_flows,
		function_rva,
	)
	.map_err(|error| match error {
		ExtentError::NoFunctionAtRva => RpcError::domain(
			ErrorKind::InvalidAddress,
			format!("no detected function starts at {function_rva:#x}"),
		),
		ExtentError::Unbounded => RpcError::domain(
			ErrorKind::InvalidAddress,
			format!(
				"no instruction was decoded at {function_rva:#x}, so the function has no extent"
			),
		),
	})?;

	f(image, extent)
}

fn basic_blocks_query(
	request: &Request,
	state: &Arc<Mutex<State>>,
) -> Result<serde_json::Value, RpcError> {
	let params: BasicBlocksParams = parse_params(request)?;
	with_function(
		state,
		&params.image_id,
		params.function_rva,
		|image, extent| {
			let (all_blocks, all_edges) = delver_analysis::control_flow::basic_blocks(
				&image.analysis.instruction_flows,
				extent.start,
				extent.end,
			);
			let limit = (params.max_blocks as usize).clamp(1, MAX_BASIC_BLOCKS);
			let block_total = all_blocks.len() as u64;
			let edge_total = all_edges.len() as u64;
			let truncated = all_blocks.len() > limit;
			let blocks = all_blocks
				.into_iter()
				.take(limit)
				.map(|block| BasicBlockWire {
					start_rva: block.start_rva,
					end_rva: block.end_rva,
					instruction_count: block.instruction_count as u64,
				})
				.collect::<Vec<_>>();
			let returned: std::collections::BTreeSet<_> =
				blocks.iter().map(|block| block.start_rva).collect();
			let edges = all_edges
				.into_iter()
				.filter(|edge| returned.contains(&edge.from) && returned.contains(&edge.to))
				.map(|edge| BasicBlockEdgeWire {
					from: edge.from,
					to: edge.to,
					kind: match edge.kind {
						delver_analysis::BasicBlockEdgeKind::Fallthrough => {
							BasicBlockEdgeKindWire::Fallthrough
						}
						delver_analysis::BasicBlockEdgeKind::Jump => BasicBlockEdgeKindWire::Jump,
						delver_analysis::BasicBlockEdgeKind::ConditionalTaken => {
							BasicBlockEdgeKindWire::ConditionalTaken
						}
					},
				})
				.collect();

			serde_json::to_value(BasicBlocksResult {
				function_rva: extent.start,
				blocks,
				edges,
				truncated,
				block_total,
				edge_total,
				bounded: extent.bounded(),
			})
			.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
		},
	)
}

fn call_graph_query(
	request: &Request,
	state: &Arc<Mutex<State>>,
) -> Result<serde_json::Value, RpcError> {
	let params: CallGraphParams = parse_params(request)?;
	with_function(
		state,
		&params.image_id,
		params.function_rva,
		|image, extent| {
			let limit = (params.max_edges as usize).clamp(1, MAX_CALL_GRAPH_EDGES);
			let graph = delver_analysis::call_graph::call_graph(
				&image.analysis.functions,
				&image.analysis.xrefs,
				&image.analysis.instruction_flows,
				&image.parsed.imports,
				extent,
				limit,
			);

			serde_json::to_value(CallGraphResult {
				function_rva: graph.function_rva,
				callers: graph.callers.iter().map(call_graph_edge_wire).collect(),
				callees: graph.callees.iter().map(call_graph_edge_wire).collect(),
				indirect_call_sites: graph
					.indirect_call_sites
					.iter()
					.map(indirect_call_site_wire)
					.collect(),
				caller_total: graph.caller_total as u64,
				callee_total: graph.callee_total as u64,
				indirect_call_site_total: graph.indirect_call_site_total as u64,
				unresolved_indirect_call_site_total: graph.unresolved_indirect_call_site_total
					as u64,
				callers_truncated: graph.callers_truncated,
				callees_truncated: graph.callees_truncated,
				indirect_truncated: graph.indirect_truncated,
				import_resolution_incomplete: !image.parsed.imports_fully_parsed(),
				bounded: extent.bounded(),
			})
			.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
		},
	)
}

fn call_paths_query(
	request: &Request,
	state: &Arc<Mutex<State>>,
) -> Result<serde_json::Value, RpcError> {
	let params: CallPathsParams = parse_params(request)?;
	with_function(state, &params.image_id, params.from_rva, |image, extent| {
		let found = delver_analysis::call_graph::call_paths(
			&image.analysis.functions,
			&image.analysis.xrefs,
			&image.analysis.instruction_flows,
			&image.parsed.imports,
			extent,
			params.to_rva,
			(params.max_depth as usize).clamp(1, MAX_CALL_PATH_DEPTH),
			(params.max_paths as usize).clamp(1, MAX_CALL_PATHS),
			(params.max_visited as usize).clamp(1, MAX_CALL_PATH_VISITS),
		)
		.map_err(|error| match error {
			CallPathSinkError::NotFunctionOrImportSlot => RpcError::domain(
				ErrorKind::InvalidAddress,
				format!(
					"{:#x} is neither a detected function entry nor an import address table slot; \
					 a call-path sink has to be one of those two",
					params.to_rva
				),
			),
			CallPathSinkError::AmbiguousImportSlot => RpcError::domain(
				ErrorKind::InvalidAddress,
				format!(
					"{:#x} is an import address table slot that two import descriptors disagree \
					 about, so no call can be proven to reach it; the sample's import table is \
					 malformed",
					params.to_rva
				),
			),
		})?;

		serde_json::to_value(CallPathsResult {
			from_rva: found.from_rva,
			to_rva: found.to_rva,
			paths: found
				.paths
				.iter()
				.map(|path| CallPathWire {
					steps: path.steps.iter().map(call_path_step_wire).collect(),
				})
				.collect(),
			paths_truncated: found.paths_truncated,
			search_exhausted: found.search_exhausted,
			depth_limit_reached: found.depth_limit_reached,
			visit_limit_reached: found.visit_limit_reached,
			visited_function_count: found.visited_function_count,
			unresolved_indirect_sites_on_frontier: found.unresolved_indirect_sites_on_frontier,
			unbounded_functions_on_frontier: found.unbounded_functions_on_frontier,
			import_resolution_incomplete: !image.parsed.imports_fully_parsed(),
			bounded: extent.bounded(),
		})
		.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
	})
}

fn function_profile_query(
	request: &Request,
	state: &Arc<Mutex<State>>,
) -> Result<serde_json::Value, RpcError> {
	let params: FunctionProfileParams = parse_params(request)?;
	with_function(
		state,
		&params.image_id,
		params.function_rva,
		|image, extent| {
			let profile = delver_analysis::call_graph::function_profile(
				&image.analysis.functions,
				&image.analysis.xrefs,
				&image.analysis.instruction_flows,
				&image.parsed.imports,
				extent,
			);

			serde_json::to_value(FunctionProfileResult {
				function_rva: profile.function_rva,
				end_rva: profile.end_rva,
				bounded: profile.bounded,
				instruction_count: profile.instruction_count as u64,
				decoded_extent_bytes: profile.decoded_extent_bytes,
				block_count: profile.block_count as u64,
				edge_count: profile.edge_count as u64,
				incoming_call_site_count: profile.incoming_call_site_count as u64,
				incoming_caller_function_count: profile.incoming_caller_function_count as u64,
				outgoing_call_site_count: profile.outgoing_call_site_count as u64,
				outgoing_target_function_count: profile.outgoing_target_function_count as u64,
				indirect_call_site_count: profile.indirect_call_site_count as u64,
				resolved_indirect_call_site_count: profile.resolved_indirect_call_site_count as u64,
				return_count: profile.return_count as u64,
			})
			.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
		},
	)
}

fn globals_query(
	request: &Request,
	state: &Arc<Mutex<State>>,
) -> Result<serde_json::Value, RpcError> {
	let params: GlobalsParams = parse_params(request)?;
	with_image_id(state, &params.image_id, |image| {
		let globals = delver_analysis::globals::global_candidates(
			&image.parsed.sections,
			&image.analysis.xrefs,
		);
		let total = globals.len();
		let start = usize::try_from(params.start)
			.unwrap_or(usize::MAX)
			.min(total);
		let limit = resolve_limit(params.max_globals, MAX_GLOBAL_RESULTS);
		let end = start.saturating_add(limit).min(total);
		let rows = globals[start..end]
			.iter()
			.map(|global| {
				let section = &image.parsed.sections[global.section_index];
				GlobalWire {
					rva: global.rva,
					section: section.name.clone(),
					writable: section.is_writable(),
					reference_count: global.reference_count as u64,
				}
			})
			.collect();

		serde_json::to_value(GlobalsResult {
			globals: rows,
			total: total as u64,
			next_start: (end < total).then_some(end as u64),
		})
		.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
	})
}

fn global_accesses_query(
	request: &Request,
	state: &Arc<Mutex<State>>,
) -> Result<serde_json::Value, RpcError> {
	let params: GlobalAccessesParams = parse_params(request)?;
	with_image_id(state, &params.image_id, |image| {
		let accesses = delver_analysis::globals::global_accesses(
			&image.analysis.functions,
			&image.analysis.xrefs,
			params.rva,
		);
		let total = accesses.len();
		let limit = resolve_limit(params.max_accesses, MAX_GLOBAL_RESULTS);
		let rows = accesses
			.into_iter()
			.take(limit)
			.map(|access| GlobalAccessWire {
				site: access.site,
				function_rva: access.function_rva,
			})
			.collect();
		serde_json::to_value(GlobalAccessesResult {
			rva: params.rva,
			accesses: rows,
			total: total as u64,
			truncated: total > limit,
		})
		.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
	})
}

fn with_image_id<T>(
	state: &Arc<Mutex<State>>,
	image_id: &str,
	f: impl FnOnce(&LoadedImage) -> Result<T, RpcError>,
) -> Result<T, RpcError> {
	let state = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;
	let image = state.image.as_ref().ok_or_else(|| {
		RpcError::domain(
			ErrorKind::NotAttached,
			"no image is open; call analysis/openImage first",
		)
	})?;
	if image.id != image_id {
		return Err(RpcError::domain(
			ErrorKind::InvalidAddress,
			format!("unknown image id {image_id}"),
		));
	}
	f(image)
}

fn call_graph_edge_wire(edge: &delver_analysis::CallGraphEdge) -> CallGraphEdgeWire {
	CallGraphEdgeWire {
		site: edge.site,
		target: edge.target,
		kind: xref_kind_wire(edge.kind),
		site_function_rva: edge.site_function_rva,
		target_function_rva: edge.target_function_rva,
		tail_call: edge.tail_call,
		resolved_import: edge.resolved_import.as_ref().map(resolved_import_wire),
	}
}

fn call_path_step_wire(step: &delver_analysis::CallPathStep) -> CallPathStepWire {
	CallPathStepWire {
		from_function_rva: step.from_function_rva,
		call_site: step.call_site,
		to_function_rva: step.to_function_rva,
		resolved_import: step.resolved_import.as_ref().map(resolved_import_wire),
		kind: xref_kind_wire(step.kind),
		tail_call: step.tail_call,
	}
}

fn indirect_call_site_wire(site: &delver_analysis::IndirectCallSite) -> IndirectCallSiteWire {
	IndirectCallSiteWire {
		site: site.site,
		resolved: site.resolved.as_ref().map(resolved_import_wire),
	}
}

fn resolved_import_wire(import: &delver_analysis::ResolvedImport) -> ResolvedImportWire {
	ResolvedImportWire {
		iat_rva: import.iat_rva,
		module: import.module.clone(),
		symbol: import.symbol.clone(),
		ordinal: import.ordinal.map(u32::from),
		method: match import.method {
			delver_analysis::IndirectResolutionMethod::IatOperand => {
				IndirectResolutionMethodWire::IatOperand
			}
			delver_analysis::IndirectResolutionMethod::ImportThunk => {
				IndirectResolutionMethodWire::ImportThunk
			}
		},
		confidence: match import.confidence {
			delver_analysis::ResolutionConfidence::Exact => ResolutionConfidenceWire::Exact,
			delver_analysis::ResolutionConfidence::Probable => ResolutionConfidenceWire::Probable,
		},
	}
}

fn initialize() -> InitializeResult {
	InitializeResult {
		protocol_version: "1".to_string(),
		capabilities: vec![TargetCapabilityWire::Analyze],
		spaces: Vec::new(),
		target: TargetDescriptorWire {
			name: "analysis".to_string(),
			kind: "analysis".to_string(),
		},
	}
}

/// Runs `f` against the loaded image and the resolved list bound, or reports
/// `NotAttached`.
fn with_image<T>(
	request: &Request,
	state: &Arc<Mutex<State>>,
	f: impl FnOnce(&LoadedImage, usize) -> Result<T, RpcError>,
) -> Result<T, RpcError> {
	let params: ImageQueryParams = parse_params(request)?;
	let state = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;

	let image = state.image.as_ref().ok_or_else(|| {
		RpcError::domain(
			ErrorKind::NotAttached,
			"no image is open; call analysis/openImage first",
		)
	})?;
	if image.id != params.image_id {
		return Err(RpcError::domain(
			ErrorKind::InvalidAddress,
			format!("unknown image id {}", params.image_id),
		));
	}
	f(image, resolve_limit(params.max_results, MAX_LIST_RESULTS))
}

fn parse_params<T: serde::de::DeserializeOwned>(request: &Request) -> Result<T, RpcError> {
	serde_json::from_value(request.params.clone()).map_err(|e| {
		RpcError::protocol(
			-32602,
			format!("invalid params for {}: {e}", request.method),
		)
	})
}

fn open_image(request: &Request, state: &Arc<Mutex<State>>) -> Result<serde_json::Value, RpcError> {
	let params: OpenImageParams = if request.params.is_null() {
		OpenImageParams {
			space: None,
			corrections: Vec::new(),
			data_ranges: Vec::new(),
		}
	} else {
		parse_params(request)?
	};
	let corrections = corrections_from_wire(&params.corrections, &params.data_ranges)?;

	let mut state = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;
	let State {
		provider,
		image,
		opens,
	} = &mut *state;

	let mut loaded = load(provider, params.space.as_deref(), &corrections).map_err(|e| {
		RpcError::domain(ErrorKind::UnreadableMemory, format!("opening image: {e}"))
	})?;
	// Stamped after a successful load, so a failed open does not burn a handle
	// and, more importantly, does not invalidate the image still open.
	*opens = opens.saturating_add(1);
	loaded.id = format!("image-{opens}");

	// Every count here is qualified three times over. It counts `loaded.bytes`,
	// which is a prefix of the space when the provider would not serve all of
	// it; the three code counts mean nothing at all unless the code passes ran;
	// and every pass reads a parse that may itself be partial. Reporting them
	// bare would present an image analysed in part — or not decoded at all — as
	// one analysed in full.
	let result = OpenImageResult {
		image_id: loaded.id.clone(),
		arch: loaded.parsed.arch.clone(),
		decoding: code_decoding_wire(&loaded.analysis.decoding),
		fully_parsed: loaded.parsed.is_fully_parsed(),
		instruction_count: loaded.analysis.instructions.len() as u64,
		function_count: loaded.analysis.functions.len() as u64,
		xref_count: loaded.analysis.xrefs.len() as u64,
		string_count: loaded.analysis.strings.len() as u64,
		strings_truncated: loaded.analysis.strings_truncated,
		coverage_complete: loaded.unreadable.is_empty(),
		bytes_read: loaded
			.coverage
			.iter()
			.map(|range| range.end - range.start)
			.sum(),
		unreadable_ranges: loaded.unreadable.clone(),
	};
	*image = Some(loaded);

	serde_json::to_value(result)
		.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
}

/// Maps the analysis decoding outcome onto the wire enum.
///
/// The one place the counts on `OpenImageResult` are qualified: mapping this to
/// anything but the analysis's own answer would restore the false claim it
/// exists to prevent.
fn code_decoding_wire(decoding: &delver_analysis::CodeDecoding) -> CodeDecodingWire {
	match decoding {
		delver_analysis::CodeDecoding::Decoded => CodeDecodingWire::Decoded,
		delver_analysis::CodeDecoding::UnsupportedArchitecture(arch) => {
			CodeDecodingWire::UnsupportedArchitecture { arch: arch.clone() }
		}
	}
}

fn listing_window(
	request: &Request,
	state: &Arc<Mutex<State>>,
) -> Result<serde_json::Value, RpcError> {
	let params: ListingWindowParams = parse_params(request)?;
	let state_guard = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;
	let image = state_guard.image.as_ref().ok_or_else(|| {
		RpcError::domain(
			ErrorKind::NotAttached,
			"no image is open; call analysis/openImage first",
		)
	})?;
	if image.id != params.image_id {
		return Err(RpcError::domain(
			ErrorKind::InvalidAddress,
			format!("unknown image id {}", params.image_id),
		));
	}

	let count = params.count.min(MAX_ROWS) as usize;
	let start = params.start_row as usize;
	let index = &image.listing;
	let instructions = index.instructions();

	let mut rows = Vec::with_capacity(count);
	for (row, content) in index.rows(start, count) {
		match content {
			ListingRow::Instruction(slot) => {
				let (Some(rva), Some(len)) = (
					instructions.address_for_row(slot),
					instructions.len_for_row(slot),
				) else {
					continue;
				};
				// The bytes are gone once analysis is done, so re-decode from the
				// parsed image to format the row. The index guarantees `rva` is a
				// real boundary, which is the anchor `decode_count` requires.
				let decoded = decode_row(image, rva);
				rows.push(ListingWindowRowWire::Instruction(ListingRowWire {
					row: row as u64,
					rva,
					len,
					mnemonic: decoded.mnemonic,
					operands: decoded.operands,
					flow: decoded.flow,
					branch_target: decoded.branch_target,
					bytes_hex: decoded.bytes_hex,
					signature_fields: decoded.signature_fields,
				}));
			}
			ListingRow::String(slot) => {
				let Some(found) = index
					.string_slot(slot)
					.and_then(|slot| image.analysis.strings.get(slot))
				else {
					continue;
				};
				rows.push(ListingWindowRowWire::String(ListingStringRowWire {
					row: row as u64,
					rva: found.rva,
					text: found.text.clone(),
					encoding: string_encoding_wire(found.encoding),
				}));
			}
		}
	}

	serde_json::to_value(ListingWindowResult {
		rows,
		total_rows: index.len() as u64,
	})
	.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
}

/// Maps an analysis string encoding onto the wire enum.
fn string_encoding_wire(encoding: delver_analysis::StringEncoding) -> StringEncodingWire {
	match encoding {
		delver_analysis::StringEncoding::Ascii => StringEncodingWire::Ascii,
		delver_analysis::StringEncoding::Utf16Le => StringEncodingWire::Utf16Le,
	}
}

struct DecodedRow {
	mnemonic: String,
	operands: String,
	flow: FlowKindWire,
	branch_target: Option<u64>,
	bytes_hex: Option<String>,
	signature_fields: Vec<SignatureFieldWire>,
}

impl DecodedRow {
	fn invalid() -> Self {
		Self {
			mnemonic: String::new(),
			operands: String::new(),
			flow: FlowKindWire::Invalid,
			branch_target: None,
			bytes_hex: None,
			signature_fields: Vec::new(),
		}
	}
}

/// Formats one row and preserves the exact encoded fields required by the
/// signature generator. Offsets are instruction-relative, never inferred from
/// formatted operand text.
fn decode_row(image: &LoadedImage, rva: u64) -> DecodedRow {
	let Some(bitness) = delver_disasm::Bitness::from_arch(&image.parsed.arch) else {
		return DecodedRow::invalid();
	};
	let Some(bytes) = image.parsed.bytes_at(&image.bytes, rva) else {
		return DecodedRow::invalid();
	};

	let disasm = delver_disasm::Disassembler::new(bitness);
	match disasm.decode_count(rva, bytes, 1).into_iter().next() {
		Some(instruction) => {
			let instruction_len = instruction.len as usize;
			let mut signature_fields = instruction
				.signature_fields
				.into_iter()
				.map(|field| SignatureFieldWire {
					index: field.offset,
					length: field.len,
					reason: match field.kind {
						SignatureFieldKind::RelativeBranch => {
							SignatureFieldReasonWire::RelativeBranch
						}
						SignatureFieldKind::IpRelativeMemory => {
							SignatureFieldReasonWire::IpRelativeMemory
						}
					},
				})
				.collect::<Vec<_>>();
			let end_rva = rva.saturating_add(instruction.len as u64);
			for relocation in relocations_in(&image.relocations, rva, end_rva) {
				signature_fields.push(SignatureFieldWire {
					index: (relocation.rva - rva) as u32,
					length: u64::from(relocation.width).min(end_rva - relocation.rva) as u32,
					reason: SignatureFieldReasonWire::BaseRelocation,
				});
			}
			signature_fields.sort_by_key(|field| (field.index, field.length, field.reason as u8));
			signature_fields.dedup_by(|left, right| {
				left.index == right.index
					&& left.length == right.length
					&& left.reason == right.reason
			});

			DecodedRow {
				mnemonic: instruction.mnemonic,
				operands: instruction.operands,
				flow: flow_wire(instruction.flow),
				branch_target: instruction.branch_target,
				bytes_hex: bytes.get(..instruction_len).map(lower_hex),
				signature_fields,
			}
		}
		None => DecodedRow::invalid(),
	}
}

/// The base relocations whose field starts inside `[start, end)`.
///
/// `LoadedImage::relocations` is sorted by RVA once at load, so this is a
/// binary search and a walk over the handful of matches. Filtering the whole
/// table per instruction is quadratic in the image, and a PE is free to declare
/// a relocation for every pointer it contains — which is exactly what turns a
/// scroll into a hang.
fn relocations_in(relocations: &[BaseRelocation], start: u64, end: u64) -> &[BaseRelocation] {
	let first = relocations.partition_point(|relocation| relocation.rva < start);
	let rest = &relocations[first..];
	let count = rest.partition_point(|relocation| relocation.rva < end);
	&rest[..count]
}

fn row_for_address(
	request: &Request,
	state: &Arc<Mutex<State>>,
) -> Result<serde_json::Value, RpcError> {
	let params: RowForAddressParams = parse_params(request)?;
	let state = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;
	let image = state
		.image
		.as_ref()
		.ok_or_else(|| RpcError::domain(ErrorKind::NotAttached, "no image is open"))?;

	let index = &image.listing;
	let row = if params.containing {
		index.row_containing(params.rva)
	} else {
		index.row_for_address(params.rva)
	};

	serde_json::to_value(RowForAddressResult {
		row: row.map(|r| r as u64),
	})
	.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
}

fn address_for_row(
	request: &Request,
	state: &Arc<Mutex<State>>,
) -> Result<serde_json::Value, RpcError> {
	let params: AddressForRowParams = parse_params(request)?;
	let state = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;
	let image = state
		.image
		.as_ref()
		.ok_or_else(|| RpcError::domain(ErrorKind::NotAttached, "no image is open"))?;

	serde_json::to_value(AddressForRowResult {
		rva: image.listing.address_for_row(params.row as usize),
	})
	.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
}

fn functions(request: &Request, state: &Arc<Mutex<State>>) -> Result<serde_json::Value, RpcError> {
	with_image(request, state, |image, limit| {
		let total = image.analysis.functions.len();
		let functions = image
			.analysis
			.functions
			.iter()
			.enumerate()
			.take(limit)
			.map(|(index, f)| FunctionWire {
				rva: f.rva,
				end_rva: f.end_rva,
				source: function_source_wire(f.source),
				authoritative: f.source.is_authoritative(),
				fragments: f
					.fragments
					.iter()
					.map(|range| RangeWire { start: range.start, end: range.end })
					.collect(),
				fingerprint: function_fingerprint(image, index),
			})
			.collect();

		serde_json::to_value(FunctionsResult {
			functions,
			total: total as u64,
			list_truncated: total > limit,
		})
		.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
	})
}

/// Digests one function's normalized listing.
///
/// The extent comes from `call_graph::function_extent` and from nowhere else.
/// This used to re-derive it, and fell back to `u64::MAX` where that routine
/// falls back to the decoded run leaving the entry — so the last function in
/// every image was fingerprinted over every trailing instruction in the file
/// while `analysis/functionProfile` reported a smaller extent for the same
/// function. Two answers to one question, and this was the one that became the
/// cross-revision matching identity.
fn function_fingerprint(
	image: &LoadedImage,
	function_index: usize,
) -> Option<FunctionFingerprintWire> {
	let function = image.analysis.functions.get(function_index)?;
	let extent = delver_analysis::call_graph::function_extent(
		&image.analysis.functions,
		&image.analysis.instruction_flows,
		function.rva,
	)
	.ok()?;
	let start_row = image.analysis.instructions.row_for_address(extent.start)?;
	let mut hasher = Sha256::new();
	let mut instruction_count = 0usize;

	for (_, rva, len) in image
		.analysis
		.instructions
		.rows(start_row, image.analysis.instructions.len() - start_row)
	{
		if rva >= extent.end {
			break;
		}
		let decoded = decode_row(image, rva);
		hasher.update(decoded.mnemonic.to_ascii_lowercase().as_bytes());
		hasher.update([0]);
		let normalized_operands = if matches!(
			decoded.flow,
			FlowKindWire::Jump | FlowKindWire::ConditionalJump | FlowKindWire::Call
		) {
			match decoded.branch_target {
				Some(target) if extent.contains(target) => image
					.analysis
					.instructions
					.row_for_address(target)
					.map(|row| format!("local:{}", row - start_row))
					.unwrap_or_else(|| "external".to_string()),
				_ => "external".to_string(),
			}
		} else {
			normalize_operand_text(&decoded.operands)
		};
		hasher.update(normalized_operands.as_bytes());
		hasher.update([0]);
		hasher.update(len.to_le_bytes());
		hasher.update([flow_tag(decoded.flow)]);
		instruction_count += 1;
	}

	// v3, because the extent a digest covers is part of what the digest means:
	// taking the shared routine's answer changes the digest of the last function
	// in every image. A stored v2 fingerprint now matches nothing, which is the
	// fail-safe direction — the same call the `Indirect` split made.
	(instruction_count > 0).then(|| FunctionFingerprintWire {
		algorithm: "sha256".to_string(),
		normalization: "delver-server-listing-v3".to_string(),
		digest: lower_hex(&hasher.finalize()),
	})
}

fn normalize_operand_text(operands: &str) -> String {
	operands
		.split_whitespace()
		.collect::<Vec<_>>()
		.join(" ")
		.to_ascii_lowercase()
}

/// Stable per-flow byte mixed into a function fingerprint.
///
/// The values are part of the digest, so they are append-only: `IndirectCall`
/// keeps the tag the conflated `Indirect` variant used, which leaves the common
/// case hashing exactly as it did, and `IndirectBranch` takes the next free
/// value. Anything else would rewrite every fingerprint the fix does not touch.
fn flow_tag(flow: FlowKindWire) -> u8 {
	match flow {
		FlowKindWire::Sequential => 0,
		FlowKindWire::Jump => 1,
		FlowKindWire::ConditionalJump => 2,
		FlowKindWire::Call => 3,
		FlowKindWire::IndirectCall => 4,
		FlowKindWire::Return => 5,
		FlowKindWire::Interrupt => 6,
		FlowKindWire::Invalid => 7,
		FlowKindWire::IndirectBranch => 8,
	}
}

fn lower_hex(bytes: &[u8]) -> String {
	const HEX: &[u8; 16] = b"0123456789abcdef";
	let mut result = String::with_capacity(bytes.len() * 2);
	for byte in bytes {
		result.push(HEX[(byte >> 4) as usize] as char);
		result.push(HEX[(byte & 0x0f) as usize] as char);
	}
	result
}

fn xrefs(
	request: &Request,
	state: &Arc<Mutex<State>>,
	incoming: bool,
) -> Result<serde_json::Value, RpcError> {
	let params: XrefsParams = parse_params(request)?;
	let state = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;
	let image = state
		.image
		.as_ref()
		.ok_or_else(|| RpcError::domain(ErrorKind::NotAttached, "no image is open"))?;

	let table = &image.analysis.xrefs;
	let matches = if incoming {
		table.to(params.rva)
	} else {
		table.from(params.rva)
	};

	let limit = resolve_limit(params.max_xrefs, MAX_XREFS);
	let xrefs = matches
		.iter()
		.take(limit)
		.map(|x| XrefWire {
			from: x.from,
			to: x.to,
			kind: xref_kind_wire(x.kind),
		})
		.collect();

	serde_json::to_value(XrefsResult {
		xrefs,
		total: matches.len() as u64,
		truncated: matches.len() > limit,
	})
	.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
}

/// Exports the xref table one page at a time.
///
/// The source ordering is the table's own, and the table is immutable once the
/// image is analysed, so a plain index is a stable cursor for the life of the
/// handle. A page that ends the walk omits `next_start` rather than returning
/// the total again — a caller retaining the table needs to distinguish "this is
/// all of it" from "this page was bounded", because a partial table stored as
/// though it were whole answers a later lookup with a confident and wrong zero.
fn xref_index(request: &Request, state: &Arc<Mutex<State>>) -> Result<serde_json::Value, RpcError> {
	let params: XrefIndexParams = parse_params(request)?;
	let state = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;
	let image = state
		.image
		.as_ref()
		.ok_or_else(|| RpcError::domain(ErrorKind::NotAttached, "no image is open"))?;
	if image.id != params.image_id {
		return Err(RpcError::domain(
			ErrorKind::InvalidAddress,
			format!("unknown image id {}", params.image_id),
		));
	}

	// A `start` index only means anything against the derivation it came from.
	if let Some(generation) = params.generation {
		if generation != image.generation {
			return Err(RpcError::domain(
				ErrorKind::StaleDerivation,
				format!(
					"cursor belongs to derivation {generation}; the facts were re-derived and are now at {}. Restart the walk.",
					image.generation
				),
			));
		}
	}

	let all = image.analysis.xrefs.all();
	let total = all.len();
	let limit = resolve_limit(params.max_xrefs, MAX_XREF_INDEX_PAGE);
	let (start, end, next_start) = xref_page_bounds(total, params.start, limit);

	let xrefs = all[start..end]
		.iter()
		.map(|x| XrefWire {
			from: x.from,
			to: x.to,
			kind: xref_kind_wire(x.kind),
		})
		.collect();

	serde_json::to_value(XrefIndexResult {
		xrefs,
		total: total as u64,
		next_start,
		generation: image.generation,
	})
	.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
}

/// Resolves one page of the xref export into `[start, end)` and the next cursor.
///
/// A `start` past the end is the natural last step of a walk rather than an
/// error — it yields an empty page and no continuation. `next_start` is present
/// only when references remain, so "the walk is complete" is a distinct
/// observation from "this page happened to be full".
fn xref_page_bounds(total: usize, start: u64, limit: usize) -> (usize, usize, Option<u64>) {
	let start = start.min(total as u64) as usize;
	let end = start.saturating_add(limit).min(total);
	let next_start = if end < total { Some(end as u64) } else { None };
	(start, end, next_start)
}

/// Converts a wire correction set into the analysis crate's own shape.
///
/// Shape errors are caught here; *conflicts* between corrections are not, and
/// deliberately so — the analysis crate owns that rule, and duplicating it would
/// give two places to keep in step and one of them would drift.
fn corrections_from_wire(
	wire: &[FunctionCorrectionWire],
	data_ranges: &[DataRangeCorrectionWire],
) -> Result<AuthoredCorrections, RpcError> {
	let functions = wire
		.iter()
		.map(|correction| {
			let kind = match correction.kind {
				FunctionCorrectionKindWire::Define => FunctionCorrectionKind::Define {
					end_rva: correction.end_rva,
				},
				FunctionCorrectionKindWire::Undefine => {
					if correction.end_rva.is_some() {
						return Err(RpcError::domain(
							ErrorKind::InvalidAddress,
							format!(
								"correction at {:#x} undefines a function and cannot carry an end address",
								correction.rva
							),
						));
					}
					FunctionCorrectionKind::Undefine
				}
			};
			Ok(FunctionCorrection {
				rva: correction.rva,
				kind,
			})
		})
		.collect::<Result<Vec<_>, RpcError>>()?;

	// Emptiness is the one shape error here; overlap and containment are
	// conflicts *between* ranges and belong to the analysis crate for the same
	// reason the function conflicts do — two implementations of one rule is one
	// implementation too many.
	let data_ranges = data_ranges
		.iter()
		.map(|range| {
			if range.end_rva <= range.rva {
				return Err(RpcError::domain(
					ErrorKind::InvalidAddress,
					format!(
						"data range at {:#x} ends at {:#x}, which is not after it",
						range.rva, range.end_rva
					),
				));
			}
			Ok(DataRangeCorrection {
				rva: range.rva,
				end_rva: range.end_rva,
			})
		})
		.collect::<Result<Vec<_>, RpcError>>()?;

	Ok(AuthoredCorrections {
		functions,
		data_ranges,
	})
}

/// Re-derives an open image against a new correction set.
///
/// The whole set is replaced rather than merged: a caller that sent two
/// overlapping partial updates would otherwise have no way to say what is in
/// effect, and "what is in effect" is the only thing that makes a derived fact
/// interpretable.
fn set_corrections(
	request: &Request,
	state: &Arc<Mutex<State>>,
) -> Result<serde_json::Value, RpcError> {
	let params: SetCorrectionsParams = parse_params(request)?;
	let corrections = corrections_from_wire(&params.corrections, &params.data_ranges)?;
	let mut state = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;
	let image = state
		.image
		.as_mut()
		.ok_or_else(|| RpcError::domain(ErrorKind::NotAttached, "no image is open"))?;
	if image.id != params.image_id {
		return Err(RpcError::domain(
			ErrorKind::InvalidAddress,
			format!("unknown image id {}", params.image_id),
		));
	}

	let before = image.analysis.functions.len() as u64;
	// A refused set leaves the image exactly as it was. Reporting the failure
	// while having emptied the facts would be the worst of both.
	reanalyze(image, corrections).map_err(|error| {
		RpcError::domain(
			ErrorKind::InvalidAddress,
			format!("applying corrections: {error}"),
		)
	})?;

	serde_json::to_value(SetCorrectionsResult {
		image_id: image.id.clone(),
		function_count_before: before,
		function_count: image.analysis.functions.len() as u64,
		instruction_count: image.analysis.instructions.len() as u64,
		corrections_applied: image.corrections.functions.len() as u64,
		data_ranges_applied: image.corrections.data_ranges.len() as u64,
		// Without this every count above is an unqualified zero on an
		// architecture the decoder does not support, which reads as "applied,
		// and the image has no code".
		decoding: code_decoding_wire(&image.analysis.decoding),
		generation: image.generation,
	})
	.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
}

/// Hard cap on strings per `analysis/scanStrings` window.
///
/// Smaller than the scanner's own retention cap, because this bounds one
/// *response* rather than the image: a caller walks as far as it needs to, and
/// the window only has to be big enough that walking is not all it does.
const MAX_SCANNED_STRINGS: usize = 4096;

/// Matches one `analysis/searchImmediates` response carries.
///
/// A constant like 0 or 1 is used everywhere, so this bound is reached often and
/// the result says so rather than implying the list is the whole answer.
const MAX_IMMEDIATE_MATCHES: usize = 4096;

/// Re-scans a bounded window of the image for strings.
///
/// `analysis/strings` serves the list retained when the image was analysed,
/// which stops at the scanner's cap — a bound nine of the thirty-five largest
/// binaries in a stock `System32` reach. Everything past it was unreachable by
/// any call. This produces the strings on demand instead, so the cap bounds one
/// answer rather than the image.
fn search_immediates(
	request: &Request,
	state: &Arc<Mutex<State>>,
) -> Result<serde_json::Value, RpcError> {
	let params: SearchImmediatesParams = parse_params(request)?;
	let state = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;
	let image = state
		.image
		.as_ref()
		.ok_or_else(|| RpcError::domain(ErrorKind::NotAttached, "no image is open"))?;
	if image.id != params.image_id {
		return Err(RpcError::domain(
			ErrorKind::InvalidAddress,
			format!("unknown image id {}", params.image_id),
		));
	}
	if let Some(width) = params.width {
		if !matches!(width, 8 | 16 | 32 | 64) {
			return Err(RpcError::domain(
				ErrorKind::InvalidAddress,
				format!("width must be 8, 16, 32 or 64, not {width}"),
			));
		}
	}
	// An architecture with no decoder cannot be searched for encoded constants,
	// and answering zero would say the image uses none.
	let Some(bitness) = delver_disasm::Bitness::from_arch(&image.parsed.arch) else {
		return Err(RpcError::domain(
			ErrorKind::UnsupportedCapability,
			format!(
				"no disassembler for architecture {}, so its instructions were never decoded",
				image.parsed.arch
			),
		));
	};

	let limit = resolve_limit(params.max_matches, MAX_IMMEDIATE_MATCHES);
	let found = delver_analysis::immediates::search_immediates(
		&image.parsed,
		&image.bytes,
		&image.coverage,
		&image.analysis.instructions,
		&delver_disasm::Disassembler::new(bitness),
		params.value,
		params.width,
		limit,
	);

	serde_json::to_value(SearchImmediatesResult {
		matches: found
			.hits
			.into_iter()
			.map(|hit| ImmediateMatchWire {
				rva: hit.rva,
				value: hit.value,
				width: hit.width,
			})
			.collect(),
		total: found.total as u64,
		list_truncated: found.truncated,
	})
	.map_err(|error| RpcError::protocol(-32603, format!("serialising result: {error}")))
}

fn scan_strings(
	request: &Request,
	state: &Arc<Mutex<State>>,
) -> Result<serde_json::Value, RpcError> {
	let params: ScanStringsParams = parse_params(request)?;
	let state = state
		.lock()
		.map_err(|_| RpcError::domain(ErrorKind::TargetBusy, "analysis state lock is poisoned"))?;
	let image = state
		.image
		.as_ref()
		.ok_or_else(|| RpcError::domain(ErrorKind::NotAttached, "no image is open"))?;
	if image.id != params.image_id {
		return Err(RpcError::domain(
			ErrorKind::InvalidAddress,
			format!("unknown image id {}", params.image_id),
		));
	}

	let limit = resolve_limit(params.max_strings, MAX_SCANNED_STRINGS);
	let scan = delver_analysis::strings::find_strings_from(
		&image.parsed,
		&image.bytes,
		&image.coverage,
		params.from_rva,
		limit,
	);

	// Bounded by bytes as well as by count, exactly as `analysis/strings` is.
	// A `StringWire` carries an unbounded run, so a packed sample with one
	// megabytes-long printable region overruns the JSON frame — and an
	// oversized frame kills the connection instead of answering.
	let strings = bounded_string_wires(&scan.strings, limit, STRING_LIST_JSON_BUDGET)?;
	// Truncating by bytes moves the resume point: continuing from the scan's own
	// `next_rva` would skip everything the budget dropped.
	let next_rva = if strings.len() < scan.strings.len() {
		strings.last().map(|last| last.rva.saturating_add(1))
	} else {
		scan.next_rva
	};

	serde_json::to_value(ScanStringsResult { strings, next_rva })
		.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
}

fn strings(request: &Request, state: &Arc<Mutex<State>>) -> Result<serde_json::Value, RpcError> {
	with_image(request, state, |image, limit| {
		let total = image.analysis.strings.len();
		let strings =
			bounded_string_wires(&image.analysis.strings, limit, STRING_LIST_JSON_BUDGET)?;
		let returned = strings.len();

		serde_json::to_value(StringsResult {
			strings,
			truncated: image.analysis.strings_truncated,
			total: total as u64,
			list_truncated: total > returned,
		})
		.map_err(|e| RpcError::protocol(-32603, format!("serialising result: {e}")))
	})
}

/// Converts strings until either the item limit or encoded byte budget is hit.
fn bounded_string_wires(
	strings: &[FoundString],
	limit: usize,
	byte_budget: usize,
) -> Result<Vec<StringWire>, RpcError> {
	let mut encoded_bytes = 2usize; // the surrounding `[]`
	let mut out = Vec::new();
	for string in strings.iter().take(limit) {
		let wire = StringWire {
			rva: string.rva,
			text: string.text.clone(),
			encoding: string_encoding_wire(string.encoding),
		};
		let item_bytes = serde_json::to_vec(&wire)
			.map_err(|e| RpcError::protocol(-32603, format!("serialising string: {e}")))?
			.len();
		let separator = usize::from(!out.is_empty());
		if encoded_bytes
			.saturating_add(separator)
			.saturating_add(item_bytes)
			> byte_budget
		{
			break;
		}
		encoded_bytes += separator + item_bytes;
		out.push(wire);
	}
	Ok(out)
}

fn flow_wire(flow: FlowKind) -> FlowKindWire {
	match flow {
		FlowKind::Sequential => FlowKindWire::Sequential,
		FlowKind::Jump => FlowKindWire::Jump,
		FlowKind::ConditionalJump => FlowKindWire::ConditionalJump,
		FlowKind::Call => FlowKindWire::Call,
		FlowKind::IndirectCall => FlowKindWire::IndirectCall,
		FlowKind::IndirectBranch => FlowKindWire::IndirectBranch,
		FlowKind::Return => FlowKindWire::Return,
		FlowKind::Interrupt => FlowKindWire::Interrupt,
		FlowKind::Invalid => FlowKindWire::Invalid,
	}
}

fn function_source_wire(source: FunctionSource) -> FunctionSourceWire {
	match source {
		FunctionSource::Authored => FunctionSourceWire::Authored,
		FunctionSource::ExceptionDirectory => FunctionSourceWire::ExceptionDirectory,
		FunctionSource::EntryPoint => FunctionSourceWire::EntryPoint,
		FunctionSource::Export => FunctionSourceWire::Export,
		FunctionSource::TlsCallback => FunctionSourceWire::TlsCallback,
		FunctionSource::CallTarget => FunctionSourceWire::CallTarget,
		FunctionSource::LinearSweep => FunctionSourceWire::LinearSweep,
	}
}

fn xref_kind_wire(kind: delver_analysis::XrefKind) -> XrefKindWire {
	match kind {
		delver_analysis::XrefKind::Call => XrefKindWire::Call,
		delver_analysis::XrefKind::Jump => XrefKindWire::Jump,
		delver_analysis::XrefKind::ConditionalJump => XrefKindWire::ConditionalJump,
		delver_analysis::XrefKind::Data => XrefKindWire::Data,
	}
}

#[cfg(test)]
mod tests {
	use super::{
		bounded_string_wires, normalize_operand_text, relocations_in, resolve_limit,
		xref_page_bounds, MAX_XREFS,
	};
	use delver_analysis::{FoundString, StringEncoding};
	use delver_format::BaseRelocation;

	#[test]
	fn normalization_preserves_immediates_that_can_change_semantics() {
		assert_eq!(
			normalize_operand_text("RAX,  [RIP+140001000h], 0X2A, 17"),
			"rax, [rip+140001000h], 0x2a, 17"
		);
	}

	#[test]
	fn relocation_lookup_returns_only_the_fields_inside_one_instruction() {
		let relocations: Vec<_> = [0x1000u64, 0x1004, 0x1008, 0x2000, 0x2008]
			.into_iter()
			.map(|rva| BaseRelocation { rva, width: 8 })
			.collect();

		let inside: Vec<_> = relocations_in(&relocations, 0x1004, 0x100C)
			.iter()
			.map(|relocation| relocation.rva)
			.collect();
		let before_first: Vec<_> = relocations_in(&relocations, 0x0, 0x1000)
			.iter()
			.map(|relocation| relocation.rva)
			.collect();
		let past_last = relocations_in(&relocations, 0x3000, 0x3008).len();

		assert_eq!(
			(inside, before_first, past_last),
			(vec![0x1004, 0x1008], Vec::new(), 0)
		);
	}

	#[test]
	fn an_unbounded_request_resolves_to_the_server_cap() {
		assert_eq!(
			(
				resolve_limit(0, MAX_XREFS),
				resolve_limit(10, MAX_XREFS),
				resolve_limit(u32::MAX, MAX_XREFS)
			),
			(MAX_XREFS, 10, MAX_XREFS)
		);
	}

	#[test]
	fn the_xref_export_signals_completion_only_when_the_table_is_exhausted() {
		let first = xref_page_bounds(5, 0, 2);
		let last = xref_page_bounds(5, 4, 2);
		let exact = xref_page_bounds(4, 0, 4);
		let past_end = xref_page_bounds(5, 9, 2);
		let empty = xref_page_bounds(0, 0, 2);

		assert_eq!(
			(first, last, exact, past_end, empty),
			(
				(0, 2, Some(2)),
				(4, 5, None),
				(0, 4, None),
				(5, 5, None),
				(0, 0, None)
			)
		);
	}

	#[test]
	fn string_results_stop_before_the_encoded_byte_budget() {
		let strings = vec![
			FoundString {
				rva: 0x1000,
				text: "short".to_string(),
				encoding: StringEncoding::Ascii,
			},
			FoundString {
				rva: 0x2000,
				text: "x".repeat(1024),
				encoding: StringEncoding::Ascii,
			},
		];

		let first_size = serde_json::to_vec(&delver_protocol::StringWire {
			rva: 0x1000,
			text: "short".to_string(),
			encoding: delver_protocol::StringEncodingWire::Ascii,
		})
		.expect("serialize first string")
		.len();
		let returned = bounded_string_wires(&strings, 2, first_size + 2).expect("bound strings");

		assert_eq!(returned.len(), 1);
	}
}
