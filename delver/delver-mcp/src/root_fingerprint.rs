//---------------------------------------------------------------------------------------------
//  Copyright (c) Microsoft Corporation. All rights reserved.
//  Licensed under the MIT License. See License.txt in the project root for license information.
//---------------------------------------------------------------------------------------------

//! Canonical workspace-root routing for the Delver rendezvous registry.

use std::fmt;
use std::path::Path;

use sha2::{Digest, Sha256};

const ROOT_V1_DOMAIN: &[u8] = b"delver-root-v1";
const MAX_ROOT_BYTES: usize = 16 * 1024;

/// Operating-system spelling used by root-v1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootPlatform {
	/// Windows drive or UNC roots.
	Windows,
	/// macOS POSIX roots.
	Darwin,
	/// Linux POSIX roots.
	Linux,
	/// FreeBSD POSIX roots.
	FreeBsd,
	/// OpenBSD POSIX roots.
	OpenBsd,
}

impl RootPlatform {
	fn posix_kind(self) -> Option<&'static str> {
		match self {
			Self::Darwin => Some("darwin"),
			Self::Linux => Some("linux"),
			Self::FreeBsd => Some("freebsd"),
			Self::OpenBsd => Some("openbsd"),
			Self::Windows => None,
		}
	}
}

/// A realpath-resolved root in the exact form hashed by root-v1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalRootV1 {
	/// Platform/path family included in the domain-separated hash.
	pub kind: &'static str,
	/// Canonical, absolute path included as exact UTF-8 bytes.
	pub path: String,
}

/// Stable root-v1 failure classification. Paths are deliberately not retained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootFingerprintError {
	/// The current operating system has no root-v1 spelling.
	UnsupportedPlatform,
	/// The supplied or resolved path is not a permitted root-v1 path.
	InvalidPath,
	/// Native realpath or metadata lookup failed.
	RootUnavailable,
	/// The resolved path exists but is not a directory.
	NotDirectory,
}

impl fmt::Display for RootFingerprintError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(match self {
			Self::UnsupportedPlatform => "the current platform does not support Delver root-v1",
			Self::InvalidPath => "the Delver root path is invalid",
			Self::RootUnavailable => "the Delver root path is unavailable",
			Self::NotDirectory => "the Delver root path is not a directory",
		})
	}
}

impl std::error::Error for RootFingerprintError {}

/// Returns the root-v1 platform for this executable.
pub fn current_root_platform() -> Result<RootPlatform, RootFingerprintError> {
	if cfg!(target_os = "windows") {
		Ok(RootPlatform::Windows)
	} else if cfg!(target_os = "macos") {
		Ok(RootPlatform::Darwin)
	} else if cfg!(target_os = "linux") {
		Ok(RootPlatform::Linux)
	} else if cfg!(target_os = "freebsd") {
		Ok(RootPlatform::FreeBsd)
	} else if cfg!(target_os = "openbsd") {
		Ok(RootPlatform::OpenBsd)
	} else {
		Err(RootFingerprintError::UnsupportedPlatform)
	}
}

/// Resolves, verifies, and fingerprints one explicit existing local directory.
pub fn compute_root_fingerprint_v1(root: &Path) -> Result<String, RootFingerprintError> {
	let platform = current_root_platform()?;
	let input = root.to_str().ok_or(RootFingerprintError::InvalidPath)?;
	validate_input_path(input, platform)?;

	let resolved =
		std::fs::canonicalize(root).map_err(|_| RootFingerprintError::RootUnavailable)?;
	let metadata =
		std::fs::metadata(&resolved).map_err(|_| RootFingerprintError::RootUnavailable)?;
	if !metadata.is_dir() {
		return Err(RootFingerprintError::NotDirectory);
	}
	let resolved = resolved.to_str().ok_or(RootFingerprintError::InvalidPath)?;
	let canonical = canonicalize_resolved_root_v1(resolved, platform)?;
	hash_canonical_root_v1(&canonical)
}

/// Canonicalizes an already-realpathed absolute path without filesystem access.
pub fn canonicalize_resolved_root_v1(
	resolved: &str,
	platform: RootPlatform,
) -> Result<CanonicalRootV1, RootFingerprintError> {
	validate_bounded_string(resolved)?;
	if platform == RootPlatform::Windows {
		return canonicalize_resolved_windows_root(resolved);
	}

	if !resolved.starts_with('/')
		|| resolved.starts_with("//")
		|| resolved.contains("//")
		|| resolved
			.split('/')
			.enumerate()
			.any(|(index, component)| index != 0 && matches!(component, "." | ".."))
	{
		return Err(RootFingerprintError::InvalidPath);
	}
	let canonical_path = if resolved.len() > 1 && resolved.ends_with('/') {
		&resolved[..resolved.len() - 1]
	} else {
		resolved
	};
	Ok(CanonicalRootV1 {
		kind: platform
			.posix_kind()
			.ok_or(RootFingerprintError::UnsupportedPlatform)?,
		path: canonical_path.to_owned(),
	})
}

/// Hashes the exact root-v1 domain, kind, and UTF-8 canonical path bytes.
pub fn hash_canonical_root_v1(root: &CanonicalRootV1) -> Result<String, RootFingerprintError> {
	let platform = match root.kind {
		"win32-drive" | "win32-unc" => RootPlatform::Windows,
		"darwin" => RootPlatform::Darwin,
		"linux" => RootPlatform::Linux,
		"freebsd" => RootPlatform::FreeBsd,
		"openbsd" => RootPlatform::OpenBsd,
		_ => return Err(RootFingerprintError::UnsupportedPlatform),
	};
	let recanonicalized = canonicalize_resolved_root_v1(&root.path, platform)?;
	if recanonicalized != *root {
		return Err(RootFingerprintError::InvalidPath);
	}

	let mut hasher = Sha256::new();
	hasher.update(ROOT_V1_DOMAIN);
	hasher.update([0]);
	hasher.update(root.kind.as_bytes());
	hasher.update([0]);
	hasher.update(root.path.as_bytes());
	Ok(format!("{:x}", hasher.finalize()))
}

fn validate_input_path(input: &str, platform: RootPlatform) -> Result<(), RootFingerprintError> {
	validate_bounded_string(input)?;
	if platform != RootPlatform::Windows {
		return if input.starts_with('/') {
			Ok(())
		} else {
			Err(RootFingerprintError::InvalidPath)
		};
	}

	if has_windows_device_prefix(input) {
		return Err(RootFingerprintError::InvalidPath);
	}
	if let Some(tail) = windows_drive_tail(input) {
		return if tail.contains(':') {
			Err(RootFingerprintError::InvalidPath)
		} else {
			Ok(())
		};
	}
	let Some((server, share, tail)) = windows_unc_parts(input) else {
		return Err(RootFingerprintError::InvalidPath);
	};
	if !valid_unc_authority(server) || !valid_unc_authority(share) || tail.contains(':') {
		return Err(RootFingerprintError::InvalidPath);
	}
	Ok(())
}

fn canonicalize_resolved_windows_root(
	resolved: &str,
) -> Result<CanonicalRootV1, RootFingerprintError> {
	let candidate = if starts_with_ascii_case_insensitive(resolved, r"\\?\UNC\") {
		format!(r"\\{}", &resolved[r"\\?\UNC\".len()..])
	} else if starts_with_ascii_case_insensitive(resolved, r"\\?\") {
		let candidate = &resolved[r"\\?\".len()..];
		if windows_drive_tail(candidate).is_none() {
			return Err(RootFingerprintError::InvalidPath);
		}
		candidate.to_owned()
	} else {
		if has_windows_device_prefix(resolved) {
			return Err(RootFingerprintError::InvalidPath);
		}
		resolved.to_owned()
	};

	if let Some(tail) = windows_drive_tail(&candidate) {
		if tail.starts_with(['/', '\\']) {
			return Err(RootFingerprintError::InvalidPath);
		}
		let drive = candidate.as_bytes()[0].to_ascii_uppercase() as char;
		let tail = canonical_windows_tail(tail)?;
		return Ok(CanonicalRootV1 {
			kind: "win32-drive",
			path: if tail.is_empty() {
				format!("{drive}:/")
			} else {
				format!("{drive}:/{tail}")
			},
		});
	}

	let Some((server, share, tail)) = windows_unc_parts(&candidate) else {
		return Err(RootFingerprintError::InvalidPath);
	};
	if !valid_unc_authority(server) || !valid_unc_authority(share) {
		return Err(RootFingerprintError::InvalidPath);
	}
	let tail = canonical_windows_tail(tail)?;
	let suffix = if tail.is_empty() {
		String::new()
	} else {
		format!("/{tail}")
	};
	Ok(CanonicalRootV1 {
		kind: "win32-unc",
		path: format!(
			"//{}/{}{}",
			server.to_ascii_lowercase(),
			share.to_ascii_lowercase(),
			suffix
		),
	})
}

fn windows_drive_tail(candidate: &str) -> Option<&str> {
	let bytes = candidate.as_bytes();
	if bytes.len() >= 3
		&& bytes[0].is_ascii_alphabetic()
		&& bytes[1] == b':'
		&& is_windows_separator(bytes[2])
	{
		Some(&candidate[3..])
	} else {
		None
	}
}

fn windows_unc_parts(candidate: &str) -> Option<(&str, &str, &str)> {
	let bytes = candidate.as_bytes();
	if bytes.len() < 5 || !is_windows_separator(bytes[0]) || !is_windows_separator(bytes[1]) {
		return None;
	}
	let rest = &candidate[2..];
	let server_end = rest.find(['/', '\\'])?;
	let server = &rest[..server_end];
	let after_server = &rest[server_end + 1..];
	if after_server.is_empty() {
		return None;
	}
	let (share, tail) = match after_server.find(['/', '\\']) {
		Some(share_end) => (&after_server[..share_end], &after_server[share_end..]),
		None => (after_server, ""),
	};
	Some((server, share, tail))
}

fn canonical_windows_tail(tail: &str) -> Result<String, RootFingerprintError> {
	let bytes = tail.as_bytes();
	if tail.contains(':')
		|| bytes
			.windows(2)
			.any(|pair| is_windows_separator(pair[0]) && is_windows_separator(pair[1]))
	{
		return Err(RootFingerprintError::InvalidPath);
	}
	let mut components: Vec<&str> = tail.split(['/', '\\']).collect();
	while components.first() == Some(&"") {
		components.remove(0);
	}
	while components.last() == Some(&"") {
		components.pop();
	}
	if components
		.iter()
		.any(|component| component.is_empty() || matches!(*component, "." | ".."))
	{
		return Err(RootFingerprintError::InvalidPath);
	}
	Ok(components.join("/"))
}

fn valid_unc_authority(component: &str) -> bool {
	!component.is_empty()
		&& !matches!(component, "." | "..")
		&& component
			.bytes()
			.all(|byte| (0x20..=0x7e).contains(&byte) && !br#"<>:"/\|?*"#.contains(&byte))
}

fn has_windows_device_prefix(candidate: &str) -> bool {
	starts_with_ascii_case_insensitive(candidate, r"\\?\")
		|| starts_with_ascii_case_insensitive(candidate, r"\\.\")
		|| starts_with_ascii_case_insensitive(candidate, r"\??\")
		|| starts_with_ascii_case_insensitive(candidate, r"\Device\")
}

fn starts_with_ascii_case_insensitive(value: &str, prefix: &str) -> bool {
	value
		.get(..prefix.len())
		.is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
}

fn is_windows_separator(byte: u8) -> bool {
	matches!(byte, b'/' | b'\\')
}

fn validate_bounded_string(candidate: &str) -> Result<(), RootFingerprintError> {
	if candidate.is_empty() || candidate.contains('\0') || candidate.len() > MAX_ROOT_BYTES {
		Err(RootFingerprintError::InvalidPath)
	} else {
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn locks_cross_implementation_vectors() {
		let vectors = [
			(
				RootPlatform::Windows,
				r"c:\Users\Alice\Project",
				"win32-drive",
				"C:/Users/Alice/Project",
				"f2ba3910dff6197279ca1c4f671d85f3b6014580b4ef125e0637e9a97fb49f6d",
			),
			(
				RootPlatform::Windows,
				"C:\\",
				"win32-drive",
				"C:/",
				"f2875af4ccc606fdeb4b57526a7bc88dbdb7d789bedc17059703c56e18cbbe38",
			),
			(
				RootPlatform::Windows,
				r"\\SERVER\SHARE\Project",
				"win32-unc",
				"//server/share/Project",
				"62f8b7c0156774720c4178969dd4970cfcaf39b08433948a04431ec3081b9f27",
			),
			(
				RootPlatform::Linux,
				"/home/alice/project",
				"linux",
				"/home/alice/project",
				"9994d17eec447dc153e2be8d9f4602b5031539bb1452487512e2c8f12c6d6731",
			),
			(
				RootPlatform::Darwin,
				"/Users/Alice/Café",
				"darwin",
				"/Users/Alice/Café",
				"5202f76b7bd885e7764e201e634f504681dda90d5d797e383911ec1e42d4eb8e",
			),
			(
				RootPlatform::Darwin,
				"/Users/Alice/Cafe\u{301}",
				"darwin",
				"/Users/Alice/Cafe\u{301}",
				"b5de87e0c91fe13c369397c330b5c326a756df3264aa748206eea96c388fcf56",
			),
		];
		for (platform, input, kind, path, fingerprint) in vectors {
			let canonical = canonicalize_resolved_root_v1(input, platform).unwrap();
			assert_eq!(
				canonical,
				CanonicalRootV1 {
					kind,
					path: path.to_owned()
				}
			);
			assert_eq!(hash_canonical_root_v1(&canonical).unwrap(), fingerprint);
		}
	}

	#[test]
	fn accepts_only_safe_extended_windows_results() {
		assert_eq!(
			canonicalize_resolved_root_v1(r"\\?\C:\StoredCase\Root", RootPlatform::Windows)
				.unwrap(),
			CanonicalRootV1 {
				kind: "win32-drive",
				path: "C:/StoredCase/Root".to_owned()
			}
		);
		assert_eq!(
			canonicalize_resolved_root_v1(
				r"\\?\UNC\SERVER\SHARE\StoredCase",
				RootPlatform::Windows
			)
			.unwrap(),
			CanonicalRootV1 {
				kind: "win32-unc",
				path: "//server/share/StoredCase".to_owned()
			}
		);
		for candidate in [
			r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\root",
			r"\\.\pipe\name",
			r"\Device\HarddiskVolume1\root",
			"C:relative",
			r"C:\root:stream",
		] {
			assert_eq!(
				canonicalize_resolved_root_v1(candidate, RootPlatform::Windows),
				Err(RootFingerprintError::InvalidPath)
			);
		}
	}

	#[test]
	fn rejects_noncanonical_resolver_output() {
		for (candidate, platform) in [
			("..", RootPlatform::Windows),
			(r"C:\root\..\other", RootPlatform::Windows),
			(r"C:\root\\child", RootPlatform::Windows),
			("/root/../other", RootPlatform::Linux),
			("/root//child", RootPlatform::Linux),
			("relative", RootPlatform::Darwin),
		] {
			assert_eq!(
				canonicalize_resolved_root_v1(candidate, platform),
				Err(RootFingerprintError::InvalidPath)
			);
		}
	}

	#[test]
	fn computes_an_existing_directory_and_rejects_a_file() {
		let root = std::env::temp_dir().join(format!(
			"delver-mcp-root-test-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		));
		std::fs::create_dir(&root).unwrap();
		let file = root.join("sample.bin");
		std::fs::write(&file, b"sample").unwrap();
		assert_eq!(
			compute_root_fingerprint_v1(&file),
			Err(RootFingerprintError::NotDirectory)
		);
		assert_eq!(compute_root_fingerprint_v1(&root).unwrap().len(), 64);
		std::fs::remove_dir_all(root).unwrap();
	}
}
