//---------------------------------------------------------------------------------------------
//  Copyright (c) Microsoft Corporation. All rights reserved.
//  Licensed under the MIT License. See License.txt in the project root for license information.
//---------------------------------------------------------------------------------------------

//! Strict, non-secret discovery of eligible Delver windows.

use std::ffi::OsString;
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::root_fingerprint::{compute_root_fingerprint_v1, RootFingerprintError};

const RENDEZVOUS_SCHEMA_VERSION: u64 = 1;
const RENDEZVOUS_BOOTSTRAP_PROTOCOL_VERSION: u64 = 1;
const RENDEZVOUS_MAX_ENTRY_BYTES: u64 = 8 * 1024;
const RENDEZVOUS_MAX_ENTRIES: usize = 256;
const RENDEZVOUS_MAX_TTL_MS: u64 = 30_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Platform-specific rendezvous location and endpoint scheme.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryPlatform {
	/// Windows local app data and named pipes.
	Windows,
	/// macOS application support and Unix sockets.
	Darwin,
	/// Linux XDG state and Unix sockets.
	Linux,
	/// FreeBSD XDG state and Unix sockets.
	FreeBsd,
	/// OpenBSD XDG state and Unix sockets.
	OpenBsd,
}

/// One strict registry-v1 publication. It contains no credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendezvousRegistryEntry {
	/// Registry schema version.
	pub schema_version: u64,
	/// One-shot bootstrap protocol version.
	pub bootstrap_protocol_version: u64,
	/// Immutable publication generation.
	pub registry_entry_id: String,
	/// Delver window generation.
	pub window_instance_id: String,
	/// Exact root-v1 routing fingerprint.
	pub root_fingerprint: String,
	/// Owner-only bootstrap endpoint, not a DTP endpoint.
	pub bootstrap_endpoint: String,
	/// Diagnostic owner process identifier; never used as authority.
	pub owner_process_id: u64,
	/// Relay-owned publication time in Unix milliseconds.
	pub published_at: u64,
	/// Absolute expiry in Unix milliseconds.
	pub expires_at: u64,
}

/// Non-secret identity returned when multiple windows match the same root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RendezvousCandidateIdentity {
	/// Immutable publication generation.
	pub registry_entry_id: String,
	/// Delver window generation.
	pub window_instance_id: String,
	/// Diagnostic process identifier only.
	pub owner_process_id: u64,
}

/// Discovery or exact-selection failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RendezvousError {
	/// The current platform is outside the registry-v1 contract.
	UnsupportedPlatform,
	/// A required absolute per-user base directory was unavailable.
	RegistryLocationUnavailable,
	/// Native owner/permission auditing failed closed.
	RegistryDirectoryNotPrivate,
	/// The audited registry directory could not be enumerated.
	RegistryUnavailable,
	/// The local clock could not be represented as a safe Unix millisecond value.
	ClockUnavailable,
	/// The explicit root could not be fingerprinted.
	RootFingerprint(RootFingerprintError),
	/// The requested fingerprint is not a lowercase SHA-256 value.
	InvalidRootFingerprint,
	/// No current Delver window publishes the requested root.
	NoMatchingWindow,
	/// More than one current window publishes the requested root.
	AmbiguousWindows(Vec<RendezvousCandidateIdentity>),
}

impl fmt::Display for RendezvousError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::UnsupportedPlatform => formatter
				.write_str("the current platform does not support Delver rendezvous discovery"),
			Self::RegistryLocationUnavailable => {
				formatter.write_str("the per-user Delver rendezvous location is unavailable")
			}
			Self::RegistryDirectoryNotPrivate => formatter
				.write_str("the Delver rendezvous directory is not private to the current user"),
			Self::RegistryUnavailable => {
				formatter.write_str("the Delver rendezvous registry is unavailable")
			}
			Self::ClockUnavailable => formatter
				.write_str("the local clock is unavailable for Delver rendezvous discovery"),
			Self::RootFingerprint(error) => error.fmt(formatter),
			Self::InvalidRootFingerprint => {
				formatter.write_str("the Delver root fingerprint is invalid")
			}
			Self::NoMatchingWindow => {
				formatter.write_str("no Delver window matches the requested root")
			}
			Self::AmbiguousWindows(candidates) => write!(
				formatter,
				"{} Delver windows match the requested root",
				candidates.len()
			),
		}
	}
}

impl std::error::Error for RendezvousError {}

impl From<RootFingerprintError> for RendezvousError {
	fn from(value: RootFingerprintError) -> Self {
		Self::RootFingerprint(value)
	}
}

/// Returns the registry-v1 platform for this executable.
pub fn current_registry_platform() -> Result<RegistryPlatform, RendezvousError> {
	if cfg!(target_os = "windows") {
		Ok(RegistryPlatform::Windows)
	} else if cfg!(target_os = "macos") {
		Ok(RegistryPlatform::Darwin)
	} else if cfg!(target_os = "linux") {
		Ok(RegistryPlatform::Linux)
	} else if cfg!(target_os = "freebsd") {
		Ok(RegistryPlatform::FreeBsd)
	} else if cfg!(target_os = "openbsd") {
		Ok(RegistryPlatform::OpenBsd)
	} else {
		Err(RendezvousError::UnsupportedPlatform)
	}
}

/// Resolves the deterministic client-neutral per-user registry-v1 directory.
pub fn resolve_rendezvous_registry_directory() -> Result<PathBuf, RendezvousError> {
	let platform = current_registry_platform()?;
	let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
	let state_home = std::env::var_os("XDG_STATE_HOME").map(PathBuf::from);
	let home = std::env::var_os("HOME").map(PathBuf::from);
	resolve_rendezvous_registry_directory_for(
		platform,
		local_app_data.as_deref(),
		state_home.as_deref(),
		home.as_deref(),
	)
}

/// Enumerates current strict registry entries after auditing the directory.
pub fn list_rendezvous_entries(
	directory: &Path,
	now_ms: u64,
) -> Result<Vec<RendezvousRegistryEntry>, RendezvousError> {
	let platform = current_registry_platform()?;
	list_rendezvous_entries_for(directory, now_ms, platform)
}

/// Fingerprints one explicit root and selects exactly one matching window.
pub fn select_window_for_root(root: &Path) -> Result<RendezvousRegistryEntry, RendezvousError> {
	let fingerprint = compute_root_fingerprint_v1(root)?;
	let directory = resolve_rendezvous_registry_directory()?;
	let now_ms = current_time_millis()?;
	select_window_for_fingerprint(&directory, &fingerprint, now_ms)
}

/// Selects exactly one current publication for a previously computed root-v1 fingerprint.
pub fn select_window_for_fingerprint(
	directory: &Path,
	fingerprint: &str,
	now_ms: u64,
) -> Result<RendezvousRegistryEntry, RendezvousError> {
	if !is_root_fingerprint(fingerprint) {
		return Err(RendezvousError::InvalidRootFingerprint);
	}
	select_window_from_entries(list_rendezvous_entries(directory, now_ms)?, fingerprint)
}

fn select_window_from_entries(
	entries: Vec<RendezvousRegistryEntry>,
	fingerprint: &str,
) -> Result<RendezvousRegistryEntry, RendezvousError> {
	let matches: Vec<_> = entries
		.into_iter()
		.filter(|entry| entry.root_fingerprint == fingerprint)
		.collect();
	match matches.as_slice() {
		[] => Err(RendezvousError::NoMatchingWindow),
		[entry] => Ok(entry.clone()),
		_ => Err(RendezvousError::AmbiguousWindows(
			matches.iter().map(candidate_identity).collect(),
		)),
	}
}

fn resolve_rendezvous_registry_directory_for(
	platform: RegistryPlatform,
	local_app_data: Option<&Path>,
	state_home: Option<&Path>,
	home: Option<&Path>,
) -> Result<PathBuf, RendezvousError> {
	if platform == RegistryPlatform::Windows {
		let base = require_absolute_base(local_app_data)?;
		return Ok(base
			.join("Delver")
			.join("agent-rendezvous")
			.join("v1")
			.join("entries"));
	}
	let home = require_absolute_base(home)?;
	if platform == RegistryPlatform::Darwin {
		return Ok(home
			.join("Library")
			.join("Application Support")
			.join("Delver")
			.join("agent-rendezvous")
			.join("v1")
			.join("entries"));
	}
	let base = match state_home {
		Some(path) if !path.as_os_str().is_empty() => require_absolute_base(Some(path))?,
		_ => home.join(".local").join("state"),
	};
	Ok(base
		.join("delver")
		.join("agent-rendezvous")
		.join("v1")
		.join("entries"))
}

fn list_rendezvous_entries_for(
	directory: &Path,
	now_ms: u64,
	platform: RegistryPlatform,
) -> Result<Vec<RendezvousRegistryEntry>, RendezvousError> {
	list_rendezvous_entries_with_audit(directory, now_ms, platform, |directory| {
		delver_rpc::ensure_private_directory(directory)
			.map_err(|_| RendezvousError::RegistryDirectoryNotPrivate)
	})
}

fn list_rendezvous_entries_with_audit(
	directory: &Path,
	now_ms: u64,
	platform: RegistryPlatform,
	audit_directory: impl FnOnce(&Path) -> Result<(), RendezvousError>,
) -> Result<Vec<RendezvousRegistryEntry>, RendezvousError> {
	if now_ms > MAX_SAFE_INTEGER {
		return Err(RendezvousError::ClockUnavailable);
	}
	audit_directory(directory)?;

	#[cfg(unix)]
	let expected_user_id = {
		use std::os::unix::fs::MetadataExt;
		std::fs::symlink_metadata(directory)
			.map_err(|_| RendezvousError::RegistryUnavailable)?
			.uid()
	};

	let mut names: Vec<OsString> = std::fs::read_dir(directory)
		.map_err(|_| RendezvousError::RegistryUnavailable)?
		.filter_map(|result| result.ok().map(|entry| entry.file_name()))
		.filter(|name| entry_id_from_file_name(name).is_some())
		.collect();
	names.sort();
	names.truncate(RENDEZVOUS_MAX_ENTRIES);

	let mut entries = Vec::new();
	for name in names {
		let Some(expected_id) = entry_id_from_file_name(&name) else {
			continue;
		};
		let candidate = directory.join(&name);
		let entry = read_registry_entry(
			&candidate,
			&expected_id,
			platform,
			now_ms,
			#[cfg(unix)]
			expected_user_id,
		);
		if let Some(entry) = entry {
			entries.push(entry);
		}
	}
	Ok(entries)
}

fn read_registry_entry(
	path: &Path,
	expected_id: &str,
	platform: RegistryPlatform,
	now_ms: u64,
	#[cfg(unix)] expected_user_id: u32,
) -> Option<RendezvousRegistryEntry> {
	let path_metadata = std::fs::symlink_metadata(path).ok()?;
	if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
		return None;
	}
	let mut file = File::open(path).ok()?;
	let metadata = file.metadata().ok()?;
	if !metadata.is_file() || metadata.len() == 0 || metadata.len() > RENDEZVOUS_MAX_ENTRY_BYTES {
		return None;
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::{MetadataExt, PermissionsExt};
		if metadata.uid() != expected_user_id || metadata.permissions().mode() & 0o077 != 0 {
			return None;
		}
	}

	let mut data = Vec::with_capacity(metadata.len() as usize);
	file.by_ref()
		.take(RENDEZVOUS_MAX_ENTRY_BYTES + 1)
		.read_to_end(&mut data)
		.ok()?;
	if data.is_empty() || data.len() as u64 > RENDEZVOUS_MAX_ENTRY_BYTES {
		return None;
	}
	let entry: RendezvousRegistryEntry = serde_json::from_slice(&data).ok()?;
	validate_registry_entry(&entry, platform, now_ms).then_some(())?;
	(entry.registry_entry_id == expected_id).then_some(entry)
}

fn validate_registry_entry(
	entry: &RendezvousRegistryEntry,
	platform: RegistryPlatform,
	now_ms: u64,
) -> bool {
	entry.schema_version == RENDEZVOUS_SCHEMA_VERSION
		&& entry.bootstrap_protocol_version == RENDEZVOUS_BOOTSTRAP_PROTOCOL_VERSION
		&& is_registry_id(&entry.registry_entry_id)
		&& is_registry_id(&entry.window_instance_id)
		&& is_root_fingerprint(&entry.root_fingerprint)
		&& is_local_endpoint(&entry.bootstrap_endpoint, platform)
		&& (1..=MAX_SAFE_INTEGER).contains(&entry.owner_process_id)
		&& entry.published_at <= MAX_SAFE_INTEGER
		&& entry.expires_at <= MAX_SAFE_INTEGER
		&& entry.published_at <= now_ms
		&& entry.expires_at > now_ms
		&& entry.expires_at >= entry.published_at
		&& entry
			.expires_at
			.checked_sub(entry.published_at)
			.is_some_and(|ttl| ttl <= RENDEZVOUS_MAX_TTL_MS)
}

fn is_local_endpoint(endpoint: &str, platform: RegistryPlatform) -> bool {
	let length = endpoint.encode_utf16().count();
	if !(8..=512).contains(&length)
		|| endpoint
			.chars()
			.any(|character| matches!(character as u32, 0x00..=0x1f | 0x7f..=0x9f))
	{
		return false;
	}
	if platform == RegistryPlatform::Windows {
		return endpoint
			.strip_prefix("pipe://")
			.is_some_and(|name| !name.is_empty() && name.bytes().all(is_pipe_name_byte));
	}
	endpoint
		.strip_prefix("unix://")
		.is_some_and(|path| path.starts_with('/'))
}

fn entry_id_from_file_name(name: &OsString) -> Option<String> {
	let name = name.to_str()?;
	let id = name.strip_suffix(".json")?;
	is_registry_id(id).then(|| id.to_owned())
}

fn is_registry_id(value: &str) -> bool {
	(16..=128).contains(&value.len())
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn is_root_fingerprint(value: &str) -> bool {
	value.len() == 64
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_pipe_name_byte(byte: u8) -> bool {
	byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
}

fn candidate_identity(entry: &RendezvousRegistryEntry) -> RendezvousCandidateIdentity {
	RendezvousCandidateIdentity {
		registry_entry_id: entry.registry_entry_id.clone(),
		window_instance_id: entry.window_instance_id.clone(),
		owner_process_id: entry.owner_process_id,
	}
}

fn require_absolute_base(value: Option<&Path>) -> Result<PathBuf, RendezvousError> {
	let value = value.ok_or(RendezvousError::RegistryLocationUnavailable)?;
	if value.as_os_str().is_empty() || !value.is_absolute() {
		return Err(RendezvousError::RegistryLocationUnavailable);
	}
	Ok(value.to_path_buf())
}

fn current_time_millis() -> Result<u64, RendezvousError> {
	let millis = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_err(|_| RendezvousError::ClockUnavailable)?
		.as_millis();
	let millis = u64::try_from(millis).map_err(|_| RendezvousError::ClockUnavailable)?;
	(millis <= MAX_SAFE_INTEGER)
		.then_some(millis)
		.ok_or(RendezvousError::ClockUnavailable)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn platform() -> RegistryPlatform {
		current_registry_platform().unwrap()
	}

	fn endpoint() -> String {
		if platform() == RegistryPlatform::Windows {
			"pipe://delver-bootstrap-0001".to_owned()
		} else {
			"unix:///tmp/delver-bootstrap-0001.sock".to_owned()
		}
	}

	fn entry(id: &str, fingerprint: &str) -> RendezvousRegistryEntry {
		RendezvousRegistryEntry {
			schema_version: 1,
			bootstrap_protocol_version: 1,
			registry_entry_id: id.to_owned(),
			window_instance_id: format!("window_{id}"),
			root_fingerprint: fingerprint.to_owned(),
			bootstrap_endpoint: endpoint(),
			owner_process_id: 4242,
			published_at: 1_000,
			expires_at: 31_000,
		}
	}

	fn fixture_directory() -> PathBuf {
		let base = std::env::temp_dir().join(format!(
			"delver-mcp-registry-test-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		));
		std::fs::create_dir(&base).unwrap();
		let directory = base
			.join("delver")
			.join("agent-rendezvous")
			.join("v1")
			.join("entries");
		std::fs::create_dir_all(&directory).unwrap();
		directory
	}

	fn write_entry(directory: &Path, entry: &RendezvousRegistryEntry) {
		let path = directory.join(format!("{}.json", entry.registry_entry_id));
		std::fs::write(&path, serde_json::to_vec(entry).unwrap()).unwrap();
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
		}
	}

	fn remove_fixture(directory: &Path) {
		let base = directory.ancestors().nth(4).unwrap();
		std::fs::remove_dir_all(base).unwrap();
	}

	fn list_fixture(directory: &Path, now_ms: u64) -> Vec<RendezvousRegistryEntry> {
		list_rendezvous_entries_with_audit(directory, now_ms, platform(), |_| Ok(())).unwrap()
	}

	#[test]
	fn lists_only_strict_current_filename_matched_entries() {
		let directory = fixture_directory();
		let fingerprint = "a".repeat(64);
		let valid = entry("registry_entry_0001", &fingerprint);
		write_entry(&directory, &valid);
		write_entry(
			&directory,
			&RendezvousRegistryEntry {
				registry_entry_id: "registry_entry_0002".to_owned(),
				published_at: 5_000,
				expires_at: 10_000,
				..valid.clone()
			},
		);
		write_entry(
			&directory,
			&RendezvousRegistryEntry {
				registry_entry_id: "registry_entry_0003".to_owned(),
				published_at: 0,
				expires_at: 1_500,
				..valid.clone()
			},
		);
		std::fs::write(directory.join("registry_entry_0004.json"), b"{bad json").unwrap();
		let mismatched = entry("registry_entry_9999", &fingerprint);
		let mismatch_path = directory.join("registry_entry_0005.json");
		std::fs::write(&mismatch_path, serde_json::to_vec(&mismatched).unwrap()).unwrap();
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			std::fs::set_permissions(mismatch_path, std::fs::Permissions::from_mode(0o600))
				.unwrap();
		}

		assert_eq!(list_fixture(&directory, 2_000), vec![valid]);
		remove_fixture(&directory);
	}

	#[test]
	fn rejects_unknown_fields_wrong_endpoint_and_permissive_files() {
		let directory = fixture_directory();
		let fingerprint = "a".repeat(64);
		let valid = entry("registry_entry_0001", &fingerprint);
		let mut value = serde_json::to_value(&valid).unwrap();
		value
			.as_object_mut()
			.unwrap()
			.insert("token".to_owned(), serde_json::json!("secret"));
		let unknown_path = directory.join("registry_entry_0001.json");
		std::fs::write(&unknown_path, serde_json::to_vec(&value).unwrap()).unwrap();
		let wrong_endpoint = RendezvousRegistryEntry {
			registry_entry_id: "registry_entry_0002".to_owned(),
			bootstrap_endpoint: if platform() == RegistryPlatform::Windows {
				"unix:///tmp/wrong".to_owned()
			} else {
				"pipe://wrong-platform".to_owned()
			},
			..valid
		};
		write_entry(&directory, &wrong_endpoint);
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			std::fs::set_permissions(unknown_path, std::fs::Permissions::from_mode(0o644)).unwrap();
		}

		assert!(list_fixture(&directory, 2_000).is_empty());
		remove_fixture(&directory);
	}

	#[test]
	fn selects_exactly_one_and_never_uses_pid_as_authority() {
		let directory = fixture_directory();
		let fingerprint = "a".repeat(64);
		let first = entry("registry_entry_0001", &fingerprint);
		write_entry(&directory, &first);
		assert_eq!(
			select_window_from_entries(list_fixture(&directory, 2_000), &fingerprint).unwrap(),
			first
		);

		let second = RendezvousRegistryEntry {
			registry_entry_id: "registry_entry_0002".to_owned(),
			window_instance_id: "window_registry_entry_0002".to_owned(),
			owner_process_id: 4242,
			..first.clone()
		};
		write_entry(&directory, &second);
		assert_eq!(
			select_window_from_entries(list_fixture(&directory, 2_000), &fingerprint),
			Err(RendezvousError::AmbiguousWindows(vec![
				candidate_identity(&first),
				candidate_identity(&second),
			]))
		);
		assert_eq!(
			select_window_from_entries(list_fixture(&directory, 2_000), &"b".repeat(64)),
			Err(RendezvousError::NoMatchingWindow)
		);
		remove_fixture(&directory);
	}

	#[cfg(unix)]
	#[test]
	fn rejects_a_registry_hierarchy_that_is_not_private() {
		use std::os::unix::fs::PermissionsExt;
		let directory = fixture_directory();
		delver_rpc::ensure_private_directory(&directory).unwrap();
		std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).unwrap();
		assert_eq!(
			list_rendezvous_entries_for(&directory, 2_000, platform()),
			Err(RendezvousError::RegistryDirectoryNotPrivate)
		);
		std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
		remove_fixture(&directory);
	}

	#[cfg(unix)]
	#[test]
	fn resolves_xdg_and_home_fallback_paths() {
		assert_eq!(
			resolve_rendezvous_registry_directory_for(
				RegistryPlatform::Linux,
				None,
				Some(Path::new("/state/alice")),
				Some(Path::new("/home/alice")),
			)
			.unwrap(),
			Path::new("/state/alice/delver/agent-rendezvous/v1/entries")
		);
		assert_eq!(
			resolve_rendezvous_registry_directory_for(
				RegistryPlatform::Linux,
				None,
				None,
				Some(Path::new("/home/alice")),
			)
			.unwrap(),
			Path::new("/home/alice/.local/state/delver/agent-rendezvous/v1/entries")
		);
	}
}
