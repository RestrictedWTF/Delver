//! MSVC RTTI complete-object locators, and the vftables they sit above.
//!
//! This recovers the *entry* into the MSVC RTTI graph and nothing further: a
//! locator, the type descriptor it names, and the address of the vftable whose
//! slot `-1` points at it. Class hierarchy descriptors, base-class arrays and
//! virtual inheritance are deliberately not parsed — see
//! `Docs/planning/ideas/compiler-metadata-semantic-recovery.md`, which measures
//! this edge and scopes the rest to P5.
//!
//! # Why the self-reference check carries the whole scan
//!
//! A locator is found by scanning read-only data for a 4-byte `1`, which on its
//! own matches 211,686 times across 70 real images. On x64 the record also
//! carries `pSelf`, its own RVA, and requiring that to match removes **97.7%**
//! of those candidates. That single comparison is the difference between 4,824
//! classes and forty-four times more, every one of them confident and wrong.
//! It is also free: no relocation processing, because the field is already an
//! RVA.
//!
//! This is x64-only for exactly that reason. A 32-bit image's locator has no
//! `pSelf` field, so the scan would have no discriminator and this module
//! declines rather than guessing (`Docs/design/principles.md` §1).

use crate::{ParsedImage, Section};
use std::collections::HashMap;

/// Maximum locators one scan reports.
///
/// A bound on attacker-controlled input rather than an expectation about real
/// images: the largest count observed across 70 System32 binaries is under
/// 5,000, so a sample that reaches this is malformed or hostile and the scan
/// says so through [`RttiScan::truncated`] instead of running unbounded.
pub const MAX_RTTI_CLASSES: usize = 65_536;

/// Size of `_RTTICompleteObjectLocator` on x64, in bytes.
///
/// `{ u32 signature; i32 offset; i32 cdOffset; u32 pTypeDescriptor;
/// u32 pClassHierarchyDescriptor; u32 pSelf; }` — six fields, so `pSelf` is at
/// `+20` and the record is 24 bytes. Reading it as 20 puts the self-reference
/// check on `pClassHierarchyDescriptor` instead, which fails closed: the scan
/// would find almost nothing rather than find the wrong thing, and the 97.7%
/// figure the module doc cites was measured at `+20`.
const LOCATOR_SIZE: u64 = 24;

/// Byte offset of `pSelf` within the locator.
const LOCATOR_SELF_OFFSET: u64 = 20;

/// Byte offset of `pTypeDescriptor` within the locator.
const LOCATOR_TYPE_DESCRIPTOR_OFFSET: u64 = 12;

/// Byte offset of `offset` — the subobject's position in the complete object.
const LOCATOR_BASE_OFFSET_OFFSET: u64 = 4;

/// Byte offset of the decorated name inside a `TypeDescriptor` on x64.
///
/// The record is `{ void* pVFTable; void* spare; char name[]; }`.
const TYPE_DESCRIPTOR_NAME_OFFSET: u64 = 16;

/// Longest decorated name read from a type descriptor.
///
/// Names are attacker-controlled bytes with no length prefix, terminated only
/// by a NUL that a hostile image can simply omit.
const MAX_DECORATED_NAME: usize = 4096;

/// One `(class, vftable)` pair recovered from a complete-object locator.
///
/// Not one per class: a class using multiple inheritance has one locator and
/// one vftable *per base subobject*, distinguished by [`Self::base_offset`].
/// Collapsing them would lose the only thing that says which vftable belongs to
/// which subobject.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RttiClass {
	/// RVA of the complete-object locator.
	pub locator_rva: u64,
	/// RVA of the `TypeDescriptor` the locator names.
	pub type_descriptor_rva: u64,
	/// Decorated name exactly as stored, e.g. `".?AVFoo@@"`.
	///
	/// Undecorated deliberately not attempted here. Demangling is a separate
	/// concern with its own failure modes, and the decorated form is the one
	/// that round-trips.
	pub decorated_name: String,
	/// RVA of the vftable's first slot.
	///
	/// The locator is referenced from `[vftable - 8]`, so this is that referrer
	/// plus eight. Measured across 70 images, every validated locator has one
	/// (4,779 of 4,779), which is why this is not optional.
	pub vftable_rva: u64,
	/// Offset of this subobject's vftable within the complete object.
	///
	/// Zero for single inheritance. The locator's `offset` field.
	pub base_offset: u32,
}

/// What one RTTI scan found, and whether it found all of it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RttiScan {
	/// Recovered pairs, ascending by [`RttiClass::vftable_rva`].
	pub classes: Vec<RttiClass>,
	/// Whether [`MAX_RTTI_CLASSES`] stopped the scan.
	///
	/// True means the list is a prefix, not the image's full set — the
	/// distinction an absent result must never blur.
	pub truncated: bool,
	/// Whether the image was a shape this scan understands at all.
	///
	/// False for anything but PE32+, where `pSelf` does not exist and the scan
	/// would have no discriminator. An empty [`Self::classes`] with this false
	/// says "not looked for", which is not the same as "none present".
	pub scanned: bool,
}

/// Scans `image` for validated complete-object locators and their vftables.
///
/// Read-only and allocation-bounded. `file` is the image's raw bytes; addresses
/// not backed by file data are skipped rather than assumed zero.
pub fn scan_rtti(image: &ParsedImage, file: &[u8]) -> RttiScan {
	if image.arch != X64_ARCH {
		return RttiScan {
			classes: Vec::new(),
			truncated: false,
			scanned: false,
		};
	}

	let regions = scan_regions(image, file);

	// Pass one: validated locators, keyed by the virtual address a vftable's
	// slot `-1` would hold if it pointed here.
	let mut locators: HashMap<u64, Locator> = HashMap::new();
	for region in &regions {
		let mut offset: u64 = 0;
		while offset + LOCATOR_SIZE <= region.bytes.len() as u64 {
			let rva = match region.base_rva.checked_add(offset) {
				Some(rva) => rva,
				None => break,
			};
			if let Some(locator) = read_locator(image, file, region, offset, rva) {
				if let Some(va) = image.image_base.checked_add(rva) {
					locators.insert(va, locator);
				}
			}
			offset += 4;
		}
	}

	if locators.is_empty() {
		return RttiScan {
			classes: Vec::new(),
			truncated: false,
			scanned: true,
		};
	}

	// Pass two: one sweep for qwords naming a locator we kept. Rescanning per
	// locator would be quadratic over thousands of locators and millions of
	// qwords.
	let mut classes: Vec<RttiClass> = Vec::new();
	let mut truncated = false;
	'outer: for region in &regions {
		let mut offset: u64 = 0;
		while offset + 8 <= region.bytes.len() as u64 {
			if let Some(value) = read_u64(region.bytes, offset) {
				if let Some(locator) = locators.get(&value) {
					let site = match region.base_rva.checked_add(offset) {
						Some(site) => site,
						None => break,
					};
					if let Some(vftable_rva) = site.checked_add(8) {
						if classes.len() >= MAX_RTTI_CLASSES {
							truncated = true;
							break 'outer;
						}
						classes.push(RttiClass {
							locator_rva: locator.locator_rva,
							type_descriptor_rva: locator.type_descriptor_rva,
							decorated_name: locator.decorated_name.clone(),
							vftable_rva,
							base_offset: locator.base_offset,
						});
					}
				}
			}
			offset += 8;
		}
	}

	classes.sort_by_key(|class| (class.vftable_rva, class.locator_rva));

	RttiScan {
		classes,
		truncated,
		scanned: true,
	}
}

/// Architecture string a PE32+ image parses to.
///
/// `ParsedImage::arch` is `format!("{:?}", ..)` of the object crate's
/// `Architecture`, so this is the debug spelling of `Architecture::X86_64`.
const X64_ARCH: &str = "X86_64";

/// A validated locator, held between the two passes.
struct Locator {
	locator_rva: u64,
	type_descriptor_rva: u64,
	decorated_name: String,
	base_offset: u32,
}

/// A section's file-backed bytes, with the RVA its first byte sits at.
struct ScanRegion<'a> {
	base_rva: u64,
	bytes: &'a [u8],
}

/// File-backed bytes of every section a locator or a vftable may live in.
fn scan_regions<'a>(image: &ParsedImage, file: &'a [u8]) -> Vec<ScanRegion<'a>> {
	scannable_sections(&image.sections)
		.into_iter()
		.filter_map(|index| {
			let section = image.sections.get(index)?;
			let bytes = image.bytes_at(file, section.virtual_address)?;
			Some(ScanRegion {
				base_rva: section.virtual_address,
				bytes,
			})
		})
		.collect()
}

/// Reads a complete-object locator at `offset` in `region`, or `None` when the
/// candidate fails any of the checks that make it one.
fn read_locator(
	image: &ParsedImage,
	file: &[u8],
	region: &ScanRegion<'_>,
	offset: u64,
	rva: u64,
) -> Option<Locator> {
	let signature = read_u32(region.bytes, offset)?;
	if signature != 1 {
		return None;
	}
	// The whole scan rests on this: the record names its own RVA.
	let self_rva = read_u32(region.bytes, offset.checked_add(LOCATOR_SELF_OFFSET)?)?;
	if u64::from(self_rva) != rva {
		return None;
	}

	let base_offset = read_u32(
		region.bytes,
		offset.checked_add(LOCATOR_BASE_OFFSET_OFFSET)?,
	)?;
	let type_descriptor_rva = u64::from(read_u32(
		region.bytes,
		offset.checked_add(LOCATOR_TYPE_DESCRIPTOR_OFFSET)?,
	)?);
	let decorated_name = read_decorated_name(image, file, type_descriptor_rva)?;

	Some(Locator {
		locator_rva: rva,
		type_descriptor_rva,
		decorated_name,
		base_offset,
	})
}

/// Reads a type descriptor's decorated name, bounded by [`MAX_DECORATED_NAME`].
///
/// A name with no NUL inside that bound rejects the candidate rather than
/// running on into whatever follows.
fn read_decorated_name(image: &ParsedImage, file: &[u8], descriptor_rva: u64) -> Option<String> {
	let name_rva = descriptor_rva.checked_add(TYPE_DESCRIPTOR_NAME_OFFSET)?;
	let bytes = image.bytes_at(file, name_rva)?;
	let bound = bytes.len().min(MAX_DECORATED_NAME);
	let window = bytes.get(..bound)?;
	let end = window.iter().position(|&byte| byte == 0)?;
	let name = window.get(..end)?;
	if !name.starts_with(b".?A") {
		return None;
	}
	String::from_utf8(name.to_vec()).ok()
}

/// Little-endian `u32` at `offset`, or `None` when it does not fit.
fn read_u32(bytes: &[u8], offset: u64) -> Option<u32> {
	let start = usize::try_from(offset).ok()?;
	let end = start.checked_add(4)?;
	let slice = bytes.get(start..end)?;
	Some(u32::from_le_bytes(slice.try_into().ok()?))
}

/// Little-endian `u64` at `offset`, or `None` when it does not fit.
fn read_u64(bytes: &[u8], offset: u64) -> Option<u64> {
	let start = usize::try_from(offset).ok()?;
	let end = start.checked_add(8)?;
	let slice = bytes.get(start..end)?;
	Some(u64::from_le_bytes(slice.try_into().ok()?))
}

/// Indices of the sections a locator may live in.
///
/// Locators are emitted into read-only data. Scanning executable sections would
/// add candidates that cannot be locators and cost the scan its cheapest bound.
fn scannable_sections(sections: &[Section]) -> Vec<usize> {
	sections
		.iter()
		.enumerate()
		.filter(|(_, section)| section.is_readable() && !section.is_executable())
		.map(|(index, _)| index)
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	const SECTION_RVA: u64 = 0x1000;
	const RAW_OFFSET: u64 = 0x400;
	const IMAGE_BASE: u64 = 0x1_4000_0000;

	/// Builds a one-section x64 image over `data`, mapped at [`SECTION_RVA`].
	fn image_over(data: &[u8]) -> (ParsedImage, Vec<u8>) {
		let mut file = vec![0u8; RAW_OFFSET as usize];
		file.extend_from_slice(data);
		let image = ParsedImage {
			arch: "X86_64".to_string(),
			image_base: IMAGE_BASE,
			sections: vec![Section {
				name: ".rdata".to_string(),
				virtual_address: SECTION_RVA,
				virtual_size: data.len() as u64,
				raw_offset: RAW_OFFSET,
				raw_size: data.len() as u64,
				// Readable, initialized data, not executable.
				characteristics: 0x4000_0040,
			}],
			..Default::default()
		};
		(image, file)
	}

	fn put_u32(data: &mut [u8], offset: usize, value: u32) {
		data[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
	}

	fn put_u64(data: &mut [u8], offset: usize, value: u64) {
		data[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
	}

	/// Section layout shared by the cases below.
	///
	/// `+0x00` locator, `+0x20` type descriptor, `+0x40` the vftable's slot `-1`
	/// so the vftable itself starts at `+0x48`.
	const LOCATOR_OFF: usize = 0x00;
	const DESCRIPTOR_OFF: usize = 0x20;
	const REFERRER_OFF: usize = 0x40;

	/// One well-formed image: locator, descriptor, and a single referrer.
	fn well_formed(name: &[u8], base_offset: u32) -> Vec<u8> {
		let mut data = vec![0u8; 0x80];
		let locator_rva = SECTION_RVA + LOCATOR_OFF as u64;
		let descriptor_rva = SECTION_RVA + DESCRIPTOR_OFF as u64;
		put_u32(&mut data, LOCATOR_OFF, 1);
		put_u32(&mut data, LOCATOR_OFF + 4, base_offset);
		put_u32(&mut data, LOCATOR_OFF + 8, 0);
		put_u32(&mut data, LOCATOR_OFF + 12, descriptor_rva as u32);
		// `pClassHierarchyDescriptor`, never followed, but it occupies `+16` —
		// which is where a 20-byte reading of this record would look for
		// `pSelf`. Left non-zero on purpose so a regression to that offset
		// fails these tests instead of coincidentally passing them.
		put_u32(&mut data, LOCATOR_OFF + 16, 0xDEAD_BEEF);
		put_u32(&mut data, LOCATOR_OFF + 20, locator_rva as u32);
		data[DESCRIPTOR_OFF + 16..DESCRIPTOR_OFF + 16 + name.len()].copy_from_slice(name);
		put_u64(&mut data, REFERRER_OFF, IMAGE_BASE + locator_rva);
		data
	}

	#[test]
	fn a_validated_locator_yields_its_class_and_vftable() {
		let data = well_formed(b".?AVFoo@@", 8);
		let (image, file) = image_over(&data);

		assert_eq!(
			scan_rtti(&image, &file),
			RttiScan {
				classes: vec![RttiClass {
					locator_rva: SECTION_RVA,
					type_descriptor_rva: SECTION_RVA + DESCRIPTOR_OFF as u64,
					decorated_name: ".?AVFoo@@".to_string(),
					vftable_rva: SECTION_RVA + REFERRER_OFF as u64 + 8,
					base_offset: 8,
				}],
				truncated: false,
				scanned: true,
			}
		);
	}

	#[test]
	fn a_locator_whose_self_rva_disagrees_is_not_one() {
		// The discriminator that removes 97.7% of `signature == 1` candidates.
		let mut data = well_formed(b".?AVFoo@@", 0);
		put_u32(&mut data, LOCATOR_OFF + 20, SECTION_RVA as u32 + 4);
		let (image, file) = image_over(&data);

		assert_eq!(
			scan_rtti(&image, &file),
			RttiScan {
				classes: vec![],
				truncated: false,
				scanned: true,
			}
		);
	}

	#[test]
	fn a_name_that_is_not_a_decorated_class_name_is_rejected() {
		let data = well_formed(b"notaclass", 0);
		let (image, file) = image_over(&data);

		assert_eq!(scan_rtti(&image, &file).classes, vec![]);
	}

	#[test]
	fn a_locator_nothing_points_at_yields_nothing() {
		let mut data = well_formed(b".?AVFoo@@", 0);
		put_u64(&mut data, REFERRER_OFF, 0);
		let (image, file) = image_over(&data);

		assert_eq!(scan_rtti(&image, &file).classes, vec![]);
	}

	#[test]
	fn several_referrers_are_several_classes_not_one() {
		// Multiple inheritance: one locator above more than one vftable.
		let mut data = well_formed(b".?AVFoo@@", 0);
		put_u64(&mut data, REFERRER_OFF + 0x10, IMAGE_BASE + SECTION_RVA);
		let (image, file) = image_over(&data);

		let vftables: Vec<u64> = scan_rtti(&image, &file)
			.classes
			.iter()
			.map(|class| class.vftable_rva)
			.collect();
		assert_eq!(
			vftables,
			vec![
				SECTION_RVA + REFERRER_OFF as u64 + 8,
				SECTION_RVA + REFERRER_OFF as u64 + 0x18,
			]
		);
	}

	#[test]
	fn an_unterminated_name_is_rejected_rather_than_read_past() {
		// Descriptor last, its name running to the end of the section with no NUL
		// anywhere after it.
		let mut data = vec![b'A'; 0x80];
		let descriptor_off = 0x40usize;
		put_u32(&mut data, LOCATOR_OFF, 1);
		put_u32(&mut data, LOCATOR_OFF + 4, 0);
		put_u32(&mut data, LOCATOR_OFF + 8, 0);
		put_u32(
			&mut data,
			LOCATOR_OFF + 12,
			SECTION_RVA as u32 + descriptor_off as u32,
		);
		put_u32(&mut data, LOCATOR_OFF + 20, SECTION_RVA as u32);
		put_u64(&mut data, 0x20, IMAGE_BASE + SECTION_RVA);
		data[descriptor_off + 16..descriptor_off + 19].copy_from_slice(b".?A");
		let (image, file) = image_over(&data);

		assert_eq!(scan_rtti(&image, &file).classes, vec![]);
	}

	#[test]
	fn a_locator_running_off_the_end_of_the_file_does_not_panic() {
		let data = well_formed(b".?AVFoo@@", 0);
		let (image, file) = image_over(&data);
		// The section claims more raw data than the file holds, and the record
		// straddles the real end.
		let mut image = image;
		image.sections[0].raw_size = 0x1000;
		let short = file[..RAW_OFFSET as usize + 0x28].to_vec();

		assert_eq!(scan_rtti(&image, &short).classes, vec![]);
	}

	#[test]
	fn a_non_x64_image_declines_rather_than_guessing() {
		let data = well_formed(b".?AVFoo@@", 0);
		let (mut image, file) = image_over(&data);
		image.arch = "I386".to_string();

		assert_eq!(
			scan_rtti(&image, &file),
			RttiScan {
				classes: vec![],
				truncated: false,
				scanned: false,
			}
		);
	}

	#[test]
	fn an_executable_section_is_not_scanned() {
		let data = well_formed(b".?AVFoo@@", 0);
		let (mut image, file) = image_over(&data);
		image.sections[0].characteristics |= 0x2000_0000;

		assert_eq!(scan_rtti(&image, &file).classes, vec![]);
	}
}
