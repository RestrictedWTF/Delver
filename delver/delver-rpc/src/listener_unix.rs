//! Unix domain socket listener implementation.
//!
//! Binding and accepting need no unsafe code; peer authentication does, because
//! `SO_PEERCRED` and `getpeereid` have no safe wrapper in the dependency tree.
//! The exemption is granted on the same terms ADR 0003 set for
//! `listener_windows`: it is confined to `libc` calls that read the kernel's
//! own view of the connected process, each argued at its call site, and no
//! unsafe code touches bytes read off the socket.

#![allow(unsafe_code)]

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{Shutdown, UnixListener};
use std::path::PathBuf;
use std::sync::Arc;

use crate::listener::{
	ensure_private_parent, Endpoint, ListenerError, PeerAuthenticatedDuplexStream, PeerIdentity,
	ShutdownableDuplexStream,
};

pub(super) fn effective_user_id() -> u32 {
	// SAFETY: geteuid takes no arguments and has no memory-safety preconditions.
	unsafe { libc::geteuid() }
}

pub(crate) struct UnixListenerImpl {
	listener: UnixListener,
	socket_path: PathBuf,
}

impl UnixListenerImpl {
	pub(crate) fn connect_shutdownable(
		endpoint: &Endpoint,
	) -> Result<ShutdownableDuplexStream, ListenerError> {
		use std::os::unix::net::UnixStream;

		let Endpoint::UnixSocket(path) = endpoint else {
			return Err(ListenerError::new(
				"only unix:// endpoints are supported on this platform",
			));
		};

		let stream = UnixStream::connect(path)
			.map_err(|e| ListenerError::io(e, "connecting to unix socket"))?;
		let read = stream
			.try_clone()
			.map_err(|e| ListenerError::io(e, "cloning unix stream"))?;
		let shutdown_stream = stream
			.try_clone()
			.map_err(|e| ListenerError::io(e, "cloning unix stream for shutdown"))?;
		Ok((
			Box::new(read),
			Box::new(stream),
			Arc::new(move || {
				let _ = shutdown_stream.shutdown(Shutdown::Both);
			}),
		))
	}

	pub(crate) fn bind(endpoint: &Endpoint) -> Result<Self, ListenerError> {
		let Endpoint::UnixSocket(socket_path) = endpoint else {
			return Err(ListenerError::new(
				"only unix:// endpoints are supported on this platform",
			));
		};

		// If the caller gave us a directory, place the socket inside it.
		let socket_path = if socket_path.is_dir() || socket_path.as_os_str().is_empty() {
			return Err(ListenerError::new(
				"unix socket endpoint must be a file path",
			));
		} else {
			socket_path.clone()
		};

		ensure_private_parent(&socket_path)?;

		// The caller must rotate to a fresh endpoint after a crash. Silently
		// unlinking an existing path could delete an attacker-chosen file or
		// replace a live listener between discovery and bind.
		match fs::symlink_metadata(&socket_path) {
			Ok(_) => {
				return Err(ListenerError::new(format!(
					"unix socket endpoint already exists: {}",
					socket_path.display()
				)));
			}
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
			Err(error) => {
				return Err(ListenerError::io(error, "checking unix socket endpoint"));
			}
		}

		let listener = UnixListener::bind(&socket_path)
			.map_err(|e| ListenerError::io(e, "binding unix socket"))?;

		let _ = fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600));

		Ok(Self {
			listener,
			socket_path,
		})
	}

	pub(crate) fn accept_shutdownable_with_peer(
		&self,
	) -> Result<PeerAuthenticatedDuplexStream, ListenerError> {
		let (stream, _addr) = self
			.listener
			.accept()
			.map_err(|e| ListenerError::io(e, "accepting unix connection"))?;
		let peer = peer_identity(&stream)?;

		let read = stream
			.try_clone()
			.map_err(|e| ListenerError::io(e, "cloning unix stream"))?;
		let shutdown_stream = stream
			.try_clone()
			.map_err(|e| ListenerError::io(e, "cloning unix stream for shutdown"))?;
		let write = stream;

		Ok((
			Box::new(read),
			Box::new(write),
			Arc::new(move || {
				let _ = shutdown_stream.shutdown(Shutdown::Both);
			}),
			peer,
		))
	}
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn peer_identity(stream: &std::os::unix::net::UnixStream) -> Result<PeerIdentity, ListenerError> {
	let mut credentials = std::mem::MaybeUninit::<libc::ucred>::uninit();
	let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
	// SAFETY: the output buffer is valid for `length`, and getsockopt initializes
	// it on success before it is read.
	let result = unsafe {
		libc::getsockopt(
			std::os::fd::AsRawFd::as_raw_fd(stream),
			libc::SOL_SOCKET,
			libc::SO_PEERCRED,
			credentials.as_mut_ptr().cast(),
			&mut length,
		)
	};
	if result != 0 || length as usize != std::mem::size_of::<libc::ucred>() {
		return Err(ListenerError::io(
			std::io::Error::last_os_error(),
			"querying unix peer credentials",
		));
	}
	// SAFETY: getsockopt succeeded and returned the full credential structure.
	let credentials = unsafe { credentials.assume_init() };
	Ok(PeerIdentity::new(
		u32::try_from(credentials.pid).ok(),
		Some(credentials.uid),
	))
}

#[cfg(any(
	target_os = "macos",
	target_os = "ios",
	target_os = "freebsd",
	target_os = "openbsd",
	target_os = "netbsd",
	target_os = "dragonfly"
))]
fn peer_identity(stream: &std::os::unix::net::UnixStream) -> Result<PeerIdentity, ListenerError> {
	let mut user_id = 0;
	let mut group_id = 0;
	// SAFETY: getpeereid writes only the two provided uid/gid outputs.
	if unsafe {
		libc::getpeereid(
			std::os::fd::AsRawFd::as_raw_fd(stream),
			&mut user_id,
			&mut group_id,
		)
	} != 0
	{
		return Err(ListenerError::io(
			std::io::Error::last_os_error(),
			"querying unix peer credentials",
		));
	}
	Ok(PeerIdentity::new(None, Some(user_id)))
}

#[cfg(not(any(
	target_os = "linux",
	target_os = "android",
	target_os = "macos",
	target_os = "ios",
	target_os = "freebsd",
	target_os = "openbsd",
	target_os = "netbsd",
	target_os = "dragonfly"
)))]
fn peer_identity(_stream: &std::os::unix::net::UnixStream) -> Result<PeerIdentity, ListenerError> {
	Err(ListenerError::new(
		"OS-derived unix peer credentials are unsupported on this platform",
	))
}

impl Drop for UnixListenerImpl {
	fn drop(&mut self) {
		let _ = fs::remove_file(&self.socket_path);
	}
}
