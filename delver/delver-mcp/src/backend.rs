// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

//! Delver rendezvous, bootstrap, and DTP backend for the MCP server.

use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use delver_rpc::{connect_shutdownable, Message, Transport, TransportLimits};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::registry::{
	resolve_rendezvous_registry_directory, select_window_for_fingerprint, RendezvousRegistryEntry,
};
use crate::root_fingerprint::compute_root_fingerprint_v1;
use crate::{BackendError, CancellationToken, Tool, ToolBackend, ToolCallResult};

const BOOTSTRAP_PROTOCOL_VERSION: u64 = 1;
const DTP_PROTOCOL_VERSION: u64 = 1;
const BOOTSTRAP_MAX_HEADER_BYTES: usize = 4 * 1024;
const BOOTSTRAP_MAX_MESSAGE_BYTES: usize = 16 * 1024;
const DTP_MAX_HEADER_BYTES: usize = 8 * 1024;
const DTP_MAX_MESSAGE_BYTES: usize = 512 * 1024;
const DTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const DTP_POLL_INTERVAL: Duration = Duration::from_millis(25);
const BOOTSTRAP_RESPONSE_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_ID_LENGTH: usize = 128;
const MAX_TOKEN_LENGTH: usize = 256;

static NONCE_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Production MCP backend bound to one explicit workspace root.
pub struct DelverBackend {
	root_fingerprint: String,
	registry_directory: PathBuf,
	display_name: String,
	session: Mutex<Option<Arc<ConnectedSession>>>,
}

impl DelverBackend {
	/// Resolves the explicit root and deterministic registry without connecting to Delver.
	pub fn new(root: &Path, display_name: impl Into<String>) -> Result<Self, BackendError> {
		let display_name = display_name.into();
		if !is_safe_display_name(&display_name) {
			return Err(BackendError::new("The MCP client display name is invalid."));
		}
		let root_fingerprint = compute_root_fingerprint_v1(root)
			.map_err(|_| BackendError::new("The configured Delver root is unavailable."))?;
		let registry_directory = resolve_rendezvous_registry_directory()
			.map_err(|_| BackendError::new("Delver rendezvous discovery is unavailable."))?;
		Ok(Self {
			root_fingerprint,
			registry_directory,
			display_name,
			session: Mutex::new(None),
		})
	}

	fn connected(
		&self,
		cancellation: &CancellationToken,
	) -> Result<Arc<ConnectedSession>, BackendError> {
		if cancellation.is_cancelled() {
			return Err(BackendError::new("The Delver request was cancelled."));
		}
		let mut cached = self
			.session
			.lock()
			.map_err(|_| BackendError::new("The Delver connection is unavailable."))?;
		if let Some(session) = cached.as_ref().filter(|session| !session.dtp.is_closed()) {
			return Ok(Arc::clone(session));
		}

		let entry = select_window_for_fingerprint(
			&self.registry_directory,
			&self.root_fingerprint,
			unix_time_millis()?,
		)
		.map_err(|error| BackendError::new(error.to_string()))?;
		let credential = claim_bootstrap(&entry, &self.display_name, cancellation)?;
		let dtp = Arc::new(DtpSession::connect(&credential, cancellation)?);
		let capabilities = dtp.request("agent/capabilities", json!({}), cancellation)?;
		let tools = parse_capability_tools(&capabilities)?;
		let session = Arc::new(ConnectedSession {
			dtp,
			tools,
			project_binding: Mutex::new(ProjectBinding::Unbound),
		});
		*cached = Some(Arc::clone(&session));
		Ok(session)
	}

	fn invalidate(&self, session: &Arc<ConnectedSession>) {
		if let Ok(mut cached) = self.session.lock() {
			if cached
				.as_ref()
				.is_some_and(|candidate| Arc::ptr_eq(candidate, session))
			{
				cached.take();
			}
		}
	}
}

impl ToolBackend for DelverBackend {
	fn list_tools(&self, cancellation: CancellationToken) -> Result<Vec<Tool>, BackendError> {
		Ok(self.connected(&cancellation)?.tools.clone())
	}

	fn call_tool(
		&self,
		name: &str,
		arguments: &Map<String, Value>,
		cancellation: CancellationToken,
	) -> Result<ToolCallResult, BackendError> {
		let session = self.connected(&cancellation)?;
		if !session.tools.iter().any(|tool| tool.name == name) {
			return Err(BackendError::invalid_params("Unknown Delver tool."));
		}
		let expected_project = session.bound_project(&cancellation)?;
		let response = match session.dtp.request(
			"agent/invoke",
			json!({
				"capability": name,
				"args": arguments,
				"expectedProject": expected_project,
			}),
			&cancellation,
		) {
			Ok(response) => response,
			Err(error) => {
				// A cancelled, timed-out, or rejected request says nothing
				// about the transport. Only a connection that actually closed
				// invalidates the cached session; tearing down a healthy one
				// costs the next call a full rendezvous and bootstrap.
				if session.dtp.is_closed() {
					self.invalidate(&session);
				}
				return Err(error);
			}
		};
		gateway_tool_result(response)
	}
}

impl Drop for DelverBackend {
	fn drop(&mut self) {
		if let Ok(mut session) = self.session.lock() {
			session.take();
		}
	}
}

struct ConnectedSession {
	dtp: Arc<DtpSession>,
	tools: Vec<Tool>,
	project_binding: Mutex<ProjectBinding>,
}

#[derive(Clone)]
enum ProjectBinding {
	Unbound,
	Bound(Option<ProjectPin>),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectPin {
	content_hash: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	revision_id: Option<String>,
}

impl ConnectedSession {
	fn bound_project(
		&self,
		cancellation: &CancellationToken,
	) -> Result<Option<ProjectPin>, BackendError> {
		let mut binding = self
			.project_binding
			.lock()
			.map_err(|_| BackendError::new("The Delver connection is unavailable."))?;
		if let ProjectBinding::Bound(project) = &*binding {
			return Ok(project.clone());
		}

		// Bind at the first actual tool call, not at tools/list. MCP clients tend
		// to discover tools immediately, before the analyst has opened a sample.
		// Holding this lock makes two concurrent first calls choose one identity.
		let capabilities = self
			.dtp
			.request("agent/capabilities", json!({}), cancellation)?;
		let project = capability_project(&capabilities)?;
		*binding = ProjectBinding::Bound(project.clone());
		Ok(project)
	}
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BootstrapCredential {
	protocol_version: u64,
	endpoint: String,
	lease_id: String,
	token: String,
	expires_at: u64,
}

fn claim_bootstrap(
	entry: &RendezvousRegistryEntry,
	display_name: &str,
	cancellation: &CancellationToken,
) -> Result<BootstrapCredential, BackendError> {
	if cancellation.is_cancelled() {
		return Err(BackendError::new("The Delver request was cancelled."));
	}
	let (reader, writer, shutdown) = connect_shutdownable(&entry.bootstrap_endpoint)
		.map_err(|_| BackendError::new("The Delver bootstrap endpoint is unavailable."))?;
	let limits = TransportLimits {
		max_header_bytes: BOOTSTRAP_MAX_HEADER_BYTES,
		max_json_frame_bytes: BOOTSTRAP_MAX_MESSAGE_BYTES,
		max_binary_frame_bytes: 0,
	};
	let mut write_transport = Transport::with_limits(io::empty(), writer, limits);
	let request = json!({
		"id": 1,
		"method": "bootstrap/claim",
		"params": {
			"protocolVersion": BOOTSTRAP_PROTOCOL_VERSION,
			"registryEntryId": entry.registry_entry_id,
			"windowInstanceId": entry.window_instance_id,
			"rootFingerprint": entry.root_fingerprint,
			"clientNonce": create_client_nonce(),
			"displayName": display_name,
		}
	});
	let encoded = serde_json::to_vec(&request)
		.map_err(|_| BackendError::new("The Delver bootstrap request is invalid."))?;
	write_transport
		.write_json(&encoded)
		.map_err(|_| BackendError::new("The Delver bootstrap endpoint is unavailable."))?;
	let (_, writer) = write_transport.into_parts();
	let (sender, receiver) = mpsc::sync_channel(1);
	std::thread::spawn(move || {
		let mut read_transport = Transport::with_limits(reader, io::sink(), limits);
		let response = match read_transport.read_message() {
			Ok(Message::Json(response)) => Ok(response),
			_ => Err(()),
		};
		let _ = sender.send(response);
	});
	let deadline = Instant::now() + BOOTSTRAP_RESPONSE_TIMEOUT;
	loop {
		if cancellation.is_cancelled() {
			shutdown();
			drop(writer);
			return Err(BackendError::new("The Delver request was cancelled."));
		}
		if Instant::now() >= deadline {
			shutdown();
			drop(writer);
			return Err(BackendError::new(
				"The Delver connection request timed out.",
			));
		}
		match receiver.recv_timeout(DTP_POLL_INTERVAL) {
			Ok(Ok(response)) => return parse_bootstrap_response(&response),
			Ok(Err(())) | Err(RecvTimeoutError::Disconnected) => {
				return Err(BackendError::new(
					"The Delver bootstrap response is invalid.",
				));
			}
			Err(RecvTimeoutError::Timeout) => {}
		}
	}
}

fn parse_bootstrap_response(response: &str) -> Result<BootstrapCredential, BackendError> {
	let value: Value = serde_json::from_str(response)
		.map_err(|_| BackendError::new("The Delver bootstrap response is invalid."))?;
	let object = value
		.as_object()
		.filter(|object| object.get("id") == Some(&json!(1)))
		.ok_or_else(|| BackendError::new("The Delver bootstrap response is invalid."))?;
	if exact_keys(object, &["id", "error"]) {
		return Err(BackendError::new(
			"The Delver connection request was not authorized.",
		));
	}
	if !exact_keys(object, &["id", "result"]) {
		return Err(BackendError::new(
			"The Delver bootstrap response is invalid.",
		));
	}
	let credential: BootstrapCredential = serde_json::from_value(object["result"].clone())
		.map_err(|_| BackendError::new("The Delver bootstrap credential is invalid."))?;
	if credential.protocol_version != BOOTSTRAP_PROTOCOL_VERSION
		|| !is_bounded_id(&credential.lease_id)
		|| credential.token.is_empty()
		|| credential.token.len() > MAX_TOKEN_LENGTH
		|| !credential
			.token
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
		|| credential.expires_at <= unix_time_millis()?
		|| !is_local_endpoint(&credential.endpoint)
	{
		return Err(BackendError::new(
			"The Delver bootstrap credential is invalid.",
		));
	}
	Ok(credential)
}

struct DtpSession {
	state: Arc<DtpState>,
	reader: Mutex<Option<JoinHandle<()>>>,
	shutdown: Arc<dyn Fn() + Send + Sync>,
}

struct DtpState {
	writer: Mutex<Option<Box<dyn Write + Send>>>,
	pending: Mutex<HashMap<u64, SyncSender<Result<Value, String>>>>,
	next_request_id: AtomicU64,
	closed: AtomicBool,
}

impl DtpSession {
	fn connect(
		credential: &BootstrapCredential,
		cancellation: &CancellationToken,
	) -> Result<Self, BackendError> {
		let (reader, writer, shutdown) = connect_shutdownable(&credential.endpoint)
			.map_err(|_| BackendError::new("The Delver private endpoint is unavailable."))?;
		let state = Arc::new(DtpState {
			writer: Mutex::new(Some(writer)),
			pending: Mutex::new(HashMap::new()),
			next_request_id: AtomicU64::new(1),
			closed: AtomicBool::new(false),
		});
		let reader = spawn_dtp_reader(reader, Arc::clone(&state));
		let session = Self {
			state,
			reader: Mutex::new(Some(reader)),
			shutdown,
		};
		let initialized = session.request(
			"initialize",
			json!({
				"protocolVersion": DTP_PROTOCOL_VERSION,
				"token": credential.token,
				"clientId": "delver-mcp",
			}),
			cancellation,
		)?;
		validate_initialize_result(&initialized)?;
		Ok(session)
	}

	fn is_closed(&self) -> bool {
		self.state.closed.load(Ordering::Acquire)
	}

	fn request(
		&self,
		method: &str,
		params: Value,
		cancellation: &CancellationToken,
	) -> Result<Value, BackendError> {
		if cancellation.is_cancelled() || self.is_closed() {
			return Err(BackendError::new("The Delver connection is unavailable."));
		}
		let request_id = self.state.next_request_id.fetch_add(1, Ordering::Relaxed);
		let (sender, receiver) = mpsc::sync_channel(1);
		self.state
			.pending
			.lock()
			.map_err(|_| BackendError::new("The Delver connection is unavailable."))?
			.insert(request_id, sender);
		if self
			.state
			.write_request(request_id, method, params)
			.is_err()
		{
			self.state.fail_all();
			return Err(BackendError::new("The Delver connection is unavailable."));
		}
		wait_for_dtp_response(&self.state, request_id, receiver, cancellation)
	}
}

impl Drop for DtpSession {
	fn drop(&mut self) {
		self.state.fail_all();
		(self.shutdown)();
		let Some(reader) = self.reader.lock().ok().and_then(|mut reader| reader.take()) else {
			return;
		};
		// The transport shutdown callback unblocks the independent reader half,
		// so this join is deterministic instead of a timed detach that leaks the
		// thread until the peer happens to close.
		let _ = reader.join();
	}
}

impl DtpState {
	fn write_request(&self, id: u64, method: &str, params: Value) -> io::Result<()> {
		let encoded = serde_json::to_vec(&json!({ "id": id, "method": method, "params": params }))
			.map_err(io::Error::other)?;
		if encoded.len() > DTP_MAX_MESSAGE_BYTES {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"DTP request is too large",
			));
		}
		let mut writer = self
			.writer
			.lock()
			.map_err(|_| io::Error::other("DTP writer lock poisoned"))?;
		let writer = writer
			.as_mut()
			.ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "DTP connection closed"))?;
		write!(writer, "Content-Length: {}\r\n\r\n", encoded.len())?;
		writer.write_all(&encoded)?;
		writer.flush()
	}

	fn cancel_request(&self, request_id: u64) {
		let cancel_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
		let _ = self.write_request(
			cancel_id,
			"agent/cancel",
			json!({ "requestId": request_id }),
		);
	}

	fn fail_all(&self) {
		if self.closed.swap(true, Ordering::AcqRel) {
			return;
		}
		if let Ok(mut writer) = self.writer.lock() {
			writer.take();
		}
		if let Ok(mut pending) = self.pending.lock() {
			for (_, sender) in pending.drain() {
				let _ = sender.send(Err("The Delver connection closed.".to_owned()));
			}
		}
	}
}

fn spawn_dtp_reader(reader: Box<dyn io::Read + Send>, state: Arc<DtpState>) -> JoinHandle<()> {
	std::thread::spawn(move || {
		let limits = TransportLimits {
			max_header_bytes: DTP_MAX_HEADER_BYTES,
			max_json_frame_bytes: DTP_MAX_MESSAGE_BYTES,
			max_binary_frame_bytes: 0,
		};
		let mut transport = Transport::with_limits(reader, io::sink(), limits);
		while let Ok(Message::Json(message)) = transport.read_message() {
			let Some((id, response)) = parse_dtp_response(&message) else {
				break;
			};
			let sender = state
				.pending
				.lock()
				.ok()
				.and_then(|mut pending| pending.remove(&id));
			if let Some(sender) = sender {
				let _ = sender.send(response);
			}
		}
		state.fail_all();
	})
}

fn parse_dtp_response(message: &str) -> Option<(u64, Result<Value, String>)> {
	let value: Value = serde_json::from_str(message).ok()?;
	let object = value.as_object()?;
	let id = object.get("id")?.as_u64()?;
	if exact_keys(object, &["id", "result"]) {
		return Some((id, Ok(object["result"].clone())));
	}
	if exact_keys(object, &["id", "error"])
		&& object["error"].as_object()?.get("code")?.as_i64().is_some()
	{
		return Some((id, Err("The Delver DTP request failed.".to_owned())));
	}
	None
}

fn wait_for_dtp_response(
	state: &DtpState,
	request_id: u64,
	receiver: Receiver<Result<Value, String>>,
	cancellation: &CancellationToken,
) -> Result<Value, BackendError> {
	let deadline = Instant::now() + DTP_REQUEST_TIMEOUT;
	loop {
		if cancellation.is_cancelled() {
			state.cancel_request(request_id);
			remove_pending(state, request_id);
			return Err(BackendError::new("The Delver request was cancelled."));
		}
		if Instant::now() >= deadline {
			state.cancel_request(request_id);
			remove_pending(state, request_id);
			return Err(BackendError::new("The Delver request timed out."));
		}
		match receiver.recv_timeout(DTP_POLL_INTERVAL) {
			Ok(Ok(result)) => return Ok(result),
			Ok(Err(message)) => return Err(BackendError::new(message)),
			Err(RecvTimeoutError::Timeout) => {}
			Err(RecvTimeoutError::Disconnected) => {
				return Err(BackendError::new("The Delver connection is unavailable."));
			}
		}
	}
}

fn remove_pending(state: &DtpState, request_id: u64) {
	if let Ok(mut pending) = state.pending.lock() {
		pending.remove(&request_id);
	}
}

fn validate_initialize_result(value: &Value) -> Result<(), BackendError> {
	let object = value
		.as_object()
		.ok_or_else(|| BackendError::new("The Delver DTP initialization response is invalid."))?;
	let methods = object
		.get("methods")
		.and_then(Value::as_array)
		.ok_or_else(|| BackendError::new("The Delver DTP initialization response is invalid."))?;
	let required = ["agent/capabilities", "agent/invoke", "agent/cancel"];
	if object.get("protocolVersion").and_then(Value::as_u64) != Some(DTP_PROTOCOL_VERSION)
		|| !required.iter().all(|required| {
			methods
				.iter()
				.any(|method| method.as_str() == Some(required))
		}) {
		return Err(BackendError::new(
			"The Delver DTP protocol is incompatible.",
		));
	}
	Ok(())
}

fn parse_capability_tools(value: &Value) -> Result<Vec<Tool>, BackendError> {
	let gateway = value
		.as_object()
		.filter(|gateway| gateway.get("schemaVersion").and_then(Value::as_u64) == Some(1))
		.ok_or_else(|| BackendError::new("The Delver capability response is invalid."))?;
	if gateway.get("ok").and_then(Value::as_bool) != Some(true) {
		return Err(BackendError::new("Delver capability discovery failed."));
	}
	let kinds = capability_kinds(gateway.get("result"))?;
	let definitions = gateway
		.get("tools")
		.and_then(Value::as_array)
		.ok_or_else(|| BackendError::new("This Delver window does not expose MCP tool schemas."))?;
	let mut tools = Vec::with_capacity(definitions.len());
	let mut names = HashSet::new();
	for definition in definitions {
		let definition = definition
			.as_object()
			.ok_or_else(|| BackendError::new("The Delver tool catalog is invalid."))?;
		let name = definition
			.get("name")
			.and_then(Value::as_str)
			.filter(|name| is_bounded_id(name) && names.insert((*name).to_owned()))
			.ok_or_else(|| BackendError::new("The Delver tool catalog is invalid."))?;
		let input_schema = definition
			.get("inputSchema")
			.filter(|schema| {
				schema
					.as_object()
					.and_then(|schema| schema.get("type"))
					.and_then(Value::as_str)
					== Some("object")
			})
			.cloned()
			.ok_or_else(|| BackendError::new("The Delver tool catalog is invalid."))?;
		let kind = kinds
			.get(name)
			.ok_or_else(|| BackendError::new("The Delver tool catalog is inconsistent."))?;
		tools.push(Tool {
			name: name.to_owned(),
			title: bounded_optional_string(definition.get("title"))?,
			description: bounded_optional_string(definition.get("description"))?,
			input_schema,
			output_schema: None,
			annotations: Some(tool_annotations(kind)),
		});
	}
	if tools.is_empty() || kinds.len() != tools.len() {
		return Err(BackendError::new(
			"The Delver tool catalog is inconsistent.",
		));
	}
	Ok(tools)
}

fn capability_project(value: &Value) -> Result<Option<ProjectPin>, BackendError> {
	let gateway = value
		.as_object()
		.filter(|gateway| {
			gateway.get("schemaVersion").and_then(Value::as_u64) == Some(1)
				&& gateway.get("ok").and_then(Value::as_bool) == Some(true)
		})
		.ok_or_else(|| BackendError::new("The Delver capability response is invalid."))?;
	let result = gateway
		.get("result")
		.and_then(Value::as_object)
		.ok_or_else(|| BackendError::new("The Delver capability response is invalid."))?;
	let Some(project) = result.get("project") else {
		return Ok(None);
	};
	let project = project
		.as_object()
		.ok_or_else(|| BackendError::new("The Delver project identity is invalid."))?;
	let content_hash = project
		.get("contentHash")
		.and_then(Value::as_str)
		.filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
		.ok_or_else(|| BackendError::new("The Delver project identity is invalid."))?
		.to_ascii_lowercase();
	let revision_id = match project.get("revisionId") {
		None => None,
		Some(value) => Some(
			value
				.as_str()
				.filter(|revision| !revision.is_empty() && revision.len() <= 256)
				.ok_or_else(|| BackendError::new("The Delver project identity is invalid."))?
				.to_owned(),
		),
	};
	Ok(Some(ProjectPin {
		content_hash,
		revision_id,
	}))
}

fn capability_kinds(result: Option<&Value>) -> Result<HashMap<String, String>, BackendError> {
	let capabilities = result
		.and_then(Value::as_object)
		.and_then(|result| result.get("data"))
		.and_then(Value::as_object)
		.and_then(|data| data.get("capabilities"))
		.and_then(Value::as_array)
		.ok_or_else(|| BackendError::new("The Delver capability response is invalid."))?;
	let mut kinds = HashMap::new();
	for capability in capabilities {
		let capability = capability
			.as_object()
			.ok_or_else(|| BackendError::new("The Delver capability response is invalid."))?;
		let id = capability
			.get("id")
			.and_then(Value::as_str)
			.filter(|id| is_bounded_id(id))
			.ok_or_else(|| BackendError::new("The Delver capability response is invalid."))?;
		let kind = capability
			.get("kind")
			.and_then(Value::as_str)
			.filter(|kind| matches!(*kind, "read" | "write" | "ui"))
			.ok_or_else(|| BackendError::new("The Delver capability response is invalid."))?;
		if kinds.insert(id.to_owned(), kind.to_owned()).is_some() {
			return Err(BackendError::new(
				"The Delver capability response is invalid.",
			));
		}
	}
	Ok(kinds)
}

fn gateway_tool_result(value: Value) -> Result<ToolCallResult, BackendError> {
	let gateway = value
		.as_object()
		.filter(|gateway| gateway.get("schemaVersion").and_then(Value::as_u64) == Some(1))
		.ok_or_else(|| BackendError::new("The Delver tool response is invalid."))?;
	match gateway.get("ok").and_then(Value::as_bool) {
		Some(true) => {
			let result = gateway
				.get("result")
				.filter(|result| result.is_object())
				.cloned()
				.ok_or_else(|| BackendError::new("The Delver tool response is invalid."))?;
			let text = serde_json::to_string(&result)
				.map_err(|_| BackendError::new("The Delver tool response is invalid."))?;
			Ok(ToolCallResult {
				content: vec![json!({ "type": "text", "text": text })],
				structured_content: Some(result),
				is_error: false,
			})
		}
		Some(false) => {
			let error = gateway
				.get("error")
				.filter(|error| error.is_object())
				.cloned()
				.ok_or_else(|| BackendError::new("The Delver tool response is invalid."))?;
			let text = serde_json::to_string(&error)
				.map_err(|_| BackendError::new("The Delver tool response is invalid."))?;
			Ok(ToolCallResult {
				content: vec![json!({ "type": "text", "text": text })],
				structured_content: Some(error),
				is_error: true,
			})
		}
		_ => Err(BackendError::new("The Delver tool response is invalid.")),
	}
}

fn tool_annotations(kind: &str) -> Value {
	match kind {
		"read" => json!({ "readOnlyHint": true, "destructiveHint": false }),
		"write" => {
			json!({ "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false })
		}
		"ui" => json!({ "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true }),
		_ => json!({ "readOnlyHint": false }),
	}
}

fn bounded_optional_string(value: Option<&Value>) -> Result<Option<String>, BackendError> {
	match value {
		None => Ok(None),
		Some(Value::String(value)) if !value.is_empty() && value.len() <= DTP_MAX_MESSAGE_BYTES => {
			Ok(Some(value.clone()))
		}
		_ => Err(BackendError::new("The Delver tool catalog is invalid.")),
	}
}

fn create_client_nonce() -> String {
	let counter = NONCE_COUNTER.fetch_add(1, Ordering::Relaxed);
	let timestamp = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_nanos();
	let mut hasher = Sha256::new();
	hasher.update(b"delver-mcp-client-nonce");
	hasher.update(std::process::id().to_le_bytes());
	hasher.update(counter.to_le_bytes());
	hasher.update(timestamp.to_le_bytes());
	format!("{:x}", hasher.finalize())
}

fn unix_time_millis() -> Result<u64, BackendError> {
	let millis = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_err(|_| BackendError::new("The system clock is unavailable."))?
		.as_millis();
	u64::try_from(millis).map_err(|_| BackendError::new("The system clock is unavailable."))
}

fn exact_keys(object: &Map<String, Value>, expected: &[&str]) -> bool {
	object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn is_bounded_id(value: &str) -> bool {
	!value.is_empty()
		&& value.len() <= MAX_ID_LENGTH
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn is_local_endpoint(endpoint: &str) -> bool {
	if endpoint.len() < 8 || endpoint.len() > 512 || endpoint.chars().any(char::is_control) {
		return false;
	}
	if cfg!(windows) {
		endpoint.strip_prefix("pipe://").is_some_and(|name| {
			!name.is_empty()
				&& name
					.bytes()
					.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
		})
	} else {
		endpoint
			.strip_prefix("unix://")
			.is_some_and(|path| Path::new(path).is_absolute())
	}
}

fn is_safe_display_name(value: &str) -> bool {
	let trimmed = value.trim();
	!trimmed.is_empty()
		&& trimmed == value
		&& value.chars().count() <= 128
		&& !value.chars().any(|character| {
			character.is_control()
				|| matches!(
					character,
					'\u{061c}'
						| '\u{200e}'
						| '\u{200f}'
						| '\u{202a}'..='\u{202e}'
						| '\u{2066}'..='\u{2069}'
				)
		})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_schema_bearing_capability_catalog() {
		let response = json!({
			"schemaVersion": 1,
			"ok": true,
			"result": { "data": { "capabilities": [
				{ "id": "delver_image_info", "kind": "read" },
				{ "id": "delver_propose_rename", "kind": "write" },
				{ "id": "delver_focus", "kind": "ui" }
			] } },
			"tools": [
				{ "name": "delver_image_info", "title": "Image Info", "description": "Read image facts.", "inputSchema": { "type": "object", "properties": {} } },
				{ "name": "delver_propose_rename", "title": "Propose Rename", "description": "Append a review-only proposal.", "inputSchema": { "type": "object", "properties": { "proposals": { "type": "array" } } } },
				{ "name": "delver_focus", "title": "Focus", "description": "Move focus.", "inputSchema": { "type": "object", "properties": { "address": { "type": "string" } } } }
			]
		});

		let tools = parse_capability_tools(&response).expect("parse tools");

		assert_eq!(tools.len(), 3);
		assert_eq!(tools[0].name, "delver_image_info");
		assert_eq!(
			tools[0].annotations,
			Some(json!({ "readOnlyHint": true, "destructiveHint": false }))
		);
		assert_eq!(
			tools[1].annotations,
			Some(
				json!({ "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false })
			)
		);
		assert_eq!(
			tools[2].annotations,
			Some(
				json!({ "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true })
			)
		);
	}

	#[test]
	fn parses_the_project_identity_used_to_bind_tool_calls() {
		let hash = "A".repeat(64);
		let response = json!({
			"schemaVersion": 1,
			"ok": true,
			"result": {
				"project": {
					"contentHash": hash,
					"revisionId": "revision-7",
					"projectPath": "ignored.delverdb"
				},
				"data": {}
			}
		});

		assert_eq!(
			capability_project(&response).expect("parse project"),
			Some(ProjectPin {
				content_hash: "a".repeat(64),
				revision_id: Some("revision-7".to_owned()),
			}),
		);
		assert_eq!(
			capability_project(&json!({
				"schemaVersion": 1,
				"ok": true,
				"result": { "data": {} }
			}))
			.expect("parse no project"),
			None,
		);
	}

	#[test]
	fn maps_gateway_success_and_failure_to_mcp_tool_results() {
		let success = gateway_tool_result(json!({
			"schemaVersion": 1,
			"ok": true,
			"result": { "schemaVersion": 1, "capability": "delver_image_info", "data": { "arch": "x86_64" } }
		}))
		.expect("map success");
		let failure = gateway_tool_result(json!({
			"schemaVersion": 1,
			"ok": false,
			"error": { "code": "NO_ACTIVE_PROJECT", "message": "Open a project." }
		}))
		.expect("map failure");

		assert!(!success.is_error);
		assert_eq!(
			success.structured_content.as_ref().unwrap()["capability"],
			"delver_image_info"
		);
		assert!(failure.is_error);
		assert_eq!(
			failure.structured_content.as_ref().unwrap()["code"],
			"NO_ACTIVE_PROJECT"
		);
	}

	#[test]
	fn rejects_inconsistent_catalogs_and_unsafe_credentials() {
		assert!(parse_capability_tools(&json!({
			"schemaVersion": 1,
			"ok": true,
			"result": { "data": { "capabilities": [{ "id": "one", "kind": "read" }] } },
			"tools": [{ "name": "two", "inputSchema": { "type": "object" } }]
		}))
		.is_err());
		assert!(parse_bootstrap_response(r#"{"id":1,"result":{"protocolVersion":1,"endpoint":"tcp://127.0.0.1","leaseId":"abcdefghijklmnop","token":"secret","expiresAt":9007199254740991}}"#).is_err());
		assert!(!is_safe_display_name("Delver\nMCP"));
		assert!(!is_safe_display_name("Delver\u{202e}MCP"));
	}

	fn test_state() -> Arc<DtpState> {
		Arc::new(DtpState {
			writer: Mutex::new(Some(Box::new(io::sink()))),
			pending: Mutex::new(HashMap::new()),
			next_request_id: AtomicU64::new(1),
			closed: AtomicBool::new(false),
		})
	}

	#[test]
	fn a_cancelled_request_leaves_the_session_usable() {
		let state = test_state();
		let (sender, receiver) = mpsc::sync_channel(1);
		state.pending.lock().unwrap().insert(1, sender);
		let cancellation = CancellationToken::default();
		cancellation.cancel();

		let error = wait_for_dtp_response(&state, 1, receiver, &cancellation).unwrap_err();

		// The connection stays open and the pending slot is reclaimed, so
		// `call_tool` keeps the cached session instead of invalidating it.
		assert_eq!(
			(
				error.to_string(),
				state.closed.load(Ordering::Acquire),
				state.pending.lock().unwrap().len()
			),
			("The Delver request was cancelled.".to_owned(), false, 0)
		);
	}

	#[test]
	fn dropping_a_session_joins_a_finished_reader() {
		let state = test_state();
		let reader = spawn_dtp_reader(Box::new(io::empty()), Arc::clone(&state));
		let session = DtpSession {
			state: Arc::clone(&state),
			reader: Mutex::new(Some(reader)),
			shutdown: Arc::new(|| {}),
		};

		let deadline = Instant::now() + Duration::from_secs(5);
		while !session.is_closed() && Instant::now() < deadline {
			std::thread::sleep(DTP_POLL_INTERVAL);
		}
		let retained_and_finished = session
			.reader
			.lock()
			.unwrap()
			.as_ref()
			.is_some_and(JoinHandle::is_finished);
		drop(session);

		assert_eq!(
			(retained_and_finished, Arc::strong_count(&state)),
			(true, 1)
		);
	}

	#[test]
	fn creates_distinct_bounded_client_nonces() {
		let first = create_client_nonce();
		let second = create_client_nonce();
		assert_ne!(first, second);
		assert!(first.len() >= 16 && first.len() <= 128);
		assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
	}
}
