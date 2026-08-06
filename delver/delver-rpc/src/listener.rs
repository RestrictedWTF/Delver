//! Cross-platform listener for local RPC connections.
//!
//! On Windows this creates a named pipe with a DACL restricted to the current
//! user. On Unix it creates a Unix domain socket inside a mode-0700 directory.
//!
//! The listener returns a `(Read, Write)` pair for each accepted connection so
//! that it plugs directly into [`Server`](crate::Server) and
//! [`Client`](crate::Client).

use std::fmt;
use std::io::{Read, Write};
use std::path::PathBuf;

/// The reader and writer halves of one accepted connection.
///
/// Boxed rather than generic so that the Windows named-pipe and Unix socket
/// backends can return the same type from a single cross-platform signature.
pub type DuplexStream = (Box<dyn Read + Send>, Box<dyn Write + Send>);

/// Errors that can occur when binding or accepting on a local endpoint.
#[derive(Debug)]
pub struct ListenerError {
	message: String,
}

impl ListenerError {
	pub(crate) fn new(message: impl Into<String>) -> Self {
		Self {
			message: message.into(),
		}
	}

	pub(crate) fn io(err: std::io::Error, context: &str) -> Self {
		Self::new(format!("{context}: {err}"))
	}
}

impl fmt::Display for ListenerError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}", self.message)
	}
}

impl std::error::Error for ListenerError {}

/// A local endpoint that a [`Listener`] can bind to.
#[derive(Debug, Clone)]
pub enum Endpoint {
	/// A Windows named pipe path, e.g. `\\.\pipe\delver-abc123`.
	NamedPipe(String),
	/// A Unix domain socket path.
	UnixSocket(PathBuf),
}

impl Endpoint {
	/// Parses an endpoint string.
	///
	/// Accepted forms:
	/// - `pipe://<name>` or `npipe://<name>` → Windows named pipe `\\.\pipe\<name>`
	/// - `unix://<path>` → Unix socket
	/// - On Windows, any other string is treated as a named-pipe name.
	/// - On Unix, any other string is treated as a socket path.
	pub fn parse(s: &str) -> Result<Self, ListenerError> {
		if let Some(name) = s.strip_prefix("pipe://") {
			return Ok(Self::named_pipe(name));
		}
		if let Some(name) = s.strip_prefix("npipe://") {
			return Ok(Self::named_pipe(name));
		}
		if let Some(path) = s.strip_prefix("unix://") {
			return Ok(Self::UnixSocket(PathBuf::from(path)));
		}

		#[cfg(windows)]
		{
			Ok(Self::named_pipe(s))
		}
		#[cfg(unix)]
		{
			Ok(Self::UnixSocket(PathBuf::from(s)))
		}
	}

	fn named_pipe(name: &str) -> Self {
		// Normalize to the full Win32 named-pipe namespace.
		let path = if name.starts_with(r"\\.\pipe\") {
			name.to_string()
		} else {
			format!(r"\\.\pipe\{name}")
		};
		Self::NamedPipe(path)
	}

	/// Returns the client-visible connection string for this endpoint.
	pub fn client_string(&self) -> String {
		match self {
			Endpoint::NamedPipe(p) => p.clone(),
			Endpoint::UnixSocket(p) => p.to_string_lossy().to_string(),
		}
	}
}

/// A bound local listener.
pub struct Listener {
	endpoint: Endpoint,
	inner: ListenerImpl,
}

impl Listener {
	/// Binds a listener to `endpoint`.
	pub fn bind(endpoint: &str) -> Result<Self, ListenerError> {
		let endpoint = Endpoint::parse(endpoint)?;
		let inner = ListenerImpl::bind(&endpoint)?;
		Ok(Self { endpoint, inner })
	}

	/// Accepts the next incoming connection.
	///
	/// Blocks until a client connects.
	pub fn accept(&self) -> Result<DuplexStream, ListenerError> {
		self.inner.accept()
	}

	/// Returns the endpoint this listener is bound to.
	pub fn endpoint(&self) -> &Endpoint {
		&self.endpoint
	}
}

/// Connects to a listening local endpoint.
///
/// On Unix this opens a Unix domain socket; on Windows it opens a named pipe.
/// Returns independent read and write halves for use with [`Client`](crate::Client).
pub fn connect(endpoint: &str) -> Result<DuplexStream, ListenerError> {
	let endpoint = Endpoint::parse(endpoint)?;
	ListenerImpl::connect(&endpoint)
}

#[cfg(unix)]
type ListenerImpl = super::listener_unix::UnixListenerImpl;

#[cfg(windows)]
type ListenerImpl = super::listener_windows::WindowsListenerImpl;

/// Ensures the parent directory of `path` exists with restricted permissions.
#[cfg(unix)]
pub(crate) fn ensure_private_parent(path: &Path) -> Result<(), ListenerError> {
	use std::fs;
	use std::os::unix::fs::PermissionsExt;

	let Some(parent) = path.parent() else {
		return Err(ListenerError::new("socket path has no parent directory"));
	};

	if !parent.exists() {
		fs::create_dir_all(parent)
			.map_err(|e| ListenerError::io(e, "creating socket directory"))?;
		let mut perms = fs::metadata(parent)
			.map_err(|e| ListenerError::io(e, "reading socket directory permissions"))?
			.permissions();
		perms.set_mode(0o700);
		fs::set_permissions(parent, perms)
			.map_err(|e| ListenerError::io(e, "setting socket directory permissions"))?;
	}

	Ok(())
}

/// Returns the last OS error as a [`ListenerError`].
#[cfg(windows)]
pub(crate) fn last_error(context: &str) -> ListenerError {
	ListenerError::new(format!("{context}: {}", std::io::Error::last_os_error()))
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::{Read, Write};
	use std::thread;

	#[test]
	fn listener_accepts_and_connects() {
		// Use a per-test endpoint. On Windows this is a named pipe; on Unix a
		// socket in the temp directory.
		#[cfg(windows)]
		let endpoint = format!("pipe://delver-test-{}", std::process::id());
		#[cfg(unix)]
		let endpoint = format!(
			"unix://{}/delver-test-{}.sock",
			std::env::temp_dir().to_string_lossy(),
			std::process::id()
		);

		let listener = Listener::bind(&endpoint).expect("bind listener");

		let server = thread::spawn(move || {
			let (mut reader, mut writer) = listener.accept().expect("accept");
			let mut buf = [0u8; 5];
			reader.read_exact(&mut buf).expect("server read");
			assert_eq!(&buf, b"hello");
			writer.write_all(b"world").expect("server write");
			writer.flush().expect("server flush");
		});

		let (mut reader, mut writer) = connect(&endpoint).expect("connect");
		writer.write_all(b"hello").expect("client write");
		writer.flush().expect("client flush");

		let mut buf = [0u8; 5];
		reader.read_exact(&mut buf).expect("client read");
		assert_eq!(&buf, b"world");

		server.join().expect("server thread");
	}
}
