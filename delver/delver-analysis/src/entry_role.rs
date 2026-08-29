//! What the image's entry point actually is, and where the user's entry is.
//!
//! `AddressOfEntryPoint` names the C runtime stub — `mainCRTStartup`,
//! `WinMainCRTStartup`, and their wide siblings — not the `main` an analyst
//! opened the file to read. Modern MSVC puts two or three stubs between the
//! two: the entry establishes a frame and calls `__scrt_common_main_seh`, which
//! assembles the arguments and calls `invoke_main`, which calls the user entry
//! and nothing else.
//!
//! **No bit in a PE says "main is here."** Everything below the entry point
//! itself is a shape recognised in the call graph, and a shape can be wrong. So
//! this module is built the way [`crate::call_graph::CallPaths::proves_absence`]
//! is built: a positive result carries the exact evidence it rests on — the call
//! sites walked, in order, and the import symbols matched — and anything that
//! leaves two readings open reports the CRT entry alone rather than the
//! least-bad candidate. Naming the wrong function `main` sends an analyst into
//! the wrong function with the confidence of a fact; saying nothing sends them
//! into the listing, where they were going anyway.
//!
//! The one claim here that is not a heuristic is the first one: the image's own
//! header says execution begins at the entry RVA, and saying "that is CRT
//! scaffolding, not your code" is already worth more than silence.

use delver_format::ImportedModule;

use crate::call_graph::{call_graph, function_extent, CallGraph, FunctionExtent, ResolvedImport};
use crate::{Function, InstructionFlow, XrefKind, XrefTable};

/// Longest chain of CRT stubs the walk will follow.
///
/// The shape being recognised is three hops deep — entry, frame, `invoke_main`
/// — and eight leaves room for a linker-inserted thunk or two without letting
/// the walk wander down a chain of single-call user functions. A walk that
/// reaches this bound declines: the bound marks a place the shape could have
/// ended and was not looked at, and a result read off a cut walk would be a
/// claim about the bound rather than about the image.
const MAX_CRT_FORWARDER_HOPS: usize = 8;

/// Fewest stubs that count as CRT scaffolding.
///
/// A single forwarder from the image entry into a large function names the
/// frame the CRT set up, not the user entry — `mainCRTStartup` calling
/// `__scrt_common_main_seh` and stopping there would report the runtime's own
/// body as `main`. Two stubs is the shortest chain in which the last hop is a
/// hop *out* of the runtime.
const MIN_CRT_FORWARDER_HOPS: usize = 2;

/// Largest a function can be and still be read as a CRT stub.
///
/// Measured in decoded instructions inside the extent. The stubs in this shape
/// establish a frame and forward; they do not have bodies. The bound is what
/// stops the walk descending through a user function that happens to make one
/// call.
const MAX_CRT_FORWARDER_INSTRUCTIONS: usize = 64;

/// Which user entry point a function is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryRoleKind {
	/// The C runtime stub the image header names. Not user code.
	CrtEntry,
	/// `main(argc, argv, envp)` — narrow arguments, console subsystem.
	Main,
	/// `wmain(argc, argv, envp)` — wide arguments, console subsystem.
	WMain,
	/// `WinMain(hInstance, hPrevInstance, lpCmdLine, nShowCmd)` — narrow
	/// arguments, GUI subsystem.
	WinMain,
	/// `wWinMain(...)` — wide arguments, GUI subsystem.
	WWinMain,
	/// `DllMain(hinstDLL, fdwReason, lpvReserved)`.
	///
	/// Nothing produces this yet. Whether an image is a DLL is a file-header
	/// characteristic, not a subsystem, and [`entry_role`] is given only the
	/// subsystem — so the `_DllMainCRTStartup` → `dllmain_dispatch` → `DllMain`
	/// chain cannot be told apart from the `main` families here. The variant
	/// exists so the caller that adds the characteristic already handles the
	/// shape it will arrive in. Do not delete it as dead.
	DllMain,
}

/// How a role was concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryRoleMethod {
	/// Read straight off the image: the optional header names this RVA as where
	/// execution begins, and the subsystem names which CRT stub family that
	/// makes it. Nothing was inferred.
	SubsystemAndEntry,
	/// The call-graph walk described in this module's header: a chain of CRT
	/// stubs, each making exactly one call nothing else already names, ending in
	/// the `invoke_main` hop into user code.
	CrtInvokeMainShape,
}

/// How much weight a role carries.
///
/// **Deliberately not [`crate::call_graph::ResolutionConfidence`].** That enum
/// answers "how sure are we of the *name* behind this indirect call"; this one
/// answers "how sure are we of this function's *role* in the image". They are
/// two axes, they move independently — an exactly-named import can sit on a
/// merely probable path — and collapsing two axes into one enum is the mistake
/// this codebase keeps having to undo. Adding a variant to one must never
/// silently widen the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryRoleConfidence {
	/// The image itself states it. There is nothing left to guess.
	Exact,
	/// Derived from a shape in the call graph. The evidence narrows the answer
	/// without proving it, and travels with the result so a human can check it.
	Probable,
}

/// Windows subsystem, reduced to what deciding an entry point needs.
///
/// [`delver_format::Subsystem`] is the parsed original and converts into this
/// with [`From`], so the reduction lives here once rather than in every caller.
/// Only the two values that name a user entry family are kept; everything else
/// is [`Subsystem::Other`], which is handled — it declines — rather than read as
/// a console program by default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subsystem {
	/// `IMAGE_SUBSYSTEM_WINDOWS_CUI` — entered through `main` or `wmain`.
	Console,
	/// `IMAGE_SUBSYSTEM_WINDOWS_GUI` — entered through `WinMain` or `wWinMain`.
	Gui,
	/// Anything else: native, a driver, or a value nothing here was taught
	/// about. No user entry family follows from it.
	Other,
}

impl From<delver_format::Subsystem> for Subsystem {
	fn from(subsystem: delver_format::Subsystem) -> Self {
		match subsystem {
			delver_format::Subsystem::Console => Self::Console,
			delver_format::Subsystem::Gui => Self::Gui,
			// A native image has no C runtime entry of either family, and an
			// unrecognised value is exactly the case that must not read as one.
			delver_format::Subsystem::Native | delver_format::Subsystem::Other(_) => Self::Other,
		}
	}
}

/// One hop of the walk, with the exact instruction that makes it.
///
/// The call site is not decoration. A chain of function entries is a claim a
/// human has to take on trust; a chain of call sites is one they can go and look
/// at, which is the whole reason for returning evidence rather than a verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EntryRoleStep {
	/// Entry of the stub the hop leaves.
	pub from_function_rva: u64,
	/// RVA of the calling instruction.
	pub call_site: u64,
	/// Entry of the detected function the hop lands in.
	pub to_function_rva: u64,
}

/// One corroborating import called from a stub on the walked chain.
///
/// Only imports reached from the stubs count. An import the *candidate* calls is
/// the user's own API use and says nothing about which function the candidate
/// is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryRoleImport {
	/// Entry of the stub that calls it.
	pub function_rva: u64,
	/// RVA of the calling instruction.
	pub site: u64,
	/// The import, named exactly as [`crate::call_graph`] names it.
	pub import: ResolvedImport,
}

/// A function's role at the front of an image, and the evidence for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryRole {
	/// Entry of the function this role describes. The image entry itself for
	/// [`EntryRoleKind::CrtEntry`]; the user entry otherwise.
	pub rva: u64,
	/// Which entry point the function is.
	pub kind: EntryRoleKind,
	/// How that was concluded.
	pub method: EntryRoleMethod,
	/// How much weight the conclusion carries.
	pub confidence: EntryRoleConfidence,
	/// The hops walked, in call order, the first leaving the image entry and the
	/// last arriving at [`Self::rva`]. Empty for a role the image states itself.
	pub path: Vec<EntryRoleStep>,
	/// Import symbols matched on the walked chain, in path then address order.
	/// Empty for a role the image states itself.
	pub imports: Vec<EntryRoleImport>,
}

/// Names the image entry's role, and the user entry it reaches when the MSVC
/// shape is recognisable.
///
/// The first answer is always the same and always exact: the function at
/// `entry_rva` is the C runtime stub, because the image's own header says
/// execution begins there. That is returned on its own whenever the walk below
/// it declines, and `None` comes back only when `entry_rva` is not a detected
/// function at all — an entry nothing was decoded at is not a role, it is a
/// broken or unanalysed image.
///
/// The walk is described in the module header. It follows direct call edges
/// derived by [`call_graph`], never a second decode, and it declines rather than
/// choose whenever the evidence leaves two readings open — see the module header
/// for why that trade is the one this codebase makes.
pub fn entry_role(
	functions: &[Function],
	xrefs: &XrefTable,
	flows: &[InstructionFlow],
	imports: &[ImportedModule],
	entry_rva: u64,
	subsystem: Subsystem,
) -> Option<EntryRole> {
	// Fail-closed, like every other address resolution in this crate: an entry
	// RVA no function starts at is refused rather than answered for the
	// enclosing function.
	functions
		.binary_search_by_key(&entry_rva, |function| function.rva)
		.ok()?;

	Some(
		user_entry(functions, xrefs, flows, imports, entry_rva, subsystem).unwrap_or(EntryRole {
			rva: entry_rva,
			kind: EntryRoleKind::CrtEntry,
			method: EntryRoleMethod::SubsystemAndEntry,
			confidence: EntryRoleConfidence::Exact,
			path: Vec::new(),
			imports: Vec::new(),
		}),
	)
}

/// Which pair of user entry names the subsystem selects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Family {
	/// `main` / `wmain`.
	Main,
	/// `WinMain` / `wWinMain`.
	WinMain,
}

/// Whether the arguments the CRT assembles are narrow or wide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Width {
	Narrow,
	Wide,
}

/// Walks the CRT stub chain from the image entry to the user entry.
///
/// `None` at every point the evidence stops being conclusive, which the caller
/// turns back into the CRT entry role. The declines are, in the order they are
/// reached: an unknown subsystem, a stub whose extent was inferred rather than
/// recorded, a function on the chain that more than one site calls, a stub with
/// an unresolved indirect call site, a chain longer than
/// [`MAX_CRT_FORWARDER_HOPS`], a chain shorter than [`MIN_CRT_FORWARDER_HOPS`]
/// — which is also where a fan-out at the image entry lands, since nothing there
/// says which of two calls continues into the runtime — and finally a chain with
/// no observed `GetCommandLine` variant to separate the narrow name from the
/// wide one.
fn user_entry(
	functions: &[Function],
	xrefs: &XrefTable,
	flows: &[InstructionFlow],
	imports: &[ImportedModule],
	entry_rva: u64,
	subsystem: Subsystem,
) -> Option<EntryRole> {
	let family = match subsystem {
		Subsystem::Console => Family::Main,
		Subsystem::Gui => Family::WinMain,
		// Not a family this module was taught, so there is no name to give and
		// no shape to look for. Declining is the whole point of the variant.
		Subsystem::Other => return None,
	};

	let mut path: Vec<EntryRoleStep> = Vec::new();
	// The chain doubles as the visited set: it is bounded by
	// `MAX_CRT_FORWARDER_HOPS`, so a linear membership test costs less than a
	// set, and "already on the chain" is exactly the un-recursion test the shape
	// needs.
	let mut visited: Vec<u64> = vec![entry_rva];
	let mut matched: Vec<EntryRoleImport> = Vec::new();
	let mut at = entry_rva;

	loop {
		let extent = function_extent(functions, flows, at).ok()?;
		// An inferred end can hide or over-include a call site, and every step
		// below rests on one function's *complete* call set.
		if !extent.bounded() {
			return None;
		}
		// Everything after the image entry has to be reached from the hop that
		// reached it and from nowhere else. A function several sites call is a
		// shared helper, not a stub the runtime threads through once — and the
		// user entry has exactly one caller too, so the same test guards the
		// candidate.
		if let Some(step) = path.last() {
			if !called_only_from(xrefs, at, step.call_site) {
				return None;
			}
		}

		let graph = call_graph(functions, xrefs, flows, imports, extent, usize::MAX);
		let onward = continuations(&graph, &visited);

		// Anything other than a single onward call ends the chain: this function
		// is the candidate. At the image entry that leaves the chain empty, and
		// the length check below turns it into a decline — two calls out of the
		// entry are two equally-good readings and neither gets to win.
		let [(call_site, target)] = onward[..] else {
			break;
		};
		if decoded_instruction_count(flows, extent) > MAX_CRT_FORWARDER_INSTRUCTIONS {
			break;
		}
		// The whole hop rests on that call being the only one this function
		// makes. A call through a register or a vtable here could be the real
		// one, which is exactly where a packed or obfuscated sample hides it.
		if graph.unresolved_indirect_call_site_total > 0 {
			return None;
		}

		matched.extend(marker_imports(&graph, at));
		path.push(EntryRoleStep {
			from_function_rva: at,
			call_site,
			to_function_rva: target,
		});
		visited.push(target);
		at = target;

		if path.len() > MAX_CRT_FORWARDER_HOPS {
			return None;
		}
	}

	if path.len() < MIN_CRT_FORWARDER_HOPS {
		return None;
	}

	Some(EntryRole {
		rva: at,
		kind: kind(family, width(&matched)?),
		method: EntryRoleMethod::CrtInvokeMainShape,
		// A shape in the call graph, never a statement by the image.
		confidence: EntryRoleConfidence::Probable,
		path,
		imports: matched,
	})
}

/// The name the family and the argument width pick out.
fn kind(family: Family, width: Width) -> EntryRoleKind {
	match (family, width) {
		(Family::Main, Width::Narrow) => EntryRoleKind::Main,
		(Family::Main, Width::Wide) => EntryRoleKind::WMain,
		(Family::WinMain, Width::Narrow) => EntryRoleKind::WinMain,
		(Family::WinMain, Width::Wide) => EntryRoleKind::WWinMain,
	}
}

/// The onward calls one stub makes that the chain has not already been through.
///
/// Distinct by target and ordered by call site, carrying the site so the hop can
/// be checked by hand. Three kinds of edge are not onward calls:
///
/// * one that resolves to an import — that is an API call, not a hop;
/// * one landing anywhere but exactly on a detected function entry, since there
///   is nothing there to continue the walk from;
/// * one back into a function already on the chain, which is the un-recursion
///   the shape needs.
fn continuations(graph: &CallGraph, visited: &[u64]) -> Vec<(u64, u64)> {
	let mut onward: Vec<(u64, u64)> = Vec::new();
	for edge in &graph.callees {
		if edge.resolved_import.is_some()
			|| edge.target_function_rva != Some(edge.target)
			|| visited.contains(&edge.target)
		{
			continue;
		}
		if !onward.iter().any(|&(_, target)| target == edge.target) {
			onward.push((edge.site, edge.target));
		}
	}
	onward
}

/// Whether exactly one site in the image references `rva`, and it is `site`.
///
/// Data references are excluded: a function whose address is taken is still a
/// function one site calls. Every other reference counts, because a stub reached
/// by a tail call is reached just as surely as one reached by a call.
fn called_only_from(xrefs: &XrefTable, rva: u64, site: u64) -> bool {
	let mut incoming = xrefs
		.to(rva)
		.iter()
		.filter(|xref| xref.kind != XrefKind::Data);
	incoming.next().is_some_and(|xref| xref.from == site) && incoming.next().is_none()
}

/// The marker imports one stub calls, ordered by call site.
///
/// Both shapes [`call_graph`] resolves are read: a direct call to a one
/// instruction thunk, and a `call [rip+X]` straight through the slot. An
/// unresolved site is not one of these and is never guessed at — the walk has
/// already refused to continue past a stub that has one.
fn marker_imports(graph: &CallGraph, function_rva: u64) -> Vec<EntryRoleImport> {
	let named = graph
		.callees
		.iter()
		.filter_map(|edge| {
			edge.resolved_import
				.as_ref()
				.map(|import| (edge.site, import))
		})
		.chain(
			graph
				.indirect_call_sites
				.iter()
				.filter_map(|site| site.resolved.as_ref().map(|import| (site.site, import))),
		);

	let mut found: Vec<EntryRoleImport> = named
		.filter(|(_, import)| import.symbol.as_deref().is_some_and(is_marker))
		.map(|(site, import)| EntryRoleImport {
			function_rva,
			site,
			import: import.clone(),
		})
		.collect();
	// Two sources merged, so ordering has to be restored explicitly. Evidence in
	// address order is evidence a human can follow down the listing.
	found.sort_by_key(|matched| matched.site);
	found
}

/// Whether a symbol is one the CRT calls while assembling the user entry's
/// arguments.
///
/// `GetCommandLine` supplies `lpCmdLine` and `argv`; `GetModuleHandle` supplies
/// `hInstance`. Both are recorded as evidence, but only the first votes — see
/// [`width`].
fn is_marker(symbol: &str) -> bool {
	matches!(
		symbol,
		"GetCommandLineA" | "GetCommandLineW" | "GetModuleHandleA" | "GetModuleHandleW"
	)
}

/// Which argument width the chain's imports observed, when they agree.
///
/// Only `GetCommandLine` decides it. That is the call whose `A`/`W` variant
/// genuinely tracks the entry point's own variant — the command line is the
/// argument that differs between `main` and `wmain` and between `WinMain` and
/// `wWinMain`. `GetModuleHandleW` is called for `hInstance` in a narrow
/// `WinMain` build just as readily as in a wide one, so letting it vote would
/// name half the narrow GUI images `wWinMain`.
///
/// `None` in the two cases that are not evidence. Neither variant observed: the
/// chain says nothing about the width, and picking the narrow name because it is
/// more common is precisely the confident false claim this module exists to
/// avoid. Both observed: the two signals disagree, which is a finding about the
/// sample and not a tiebreak.
fn width(imports: &[EntryRoleImport]) -> Option<Width> {
	let observed = |symbol: &str| {
		imports
			.iter()
			.any(|matched| matched.import.symbol.as_deref() == Some(symbol))
	};
	match (observed("GetCommandLineA"), observed("GetCommandLineW")) {
		(true, false) => Some(Width::Narrow),
		(false, true) => Some(Width::Wide),
		_ => None,
	}
}

/// Decoded instructions inside one extent.
///
/// `AnalyzedImage::instruction_flows` is sorted and deduplicated by RVA, so both
/// bounds are a binary search rather than a scan of the whole image.
fn decoded_instruction_count(flows: &[InstructionFlow], extent: FunctionExtent) -> usize {
	if extent.end <= extent.start {
		return 0;
	}
	let lo = flows.partition_point(|fact| fact.rva < extent.start);
	let hi = flows.partition_point(|fact| fact.rva < extent.end);
	hi - lo
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::call_graph::{IndirectResolutionMethod, ResolutionConfidence};
	use crate::{FunctionSource, Xref};
	use delver_disasm::FlowKind;
	use delver_format::ImportedSymbol;

	fn function(rva: u64, end_rva: u64) -> Function {
		Function {
			rva,
			end_rva: Some(end_rva),
			source: FunctionSource::ExceptionDirectory,
		}
	}

	fn xref(from: u64, to: u64, kind: XrefKind) -> Xref {
		Xref { from, to, kind }
	}

	fn flow(rva: u64, len: u32, flow: FlowKind, branch_target: Option<u64>) -> InstructionFlow {
		InstructionFlow {
			rva,
			len,
			flow,
			branch_target,
		}
	}

	fn module(symbol: &str, iat_rva: u64) -> ImportedModule {
		ImportedModule {
			name: "KERNEL32.dll".to_string(),
			symbols: vec![ImportedSymbol {
				name: Some(symbol.to_string()),
				iat_rva,
				..Default::default()
			}],
			..Default::default()
		}
	}

	/// One image, held as the four loose lists [`entry_role`] takes so a test
	/// can add the one edge, flow or function it is about and then ask.
	struct Chain {
		functions: Vec<Function>,
		xrefs: Vec<Xref>,
		flows: Vec<InstructionFlow>,
		imports: Vec<ImportedModule>,
	}

	impl Chain {
		fn role_at(mut self, entry_rva: u64, subsystem: Subsystem) -> Option<EntryRole> {
			// Both are sorted by RVA when they arrive from `analyze`, and both
			// are binary-searched here, so the fixture owes them the same order.
			self.functions.sort_by_key(|function| function.rva);
			self.flows.sort_by_key(|fact| fact.rva);
			entry_role(
				&self.functions,
				&XrefTable::new(self.xrefs),
				&self.flows,
				&self.imports,
				entry_rva,
				subsystem,
			)
		}

		fn role(self, subsystem: Subsystem) -> Option<EntryRole> {
			self.role_at(0x1000, subsystem)
		}
	}

	/// The idealised MSVC chain.
	///
	/// `0x1000` is the image entry (`mainCRTStartup`), `0x1100` the frame
	/// (`__scrt_common_main_seh`) where the runtime assembles the user entry's
	/// arguments — and so where `markers` are called, each through its own IAT
	/// slot — `0x1200` is `invoke_main`, and `0x1300` is the user entry, which
	/// fans out into two callees of its own and thereby ends the chain.
	fn chain(markers: &[&str]) -> Chain {
		let mut xrefs = vec![
			xref(0x1004, 0x1100, XrefKind::Call),
			xref(0x1104, 0x1200, XrefKind::Call),
			xref(0x1204, 0x1300, XrefKind::Call),
			xref(0x1304, 0x1500, XrefKind::Call),
			xref(0x1308, 0x1600, XrefKind::Call),
		];
		let mut flows = Vec::new();
		let mut imports = Vec::new();
		for (index, symbol) in markers.iter().enumerate() {
			// `call [rip+X]`: an `IndirectCall` with no branch target plus a
			// data reference to the slot, which is how the descent records one.
			let (site, slot) = (0x1110 + index as u64 * 8, 0x4000 + index as u64 * 8);
			xrefs.push(xref(site, slot, XrefKind::Data));
			flows.push(flow(site, 6, FlowKind::IndirectCall, None));
			imports.push(module(symbol, slot));
		}

		Chain {
			functions: vec![
				function(0x1000, 0x1010),
				function(0x1100, 0x1200),
				function(0x1200, 0x1210),
				function(0x1300, 0x1400),
				function(0x1500, 0x1510),
				function(0x1600, 0x1610),
			],
			xrefs,
			flows,
			imports,
		}
	}

	/// The marker the frame calls at slot `index`, as the evidence names it.
	fn marker(index: u64, symbol: &str) -> EntryRoleImport {
		EntryRoleImport {
			function_rva: 0x1100,
			site: 0x1110 + index * 8,
			import: ResolvedImport {
				iat_rva: 0x4000 + index * 8,
				module: "KERNEL32.dll".to_string(),
				symbol: Some(symbol.to_string()),
				ordinal: None,
				method: IndirectResolutionMethod::IatOperand,
				confidence: ResolutionConfidence::Exact,
			},
		}
	}

	/// What every decline falls back to: the one claim the image itself makes.
	fn crt_entry() -> Option<EntryRole> {
		Some(EntryRole {
			rva: 0x1000,
			kind: EntryRoleKind::CrtEntry,
			method: EntryRoleMethod::SubsystemAndEntry,
			confidence: EntryRoleConfidence::Exact,
			path: Vec::new(),
			imports: Vec::new(),
		})
	}

	#[test]
	fn the_console_shape_names_main_and_carries_the_evidence_it_rests_on() {
		assert_eq!(
			chain(&["GetCommandLineA"]).role(Subsystem::Console),
			Some(EntryRole {
				rva: 0x1300,
				kind: EntryRoleKind::Main,
				method: EntryRoleMethod::CrtInvokeMainShape,
				// A shape in the call graph, never a statement by the image.
				confidence: EntryRoleConfidence::Probable,
				// Three call sites a human can go and look at, in order.
				path: vec![
					EntryRoleStep {
						from_function_rva: 0x1000,
						call_site: 0x1004,
						to_function_rva: 0x1100,
					},
					EntryRoleStep {
						from_function_rva: 0x1100,
						call_site: 0x1104,
						to_function_rva: 0x1200,
					},
					EntryRoleStep {
						from_function_rva: 0x1200,
						call_site: 0x1204,
						to_function_rva: 0x1300,
					},
				],
				imports: vec![marker(0, "GetCommandLineA")],
			})
		);
	}

	/// The role's address and name, which is what the two signals decide.
	fn named(markers: &[&str], subsystem: Subsystem) -> Option<(u64, EntryRoleKind)> {
		chain(markers)
			.role(subsystem)
			.map(|role| (role.rva, role.kind))
	}

	#[test]
	fn the_subsystem_picks_the_family_and_the_command_line_picks_the_width() {
		assert_eq!(
			(
				named(&["GetCommandLineA"], Subsystem::Console),
				named(&["GetCommandLineW"], Subsystem::Console),
				named(&["GetCommandLineA"], Subsystem::Gui),
				named(&["GetCommandLineW"], Subsystem::Gui),
			),
			(
				Some((0x1300, EntryRoleKind::Main)),
				Some((0x1300, EntryRoleKind::WMain)),
				Some((0x1300, EntryRoleKind::WinMain)),
				Some((0x1300, EntryRoleKind::WWinMain)),
			)
		);
	}

	#[test]
	fn an_unrecognised_subsystem_declines_to_the_crt_entry_alone() {
		// Knowing "this is runtime scaffolding, not your code" is still worth
		// saying; naming a family the image never declared is not.
		assert_eq!(
			(
				chain(&["GetCommandLineA"]).role(Subsystem::Other),
				Subsystem::from(delver_format::Subsystem::Native),
				Subsystem::from(delver_format::Subsystem::Other(0x2a)),
			),
			(crt_entry(), Subsystem::Other, Subsystem::Other)
		);
	}

	#[test]
	fn a_chain_with_no_command_line_marker_declines_rather_than_guess_the_width() {
		// The shape is there in full and nothing in it separates `main` from
		// `wmain`. The name is the whole answer, so half an answer is none.
		assert_eq!(chain(&[]).role(Subsystem::Console), crt_entry());
	}

	#[test]
	fn both_command_line_variants_on_one_chain_decline_rather_than_break_the_tie() {
		assert_eq!(
			chain(&["GetCommandLineA", "GetCommandLineW"]).role(Subsystem::Console),
			crt_entry()
		);
	}

	#[test]
	fn get_module_handle_is_recorded_as_evidence_but_does_not_vote() {
		// `GetModuleHandleW` supplies `hInstance` in a narrow `WinMain` build
		// just as readily as in a wide one. It corroborates the frame and
		// decides nothing.
		assert_eq!(
			(
				chain(&["GetModuleHandleW"]).role(Subsystem::Gui),
				chain(&["GetCommandLineA", "GetModuleHandleW"])
					.role(Subsystem::Gui)
					.map(|role| (role.kind, role.imports)),
			),
			(
				crt_entry(),
				Some((
					EntryRoleKind::WinMain,
					vec![marker(0, "GetCommandLineA"), marker(1, "GetModuleHandleW")],
				)),
			)
		);
	}

	#[test]
	fn a_call_back_into_the_chain_is_not_a_second_candidate() {
		let mut chain = chain(&["GetCommandLineA"]);
		// `invoke_main` calling back into the entry: already on the chain, so
		// it is recursion rather than a fork the walk has to choose between.
		chain.xrefs.push(xref(0x1208, 0x1000, XrefKind::Call));
		assert_eq!(
			chain.role(Subsystem::Console).map(|role| role.rva),
			Some(0x1300)
		);
	}

	#[test]
	fn two_calls_out_of_the_image_entry_decline_rather_than_pick_one() {
		let mut chain = chain(&["GetCommandLineA"]);
		// Nothing says which of the two continues into the runtime, and the
		// entry is the one function the walk cannot treat as a candidate.
		chain.functions.push(function(0x1080, 0x1090));
		chain.xrefs.push(xref(0x1008, 0x1080, XrefKind::Call));
		assert_eq!(chain.role(Subsystem::Console), crt_entry());
	}

	#[test]
	fn a_frame_that_fans_out_one_hop_below_the_entry_is_not_the_user_entry() {
		// The real `__scrt_common_main_seh` is shaped like this: one call in
		// from the entry, then a dozen calls of its own. It is the runtime's
		// own body, and naming it `main` is exactly the confident false claim
		// this refuses to make — so the chain is one stub long and declines.
		let chain = Chain {
			functions: vec![
				function(0x1000, 0x1100),
				function(0x1100, 0x1200),
				function(0x1200, 0x1210),
				function(0x1300, 0x1310),
			],
			xrefs: vec![
				xref(0x1004, 0x1100, XrefKind::Call),
				xref(0x1010, 0x4000, XrefKind::Data),
				xref(0x1104, 0x1200, XrefKind::Call),
				xref(0x1108, 0x1300, XrefKind::Call),
			],
			flows: vec![flow(0x1010, 6, FlowKind::IndirectCall, None)],
			imports: vec![module("GetCommandLineA", 0x4000)],
		};
		assert_eq!(chain.role(Subsystem::Console), crt_entry());
	}

	#[test]
	fn an_unresolved_indirect_call_on_a_stub_declines() {
		let mut chain = chain(&["GetCommandLineA"]);
		// `call rax` inside the frame: no memory operand, so nothing names
		// where it goes, and it could be the hop the whole chain rests on.
		chain
			.flows
			.push(flow(0x1120, 2, FlowKind::IndirectCall, None));
		assert_eq!(chain.role(Subsystem::Console), crt_entry());
	}

	#[test]
	fn an_inferred_extent_on_the_chain_declines() {
		let mut chain = chain(&["GetCommandLineA"]);
		// `invoke_main` with no recorded end. The boundary inferred from the
		// next detected function can hide or over-include a call site, and the
		// hop rests on the function's complete call set.
		chain.functions[2].end_rva = None;
		assert_eq!(chain.role(Subsystem::Console), crt_entry());
	}

	#[test]
	fn a_function_several_sites_call_is_a_shared_helper_and_declines() {
		let mut chain = chain(&["GetCommandLineA"]);
		// `0x1600` also calls `invoke_main`. A function reached from more than
		// one place is not a stub the runtime threads through once.
		chain.xrefs.push(xref(0x1604, 0x1200, XrefKind::Call));
		assert_eq!(chain.role(Subsystem::Console), crt_entry());
	}

	/// A chain of `hops` stubs from the image entry, each calling the next, with
	/// the marker import on the first stub below the entry.
	fn long_chain(hops: usize) -> Option<EntryRole> {
		let rva = |index: usize| 0x1000 + index as u64 * 0x100;
		let mut xrefs: Vec<Xref> = (0..hops)
			.map(|index| xref(rva(index) + 4, rva(index + 1), XrefKind::Call))
			.collect();
		xrefs.push(xref(rva(1) + 0x10, 0x4000, XrefKind::Data));

		Chain {
			functions: (0..=hops)
				.map(|index| function(rva(index), rva(index) + 0x100))
				.collect(),
			xrefs,
			flows: vec![flow(rva(1) + 0x10, 6, FlowKind::IndirectCall, None)],
			imports: vec![module("GetCommandLineA", 0x4000)],
		}
		.role(Subsystem::Console)
	}

	#[test]
	fn a_chain_longer_than_the_bound_declines_rather_than_report_a_cut_walk() {
		assert_eq!(
			(
				long_chain(MAX_CRT_FORWARDER_HOPS).map(|role| (role.rva, role.kind)),
				long_chain(MAX_CRT_FORWARDER_HOPS + 1).map(|role| (role.rva, role.kind)),
			),
			(
				Some((
					0x1000 + MAX_CRT_FORWARDER_HOPS as u64 * 0x100,
					EntryRoleKind::Main
				)),
				// One hop further and the walk hit its bound. The shape is just
				// as unambiguous at every hop; a result read off a cut walk
				// would be a claim about the bound, not about the image.
				Some((0x1000, EntryRoleKind::CrtEntry)),
			)
		);
	}

	#[test]
	fn an_entry_no_function_starts_at_is_no_role_at_all() {
		// Mid-function, so there is nothing to be the CRT entry either.
		assert_eq!(
			chain(&["GetCommandLineA"]).role_at(0x1004, Subsystem::Console),
			None
		);
	}
}
