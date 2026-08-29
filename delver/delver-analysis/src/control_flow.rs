//! Basic-block construction from retained instruction-flow facts.

use std::collections::BTreeSet;

use delver_disasm::FlowKind;

use crate::InstructionFlow;

/// One maximal straight-line instruction sequence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BasicBlock {
	/// First instruction RVA.
	pub start_rva: u64,
	/// Exclusive end of the last instruction.
	pub end_rva: u64,
	/// Number of instructions in the block.
	pub instruction_count: usize,
}

/// The reason control moves between two blocks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BasicBlockEdgeKind {
	/// Natural continuation into the next block.
	Fallthrough,
	/// An unconditional direct branch.
	Jump,
	/// The taken side of a conditional direct branch.
	ConditionalTaken,
}

/// One direct, intra-function CFG edge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BasicBlockEdge {
	/// Source block start.
	pub from: u64,
	/// Destination block start.
	pub to: u64,
	/// Edge classification.
	pub kind: BasicBlockEdgeKind,
}

/// Builds the complete direct CFG for the half-open function range.
///
/// Facts may arrive in any order. Duplicate RVAs are collapsed after a stable
/// sort, retaining the first fact supplied for that address.
pub fn basic_blocks(
	facts: &[InstructionFlow],
	start: u64,
	end: u64,
) -> (Vec<BasicBlock>, Vec<BasicBlockEdge>) {
	let (blocks, edges, _) = basic_blocks_bounded(facts, start, end, usize::MAX);
	(blocks, edges)
}

/// Builds a bounded prefix of the direct CFG for a half-open function range.
///
/// Blocks are ordered by start RVA. Edges are included only when both endpoints
/// are among the returned blocks. The final boolean reports whether additional
/// blocks were omitted. Facts may arrive in any order; duplicate RVAs retain the
/// first fact supplied for that address.
pub fn basic_blocks_bounded(
	facts: &[InstructionFlow],
	start: u64,
	end: u64,
	max_blocks: usize,
) -> (Vec<BasicBlock>, Vec<BasicBlockEdge>, bool) {
	if end <= start {
		return (Vec::new(), Vec::new(), false);
	}

	let mut facts: Vec<_> = facts
		.iter()
		.copied()
		.filter(|fact| start <= fact.rva && fact.rva < end)
		.collect();
	if facts.is_empty() {
		return (Vec::new(), Vec::new(), false);
	}
	facts.sort_by_key(|fact| fact.rva);
	facts.dedup_by_key(|fact| fact.rva);
	if max_blocks == 0 {
		return (Vec::new(), Vec::new(), true);
	}

	let instruction_starts: BTreeSet<_> = facts.iter().map(|fact| fact.rva).collect();
	let mut leaders = BTreeSet::from([facts[0].rva]);
	for pair in facts.windows(2) {
		let previous_end = pair[0].rva.saturating_add(pair[0].len as u64);
		if pair[1].rva != previous_end {
			leaders.insert(pair[1].rva);
		}
	}
	for fact in &facts {
		let next = fact.rva.saturating_add(fact.len as u64);
		if (!fact.flow.falls_through() || matches!(fact.flow, FlowKind::ConditionalJump))
			&& instruction_starts.contains(&next)
		{
			leaders.insert(next);
		}
		if matches!(fact.flow, FlowKind::Jump | FlowKind::ConditionalJump) {
			if let Some(target) = fact
				.branch_target
				.filter(|target| instruction_starts.contains(target))
			{
				leaders.insert(target);
			}
		}
	}

	let leader_vec: Vec<_> = leaders.iter().copied().collect();
	let truncated = leader_vec.len() > max_blocks;
	let returned_count = leader_vec.len().min(max_blocks);
	let mut blocks = Vec::with_capacity(returned_count);
	let mut terminals = Vec::with_capacity(returned_count);
	let mut fact_index = 0;
	for (index, leader) in leader_vec.iter().copied().take(returned_count).enumerate() {
		let limit = leader_vec.get(index + 1).copied().unwrap_or(end);
		while facts.get(fact_index).is_some_and(|fact| fact.rva < leader) {
			fact_index += 1;
		}
		let first_member = fact_index;
		while facts.get(fact_index).is_some_and(|fact| fact.rva < limit) {
			fact_index += 1;
		}
		if fact_index > first_member {
			let terminal = facts[fact_index - 1];
			blocks.push(BasicBlock {
				start_rva: leader,
				end_rva: terminal.rva.saturating_add(terminal.len as u64),
				instruction_count: fact_index - first_member,
			});
			terminals.push(terminal);
		}
	}

	let block_starts: BTreeSet<_> = blocks.iter().map(|block| block.start_rva).collect();
	let mut edges = Vec::with_capacity(blocks.len().saturating_mul(2));
	for (block, terminal) in blocks.iter().zip(terminals) {
		let next = terminal.rva.saturating_add(terminal.len as u64);
		if matches!(terminal.flow, FlowKind::ConditionalJump) && block_starts.contains(&next) {
			edges.push(BasicBlockEdge {
				from: block.start_rva,
				to: next,
				kind: BasicBlockEdgeKind::Fallthrough,
			});
		}
		if matches!(terminal.flow, FlowKind::Jump | FlowKind::ConditionalJump) {
			if let Some(target) = terminal
				.branch_target
				.filter(|target| block_starts.contains(target))
			{
				edges.push(BasicBlockEdge {
					from: block.start_rva,
					to: target,
					kind: if terminal.flow == FlowKind::Jump {
						BasicBlockEdgeKind::Jump
					} else {
						BasicBlockEdgeKind::ConditionalTaken
					},
				});
			}
		} else if terminal.flow.falls_through() && block_starts.contains(&next) {
			edges.push(BasicBlockEdge {
				from: block.start_rva,
				to: next,
				kind: BasicBlockEdgeKind::Fallthrough,
			});
		}
	}
	(blocks, edges, truncated)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn fact(rva: u64, len: u32, flow: FlowKind, branch_target: Option<u64>) -> InstructionFlow {
		InstructionFlow {
			rva,
			len,
			flow,
			branch_target,
		}
	}

	#[test]
	fn splits_a_diamond_and_emits_ordered_edges() {
		let facts = vec![
			fact(0x1000, 2, FlowKind::ConditionalJump, Some(0x1005)),
			fact(0x1002, 3, FlowKind::Jump, Some(0x1006)),
			fact(0x1005, 1, FlowKind::Sequential, None),
			fact(0x1006, 1, FlowKind::Return, None),
		];
		let (blocks, edges) = basic_blocks(&facts, 0x1000, 0x1007);
		assert_eq!(
			blocks
				.iter()
				.map(|block| (block.start_rva, block.end_rva))
				.collect::<Vec<_>>(),
			vec![
				(0x1000, 0x1002),
				(0x1002, 0x1005),
				(0x1005, 0x1006),
				(0x1006, 0x1007)
			]
		);
		assert_eq!(
			edges
				.iter()
				.map(|edge| (edge.from, edge.to, edge.kind))
				.collect::<Vec<_>>(),
			vec![
				(0x1000, 0x1002, BasicBlockEdgeKind::Fallthrough),
				(0x1000, 0x1005, BasicBlockEdgeKind::ConditionalTaken),
				(0x1002, 0x1006, BasicBlockEdgeKind::Jump),
				(0x1005, 0x1006, BasicBlockEdgeKind::Fallthrough),
			]
		);
	}

	#[test]
	fn an_undecoded_gap_starts_a_new_block_without_a_fallthrough_edge() {
		let facts = vec![
			fact(0x1000, 1, FlowKind::Sequential, None),
			fact(0x1004, 1, FlowKind::Return, None),
		];
		let (blocks, edges) = basic_blocks(&facts, 0x1000, 0x1005);
		assert_eq!(
			blocks
				.iter()
				.map(|block| (block.start_rva, block.end_rva))
				.collect::<Vec<_>>(),
			vec![(0x1000, 0x1001), (0x1004, 0x1005)]
		);
		assert!(edges.is_empty(), "a gap is not evidence of fallthrough");
	}

	#[test]
	fn unordered_facts_are_sorted_before_blocks_are_built() {
		let facts = vec![
			fact(0x1006, 1, FlowKind::Return, None),
			fact(0x1002, 3, FlowKind::Jump, Some(0x1006)),
			fact(0x1000, 2, FlowKind::ConditionalJump, Some(0x1005)),
			fact(0x1005, 1, FlowKind::Sequential, None),
		];
		let (blocks, edges) = basic_blocks(&facts, 0x1000, 0x1007);
		assert_eq!(
			(
				blocks
					.iter()
					.map(|block| (block.start_rva, block.end_rva))
					.collect::<Vec<_>>(),
				edges
					.iter()
					.map(|edge| (edge.from, edge.to, edge.kind))
					.collect::<Vec<_>>(),
			),
			(
				vec![
					(0x1000, 0x1002),
					(0x1002, 0x1005),
					(0x1005, 0x1006),
					(0x1006, 0x1007)
				],
				vec![
					(0x1000, 0x1002, BasicBlockEdgeKind::Fallthrough),
					(0x1000, 0x1005, BasicBlockEdgeKind::ConditionalTaken),
					(0x1002, 0x1006, BasicBlockEdgeKind::Jump),
					(0x1005, 0x1006, BasicBlockEdgeKind::Fallthrough),
				],
			)
		);
	}

	#[test]
	fn bounded_graph_reports_truncation_and_omits_external_edges() {
		let facts = vec![
			fact(0x1000, 2, FlowKind::ConditionalJump, Some(0x1005)),
			fact(0x1002, 3, FlowKind::Jump, Some(0x1006)),
			fact(0x1005, 1, FlowKind::Sequential, None),
			fact(0x1006, 1, FlowKind::Return, None),
		];
		let (blocks, edges, truncated) = basic_blocks_bounded(&facts, 0x1000, 0x1007, 2);
		assert_eq!(
			(
				blocks
					.iter()
					.map(|block| block.start_rva)
					.collect::<Vec<_>>(),
				edges
					.iter()
					.map(|edge| (edge.from, edge.to, edge.kind))
					.collect::<Vec<_>>(),
				truncated,
			),
			(
				vec![0x1000, 0x1002],
				vec![(0x1000, 0x1002, BasicBlockEdgeKind::Fallthrough)],
				true,
			)
		);
	}

	#[test]
	fn rva_arithmetic_saturates_at_the_address_space_end() {
		let facts = vec![fact(u64::MAX - 1, 4, FlowKind::Return, None)];
		let (blocks, edges) = basic_blocks(&facts, u64::MAX - 1, u64::MAX);
		assert_eq!(
			(blocks[0].end_rva, edges),
			(u64::MAX, Vec::<BasicBlockEdge>::new())
		);
	}
}
