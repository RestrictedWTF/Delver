//! Global-data candidates derived from retained data cross-references.
//!
//! A candidate is deliberately narrower than a claimed source-level global: it
//! is an address in a non-executable image section that at least one decoded
//! instruction names through a data reference. This excludes immediates and
//! inferred pointer targets, so an absent candidate is never proof that no
//! global exists at an address.

use std::collections::BTreeMap;

use delver_format::Section;

use crate::{Function, XrefKind, XrefTable};

/// One observed global-data address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalCandidate {
	/// Referenced image RVA.
	pub rva: u64,
	/// Index of the non-executable section containing the address.
	pub section_index: usize,
	/// Number of distinct retained data references to the address.
	pub reference_count: usize,
}

/// One instruction observed referencing a global-data address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalAccess {
	/// RVA of the referencing instruction.
	pub site: u64,
	/// Entry RVA of the detected function containing the site, when known.
	pub function_rva: Option<u64>,
}

/// Returns all observed global-data candidates ordered by address.
pub fn global_candidates(sections: &[Section], xrefs: &XrefTable) -> Vec<GlobalCandidate> {
	let mut candidates: BTreeMap<u64, (usize, usize)> = BTreeMap::new();
	for xref in xrefs
		.all()
		.iter()
		.filter(|xref| xref.kind == XrefKind::Data)
	{
		let Some(section_index) = containing_data_section(sections, xref.to) else {
			continue;
		};
		let entry = candidates.entry(xref.to).or_insert((section_index, 0));
		entry.1 += 1;
	}
	candidates
		.into_iter()
		.map(|(rva, (section_index, reference_count))| GlobalCandidate {
			rva,
			section_index,
			reference_count,
		})
		.collect()
}

/// Returns every retained data reference to `rva`, ordered by instruction RVA.
pub fn global_accesses(functions: &[Function], xrefs: &XrefTable, rva: u64) -> Vec<GlobalAccess> {
	xrefs
		.to(rva)
		.iter()
		.filter(|xref| xref.kind == XrefKind::Data)
		.map(|xref| GlobalAccess {
			site: xref.from,
			function_rva: crate::call_graph::containing_function(functions, xref.from),
		})
		.collect()
}

fn containing_data_section(sections: &[Section], rva: u64) -> Option<usize> {
	sections.iter().enumerate().find_map(|(index, section)| {
		let len = section.virtual_size.max(section.raw_size);
		(!section.is_executable()
			&& rva >= section.virtual_address
			&& rva < section.virtual_address.saturating_add(len))
		.then_some(index)
	})
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{FunctionSource, Xref};

	fn section(name: &str, rva: u64, size: u64, executable: bool) -> Section {
		Section {
			name: name.to_string(),
			virtual_address: rva,
			virtual_size: size,
			raw_offset: 0,
			raw_size: size,
			characteristics: if executable { 0x2000_0000 } else { 0x4000_0000 },
		}
	}

	fn xref(from: u64, to: u64, kind: XrefKind) -> Xref {
		Xref { from, to, kind }
	}

	#[test]
	fn candidates_are_unique_ordered_and_restricted_to_non_executable_sections() {
		let sections = vec![
			section(".text", 0x1000, 0x100, true),
			section(".data", 0x3000, 0x100, false),
		];
		let xrefs = XrefTable::new(vec![
			xref(0x1010, 0x3010, XrefKind::Data),
			xref(0x1020, 0x3000, XrefKind::Data),
			xref(0x1030, 0x3010, XrefKind::Data),
			xref(0x1040, 0x1008, XrefKind::Data),
			xref(0x1050, 0x3020, XrefKind::Call),
		]);

		assert_eq!(
			global_candidates(&sections, &xrefs),
			vec![
				GlobalCandidate {
					rva: 0x3000,
					section_index: 1,
					reference_count: 1
				},
				GlobalCandidate {
					rva: 0x3010,
					section_index: 1,
					reference_count: 2
				},
			]
		);
	}

	#[test]
	fn accesses_name_the_containing_function_without_inventing_one() {
		let functions = vec![Function {
			rva: 0x1000,
			end_rva: Some(0x1020),
			source: FunctionSource::ExceptionDirectory,
		}];
		let xrefs = XrefTable::new(vec![
			xref(0x1010, 0x3000, XrefKind::Data),
			xref(0x2000, 0x3000, XrefKind::Data),
			xref(0x1018, 0x3000, XrefKind::Call),
		]);

		assert_eq!(
			global_accesses(&functions, &xrefs, 0x3000),
			vec![
				GlobalAccess {
					site: 0x1010,
					function_rva: Some(0x1000)
				},
				GlobalAccess {
					site: 0x2000,
					function_rva: None
				},
			]
		);
	}
}
