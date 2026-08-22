//! Current-user-only directory preparation for local discovery metadata.

use std::fmt;
use std::path::{Component, Path, PathBuf};

const OWNED_DIRECTORY_DEPTH: usize = 4;
const MAX_DIRECTORY_PATH_LENGTH: usize = 2048;

/// Error returned when a private directory cannot be created or audited.
#[derive(Debug)]
pub struct PrivateDirectoryError {
	message: String,
}

impl PrivateDirectoryError {
	pub(crate) fn new(message: impl Into<String>) -> Self {
		Self {
			message: message.into(),
		}
	}

	pub(crate) fn io(error: std::io::Error, context: &str) -> Self {
		Self::new(format!("{context}: {error}"))
	}
}

impl fmt::Display for PrivateDirectoryError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(formatter, "{}", self.message)
	}
}

impl std::error::Error for PrivateDirectoryError {}

/// Creates and audits the final four Delver-owned path components.
///
/// Windows directories receive a protected, inheritable DACL containing only
/// the current token user's full-control ACE. POSIX directories must be real,
/// current-user-owned mode-0700 directories. Existing permissive paths are
/// rejected rather than silently repaired.
pub fn ensure_private_directory(path: &Path) -> Result<(), PrivateDirectoryError> {
	let chain = owned_directory_chain(path)?;
	platform::ensure(&chain)
}

fn owned_directory_chain(path: &Path) -> Result<Vec<PathBuf>, PrivateDirectoryError> {
	if !path.is_absolute() || path.as_os_str().len() > MAX_DIRECTORY_PATH_LENGTH {
		return Err(PrivateDirectoryError::new(
			"private directory path must be a bounded absolute path",
		));
	}
	if path
		.components()
		.any(|component| matches!(component, Component::CurDir | Component::ParentDir))
	{
		return Err(PrivateDirectoryError::new(
			"private directory path must not contain relative components",
		));
	}
	validate_platform_path(path)?;

	let mut chain = Vec::with_capacity(OWNED_DIRECTORY_DEPTH);
	let mut current = path.to_path_buf();
	for _ in 0..OWNED_DIRECTORY_DEPTH {
		if !matches!(current.file_name(), Some(name) if !name.is_empty()) {
			return Err(PrivateDirectoryError::new(
				"private directory path is too shallow",
			));
		}
		chain.push(current.clone());
		current = current
			.parent()
			.ok_or_else(|| PrivateDirectoryError::new("private directory path is too shallow"))?
			.to_path_buf();
	}
	chain.reverse();
	Ok(chain)
}

#[cfg(windows)]
fn validate_platform_path(path: &Path) -> Result<(), PrivateDirectoryError> {
	use std::path::Prefix;

	let mut components = path.components();
	if !matches!(components.next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
		|| !matches!(components.next(), Some(Component::RootDir))
		|| components.any(|component| matches!(component, Component::Normal(value) if value.to_string_lossy().contains(':')))
	{
		return Err(PrivateDirectoryError::new(
			"private directory must be a local drive path without device, UNC, or stream syntax",
		));
	}
	Ok(())
}

#[cfg(unix)]
fn validate_platform_path(_path: &Path) -> Result<(), PrivateDirectoryError> {
	Ok(())
}

#[cfg(unix)]
mod platform {
	use super::*;
	use std::fs;
	use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

	pub(super) fn ensure(chain: &[PathBuf]) -> Result<(), PrivateDirectoryError> {
		let user_id = crate::listener_unix::effective_user_id();
		for directory in chain {
			let metadata = match fs::symlink_metadata(directory) {
				Ok(metadata) => metadata,
				Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
					let mut builder = fs::DirBuilder::new();
					builder.mode(0o700);
					match builder.create(directory) {
						Ok(()) => {}
						Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
						Err(error) => {
							return Err(PrivateDirectoryError::io(
								error,
								"creating private directory",
							));
						}
					}
					fs::symlink_metadata(directory).map_err(|error| {
						PrivateDirectoryError::io(error, "auditing created private directory")
					})?
				}
				Err(error) => {
					return Err(PrivateDirectoryError::io(
						error,
						"auditing private directory",
					));
				}
			};
			if metadata.file_type().is_symlink()
				|| !metadata.is_dir()
				|| metadata.uid() != user_id
				|| metadata.permissions().mode() & 0o077 != 0
			{
				return Err(PrivateDirectoryError::new(
					"private directory is not restricted to the current user",
				));
			}
		}
		Ok(())
	}
}

#[cfg(windows)]
#[path = "private_directory_windows.rs"]
mod platform;

#[cfg(test)]
mod tests {
	use super::*;
	use std::time::{SystemTime, UNIX_EPOCH};

	#[test]
	fn creates_and_reaudits_private_hierarchy() {
		let root = test_root();
		std::fs::create_dir(&root).expect("create private directory test root");
		let directory = root
			.join("delver")
			.join("agent-rendezvous")
			.join("v1")
			.join("entries");
		ensure_private_directory(&directory).expect("create private directory");
		ensure_private_directory(&directory).expect("reaudit private directory");
		assert!(directory.is_dir());
		std::fs::remove_dir_all(&root).expect("remove private directory test root");
	}

	#[test]
	fn rejects_relative_and_shallow_paths() {
		assert!(ensure_private_directory(Path::new("relative/path")).is_err());
		#[cfg(unix)]
		assert!(ensure_private_directory(Path::new("/one/two")).is_err());
	}

	#[test]
	fn supports_concurrent_creators_and_rejects_a_file_component() {
		let root = test_root();
		std::fs::create_dir(&root).expect("create private directory test root");
		let directory = root
			.join("delver")
			.join("agent-rendezvous")
			.join("v1")
			.join("entries");
		let first = directory.clone();
		let second = directory.clone();
		let creators = [
			std::thread::spawn(move || ensure_private_directory(&first)),
			std::thread::spawn(move || ensure_private_directory(&second)),
		];
		for creator in creators {
			creator
				.join()
				.expect("join creator")
				.expect("create concurrently");
		}
		std::fs::remove_dir_all(&root).expect("remove concurrent directory test root");

		let file_root = test_root();
		std::fs::create_dir(&file_root).expect("create file component test root");
		std::fs::write(file_root.join("delver"), b"not a directory").expect("write file component");
		let invalid = file_root
			.join("delver")
			.join("agent-rendezvous")
			.join("v1")
			.join("entries");
		assert!(ensure_private_directory(&invalid).is_err());
		std::fs::remove_dir_all(&file_root).expect("remove file component test root");
	}

	#[cfg(unix)]
	#[test]
	fn rejects_permissive_existing_directory() {
		use std::os::unix::fs::PermissionsExt;

		let root = test_root();
		std::fs::create_dir(&root).expect("create private directory test root");
		let directory = root
			.join("delver")
			.join("agent-rendezvous")
			.join("v1")
			.join("entries");
		ensure_private_directory(&directory).expect("create private directory");
		std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755))
			.expect("make directory permissive");
		assert!(ensure_private_directory(&directory).is_err());
		std::fs::remove_dir_all(&root).expect("remove private directory test root");
	}

	fn test_root() -> PathBuf {
		let nonce = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system clock")
			.as_nanos();
		std::env::temp_dir().join(format!(
			"delver-private-directory-test-{}-{nonce}",
			std::process::id()
		))
	}
}
