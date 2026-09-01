//! Virtual method tables, bounded by recovered function entries.
//!
//! [`delver_format::rtti`] finds where a vftable *starts*. This decides where it
//! ends, which is the harder half and the one a measurement showed the obvious
//! rule gets wrong.
//!
//! # Why "until a non-executable pointer" is not the rule
//!
//! Walking slots until a qword stops pointing into executable memory is the
//! natural rule and it fails at the end of a pointer region. Across 70 images
//! it produced twenty vtables of more than 64 slots, all of them the same
//! class — `std::bad_array_new_length`, which has two virtual methods and was
//! reported with up to **3,166 slots**. It is the last RTTI vftable in
//! `.rdata` in those images, so the walk left the table and continued through
//! whatever array of function pointers followed. A boundary check confirmed the
//! complementary fact: *zero* walks ran into another locator-preceded vftable,
//! so the overrun is always into non-RTTI data, which is why the obvious guard
//! does not catch it.
//!
//! # The rule this uses
//!
//! A slot counts only when its target is a **recovered function entry** — not
//! merely an address in an executable section. Delver has that oracle and a
//! standalone RTTI parser does not, which makes this module dependent on
//! function recovery having run and *not* a parser that can stand alone.
//!
//! The consequence to keep in view: under-recovery now truncates a vtable
//! rather than inventing slots. That is the safer direction, and it is still an
//! error, so every walk records why it stopped in [`Vtable::terminator`] and
//! `NotAFunction` carries the address it rejected. Silently short tables would
//! be indistinguishable from small classes.

use std::collections::BTreeSet;

use delver_format::{rtti::RttiClass, ParsedImage};

use crate::Function;

/// Maximum slots one vtable reports.
///
/// Bounds a malformed image rather than a real class. The largest plausible
/// vtable in the measured corpus is well under this; reaching it is reported
/// through [`SlotTerminator::Cap`] rather than silently truncating.
pub const MAX_VTABLE_SLOTS: usize = 4096;

/// One recovered virtual method table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Vtable {
	/// RVA of slot zero.
	pub vftable_rva: u64,
	/// RVA of the locator that identified this table.
	pub locator_rva: u64,
	/// Decorated class name, from the type descriptor.
	pub decorated_name: String,
	/// Offset of this subobject's vftable within the complete object.
	pub base_offset: u32,
	/// Slots, ascending by index.
	pub slots: Vec<VtableSlot>,
	/// Why the walk stopped. Never absent: a table with no recorded reason
	/// could not be told apart from one that was never walked.
	pub terminator: SlotTerminator,
}

/// One virtual method slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VtableSlot {
	/// Zero-based slot index.
	pub index: u32,
	/// RVA of the slot itself.
	pub slot_rva: u64,
	/// Entry RVA of the function the slot names.
	///
	/// Always a recovered function entry — that is the admission rule, so this
	/// is not optional and callers need no fallback for a slot that resolved to
	/// nothing.
	pub function_rva: u64,
}

/// Why a vtable walk stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlotTerminator {
	/// The next qword did not name a recovered function entry.
	///
	/// The normal ending. The rejected value is carried so a short table can be
	/// investigated rather than trusted: it distinguishes "the array ended" from
	/// "function recovery missed a thunk".
	NotAFunction {
		/// The qword read, as an image RVA when it fell inside the image, and
		/// `None` when it did not point into the image at all.
		rejected_rva: Option<u64>,
	},
	/// The next slot would enter another known vftable.
	NextVtable {
		/// Where that table starts.
		vftable_rva: u64,
	},
	/// The next slot is not backed by file data.
	NotBackedByFile,
	/// [`MAX_VTABLE_SLOTS`] stopped the walk. The table is a prefix.
	Cap,
}

/// Recovers the vtable for every class in `classes`.
///
/// `functions` supplies the admission rule; passing an empty slice yields
/// zero-slot tables rather than falling back to a weaker test, because a weaker
/// test is what this module exists to avoid.
///
/// Returned ascending by [`Vtable::vftable_rva`].
pub fn recover_vtables(
	image: &ParsedImage,
	file: &[u8],
	functions: &[Function],
	classes: &[RttiClass],
) -> Vec<Vtable> {
	let entries = function_entries(functions);
	let vftable_starts: BTreeSet<u64> = classes.iter().map(|class| class.vftable_rva).collect();

	let mut vtables: Vec<Vtable> = classes
		.iter()
		.map(|class| {
			let (slots, terminator) =
				walk_slots(image, file, &entries, &vftable_starts, class.vftable_rva);
			Vtable {
				vftable_rva: class.vftable_rva,
				locator_rva: class.locator_rva,
				decorated_name: class.decorated_name.clone(),
				base_offset: class.base_offset,
				slots,
				terminator,
			}
		})
		.collect();
	vtables.sort_by_key(|vtable| vtable.vftable_rva);
	vtables
}

/// Walks one table's slots, returning them and the reason the walk stopped.
fn walk_slots(
	image: &ParsedImage,
	file: &[u8],
	entries: &BTreeSet<u64>,
	vftable_starts: &BTreeSet<u64>,
	vftable_rva: u64,
) -> (Vec<VtableSlot>, SlotTerminator) {
	let mut slots = Vec::new();
	for index in 0..MAX_VTABLE_SLOTS {
		let Some(slot_rva) = (index as u64)
			.checked_mul(8)
			.and_then(|offset| vftable_rva.checked_add(offset))
		else {
			return (slots, SlotTerminator::NotBackedByFile);
		};

		// Slot zero is this table's own start, so it never terminates the walk.
		if index > 0 && vftable_starts.contains(&slot_rva) {
			return (
				slots,
				SlotTerminator::NextVtable {
					vftable_rva: slot_rva,
				},
			);
		}

		let Some(bytes) = image.bytes_at(file, slot_rva) else {
			return (slots, SlotTerminator::NotBackedByFile);
		};
		let Some(qword) = bytes.get(..8) else {
			return (slots, SlotTerminator::NotBackedByFile);
		};
		let mut value_bytes = [0u8; 8];
		value_bytes.copy_from_slice(qword);
		let value = u64::from_le_bytes(value_bytes);

		let target_rva = match value.checked_sub(image.image_base) {
			Some(target_rva) if image.section_containing(target_rva).is_some() => target_rva,
			_ => return (slots, SlotTerminator::NotAFunction { rejected_rva: None }),
		};

		if !entries.contains(&target_rva) {
			return (
				slots,
				SlotTerminator::NotAFunction {
					rejected_rva: Some(target_rva),
				},
			);
		}

		slots.push(VtableSlot {
			index: index as u32,
			slot_rva,
			function_rva: target_rva,
		});
	}
	(slots, SlotTerminator::Cap)
}

/// Entry RVAs, for admission testing.
///
/// Entries only. A fragment start is inside a function, not the head of one, so
/// a slot pointing at one is not a virtual method and admitting it would put
/// this module back in the business of guessing.
fn function_entries(functions: &[Function]) -> BTreeSet<u64> {
	functions.iter().map(|function| function.rva).collect()
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::FunctionSource;
	use delver_format::Section;

	const IMAGE_BASE: u64 = 0x1_4000_0000;
	/// Raw data for `.rdata` ends here; `0x2100..0x2200` is virtual-only.
	const RDATA_RAW_END: u64 = 0x2100;

	fn section(
		name: &str,
		rva: u64,
		virtual_size: u64,
		raw_size: u64,
		executable: bool,
	) -> Section {
		Section {
			name: name.to_string(),
			virtual_address: rva,
			virtual_size,
			raw_offset: rva,
			raw_size,
			characteristics: if executable { 0x2000_0000 } else { 0x4000_0000 },
		}
	}

	/// An image whose section RVAs equal their file offsets, so a test can
	/// address bytes by RVA.
	fn image() -> ParsedImage {
		ParsedImage {
			image_base: IMAGE_BASE,
			sections: vec![
				section(".text", 0x1000, 0x1000, 0x1000, true),
				section(".rdata", 0x2000, 0x200, 0x100, false),
			],
			..Default::default()
		}
	}

	/// `(rva, value)` pairs written little-endian into a flat file image.
	fn file(qwords: &[(u64, u64)]) -> Vec<u8> {
		let mut bytes = vec![0u8; 0x3000];
		for &(rva, value) in qwords {
			let at = rva as usize;
			bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
		}
		bytes
	}

	fn function(rva: u64) -> Function {
		Function {
			rva,
			end_rva: None,
			source: FunctionSource::ExceptionDirectory,
			fragments: Vec::new(),
		}
	}

	fn class(vftable_rva: u64, name: &str) -> RttiClass {
		RttiClass {
			locator_rva: vftable_rva - 8,
			type_descriptor_rva: 0x2800,
			decorated_name: name.to_string(),
			vftable_rva,
			base_offset: 0,
		}
	}

	fn slot(index: u32, slot_rva: u64, function_rva: u64) -> VtableSlot {
		VtableSlot {
			index,
			slot_rva,
			function_rva,
		}
	}

	#[test]
	fn walks_every_slot_naming_a_recovered_entry_and_records_why_it_stopped() {
		let bytes = file(&[
			(0x2000, IMAGE_BASE + 0x1000),
			(0x2008, IMAGE_BASE + 0x1020),
			(0x2010, IMAGE_BASE + 0x1040),
			(0x2018, 0),
		]);
		let functions = vec![function(0x1000), function(0x1020), function(0x1040)];

		assert_eq!(
			recover_vtables(&image(), &bytes, &functions, &[class(0x2000, ".?AVFoo@@")]),
			vec![Vtable {
				vftable_rva: 0x2000,
				locator_rva: 0x1ff8,
				decorated_name: ".?AVFoo@@".to_owned(),
				base_offset: 0,
				slots: vec![
					slot(0, 0x2000, 0x1000),
					slot(1, 0x2008, 0x1020),
					slot(2, 0x2010, 0x1040),
				],
				terminator: SlotTerminator::NotAFunction { rejected_rva: None },
			}]
		);
	}

	#[test]
	fn a_pointer_into_executable_memory_that_is_not_a_recovered_entry_stops_the_walk() {
		// The measured defect: `.text`-membership alone once admitted this slot
		// and ran a two-method class out to thousands of slots.
		let bytes = file(&[
			(0x2000, IMAGE_BASE + 0x1000),
			(0x2008, IMAGE_BASE + 0x1008),
			(0x2010, IMAGE_BASE + 0x1020),
		]);
		let functions = vec![function(0x1000), function(0x1020)];

		assert_eq!(
			recover_vtables(&image(), &bytes, &functions, &[class(0x2000, ".?AVFoo@@")]),
			vec![Vtable {
				vftable_rva: 0x2000,
				locator_rva: 0x1ff8,
				decorated_name: ".?AVFoo@@".to_owned(),
				base_offset: 0,
				slots: vec![slot(0, 0x2000, 0x1000)],
				terminator: SlotTerminator::NotAFunction {
					rejected_rva: Some(0x1008)
				},
			}]
		);
	}

	#[test]
	fn a_walk_reaching_another_classes_vftable_stops_there() {
		let bytes = file(&[
			(0x2000, IMAGE_BASE + 0x1000),
			(0x2008, IMAGE_BASE + 0x1020),
			(0x2010, IMAGE_BASE + 0x1040),
			(0x2018, 0),
		]);
		let functions = vec![function(0x1000), function(0x1020), function(0x1040)];
		let classes = vec![class(0x2010, ".?AVBar@@"), class(0x2000, ".?AVFoo@@")];

		let recovered = recover_vtables(&image(), &bytes, &functions, &classes);
		assert_eq!(
			recovered
				.iter()
				.map(|vtable| (
					vtable.vftable_rva,
					vtable.slots.clone(),
					vtable.terminator.clone()
				))
				.collect::<Vec<_>>(),
			vec![
				(
					0x2000,
					vec![slot(0, 0x2000, 0x1000), slot(1, 0x2008, 0x1020)],
					SlotTerminator::NextVtable {
						vftable_rva: 0x2010
					}
				),
				(
					0x2010,
					vec![slot(0, 0x2010, 0x1040)],
					SlotTerminator::NotAFunction { rejected_rva: None }
				),
			]
		);
	}

	#[test]
	fn a_slot_past_the_file_backed_data_stops_the_walk() {
		let start = RDATA_RAW_END - 8;
		let bytes = file(&[(start, IMAGE_BASE + 0x1000)]);
		let functions = vec![function(0x1000)];

		let recovered = recover_vtables(&image(), &bytes, &functions, &[class(start, ".?AVEnd@@")]);
		assert_eq!(
			(recovered[0].slots.clone(), recovered[0].terminator.clone()),
			(
				vec![slot(0, start, 0x1000)],
				SlotTerminator::NotBackedByFile
			)
		);
	}

	#[test]
	fn no_recovered_functions_yields_a_zero_slot_table_rather_than_a_weaker_rule() {
		let bytes = file(&[(0x2000, IMAGE_BASE + 0x1000), (0x2008, IMAGE_BASE + 0x1020)]);

		let recovered = recover_vtables(&image(), &bytes, &[], &[class(0x2000, ".?AVFoo@@")]);
		assert_eq!(
			(recovered[0].slots.clone(), recovered[0].terminator.clone()),
			(
				Vec::new(),
				SlotTerminator::NotAFunction {
					rejected_rva: Some(0x1000)
				}
			)
		);
	}
}
