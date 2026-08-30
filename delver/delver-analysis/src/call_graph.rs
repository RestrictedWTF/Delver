//! Call-graph and function-profile derivation from retained facts.
//!
//! Everything here is a view over facts the analysis already holds — the xref
//! table, the detected function list, and the retained instruction flows. No
//! byte is decoded a second time, so asking for a call graph costs a handful of
//! binary searches rather than another analysis pass.
//!
//! `analysis/callGraph` and `analysis/functionProfile` both derive from these
//! functions, and that is the point: a profile that disagreed with the graph it
//! summarises would be worse than no profile at all.
//!
//! `analysis/callPaths` searches over that same derivation instead of over a
//! graph materialised in advance, and it obeys one rule the rest of this module
//! never has to state: **an empty path list is not a proof of absence.** It is a
//! claim about the program only when the search was genuinely complete — the
//! reachable set exhausted, no depth cut, no visit cut, not one unresolved
//! indirect call site, and no inferred function extent on the frontier it
//! touched. A call through a
//! register or a vtable is exactly where a real sample hides the edge that was
//! being looked for, so every one of them is counted and reported rather than
//! passed over. A bounded search that presented "no path" as a finding would be
//! worse than one that refused to answer. See [`CallPaths::proves_absence`].

use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

use delver_disasm::FlowKind;
use delver_format::ImportedModule;

use crate::control_flow;
use crate::{Function, InstructionFlow, Xref, XrefKind, XrefTable};

/// The half-open range one detected function occupies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FunctionExtent {
	/// Function entry RVA.
	pub start: u64,
	/// Exclusive end used for every range test below.
	pub end: u64,
	/// The function's own recorded end, when a source recorded one. Absent when
	/// [`Self::end`] was inferred — from the next detected function, or from the
	/// run of decoded instructions leaving the entry.
	pub recorded_end: Option<u64>,
}

impl FunctionExtent {
	/// Whether the end came from a recorded boundary rather than from one of the
	/// two inferences below it.
	///
	/// An inferred end is a guess, and every count derived from it inherits that
	/// uncertainty. Callers have to be able to see the difference.
	pub fn bounded(self) -> bool {
		self.recorded_end.is_some()
	}

	/// Whether `rva` falls inside the half-open extent.
	pub fn contains(self, rva: u64) -> bool {
		self.start <= rva && rva < self.end
	}
}

/// Why a function's extent could not be resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtentError {
	/// No detected function starts exactly at the requested RVA.
	///
	/// Resolution is deliberately fail-closed. Answering for the enclosing
	/// function would silently reinterpret the question, and a caller that asked
	/// about a mid-function address usually holds a wrong assumption worth
	/// surfacing.
	NoFunctionAtRva,
	/// A function starts there, but nothing was decoded at the entry, so none of
	/// the three bounds apply and there is no range to derive anything from.
	///
	/// An entry with no instruction is an entry the analysis never reached.
	/// Manufacturing an extent for it would be inventing a function out of
	/// nothing.
	Unbounded,
}

/// How an indirect target was named.
///
/// Both shapes below name an import table slot from facts the analysis already
/// holds. Neither infers a target from a value; the operand *is* the evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndirectResolutionMethod {
	/// The call's own memory operand names an IAT slot — `call [rip+X]`.
	IatOperand,
	/// The call targets a one-instruction thunk that branches through an IAT
	/// slot — `call sub_1234` where `sub_1234` is `jmp [rip+X]`.
	ImportThunk,
}

/// How much weight a resolution carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolutionConfidence {
	/// The operand names one slot and the import table names one symbol for it.
	/// There is nothing left to guess.
	Exact,
	/// Derived from evidence that narrows the target without proving it.
	///
	/// Nothing produces this yet. It exists so that the first resolution which
	/// *is* a narrowing — a vtable slot, a value recovered by dataflow — has a
	/// place to land, and so a caller switching on this enum today already
	/// handles the shape it will arrive in. Do not delete it as dead.
	Probable,
}

/// One import a call site or thunk resolves to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedImport {
	/// RVA of the import address table slot the call indirects through.
	pub iat_rva: u64,
	/// Module name as written in the import descriptor, e.g. "KERNEL32.dll".
	pub module: String,
	/// Symbol name, absent for an import by ordinal.
	pub symbol: Option<String>,
	/// Ordinal, present for an import by ordinal.
	pub ordinal: Option<u16>,
	/// Which of the two shapes named this import.
	pub method: IndirectResolutionMethod,
	/// How much weight the resolution carries.
	pub confidence: ResolutionConfidence,
}

/// One call site whose callee the decoder could not name, and what — if
/// anything — the import table names for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndirectCallSite {
	/// RVA of the calling instruction.
	pub site: u64,
	/// The import the site indirects through, when exactly one is named.
	/// Absent means unresolved, never "probably nothing".
	pub resolved: Option<ResolvedImport>,
}

/// One direct inter-function edge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallGraphEdge {
	/// RVA of the referencing instruction.
	pub site: u64,
	/// RVA referred to.
	pub target: u64,
	/// Kind of reference the site makes.
	pub kind: XrefKind,
	/// Entry of the detected function containing the site, when one owns it.
	pub site_function_rva: Option<u64>,
	/// Entry of the detected function containing the target, when one owns it.
	pub target_function_rva: Option<u64>,
	/// Whether this is a branch that leaves its own function — a tail call
	/// rather than intra-function control flow.
	pub tail_call: bool,
	/// The import this edge really reaches, when its target is nothing but a
	/// thunk into the IAT. The edge still names the thunk; this names what the
	/// thunk is for.
	pub resolved_import: Option<ResolvedImport>,
}

/// A bounded direct call graph around one function.
///
/// The three lists are bounded independently. A function with thousands of
/// callers still reports its handful of callees in full, and each list carries
/// its untruncated total so a caller can tell a complete answer from a page of
/// one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallGraph {
	/// Entry of the function the graph is centred on.
	pub function_rva: u64,
	/// Edges arriving at the entry, ordered by site RVA.
	pub callers: Vec<CallGraphEdge>,
	/// Edges leaving the function, ordered by site RVA.
	pub callees: Vec<CallGraphEdge>,
	/// Call sites inside the function whose callee the decoder cannot name,
	/// ordered by RVA. Each carries the import it indirects through when one is
	/// named for it.
	pub indirect_call_sites: Vec<IndirectCallSite>,
	/// Caller edges before the bound was applied.
	pub caller_total: usize,
	/// Callee edges before the bound was applied.
	pub callee_total: usize,
	/// Indirect call sites before the bound was applied, resolved or not.
	pub indirect_call_site_total: usize,
	/// Indirect call sites before the bound was applied that could **not** be
	/// resolved.
	///
	/// A total over every site, never over the returned page: this is the number
	/// the completeness claim rests on, and a claim computed from a page would
	/// be a claim about the page.
	pub unresolved_indirect_call_site_total: usize,
	/// Whether caller edges were omitted.
	pub callers_truncated: bool,
	/// Whether callee edges were omitted.
	pub callees_truncated: bool,
	/// Whether unresolved call sites were omitted.
	pub indirect_truncated: bool,
}

/// Aggregate structure counts for one function.
///
/// Every count summarises the same derivation the bounded results expose, so a
/// caller can decide whether fetching the detail is worthwhile without first
/// paging through it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionProfile {
	/// Function entry RVA.
	pub function_rva: u64,
	/// The function's own recorded end, absent when no source recorded one.
	pub end_rva: Option<u64>,
	/// Whether the extent came from a recorded end.
	pub bounded: bool,
	/// Decoded instructions inside the extent.
	pub instruction_count: usize,
	/// Bytes inside the extent covered by decoded instructions. Less than the
	/// extent when the function contains data or undecoded gaps.
	pub decoded_extent_bytes: u64,
	/// Basic blocks inside the extent.
	pub block_count: usize,
	/// Direct intra-function control-flow edges inside the extent.
	pub edge_count: usize,
	/// Sites elsewhere that reference the entry.
	pub incoming_call_site_count: usize,
	/// Distinct detected functions containing those sites.
	pub incoming_caller_function_count: usize,
	/// Sites inside the extent that reference code the function does not own.
	pub outgoing_call_site_count: usize,
	/// Distinct detected functions those sites resolve to.
	pub outgoing_target_function_count: usize,
	/// Call sites inside the extent whose callee is not statically known.
	pub indirect_call_site_count: usize,
	/// How many of those the import table names a target for.
	pub resolved_indirect_call_site_count: usize,
	/// Instructions inside the extent that return from the function.
	pub return_count: usize,
}

/// Resolves an exact detected function entry to its half-open extent.
///
/// `functions` is sorted by entry RVA, which is what makes the lookup a binary
/// search. Three bounds are tried, strongest evidence first:
///
/// 1. the function's own recorded end, when a source recorded one;
/// 2. the entry of the next detected function;
/// 3. the end of the contiguous run of decoded instructions leaving the entry.
///
/// The third exists because the last function in an image has neither of the
/// first two — the PE entry-point seed is recorded with no end, and nothing
/// follows it — and refusing every structure query for it is worse than
/// answering from the instructions the analysis actually decoded. Only the first
/// sets [`FunctionExtent::recorded_end`], so a caller can still tell a recorded
/// extent from an inferred one.
///
/// An entry with no decoded instruction at all still has no extent. There is a
/// difference between inferring a boundary from evidence and inventing one.
pub fn function_extent(
	functions: &[Function],
	flows: &[InstructionFlow],
	function_rva: u64,
) -> Result<FunctionExtent, ExtentError> {
	let index = functions
		.binary_search_by_key(&function_rva, |function| function.rva)
		.map_err(|_| ExtentError::NoFunctionAtRva)?;
	let function = &functions[index];
	let end = function
		.end_rva
		.or_else(|| functions.get(index + 1).map(|next| next.rva))
		.or_else(|| decoded_run_end(flows, function.rva))
		.ok_or(ExtentError::Unbounded)?;

	Ok(FunctionExtent {
		start: function.rva,
		end,
		recorded_end: function.end_rva,
	})
}

/// The exclusive end of the unbroken run of decoded instructions from `start`.
///
/// The run stops at the first gap: an address the analysis decoded nothing at is
/// not evidence the function continues through it. `flows` is sorted and
/// deduplicated by RVA, so finding the entry is a binary search and the walk
/// visits only the run itself. `None` when nothing was decoded at `start`.
fn decoded_run_end(flows: &[InstructionFlow], start: u64) -> Option<u64> {
	let first = flows.partition_point(|fact| fact.rva < start);
	let entry = flows.get(first).filter(|fact| fact.rva == start)?;
	let mut end = entry.rva.saturating_add(entry.len as u64);
	for fact in &flows[first + 1..] {
		if fact.rva != end {
			break;
		}
		end = fact.rva.saturating_add(fact.len as u64);
	}
	Some(end)
}

/// The entry of the detected function containing `rva`, when one owns it.
///
/// Functions arrive sorted by entry, so this is a binary search for the last
/// entry at or below the address. A recorded end is enforced: an address in the
/// padding after a function belongs to no function, and saying otherwise invents
/// ownership the analysis never claimed. The workbench's `containingFunction`
/// answers the same question the same way, and the two must not disagree.
pub fn containing_function(functions: &[Function], rva: u64) -> Option<u64> {
	let index = functions.partition_point(|function| function.rva <= rva);
	if let Some(candidate) = index.checked_sub(1).and_then(|index| functions.get(index)) {
		match candidate.end_rva {
			Some(end) if rva >= end => {}
			_ => return Some(candidate.rva),
		}
	}
	// The address is past the preceding entry's extent, but a split function's
	// later pieces sit outside that extent by construction, and one of them may
	// own this address. Searched only after the contiguous answer fails, so the
	// common case still costs one binary search.
	containing_fragment(functions, rva)
}

/// The entry of the function one of whose chained fragments covers `rva`.
///
/// Fragments are rare and scattered, so this is a linear scan over the functions
/// that have any rather than an index — building one would cost more than it
/// saves on every image that has no split functions at all.
fn containing_fragment(functions: &[Function], rva: u64) -> Option<u64> {
	functions
		.iter()
		.find(|function| {
			function
				.fragments
				.iter()
				.any(|fragment| fragment.contains(&rva))
		})
		.map(|function| function.rva)
}

/// Builds the bounded direct call graph around one function extent.
///
/// Each list is truncated to `max_edges` independently and reports its own
/// untruncated total. Ordering is by site RVA in every list, which the xref
/// table's two orderings already provide.
///
/// `imports` is the image's import table, indexed once here by IAT slot. On a
/// Windows binary the most common outgoing call is a call to an imported API,
/// and both shapes it takes — a `call [rip+X]` straight through the slot and a
/// call to a one-instruction thunk that jumps through it — are named exactly by
/// facts already on hand. Naming them is what keeps
/// [`CallGraph::unresolved_indirect_call_site_total`] an honest number instead
/// of a count of everything the graph declined to look at.
pub fn call_graph(
	functions: &[Function],
	xrefs: &XrefTable,
	flows: &[InstructionFlow],
	imports: &[ImportedModule],
	extent: FunctionExtent,
	max_edges: usize,
) -> CallGraph {
	let index = ImportIndex::new(imports);

	let callers: Vec<_> = xrefs
		.to(extent.start)
		.iter()
		.map(|xref| edge(functions, xref))
		.collect();
	let callees: Vec<_> = xrefs
		.range_from(extent.start, extent.end)
		.iter()
		.filter(|xref| is_outgoing_call(extent, xref))
		.map(|xref| CallGraphEdge {
			resolved_import: resolve_import_thunk(functions, xrefs, flows, &index, xref.to),
			..edge(functions, xref)
		})
		.collect();
	let indirect: Vec<_> = flows_in(flows, extent)
		.iter()
		.filter(|fact| is_unresolved_call(fact))
		.map(|fact| IndirectCallSite {
			site: fact.rva,
			resolved: resolve_iat_operand(xrefs, &index, fact.rva),
		})
		.collect();
	// Counted before the bound: a completeness claim computed from a page would
	// be a claim about the page.
	let unresolved_indirect_call_site_total = indirect
		.iter()
		.filter(|site| site.resolved.is_none())
		.count();

	let (callers, caller_total, callers_truncated) = bound(callers, max_edges);
	let (callees, callee_total, callees_truncated) = bound(callees, max_edges);
	let (indirect_call_sites, indirect_call_site_total, indirect_truncated) =
		bound(indirect, max_edges);

	CallGraph {
		function_rva: extent.start,
		callers,
		callees,
		indirect_call_sites,
		caller_total,
		callee_total,
		indirect_call_site_total,
		unresolved_indirect_call_site_total,
		callers_truncated,
		callees_truncated,
		indirect_truncated,
	}
}

/// Summarises one function extent.
///
/// The profile describes the complete graph, never a bounded page of it, so the
/// shared derivation runs unbounded here.
pub fn function_profile(
	functions: &[Function],
	xrefs: &XrefTable,
	flows: &[InstructionFlow],
	imports: &[ImportedModule],
	extent: FunctionExtent,
) -> FunctionProfile {
	let graph = call_graph(functions, xrefs, flows, imports, extent, usize::MAX);
	let (blocks, edges) = control_flow::basic_blocks(flows, extent.start, extent.end);
	let inside = flows_in(flows, extent);

	// Clamped so an instruction running past the extent cannot report more
	// coverage than the extent has to give.
	let decoded_extent_bytes: u64 = inside
		.iter()
		.map(|fact| {
			fact.rva
				.saturating_add(fact.len as u64)
				.min(extent.end)
				.saturating_sub(fact.rva)
		})
		.sum();

	FunctionProfile {
		function_rva: extent.start,
		end_rva: extent.recorded_end,
		bounded: extent.bounded(),
		instruction_count: inside.len(),
		decoded_extent_bytes,
		block_count: blocks.len(),
		edge_count: edges.len(),
		incoming_call_site_count: graph.caller_total,
		incoming_caller_function_count: distinct(
			graph
				.callers
				.iter()
				.filter_map(|edge| edge.site_function_rva),
		),
		outgoing_call_site_count: graph.callee_total,
		outgoing_target_function_count: distinct(
			graph
				.callees
				.iter()
				.filter_map(|edge| edge.target_function_rva),
		),
		indirect_call_site_count: graph.indirect_call_site_total,
		// From the two totals, never from the returned list: the profile has to
		// agree with the graph even when the graph was paged.
		resolved_indirect_call_site_count: graph
			.indirect_call_site_total
			.saturating_sub(graph.unresolved_indirect_call_site_total),
		return_count: inside
			.iter()
			.filter(|fact| fact.flow == FlowKind::Return)
			.count(),
	}
}

/// Whether an xref leaving the extent is a call-graph edge.
///
/// Data references are excluded: a RIP-relative operand names a global, not a
/// callee, and S4 owns those. A branch whose target stays inside the same
/// function is excluded too — that is intra-function control flow, already
/// answered in full by `analysis/basicBlocks`, and repeating it here would bury
/// the edges that actually leave.
fn is_outgoing_call(extent: FunctionExtent, xref: &Xref) -> bool {
	match xref.kind {
		XrefKind::Data => false,
		XrefKind::Jump | XrefKind::ConditionalJump => !extent.contains(xref.to),
		XrefKind::Call => true,
	}
}

/// Whether an instruction calls a target the decoder cannot name.
///
/// An indirect branch is not one of these. A jump-table dispatch or a tail call
/// through a thunk transfers control without naming a callee, but it is not a
/// call edge the graph is missing, and counting it here inflated the one number
/// a caller uses to decide whether the named edges are the whole story.
fn is_unresolved_call(fact: &InstructionFlow) -> bool {
	matches!(fact.flow, FlowKind::IndirectCall | FlowKind::Call) && fact.branch_target.is_none()
}

/// One import table entry, keyed by the slot a call site indirects through.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ImportSlot {
	module: String,
	symbol: Option<String>,
	ordinal: Option<u16>,
}

/// `iat_rva -> import`, built once per query.
///
/// A slot two entries disagree about maps to `None` rather than to either of
/// them. An import table that names one address twice is malformed, and a
/// malformed table is exactly where guessing does the most damage.
#[derive(Debug, Clone, Default)]
struct ImportIndex {
	slots: BTreeMap<u64, Option<ImportSlot>>,
}

impl ImportIndex {
	fn new(imports: &[ImportedModule]) -> Self {
		let mut slots: BTreeMap<u64, Option<ImportSlot>> = BTreeMap::new();
		for module in imports {
			for symbol in &module.symbols {
				let entry = ImportSlot {
					module: module.name.clone(),
					symbol: symbol.name.clone(),
					ordinal: symbol.ordinal,
				};
				match slots.entry(symbol.iat_rva) {
					Entry::Vacant(vacant) => {
						vacant.insert(Some(entry));
					}
					Entry::Occupied(mut occupied) => {
						// Identical restatements are harmless; a genuine
						// disagreement poisons the slot for good.
						if occupied.get().as_ref() != Some(&entry) {
							occupied.insert(None);
						}
					}
				}
			}
		}
		Self { slots }
	}

	/// Whether the table names exactly one import at `iat_rva`.
	///
	/// A slot the table disagrees with itself about answers `false`. Nothing can
	/// ever resolve to it, so treating it as a real slot would only produce
	/// searches guaranteed to find nothing.
	fn names(&self, iat_rva: u64) -> bool {
		self.slots.get(&iat_rva).is_some_and(|slot| slot.is_some())
	}

	/// Whether the import table claims `iat_rva` at all, named or ambiguous.
	///
	/// This exists only so a refusal can say *which* problem it hit. "Not an
	/// import slot" is the wrong sentence to hand an analyst whose import table
	/// is malformed — it sends them looking for a typo in the address instead of
	/// at the sample.
	fn claims(&self, iat_rva: u64) -> bool {
		self.slots.contains_key(&iat_rva)
	}

	/// The unambiguous import at `iat_rva`, if the table names exactly one.
	fn resolve(&self, iat_rva: u64, method: IndirectResolutionMethod) -> Option<ResolvedImport> {
		let slot = self.slots.get(&iat_rva)?.as_ref()?;
		Some(ResolvedImport {
			iat_rva,
			module: slot.module.clone(),
			symbol: slot.symbol.clone(),
			ordinal: slot.ordinal,
			method,
			// The operand names one slot and the import table names one symbol
			// for it. Nothing here was inferred.
			confidence: ResolutionConfidence::Exact,
		})
	}
}

/// Resolves the single IAT slot an instruction's memory operand names.
///
/// Exactly one data reference, naming exactly one import, or nothing. An
/// instruction with two memory operands offers no way to tell which one the
/// call goes through, and a slot the import table does not claim is not an
/// import however much it looks like one.
fn resolve_slot_operand(
	xrefs: &XrefTable,
	imports: &ImportIndex,
	rva: u64,
	method: IndirectResolutionMethod,
) -> Option<ResolvedImport> {
	let mut data = xrefs
		.from(rva)
		.iter()
		.filter(|xref| xref.kind == XrefKind::Data);
	let slot = data.next()?;
	if data.next().is_some() {
		return None;
	}
	imports.resolve(slot.to, method)
}

/// Resolves `call [rip+X]` — the call's own operand names the IAT slot.
fn resolve_iat_operand(
	xrefs: &XrefTable,
	imports: &ImportIndex,
	site: u64,
) -> Option<ResolvedImport> {
	resolve_slot_operand(xrefs, imports, site, IndirectResolutionMethod::IatOperand)
}

/// Resolves a direct call to an import thunk — `jmp [rip+X]` and nothing else.
///
/// The thunk test is deliberately narrow: a detected function at `target` whose
/// extent holds exactly one decoded instruction, that instruction being an
/// indirect branch through a single IAT slot. Anything longer is a function that
/// happens to end in an indirect branch, which is a different claim entirely.
/// One hop only — a chain of thunks is not followed, because each further hop
/// is another assumption about a target nobody has proven.
fn resolve_import_thunk(
	functions: &[Function],
	xrefs: &XrefTable,
	flows: &[InstructionFlow],
	imports: &ImportIndex,
	target: u64,
) -> Option<ResolvedImport> {
	// Fails closed when nothing is detected at `target`, which is also the test
	// for "the edge points at a detected function".
	let extent = function_extent(functions, flows, target).ok()?;
	let [only] = flows_in(flows, extent) else {
		return None;
	};
	if only.rva != target || only.flow != FlowKind::IndirectBranch {
		return None;
	}
	resolve_slot_operand(
		xrefs,
		imports,
		target,
		IndirectResolutionMethod::ImportThunk,
	)
}

/// The retained flow facts inside a half-open extent.
///
/// `AnalyzedImage::instruction_flows` is sorted and deduplicated by RVA, so both
/// bounds are a binary search rather than a scan of the whole image.
fn flows_in(flows: &[InstructionFlow], extent: FunctionExtent) -> &[InstructionFlow] {
	if extent.end <= extent.start {
		return &[];
	}
	let lo = flows.partition_point(|fact| fact.rva < extent.start);
	let hi = flows.partition_point(|fact| fact.rva < extent.end);
	&flows[lo..hi]
}

/// Builds one edge, resolving both endpoints to their owning functions.
fn edge(functions: &[Function], xref: &Xref) -> CallGraphEdge {
	let site_function_rva = containing_function(functions, xref.from);
	let target_function_rva = containing_function(functions, xref.to);

	CallGraphEdge {
		site: xref.from,
		target: xref.to,
		kind: xref.kind,
		site_function_rva,
		target_function_rva,
		// A branch landing in a different function than the one it came from is
		// a tail call. For an outgoing edge that is exactly "the target is
		// outside our own extent"; for an incoming one it is the same test read
		// from the caller's side.
		tail_call: matches!(xref.kind, XrefKind::Jump | XrefKind::ConditionalJump)
			&& site_function_rva != target_function_rva,
		// Filled in by the caller for outgoing edges only. An incoming edge's
		// target is the function being asked about, not a thunk.
		resolved_import: None,
	}
}

/// Truncates a list, reporting what it held before the bound was applied.
fn bound<T>(mut items: Vec<T>, max_edges: usize) -> (Vec<T>, usize, bool) {
	let total = items.len();
	items.truncate(max_edges);
	(items, total, total > max_edges)
}

/// Counts distinct values.
fn distinct(values: impl Iterator<Item = u64>) -> usize {
	values.collect::<BTreeSet<_>>().len()
}

/// What a path search is looking for.
///
/// A sink is one of exactly two things, and which one it is decides what counts
/// as an arriving edge. Nothing else is accepted: a search for an RVA that is
/// neither would explore the whole reachable set and then report an absence it
/// never had the means to observe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sink {
	/// An exact detected function entry.
	Function(u64),
	/// An import address table slot the import table names one import for.
	Import(u64),
}

/// Why a requested path sink could not be resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallPathSinkError {
	/// `to_rva` is neither an exact detected function entry nor an IAT slot the
	/// import table names exactly one import for.
	///
	/// An ambiguous slot — one two import descriptors disagree about — is
	/// refused here rather than accepted and searched for. No edge can ever
	/// resolve to it, so accepting it would guarantee an empty result that looks
	/// exactly like a proof of absence.
	NotFunctionOrImportSlot,
	/// `to_rva` is an IAT slot two import descriptors disagree about.
	///
	/// Refused for the same reason, but reported separately: the address was
	/// right and the sample's import table is malformed, which is a finding in
	/// its own right rather than a mistake by the caller.
	AmbiguousImportSlot,
}

/// One call in an ordered path, with the exact instruction that makes it.
///
/// The call site is not decoration. A path of function entries is a claim a
/// human has to take on trust; a path of call sites is one they can go and look
/// at, which is the whole reason for returning evidence rather than a summary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallPathStep {
	/// Entry of the function the step leaves.
	pub from_function_rva: u64,
	/// RVA of the calling instruction.
	pub call_site: u64,
	/// Entry of the detected function the step lands in. Absent when the step
	/// lands straight on an import through an IAT slot, which no function owns.
	pub to_function_rva: Option<u64>,
	/// The import this step really reaches, when the target is an IAT slot or a
	/// one-instruction thunk into one. A thunk step still names the thunk in
	/// [`Self::to_function_rva`]; this names what the thunk is for.
	pub resolved_import: Option<ResolvedImport>,
	/// Kind of reference the site makes.
	pub kind: XrefKind,
	/// Whether the step is a branch that leaves its own function — a tail call
	/// rather than intra-function control flow.
	pub tail_call: bool,
}

/// One ordered source-to-sink path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallPath {
	/// Steps in call order, the first leaving the source function and the last
	/// arriving at the sink. Empty only when source and sink are the same
	/// function, which is reached in no steps at all.
	pub steps: Vec<CallPathStep>,
}

/// A bounded path search between one function and one sink.
///
/// **An empty [`Self::paths`] is not a proof of absence.** Every bound this
/// search respects marks a place a path could have been and was not looked at,
/// so the completeness signals travel with the result and a negative answer
/// is a claim about the program only when all of them are clean — see
/// [`Self::proves_absence`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallPaths {
	/// Entry of the function the search started from.
	pub from_rva: u64,
	/// The requested sink: a function entry or an IAT slot.
	pub to_rva: u64,
	/// Distinct simple paths found, shortest first. No function repeats within a
	/// single path, so recursion cannot spin one out forever.
	pub paths: Vec<CallPath>,
	/// Whether at least one further path was reached beyond the requested bound.
	///
	/// Set only when an extra path was genuinely found, never merely because the
	/// bound was met.
	pub paths_truncated: bool,
	/// Whether the whole reachable set within the limits was explored.
	///
	/// False when the visit budget or the path bound stopped the walk, and false
	/// when a function on the frontier had no derivable extent and so could not
	/// have its edges enumerated at all. A depth cut does *not* clear this —
	/// depth is one of the limits, and [`Self::depth_limit_reached`] reports it
	/// on its own.
	pub search_exhausted: bool,
	/// Whether some edge was dropped because following it would have exceeded
	/// the depth bound. The frontier below that edge is unexplored.
	pub depth_limit_reached: bool,
	/// Whether the visit budget ran out with work still queued.
	pub visit_limit_reached: bool,
	/// Distinct functions whose outgoing edges were expanded.
	///
	/// A count of functions, not of work: a function is expanded once per
	/// distinct path prefix that reaches it, and `max_visited` bounds those
	/// expansions rather than this number.
	pub visited_function_count: u64,
	/// Call sites with no nameable callee, found in the functions this search
	/// actually expanded.
	///
	/// **Not an image-wide total.** It counts only the frontier the search
	/// touched, which is exactly the set where a hidden edge would have changed
	/// this answer. A call through a register or a vtable is where a real sample
	/// hides the path being looked for, so a non-zero count here forbids reading
	/// an empty result as "no path exists".
	pub unresolved_indirect_sites_on_frontier: u64,
	/// Distinct expanded functions whose extents were inferred rather than
	/// recorded. Their edge sets are useful but cannot support a proof of
	/// absence, because the inferred end can hide or over-include a call site.
	pub unbounded_functions_on_frontier: u64,
}

impl CallPaths {
	/// Whether an empty [`Self::paths`] is a claim that no path exists.
	///
	/// The rule, in one place so nobody has to reassemble it: the search found
	/// nothing, it ran to exhaustion, no bound cut a frontier, and every call
	/// site it passed had a nameable callee. Anything less means "this search
	/// did not find one", which is a different sentence.
	pub fn proves_absence(&self) -> bool {
		self.paths.is_empty()
			&& self.search_exhausted
			&& !self.depth_limit_reached
			&& !self.visit_limit_reached
			&& self.unresolved_indirect_sites_on_frontier == 0
			&& self.unbounded_functions_on_frontier == 0
	}
}

/// One partial path waiting to be extended.
///
/// Each frontier carries its own visited set rather than sharing one across the
/// search. "Already on this path" is what stops recursion spinning; a set shared
/// across the whole walk would also drop the second of two genuinely distinct
/// paths through the same function, which is the thing being asked for.
struct Frontier {
	/// Steps taken to get here, in call order.
	steps: Vec<CallPathStep>,
	/// Functions already on this path, source first. Bounded by `max_depth`, so
	/// a linear membership test costs less than a set.
	on_path: Vec<u64>,
	/// The function whose edges are expanded next.
	at: u64,
}

/// Enumerates bounded simple call paths from one function to one sink.
///
/// Breadth-first over the same outgoing edges [`call_graph`] classifies, so a
/// path and a graph can never disagree about what an edge is. Nothing is
/// materialised in advance: a function's edges are derived when its frontier is
/// popped, from the xref table and the retained flows, and the walk stops at the
/// first bound it meets. An image with a million functions costs whatever the
/// reachable frontier costs and not one edge more.
///
/// `from` is the source function's already-resolved extent, so the fail-closed
/// resolution every other structure query uses applies to it unchanged. `to_rva`
/// is resolved here, to a function entry or to an IAT slot; an import sink is
/// the question that actually gets asked of a malware sample — "what reaches
/// `VirtualAlloc`?" — and the resolved-import edges already make it answerable.
///
/// Every bound marks a place a path could have been and was not looked at, which
/// is why the result reports every completeness signal. See
/// [`CallPaths::proves_absence`] for the only condition under which an empty
/// result is a statement about the program rather than about the search.
// The three bounds could be a struct, but they are three independent scalars a
// caller tunes independently, and hiding them behind a type would only move the
// argument list somewhere less visible.
#[allow(clippy::too_many_arguments)]
pub fn call_paths(
	functions: &[Function],
	xrefs: &XrefTable,
	flows: &[InstructionFlow],
	imports: &[ImportedModule],
	from: FunctionExtent,
	to_rva: u64,
	max_depth: usize,
	max_paths: usize,
	max_visited: usize,
) -> Result<CallPaths, CallPathSinkError> {
	let index = ImportIndex::new(imports);
	let sink = resolve_sink(functions, &index, to_rva)?;

	if sink == Sink::Function(from.start) {
		// A function reaches itself in no steps. Saying so is honest; reporting
		// nothing because a simple path may not repeat a function would be a
		// negative answer manufactured out of the search's own rule.
		return Ok(CallPaths {
			from_rva: from.start,
			to_rva,
			paths: vec![CallPath { steps: Vec::new() }],
			paths_truncated: false,
			search_exhausted: true,
			depth_limit_reached: false,
			visit_limit_reached: false,
			visited_function_count: 0,
			unresolved_indirect_sites_on_frontier: 0,
			unbounded_functions_on_frontier: 0,
		});
	}

	let mut queue = VecDeque::from([Frontier {
		steps: Vec::new(),
		on_path: vec![from.start],
		at: from.start,
	}]);
	let mut paths: Vec<CallPath> = Vec::new();
	let mut expanded: BTreeSet<u64> = BTreeSet::new();
	let mut expansions = 0usize;
	let mut unresolved_indirect_sites_on_frontier = 0u64;
	let mut unbounded_functions_on_frontier = 0u64;
	let mut depth_limit_reached = false;
	let mut visit_limit_reached = false;
	let mut paths_truncated = false;
	// Cleared by anything that leaves part of the reachable set unlooked-at.
	let mut exhausted = true;

	'search: while let Some(frontier) = queue.pop_front() {
		if expansions >= max_visited {
			visit_limit_reached = true;
			exhausted = false;
			break 'search;
		}
		expansions += 1;

		// The source's extent is already resolved; every other frontier function
		// is resolved the same fail-closed way. One that cannot be bounded is one
		// whose edges nobody can enumerate, so the reachable set below it stays
		// unexplored and the search is not exhausted.
		let extent = if frontier.at == from.start {
			from
		} else {
			match function_extent(functions, flows, frontier.at) {
				Ok(extent) => extent,
				Err(_) => {
					exhausted = false;
					continue;
				}
			}
		};

		// Once per distinct function, never once per prefix: the same function
		// reached two ways hides the same call sites both times, and counting it
		// twice would inflate the one number the honesty rule rests on.
		if expanded.insert(frontier.at) {
			if frontier.at != from.start && !extent.bounded() {
				unbounded_functions_on_frontier += 1;
			}
			unresolved_indirect_sites_on_frontier +=
				unresolved_indirect_sites(xrefs, flows, &index, extent) as u64;
		}

		for step in outgoing_steps(functions, xrefs, flows, &index, extent, sink) {
			let arrives = reaches(&step, sink);
			let extends = step
				.to_function_rva
				.is_some_and(|next| !frontier.on_path.contains(&next));
			if !arrives && !extends {
				// A dead end: an import that is not the sink, a branch into bytes
				// no function owns, or a function already on this path. Nothing
				// was cut here, so no bound gets to claim it was.
				continue;
			}
			if frontier.steps.len() >= max_depth {
				depth_limit_reached = true;
				continue;
			}

			let next = step.to_function_rva;
			let mut steps = frontier.steps.clone();
			steps.push(step);

			if arrives {
				if paths.len() >= max_paths {
					// A real further path, not merely a bound that was met.
					paths_truncated = true;
					exhausted = false;
					break 'search;
				}
				paths.push(CallPath { steps });
				continue;
			}

			let at = next.expect("an extending step lands on a detected function");
			let mut on_path = frontier.on_path.clone();
			on_path.push(at);
			queue.push_back(Frontier { steps, on_path, at });
		}
	}

	Ok(CallPaths {
		from_rva: from.start,
		to_rva,
		paths,
		paths_truncated,
		search_exhausted: exhausted,
		depth_limit_reached,
		visit_limit_reached,
		visited_function_count: expanded.len() as u64,
		unresolved_indirect_sites_on_frontier,
		unbounded_functions_on_frontier,
	})
}

/// Resolves a requested sink RVA to the one thing it can be.
///
/// Fail-closed, like every other address resolution here. An RVA that is neither
/// an exact detected function entry nor an unambiguously named IAT slot is
/// refused rather than searched for.
fn resolve_sink(
	functions: &[Function],
	imports: &ImportIndex,
	to_rva: u64,
) -> Result<Sink, CallPathSinkError> {
	if functions
		.binary_search_by_key(&to_rva, |function| function.rva)
		.is_ok()
	{
		return Ok(Sink::Function(to_rva));
	}
	if imports.names(to_rva) {
		return Ok(Sink::Import(to_rva));
	}
	if imports.claims(to_rva) {
		return Err(CallPathSinkError::AmbiguousImportSlot);
	}
	Err(CallPathSinkError::NotFunctionOrImportSlot)
}

/// Whether a step arrives at the sink.
fn reaches(step: &CallPathStep, sink: Sink) -> bool {
	match sink {
		Sink::Function(rva) => step.to_function_rva == Some(rva),
		Sink::Import(slot) => step
			.resolved_import
			.as_ref()
			.is_some_and(|import| import.iat_rva == slot),
	}
}

/// Derives the steps leaving one function extent, on demand.
///
/// Direct edges use exactly [`is_outgoing_call`], so the path search and the
/// call graph agree about what an edge is by construction rather than by review.
/// A call straight through an IAT slot names no function and cannot be walked
/// through, so those are emitted only when the slot they name *is* the sink;
/// emitting them otherwise would leave dead ends behind that make a depth cut
/// look as though it hid something.
fn outgoing_steps(
	functions: &[Function],
	xrefs: &XrefTable,
	flows: &[InstructionFlow],
	imports: &ImportIndex,
	extent: FunctionExtent,
	sink: Sink,
) -> Vec<CallPathStep> {
	let mut steps: Vec<CallPathStep> = xrefs
		.range_from(extent.start, extent.end)
		.iter()
		.filter(|xref| is_outgoing_call(extent, xref))
		.map(|xref| {
			let direct = edge(functions, xref);
			CallPathStep {
				from_function_rva: extent.start,
				call_site: xref.from,
				to_function_rva: direct.target_function_rva,
				resolved_import: resolve_import_thunk(functions, xrefs, flows, imports, xref.to),
				kind: xref.kind,
				tail_call: direct.tail_call,
			}
		})
		.collect();

	if let Sink::Import(slot) = sink {
		steps.extend(
			flows_in(flows, extent)
				.iter()
				.filter(|fact| is_unresolved_call(fact))
				.filter_map(|fact| {
					let resolved = resolve_iat_operand(xrefs, imports, fact.rva)
						.filter(|import| import.iat_rva == slot)?;
					Some(CallPathStep {
						from_function_rva: extent.start,
						call_site: fact.rva,
						to_function_rva: None,
						resolved_import: Some(resolved),
						kind: XrefKind::Call,
						tail_call: false,
					})
				}),
		);
		// Two sources merged, so ordering has to be restored explicitly. Evidence
		// in address order is evidence a human can follow down the listing.
		steps.sort_by_key(|step| step.call_site);
	}

	steps
}

/// Call sites inside one extent whose callee nothing names.
///
/// A site the import table resolves is not one of these: its edge is derived,
/// not missing. Only the genuinely unnameable ones can hide a path.
fn unresolved_indirect_sites(
	xrefs: &XrefTable,
	flows: &[InstructionFlow],
	imports: &ImportIndex,
	extent: FunctionExtent,
) -> usize {
	flows_in(flows, extent)
		.iter()
		.filter(|fact| is_unresolved_call(fact))
		.filter(|fact| resolve_iat_operand(xrefs, imports, fact.rva).is_none())
		.count()
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::FunctionSource;
	use delver_format::ImportedSymbol;

	fn function(rva: u64, end_rva: Option<u64>) -> Function {
		Function {
			rva,
			end_rva,
			source: FunctionSource::ExceptionDirectory,
			fragments: Vec::new(),
		}
	}

	/// Three bounded functions — `0x1000`, `0x1040`, `0x1080` — with `0x1090`
	/// onwards owned by nothing.
	fn functions() -> Vec<Function> {
		vec![
			function(0x1000, Some(0x1040)),
			function(0x1040, Some(0x1080)),
			function(0x1080, Some(0x1090)),
		]
	}

	fn xref(from: u64, to: u64, kind: XrefKind) -> Xref {
		Xref { from, to, kind }
	}

	fn xrefs() -> XrefTable {
		XrefTable::new(vec![
			// Leaving 0x1000.
			xref(0x1004, 0x1040, XrefKind::Call),
			xref(0x1008, 0x1020, XrefKind::ConditionalJump),
			xref(0x100C, 0x1080, XrefKind::Jump),
			xref(0x1010, 0x3000, XrefKind::Data),
			xref(0x1014, 0x1000, XrefKind::Call),
			// Arriving at 0x1000.
			xref(0x1044, 0x1000, XrefKind::Call),
			xref(0x1095, 0x1000, XrefKind::Jump),
		])
	}

	fn flow(rva: u64, len: u32, flow: FlowKind, branch_target: Option<u64>) -> InstructionFlow {
		InstructionFlow {
			rva,
			len,
			flow,
			branch_target,
		}
	}

	fn flows() -> Vec<InstructionFlow> {
		vec![
			flow(0x1000, 4, FlowKind::Sequential, None),
			flow(0x1004, 5, FlowKind::Call, Some(0x1040)),
			flow(0x1009, 2, FlowKind::IndirectCall, None),
			flow(0x1030, 3, FlowKind::IndirectCall, None),
			flow(0x1033, 1, FlowKind::Return, None),
			flow(0x1040, 1, FlowKind::Return, None),
		]
	}

	fn extent() -> FunctionExtent {
		function_extent(&functions(), &flows(), 0x1000).unwrap()
	}

	fn graph(max_edges: usize) -> CallGraph {
		call_graph(&functions(), &xrefs(), &flows(), &[], extent(), max_edges)
	}

	/// The RVAs of the returned indirect sites, ignoring what they resolve to.
	fn sites(graph: &CallGraph) -> Vec<u64> {
		graph
			.indirect_call_sites
			.iter()
			.map(|site| site.site)
			.collect()
	}

	fn module(name: &str, symbols: Vec<ImportedSymbol>) -> ImportedModule {
		ImportedModule {
			name: name.to_string(),
			symbols,
			..Default::default()
		}
	}

	fn symbol(name: Option<&str>, ordinal: Option<u16>, iat_rva: u64) -> ImportedSymbol {
		ImportedSymbol {
			name: name.map(str::to_string),
			ordinal,
			iat_rva,
			..Default::default()
		}
	}

	/// One import: `KERNEL32.dll!CreateFileW` in the IAT slot at `0x4000`.
	fn imports() -> Vec<ImportedModule> {
		vec![module(
			"KERNEL32.dll",
			vec![symbol(Some("CreateFileW"), None, 0x4000)],
		)]
	}

	fn create_file_w(method: IndirectResolutionMethod) -> ResolvedImport {
		ResolvedImport {
			iat_rva: 0x4000,
			module: "KERNEL32.dll".to_string(),
			symbol: Some("CreateFileW".to_string()),
			ordinal: None,
			method,
			confidence: ResolutionConfidence::Exact,
		}
	}

	#[test]
	fn resolution_is_exact_and_fails_closed() {
		let unbounded = vec![function(0x1000, None)];
		assert_eq!(
			(
				function_extent(&functions(), &flows(), 0x1004).unwrap_err(),
				// No recorded end, no next function, and nothing decoded either.
				function_extent(&unbounded, &[], 0x1000).unwrap_err(),
				function_extent(&functions(), &flows(), 0x1000).unwrap(),
			),
			(
				ExtentError::NoFunctionAtRva,
				ExtentError::Unbounded,
				FunctionExtent {
					start: 0x1000,
					end: 0x1040,
					recorded_end: Some(0x1040),
				},
			)
		);
	}

	#[test]
	fn an_inferred_extent_ends_at_the_next_function_and_says_so() {
		let functions = vec![function(0x1000, None), function(0x1040, None)];
		let extent = function_extent(&functions, &flows(), 0x1000).unwrap();
		assert_eq!(
			(extent.end, extent.recorded_end, extent.bounded()),
			(0x1040, None, false)
		);
	}

	#[test]
	fn a_contiguous_run_of_instructions_bounds_the_last_function() {
		// The last function in every image looks like this: the PE entry-point
		// seed records no end, and nothing is detected after it.
		let functions = vec![function(0x1000, None)];
		let flows = vec![
			flow(0x1000, 4, FlowKind::Sequential, None),
			flow(0x1004, 5, FlowKind::Call, Some(0x2000)),
			flow(0x1009, 1, FlowKind::Return, None),
		];
		let extent = function_extent(&functions, &flows, 0x1000).unwrap();
		assert_eq!(
			(extent.end, extent.recorded_end, extent.bounded()),
			// Inferred, and it says so: the run is evidence, not a boundary the
			// image vouched for.
			(0x100A, None, false)
		);
	}

	#[test]
	fn the_run_stops_at_the_first_undecoded_gap() {
		let functions = vec![function(0x1000, None)];
		let flows = vec![
			flow(0x1000, 4, FlowKind::Sequential, None),
			flow(0x1004, 2, FlowKind::Return, None),
			// A byte of padding, then unrelated code the run must not swallow.
			flow(0x1007, 1, FlowKind::Return, None),
		];
		assert_eq!(
			function_extent(&functions, &flows, 0x1000).unwrap().end,
			0x1006
		);
	}

	#[test]
	fn the_next_function_bounds_the_extent_before_the_run_does() {
		let functions = vec![function(0x1000, None), function(0x1004, None)];
		let flows = vec![
			flow(0x1000, 4, FlowKind::Sequential, None),
			flow(0x1004, 1, FlowKind::Return, None),
		];
		// The run reaches 0x1005, but a detected entry at 0x1004 is the better
		// evidence and has to win.
		assert_eq!(
			function_extent(&functions, &flows, 0x1000).unwrap().end,
			0x1004
		);
	}

	#[test]
	fn an_entry_with_no_decoded_instruction_still_has_no_extent() {
		let functions = vec![function(0x1000, None)];
		// Facts exist, but none of them start at the entry. There is nothing to
		// infer from, and inventing an extent is worse than refusing one.
		let flows = vec![flow(0x1004, 1, FlowKind::Return, None)];
		assert_eq!(
			function_extent(&functions, &flows, 0x1000).unwrap_err(),
			ExtentError::Unbounded
		);
	}

	#[test]
	fn padding_after_a_function_belongs_to_no_function() {
		let functions = functions();
		assert_eq!(
			(
				containing_function(&functions, 0x1000),
				containing_function(&functions, 0x103F),
				containing_function(&functions, 0x1095),
				containing_function(&functions, 0x0FFF),
			),
			(Some(0x1000), Some(0x1000), None, None)
		);
	}

	#[test]
	fn classifies_callers_and_callees_and_marks_tail_calls() {
		let graph = graph(usize::MAX);
		assert_eq!(
			(
				graph
					.callers
					.iter()
					.map(|edge| (edge.site, edge.site_function_rva, edge.kind, edge.tail_call))
					.collect::<Vec<_>>(),
				graph
					.callees
					.iter()
					.map(|edge| (
						edge.site,
						edge.target_function_rva,
						edge.kind,
						edge.tail_call
					))
					.collect::<Vec<_>>(),
			),
			(
				vec![
					// A self-recursive call is genuinely an incoming edge.
					(0x1014, Some(0x1000), XrefKind::Call, false),
					(0x1044, Some(0x1040), XrefKind::Call, false),
					// A branch in from unowned bytes: no site function, and a
					// branch crossing a function boundary is a tail call.
					(0x1095, None, XrefKind::Jump, true),
				],
				vec![
					(0x1004, Some(0x1040), XrefKind::Call, false),
					(0x100C, Some(0x1080), XrefKind::Jump, true),
					(0x1014, Some(0x1000), XrefKind::Call, false),
				],
			)
		);
	}

	#[test]
	fn intra_function_branches_and_data_references_are_not_call_edges() {
		assert_eq!(
			graph(usize::MAX)
				.callees
				.iter()
				.map(|edge| edge.site)
				.collect::<Vec<_>>(),
			// 0x1008 branches inside the same function and 0x1010 is a data
			// reference; neither is an edge in a call graph.
			vec![0x1004, 0x100C, 0x1014]
		);
	}

	#[test]
	fn unresolved_call_sites_come_from_retained_flows_inside_the_extent() {
		let graph = graph(usize::MAX);
		assert_eq!(
			(sites(&graph), graph.indirect_call_site_total),
			// 0x1004 is a direct call and carries a target; 0x1040 lies outside
			// the extent entirely.
			(vec![0x1009, 0x1030], 2)
		);
	}

	#[test]
	fn an_indirect_branch_is_not_an_unresolved_call_site() {
		let functions = functions();
		let flows = vec![
			flow(0x1000, 2, FlowKind::IndirectCall, None),
			// A jump-table dispatch names no callee, but it is not a call edge
			// the graph is missing either.
			flow(0x1002, 2, FlowKind::IndirectBranch, None),
		];
		let extent = function_extent(&functions, &flows, 0x1000).unwrap();
		let graph = call_graph(&functions, &xrefs(), &flows, &[], extent, usize::MAX);
		assert_eq!(
			(sites(&graph), graph.indirect_call_site_total),
			(vec![0x1000], 1)
		);
	}

	#[test]
	fn each_list_is_bounded_independently_and_keeps_its_total() {
		let graph = graph(1);
		assert_eq!(
			(
				graph
					.callers
					.iter()
					.map(|edge| edge.site)
					.collect::<Vec<_>>(),
				graph
					.callees
					.iter()
					.map(|edge| edge.site)
					.collect::<Vec<_>>(),
				sites(&graph),
				(
					graph.caller_total,
					graph.callee_total,
					graph.indirect_call_site_total
				),
				(
					graph.callers_truncated,
					graph.callees_truncated,
					graph.indirect_truncated
				),
			),
			(
				vec![0x1014],
				vec![0x1004],
				vec![0x1009],
				(3, 3, 2),
				(true, true, true),
			)
		);
	}

	#[test]
	fn a_profile_summarises_the_same_derivation() {
		assert_eq!(
			function_profile(&functions(), &xrefs(), &flows(), &[], extent()),
			FunctionProfile {
				function_rva: 0x1000,
				end_rva: Some(0x1040),
				bounded: true,
				instruction_count: 5,
				// 0x40 bytes of extent, 15 of them decoded: the rest is a gap.
				decoded_extent_bytes: 15,
				// 0x1000-0x100B is one run, and 0x1030's indirect call returns to
				// fall through into 0x1033, so those two share a block.
				block_count: 2,
				edge_count: 0,
				incoming_call_site_count: 3,
				incoming_caller_function_count: 2,
				outgoing_call_site_count: 3,
				outgoing_target_function_count: 3,
				indirect_call_site_count: 2,
				// No import table in this fixture, so neither site can be named.
				resolved_indirect_call_site_count: 0,
				return_count: 1,
			}
		);
	}

	/// `call [rip+X]` at `0x1000`, its operand naming the IAT slot at `0x4000`.
	///
	/// This is the exact shape the descent records: an `IndirectCall` flow with
	/// no branch target, plus a `Data` xref to the memory operand.
	fn iat_call_fixture() -> (Vec<Function>, XrefTable, Vec<InstructionFlow>) {
		(
			vec![function(0x1000, Some(0x1010))],
			XrefTable::new(vec![xref(0x1000, 0x4000, XrefKind::Data)]),
			vec![
				flow(0x1000, 6, FlowKind::IndirectCall, None),
				flow(0x1006, 1, FlowKind::Return, None),
			],
		)
	}

	fn iat_graph(
		fixture: &(Vec<Function>, XrefTable, Vec<InstructionFlow>),
		imports: &[ImportedModule],
	) -> CallGraph {
		let (functions, xrefs, flows) = fixture;
		let extent = function_extent(functions, flows, 0x1000).unwrap();
		call_graph(functions, xrefs, flows, imports, extent, usize::MAX)
	}

	#[test]
	fn a_call_through_an_iat_slot_names_the_import_exactly() {
		let graph = iat_graph(&iat_call_fixture(), &imports());
		assert_eq!(
			(
				graph.indirect_call_sites,
				graph.indirect_call_site_total,
				graph.unresolved_indirect_call_site_total,
			),
			(
				vec![IndirectCallSite {
					site: 0x1000,
					resolved: Some(create_file_w(IndirectResolutionMethod::IatOperand)),
				}],
				1,
				0,
			)
		);
	}

	#[test]
	fn an_import_by_ordinal_resolves_without_a_name() {
		let imports = vec![module("WS2_32.dll", vec![symbol(None, Some(115), 0x4000)])];
		assert_eq!(
			iat_graph(&iat_call_fixture(), &imports).indirect_call_sites[0].resolved,
			Some(ResolvedImport {
				iat_rva: 0x4000,
				module: "WS2_32.dll".to_string(),
				// Absent, not empty: the import table never named this symbol.
				symbol: None,
				ordinal: Some(115),
				method: IndirectResolutionMethod::IatOperand,
				confidence: ResolutionConfidence::Exact,
			})
		);
	}

	#[test]
	fn two_data_operands_leave_the_site_unresolved() {
		let (functions, _, flows) = iat_call_fixture();
		// Both slots are imports. That makes it worse, not better: nothing here
		// says which one the call goes through.
		let xrefs = XrefTable::new(vec![
			xref(0x1000, 0x4000, XrefKind::Data),
			xref(0x1000, 0x4008, XrefKind::Data),
		]);
		let imports = vec![module(
			"KERNEL32.dll",
			vec![
				symbol(Some("CreateFileW"), None, 0x4000),
				symbol(Some("CloseHandle"), None, 0x4008),
			],
		)];
		let graph = iat_graph(&(functions, xrefs, flows), &imports);
		assert_eq!(
			(
				graph.indirect_call_sites[0].resolved.clone(),
				graph.unresolved_indirect_call_site_total,
			),
			(None, 1)
		);
	}

	#[test]
	fn a_data_operand_that_is_not_an_import_stays_unresolved() {
		// A RIP-relative reference to a global is not an IAT slot, and looking
		// like one is not evidence.
		let (functions, _, flows) = iat_call_fixture();
		let xrefs = XrefTable::new(vec![xref(0x1000, 0x9000, XrefKind::Data)]);
		let graph = iat_graph(&(functions, xrefs, flows), &imports());
		assert_eq!(
			(
				graph.indirect_call_sites[0].resolved.clone(),
				graph.unresolved_indirect_call_site_total,
			),
			(None, 1)
		);
	}

	#[test]
	fn one_slot_claimed_twice_is_ambiguous_and_stays_unresolved() {
		let imports = vec![
			module(
				"KERNEL32.dll",
				vec![symbol(Some("CreateFileW"), None, 0x4000)],
			),
			module("OTHER.dll", vec![symbol(Some("CreateFileW"), None, 0x4000)]),
		];
		assert_eq!(
			iat_graph(&iat_call_fixture(), &imports).indirect_call_sites[0].resolved,
			None
		);
	}

	#[test]
	fn a_mix_of_resolved_and_unresolved_sites_counts_only_the_unresolved() {
		let functions = vec![function(0x1000, Some(0x1010))];
		let xrefs = XrefTable::new(vec![xref(0x1000, 0x4000, XrefKind::Data)]);
		let flows = vec![
			// Resolved through the IAT.
			flow(0x1000, 6, FlowKind::IndirectCall, None),
			// `call rax`: no memory operand, so no data xref and nothing to name.
			flow(0x1006, 2, FlowKind::IndirectCall, None),
			flow(0x1008, 1, FlowKind::Return, None),
		];
		let extent = function_extent(&functions, &flows, 0x1000).unwrap();
		let graph = call_graph(&functions, &xrefs, &flows, &imports(), extent, usize::MAX);
		let profile = function_profile(&functions, &xrefs, &flows, &imports(), extent);
		assert_eq!(
			(
				graph.indirect_call_site_total,
				graph.unresolved_indirect_call_site_total,
				profile.indirect_call_site_count,
				profile.resolved_indirect_call_site_count,
			),
			(2, 1, 2, 1)
		);
	}

	/// `call sub_2000` at `0x1000`, where `sub_2000` is `jmp [rip+X]` into the
	/// IAT and nothing else.
	fn thunk_fixture(thunk_flows: Vec<InstructionFlow>) -> CallGraph {
		let functions = vec![
			function(0x1000, Some(0x1010)),
			function(0x2000, Some(0x2010)),
		];
		let xrefs = XrefTable::new(vec![
			xref(0x1000, 0x2000, XrefKind::Call),
			xref(0x2000, 0x4000, XrefKind::Data),
		]);
		let mut flows = vec![
			flow(0x1000, 5, FlowKind::Call, Some(0x2000)),
			flow(0x1005, 1, FlowKind::Return, None),
		];
		flows.extend(thunk_flows);
		let extent = function_extent(&functions, &flows, 0x1000).unwrap();
		call_graph(&functions, &xrefs, &flows, &imports(), extent, usize::MAX)
	}

	#[test]
	fn a_call_to_a_one_instruction_import_thunk_names_the_import() {
		let graph = thunk_fixture(vec![flow(0x2000, 6, FlowKind::IndirectBranch, None)]);
		assert_eq!(
			graph
				.callees
				.iter()
				.map(|edge| (edge.target, edge.resolved_import.clone()))
				.collect::<Vec<_>>(),
			vec![(
				// The edge still names the thunk; the resolution names what the
				// thunk is for.
				0x2000,
				Some(create_file_w(IndirectResolutionMethod::ImportThunk)),
			)]
		);
	}

	#[test]
	fn a_two_instruction_function_is_not_a_thunk() {
		// A function that happens to end in an indirect branch is a function,
		// not a thunk, and chasing it would be a guess about what runs first.
		let graph = thunk_fixture(vec![
			flow(0x2000, 3, FlowKind::Sequential, None),
			flow(0x2003, 6, FlowKind::IndirectBranch, None),
		]);
		assert_eq!(
			graph
				.callees
				.iter()
				.map(|edge| edge.resolved_import.clone())
				.collect::<Vec<_>>(),
			vec![None]
		);
	}

	#[test]
	fn a_callee_that_is_not_a_thunk_at_all_resolves_to_nothing() {
		// An ordinary indirect *call* at the entry is not a branch into the IAT.
		let graph = thunk_fixture(vec![flow(0x2000, 6, FlowKind::IndirectCall, None)]);
		assert_eq!(graph.callees[0].resolved_import, None);
	}

	/// Four bounded functions. `0x1000` reaches `0x1200` two distinct ways —
	/// through `0x1100` and through `0x1300` — and `0x1200` calls nothing.
	fn path_functions() -> Vec<Function> {
		vec![
			function(0x1000, Some(0x1100)),
			function(0x1100, Some(0x1200)),
			function(0x1200, Some(0x1300)),
			function(0x1300, Some(0x1400)),
		]
	}

	fn path_xrefs() -> XrefTable {
		XrefTable::new(vec![
			xref(0x1004, 0x1100, XrefKind::Call),
			xref(0x1008, 0x1300, XrefKind::Call),
			xref(0x1104, 0x1200, XrefKind::Call),
			xref(0x1304, 0x1200, XrefKind::Call),
		])
	}

	/// Searches the four-function fixture, which needs no decoded flows: every
	/// function there carries a recorded end.
	fn search(
		from: u64,
		to: u64,
		max_depth: usize,
		max_paths: usize,
		max_visited: usize,
	) -> CallPaths {
		let functions = path_functions();
		let extent = function_extent(&functions, &[], from).unwrap();
		call_paths(
			&functions,
			&path_xrefs(),
			&[],
			&[],
			extent,
			to,
			max_depth,
			max_paths,
			max_visited,
		)
		.unwrap()
	}

	/// Each path as `(from function, call site, to function)` triples — the
	/// ordered address evidence, which is the thing being returned.
	fn evidence(found: &CallPaths) -> Vec<Vec<(u64, u64, Option<u64>)>> {
		found
			.paths
			.iter()
			.map(|path| {
				path.steps
					.iter()
					.map(|step| (step.from_function_rva, step.call_site, step.to_function_rva))
					.collect()
			})
			.collect()
	}

	/// The core completeness signals plus what they add up to.
	fn completeness(found: &CallPaths) -> (bool, bool, bool, u64, bool) {
		(
			found.search_exhausted,
			found.depth_limit_reached,
			found.visit_limit_reached,
			found.unresolved_indirect_sites_on_frontier,
			found.proves_absence(),
		)
	}

	#[test]
	fn a_direct_call_is_a_one_step_path_carrying_its_call_site() {
		let found = search(0x1100, 0x1200, 8, 16, 1000);
		assert_eq!(
			(
				found.paths.clone(),
				found.visited_function_count,
				completeness(&found),
			),
			(
				vec![CallPath {
					steps: vec![CallPathStep {
						from_function_rva: 0x1100,
						// The exact calling instruction, not just the callee: a
						// path a human cannot go and look at is not evidence.
						call_site: 0x1104,
						to_function_rva: Some(0x1200),
						resolved_import: None,
						kind: XrefKind::Call,
						tail_call: false,
					}],
				}],
				1,
				// A path was found, so `proves_absence` is false whatever the
				// signals say.
				(true, false, false, 0, false),
			)
		);
	}

	#[test]
	fn distinct_transitive_paths_come_back_in_full_ordered_address_evidence() {
		let found = search(0x1000, 0x1200, 8, 16, 1000);
		assert_eq!(
			(
				evidence(&found),
				found.paths_truncated,
				found.visited_function_count,
			),
			(
				vec![
					vec![
						(0x1000, 0x1004, Some(0x1100)),
						(0x1100, 0x1104, Some(0x1200)),
					],
					vec![
						(0x1000, 0x1008, Some(0x1300)),
						(0x1300, 0x1304, Some(0x1200)),
					],
				],
				false,
				// Only the frontier, never the image: 0x1200 is a sink, not a
				// function whose edges anyone had to expand.
				3,
			)
		);
	}

	#[test]
	fn max_paths_truncates_and_says_a_further_path_really_exists() {
		let found = search(0x1000, 0x1200, 8, 1, 1000);
		assert_eq!(
			(
				evidence(&found),
				found.paths_truncated,
				found.search_exhausted,
			),
			(
				vec![vec![
					(0x1000, 0x1004, Some(0x1100)),
					(0x1100, 0x1104, Some(0x1200)),
				]],
				// Set because a second path was genuinely reached, not because
				// the bound was met.
				true,
				false,
			)
		);
	}

	#[test]
	fn recursion_cannot_spin_a_path_forever() {
		let functions = path_functions();
		let xrefs = XrefTable::new(vec![
			xref(0x1004, 0x1100, XrefKind::Call),
			xref(0x1104, 0x1200, XrefKind::Call),
			// Straight back into the caller, and into itself for good measure.
			xref(0x1108, 0x1000, XrefKind::Call),
			xref(0x110C, 0x1100, XrefKind::Call),
		]);
		let extent = function_extent(&functions, &[], 0x1000).unwrap();
		let found = call_paths(&functions, &xrefs, &[], &[], extent, 0x1200, 8, 16, 1000).unwrap();
		assert_eq!(
			(
				evidence(&found),
				found.visited_function_count,
				found.search_exhausted
			),
			(
				vec![vec![
					(0x1000, 0x1004, Some(0x1100)),
					(0x1100, 0x1104, Some(0x1200)),
				]],
				2,
				// A cycle is a dead end for a simple path, not a truncation and
				// not an unexplored frontier.
				true,
			)
		);
	}

	#[test]
	fn a_depth_cut_forbids_reading_an_empty_result_as_a_proof_of_absence() {
		let found = search(0x1000, 0x1200, 1, 16, 1000);
		assert_eq!(
			(found.paths.len(), completeness(&found)),
			// Everything within the limits was explored — and the limit itself
			// cut a frontier, so "no path" is a fact about this search only.
			(0, (true, true, false, 0, false))
		);
	}

	#[test]
	fn a_visit_cut_forbids_reading_an_empty_result_as_a_proof_of_absence() {
		let found = search(0x1000, 0x1200, 8, 16, 1);
		assert_eq!(
			(
				found.paths.len(),
				found.visited_function_count,
				completeness(&found)
			),
			(0, 1, (false, false, true, 0, false))
		);
	}

	#[test]
	fn an_exhausted_search_reports_every_completeness_signal_clean() {
		// 0x1200 calls nothing at all, so the reachable set is one function and
		// the walk really does see all of it.
		let found = search(0x1200, 0x1000, 8, 16, 1000);
		assert_eq!(
			(
				found.paths.len(),
				found.visited_function_count,
				completeness(&found)
			),
			// The one case where an empty result is a statement about the
			// program rather than about the search.
			(0, 1, (true, false, false, 0, true))
		);
	}

	#[test]
	fn an_inferred_frontier_extent_forbids_the_negative_claim() {
		let functions = vec![
			function(0x1000, Some(0x1100)),
			function(0x1100, None),
			function(0x1200, Some(0x1300)),
			function(0x1300, Some(0x1400)),
		];
		let xrefs = XrefTable::new(vec![xref(0x1004, 0x1100, XrefKind::Call)]);
		let flows = vec![flow(0x1100, 1, FlowKind::Return, None)];
		let extent = function_extent(&functions, &flows, 0x1000).unwrap();
		let found =
			call_paths(&functions, &xrefs, &flows, &[], extent, 0x1300, 8, 16, 1000).unwrap();

		assert_eq!(
			(
				found.paths.len(),
				found.search_exhausted,
				found.unbounded_functions_on_frontier,
				found.proves_absence(),
			),
			(0, true, 1, false),
		);
	}

	#[test]
	fn an_unresolved_indirect_site_on_the_frontier_forbids_the_negative_claim() {
		let functions = path_functions();
		let xrefs = XrefTable::new(vec![xref(0x1004, 0x1100, XrefKind::Call)]);
		let flows = vec![
			// `call rax`: no memory operand, so nothing names where it goes.
			flow(0x1000, 2, FlowKind::IndirectCall, None),
			flow(0x1004, 5, FlowKind::Call, Some(0x1100)),
			flow(0x1009, 1, FlowKind::Return, None),
			flow(0x1100, 1, FlowKind::Return, None),
		];
		let extent = function_extent(&functions, &flows, 0x1000).unwrap();
		let found = call_paths(
			&functions,
			&xrefs,
			&flows,
			&imports(),
			extent,
			0x1200,
			8,
			16,
			1000,
		)
		.unwrap();
		assert_eq!(
			(
				found.paths.len(),
				found.visited_function_count,
				completeness(&found)
			),
			// The walk saw everything it could reach and found nothing. It still
			// cannot say no path exists: `call rax` could go anywhere, and that
			// is exactly where a real sample hides the edge.
			(0, 2, (true, false, false, 1, false))
		);
	}

	#[test]
	fn an_import_slot_is_reached_through_a_call_that_indirects_through_it() {
		let (functions, xrefs, flows) = iat_call_fixture();
		let extent = function_extent(&functions, &flows, 0x1000).unwrap();
		let found = call_paths(
			&functions,
			&xrefs,
			&flows,
			&imports(),
			extent,
			0x4000,
			8,
			16,
			1000,
		)
		.unwrap();
		assert_eq!(
			(found.paths.clone(), completeness(&found)),
			(
				vec![CallPath {
					steps: vec![CallPathStep {
						from_function_rva: 0x1000,
						call_site: 0x1000,
						// An import is owned by no function; the resolution is
						// what names it.
						to_function_rva: None,
						resolved_import: Some(create_file_w(IndirectResolutionMethod::IatOperand)),
						kind: XrefKind::Call,
						tail_call: false,
					}],
				}],
				// The site resolved, so it is not one of the sites that could be
				// hiding an edge.
				(true, false, false, 0, false),
			)
		);
	}

	#[test]
	fn an_import_slot_is_reached_through_a_one_instruction_thunk() {
		let functions = vec![
			function(0x1000, Some(0x1010)),
			function(0x2000, Some(0x2010)),
		];
		let xrefs = XrefTable::new(vec![
			xref(0x1000, 0x2000, XrefKind::Call),
			xref(0x2000, 0x4000, XrefKind::Data),
		]);
		let flows = vec![
			flow(0x1000, 5, FlowKind::Call, Some(0x2000)),
			flow(0x1005, 1, FlowKind::Return, None),
			flow(0x2000, 6, FlowKind::IndirectBranch, None),
		];
		let extent = function_extent(&functions, &flows, 0x1000).unwrap();
		let found = call_paths(
			&functions,
			&xrefs,
			&flows,
			&imports(),
			extent,
			0x4000,
			8,
			16,
			1000,
		)
		.unwrap();
		assert_eq!(
			found.paths,
			vec![CallPath {
				steps: vec![CallPathStep {
					from_function_rva: 0x1000,
					call_site: 0x1000,
					// The step still names the thunk; the resolution names what
					// the thunk is for.
					to_function_rva: Some(0x2000),
					resolved_import: Some(create_file_w(IndirectResolutionMethod::ImportThunk)),
					kind: XrefKind::Call,
					tail_call: false,
				}],
			}]
		);
	}

	#[test]
	fn a_function_reaches_itself_in_no_steps() {
		let found = search(0x1000, 0x1000, 8, 16, 1000);
		assert_eq!(
			(found.paths, found.search_exhausted),
			// Not "no path": a search rule about repeating functions must not
			// turn into a claim about the program.
			(vec![CallPath { steps: Vec::new() }], true)
		);
	}

	#[test]
	fn a_sink_that_is_neither_a_function_nor_an_import_slot_is_refused() {
		let functions = path_functions();
		let extent = function_extent(&functions, &[], 0x1000).unwrap();
		assert_eq!(
			call_paths(
				&functions,
				&path_xrefs(),
				&[],
				&imports(),
				extent,
				// Mid-function, and no import descriptor claims it either.
				0x1104,
				8,
				16,
				1000,
			)
			.unwrap_err(),
			CallPathSinkError::NotFunctionOrImportSlot
		);
	}

	#[test]
	fn an_ambiguous_import_slot_is_refused_rather_than_searched_for() {
		// Two descriptors disagree about 0x4000, so nothing can ever resolve to
		// it. Accepting it would guarantee an empty result that reads exactly
		// like a proof of absence. It is refused under its own error, because
		// the caller's address was right and the sample's import table is not.
		let imports = vec![
			module(
				"KERNEL32.dll",
				vec![symbol(Some("CreateFileW"), None, 0x4000)],
			),
			module("OTHER.dll", vec![symbol(Some("CreateFileW"), None, 0x4000)]),
		];
		let (functions, xrefs, flows) = iat_call_fixture();
		let extent = function_extent(&functions, &flows, 0x1000).unwrap();
		assert_eq!(
			call_paths(&functions, &xrefs, &flows, &imports, extent, 0x4000, 8, 16, 1000,)
				.unwrap_err(),
			CallPathSinkError::AmbiguousImportSlot
		);
	}
}
