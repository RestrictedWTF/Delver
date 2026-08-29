//! Owner-only local transport relay for the Delver agent bridge.
//!
//! The relay deliberately does not parse DTP, authenticate clients, or know
//! about analysis. It gives the extension host a byte stream backed by the
//! security-sensitive named-pipe/Unix-socket implementation in `delver-rpc`.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::io::{self, Read, Write};
use std::sync::{mpsc, Arc};
use std::thread;

use delver_rpc::{Listener, PeerIdentity};
use serde::Serialize;

/// Exact bounded JSON line written after the endpoint is bound and before accept.
pub const READY_SIGNAL: &str = r#"{"event":"ready","schemaVersion":1}"#;

/// Exact bounded JSON line emitted after the private registry hierarchy passes audit.
pub const REGISTRY_DIRECTORY_READY_SIGNAL: &str =
	r#"{"event":"registryDirectoryReady","schemaVersion":1}"#;

/// Accepts one client and relays bytes between it and the host streams.
///
/// One process intentionally owns one connection. When the client disconnects,
/// this function returns and the extension starts a fresh process. That makes
/// connection teardown an OS process boundary and avoids multiplexing client
/// identities inside an untrusted byte relay.
pub fn relay_once<R, W>(listener: &Listener, host_input: R, host_output: W) -> anyhow::Result<u64>
where
	R: Read + Send + 'static,
	W: Write + Send + 'static,
{
	relay_once_with_peer(listener, host_input, host_output, |_| Ok(()))
}

/// Accepts one client, reports its OS-derived identity, then relays bytes.
pub fn relay_once_with_peer<R, W, F>(
	listener: &Listener,
	mut host_input: R,
	mut host_output: W,
	report_peer: F,
) -> anyhow::Result<u64>
where
	R: Read + Send + 'static,
	W: Write + Send + 'static,
	F: FnOnce(&PeerIdentity) -> anyhow::Result<()>,
{
	let (mut client_reader, mut client_writer, shutdown, peer) =
		listener.accept_shutdownable_with_peer()?;
	report_peer(&peer)?;
	let (completed, completion) = mpsc::channel();

	let writer_completed = completed.clone();
	let writer_shutdown = Arc::clone(&shutdown);
	thread::spawn(move || {
		let copied = copy_live(&mut host_input, &mut client_writer);
		let _ = writer_completed.send(copied);
		writer_shutdown();
	});

	let reader_shutdown = Arc::clone(&shutdown);
	thread::spawn(move || {
		let copied = copy_live(&mut client_reader, &mut host_output);
		let _ = completed.send(copied);
		reader_shutdown();
	});

	let copied = completion_result(&completion.recv());
	shutdown();
	copied
}

fn copy_live<R: Read, W: Write>(reader: &mut R, writer: &mut W) -> io::Result<u64> {
	let mut buffer = [0_u8; 64 * 1024];
	let mut copied = 0_u64;
	loop {
		let read = reader.read(&mut buffer)?;
		if read == 0 {
			return Ok(copied);
		}
		writer.write_all(&buffer[..read])?;
		writer.flush()?;
		copied = copied.saturating_add(read as u64);
	}
}

/// Serializes the bounded control record used to attest a bootstrap peer.
pub fn peer_control_record(peer: &PeerIdentity) -> anyhow::Result<String> {
	Ok(serde_json::to_string(&PeerControlRecord {
		event: "peer",
		schema_version: 1,
		process_id: peer.process_id(),
		user_id: peer.user_id(),
	})?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PeerControlRecord {
	event: &'static str,
	schema_version: u8,
	#[serde(skip_serializing_if = "Option::is_none")]
	process_id: Option<u32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	user_id: Option<u32>,
}

fn completion_result(completed: &Result<io::Result<u64>, mpsc::RecvError>) -> anyhow::Result<u64> {
	match completed {
		Ok(Ok(count)) => Ok(*count),
		Ok(Err(error)) if is_disconnect_error(error) => Ok(0),
		Ok(Err(error)) => Err(anyhow::anyhow!(error.to_string())),
		Err(error) => Err(anyhow::anyhow!(error.to_string())),
	}
}

fn is_disconnect_error(error: &io::Error) -> bool {
	matches!(
		error.kind(),
		io::ErrorKind::BrokenPipe
			| io::ErrorKind::ConnectionAborted
			| io::ErrorKind::ConnectionReset
			| io::ErrorKind::UnexpectedEof
	)
}

#[cfg(test)]
mod tests {
	use super::*;
	use delver_rpc::connect;
	use std::io::Cursor;
	use std::sync::{mpsc, Arc, Condvar, Mutex};
	use std::time::{Duration, Instant};

	#[derive(Default)]
	struct SharedOutputState {
		pending: Vec<u8>,
		flushed: Vec<u8>,
	}

	#[derive(Clone, Default)]
	struct SharedOutput(Arc<(Mutex<SharedOutputState>, Condvar)>);

	impl Write for SharedOutput {
		fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
			let output = &self.0 .0;
			output
				.lock()
				.expect("lock output")
				.pending
				.extend_from_slice(buffer);
			Ok(buffer.len())
		}

		fn flush(&mut self) -> io::Result<()> {
			let (output, changed) = &*self.0;
			let mut output = output.lock().expect("lock output");
			let pending = std::mem::take(&mut output.pending);
			output.flushed.extend_from_slice(&pending);
			changed.notify_all();
			Ok(())
		}
	}

	impl SharedOutput {
		fn wait_for_len(&self, length: usize, timeout: Duration) -> bool {
			let (output, changed) = &*self.0;
			let mut output = output.lock().expect("lock output");
			let deadline = Instant::now() + timeout;
			while output.flushed.len() < length {
				let remaining = deadline.saturating_duration_since(Instant::now());
				if remaining.is_zero() {
					return false;
				}
				let (next, result) = changed
					.wait_timeout(output, remaining)
					.expect("wait for output");
				output = next;
				if result.timed_out() && output.flushed.len() < length {
					return false;
				}
			}
			true
		}

		fn bytes(&self) -> Vec<u8> {
			self.0 .0.lock().expect("lock output").flushed.clone()
		}
	}

	struct GatedInput {
		bytes: Cursor<&'static [u8]>,
		release: mpsc::Receiver<()>,
	}

	impl Read for GatedInput {
		fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
			let read = self.bytes.read(buffer)?;
			if read > 0 {
				return Ok(read);
			}
			let _ = self.release.recv();
			Ok(0)
		}
	}

	#[test]
	fn relays_one_connection_in_both_directions() {
		let (endpoint, _cleanup_directory) = test_endpoint();
		let listener = Listener::bind(&endpoint).expect("bind relay listener");
		let host_output = SharedOutput::default();
		let captured_output = host_output.clone();
		let (release, released) = mpsc::channel();
		let (completed, completion) = mpsc::channel();
		let (reported_peer, peer_report) = mpsc::channel();
		let relay = thread::spawn(move || {
			let result = relay_once_with_peer(
				&listener,
				GatedInput {
					bytes: Cursor::new(b"from-host"),
					release: released,
				},
				host_output,
				|peer| {
					reported_peer
						.send(peer.clone())
						.expect("report peer identity");
					Ok(())
				},
			);
			completed.send(result).expect("report relay completion");
		});

		let (mut client_reader, mut client_writer) =
			connect(&endpoint).expect("connect relay client");
		let peer = peer_report
			.recv_timeout(Duration::from_secs(5))
			.expect("receive peer identity");
		#[cfg(any(windows, target_os = "linux", target_os = "android"))]
		assert_eq!(peer.process_id(), Some(std::process::id()));
		let control: serde_json::Value =
			serde_json::from_str(&peer_control_record(&peer).expect("serialize peer"))
				.expect("parse peer control record");
		assert_eq!(control["event"], "peer");
		assert_eq!(control["schemaVersion"], 1);
		let mut received = [0u8; 9];
		client_reader
			.read_exact(&mut received)
			.expect("read host bytes");
		client_writer
			.write_all(b"from-client")
			.expect("write client bytes");
		client_writer.flush().expect("flush client bytes");
		assert!(
			captured_output.wait_for_len(b"from-client".len(), Duration::from_secs(5)),
			"relay did not copy client bytes to the host"
		);
		release.send(()).expect("release host input");
		drop(client_writer);
		drop(client_reader);

		completion
			.recv_timeout(Duration::from_secs(5))
			.expect("relay did not stop after EOF")
			.expect("relay failed");
		relay.join().expect("join relay");
		assert_eq!(&received, b"from-host");
		assert_eq!(captured_output.bytes(), b"from-client");

		#[cfg(unix)]
		if let Some(directory) = _cleanup_directory {
			let _ = std::fs::remove_dir(directory);
		}
	}

	fn test_endpoint() -> (String, Option<std::path::PathBuf>) {
		#[cfg(windows)]
		{
			(
				format!("pipe://delver-agent-relay-test-{}", std::process::id()),
				None,
			)
		}
		#[cfg(unix)]
		{
			let directory = std::env::temp_dir()
				.join(format!("delver-agent-relay-test-{}", std::process::id()));
			(
				format!("unix://{}", directory.join("session.sock").display()),
				Some(directory),
			)
		}
	}
}
