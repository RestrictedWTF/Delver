// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

//! A small Model Context Protocol server.
//!
//! This root module is transport-only: it owns MCP framing, lifecycle, and
//! dispatch, and reaches Delver only through the injected [`ToolBackend`], so
//! protocol behavior stays independently testable. The Delver-specific
//! rendezvous, bootstrap, and DTP client are siblings rather than dependencies
//! of it, in [`backend`], [`registry`], and [`root_fingerprint`].
//!
//! Every byte this crate handles arrives over a transport, so per CLAUDE.md
//! invariant 13 it forbids `unsafe` outright.

#![forbid(unsafe_code)]

pub mod backend;
pub mod registry;
pub mod root_fingerprint;

use std::collections::HashMap;
use std::fmt;
use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Map, Value};

/// The newest protocol revision implemented by this server.
pub const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";

const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &[
	"2024-10-07",
	"2024-11-05",
	"2025-03-26",
	"2025-06-18",
	LATEST_PROTOCOL_VERSION,
];
const DEFAULT_MAX_LINE_BYTES: usize = 1024 * 1024;

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL_ERROR: i64 = -32603;
const NOT_INITIALIZED: i64 = -32002;

/// A cancellation signal shared between the MCP server and a backend request.
#[derive(Clone, Debug, Default)]
pub struct CancellationToken {
	cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
	/// Signals cancellation. Calling this more than once is harmless.
	pub fn cancel(&self) {
		self.cancelled.store(true, Ordering::Release);
	}

	/// Returns whether cancellation has been requested.
	pub fn is_cancelled(&self) -> bool {
		self.cancelled.load(Ordering::Acquire)
	}
}

/// A tool exposed through `tools/list`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
	/// The stable identifier clients use with `tools/call`.
	pub name: String,
	/// An optional human-readable display title.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub title: Option<String>,
	/// An optional explanation of the tool's behavior.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub description: Option<String>,
	/// The JSON Schema for tool arguments.
	pub input_schema: Value,
	/// An optional JSON Schema for structured results.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub output_schema: Option<Value>,
	/// Optional MCP behavioral hints for the tool.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub annotations: Option<Value>,
}

impl Tool {
	/// Creates a tool with an object input schema and no optional metadata.
	pub fn new(name: impl Into<String>, input_schema: Value) -> Self {
		Self {
			name: name.into(),
			title: None,
			description: None,
			input_schema,
			output_schema: None,
			annotations: None,
		}
	}
}

/// A successful or tool-level-error result returned by `tools/call`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallResult {
	/// MCP content blocks returned to the client.
	pub content: Vec<Value>,
	/// An optional result matching the tool's output schema.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub structured_content: Option<Value>,
	/// Whether the tool ran but reported a tool-level failure.
	#[serde(default, skip_serializing_if = "is_false")]
	pub is_error: bool,
}

fn is_false(value: &bool) -> bool {
	!*value
}

impl ToolCallResult {
	/// Creates a successful result from MCP content blocks.
	pub fn success(content: Vec<Value>) -> Self {
		Self {
			content,
			structured_content: None,
			is_error: false,
		}
	}

	fn error(message: String) -> Self {
		Self {
			content: vec![json!({ "type": "text", "text": message })],
			structured_content: None,
			is_error: true,
		}
	}
}

/// A backend failure safe to return to the MCP client.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendError {
	message: String,
	kind: BackendErrorKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BackendErrorKind {
	Tool,
	InvalidParams,
}

impl BackendError {
	/// Creates an error whose message is safe to return as tool content.
	pub fn new(message: impl Into<String>) -> Self {
		Self {
			message: message.into(),
			kind: BackendErrorKind::Tool,
		}
	}

	/// Creates a protocol-level invalid-parameters failure, such as an unknown tool.
	pub fn invalid_params(message: impl Into<String>) -> Self {
		Self {
			message: message.into(),
			kind: BackendErrorKind::InvalidParams,
		}
	}
}

impl fmt::Display for BackendError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(&self.message)
	}
}

impl std::error::Error for BackendError {}

/// Supplies tools and executes calls for an [`McpServer`].
pub trait ToolBackend: Send + Sync + 'static {
	/// Returns the complete set of currently available tools.
	fn list_tools(&self, cancellation: CancellationToken) -> Result<Vec<Tool>, BackendError>;

	/// Invokes one tool with validated object arguments.
	fn call_tool(
		&self,
		name: &str,
		arguments: &Map<String, Value>,
		cancellation: CancellationToken,
	) -> Result<ToolCallResult, BackendError>;
}

/// Writes exactly one JSON-RPC message to the protocol output.
pub trait ProtocolWriter: Send + Sync {
	/// Writes one complete JSON-RPC message without diagnostics or other output.
	fn write_message(&self, message: &Value) -> io::Result<()>;
}

/// A synchronized newline-delimited JSON writer.
pub struct NdjsonWriter<W: Write + Send> {
	inner: Mutex<W>,
}

impl<W: Write + Send> NdjsonWriter<W> {
	/// Wraps a protocol output stream.
	pub fn new(inner: W) -> Self {
		Self {
			inner: Mutex::new(inner),
		}
	}
}

impl<W: Write + Send> ProtocolWriter for NdjsonWriter<W> {
	fn write_message(&self, message: &Value) -> io::Result<()> {
		let mut inner = self
			.inner
			.lock()
			.map_err(|_| io::Error::other("protocol writer lock poisoned"))?;
		serde_json::to_writer(&mut *inner, message).map_err(io::Error::other)?;
		inner.write_all(b"\n")?;
		inner.flush()
	}
}

/// A concurrent MCP server over newline-delimited JSON-RPC.
pub struct McpServer<B: ToolBackend> {
	backend: Arc<B>,
	max_line_bytes: usize,
}

impl<B: ToolBackend> McpServer<B> {
	/// Creates a server using the default one-MiB physical-line limit.
	pub fn new(backend: B) -> Self {
		Self {
			backend: Arc::new(backend),
			max_line_bytes: DEFAULT_MAX_LINE_BYTES,
		}
	}

	/// Overrides the maximum encoded size of one input message.
	pub fn with_max_line_bytes(mut self, max_line_bytes: usize) -> Self {
		self.max_line_bytes = max_line_bytes.max(1);
		self
	}

	/// Runs until input reaches EOF, then cancels backend calls with a bounded shutdown grace.
	pub fn run<R, W>(&self, mut input: R, output: Arc<W>) -> io::Result<()>
	where
		R: BufRead,
		W: ProtocolWriter + 'static,
	{
		let inflight = Arc::new(Mutex::new(HashMap::<String, Inflight>::new()));
		let mut workers = Vec::<JoinHandle<io::Result<()>>>::new();
		let mut lifecycle = Lifecycle::Uninitialized;

		loop {
			drain_finished_workers(&mut workers)?;
			match read_bounded_line(&mut input, self.max_line_bytes)? {
				LineRead::Eof => break,
				LineRead::Oversized => {
					output.write_message(&error_response(
						Value::Null,
						PARSE_ERROR,
						"Parse error",
					))?;
				}
				LineRead::Line(line) => {
					if line.iter().all(u8::is_ascii_whitespace) {
						output.write_message(&error_response(
							Value::Null,
							PARSE_ERROR,
							"Parse error",
						))?;
						continue;
					}
					let message = match serde_json::from_slice::<Value>(&line) {
						Ok(message) => message,
						Err(_) => {
							output.write_message(&error_response(
								Value::Null,
								PARSE_ERROR,
								"Parse error",
							))?;
							continue;
						}
					};
					self.handle_message(
						message,
						&mut lifecycle,
						Arc::clone(&output),
						Arc::clone(&inflight),
						&mut workers,
					)?;
				}
			}
		}

		cancel_all(&inflight);
		finish_cancelled_workers(&mut workers)
	}

	fn handle_message<W: ProtocolWriter + 'static>(
		&self,
		message: Value,
		lifecycle: &mut Lifecycle,
		output: Arc<W>,
		inflight: Arc<Mutex<HashMap<String, Inflight>>>,
		workers: &mut Vec<JoinHandle<io::Result<()>>>,
	) -> io::Result<()> {
		let object = match message.as_object() {
			Some(object) => object,
			None => {
				return output.write_message(&error_response(
					Value::Null,
					INVALID_REQUEST,
					"Invalid Request",
				));
			}
		};
		if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
			return output.write_message(&error_response(
				valid_response_id(object.get("id")),
				INVALID_REQUEST,
				"Invalid Request",
			));
		}
		let method = match object.get("method").and_then(Value::as_str) {
			Some(method) => method,
			None => {
				return output.write_message(&error_response(
					valid_response_id(object.get("id")),
					INVALID_REQUEST,
					"Invalid Request",
				));
			}
		};

		let Some(id_value) = object.get("id") else {
			return self.handle_notification(method, object.get("params"), lifecycle, inflight);
		};
		let Some(id) = RequestId::from_value(id_value) else {
			return output.write_message(&error_response(
				Value::Null,
				INVALID_REQUEST,
				"Invalid Request",
			));
		};

		match method {
			"initialize" => {
				if *lifecycle != Lifecycle::Uninitialized {
					return output.write_message(&error_response(
						id.value,
						INVALID_REQUEST,
						"Server is already initialized",
					));
				}
				let Some(requested_version) = initialize_parameters(object.get("params")) else {
					return output.write_message(&error_response(
						id.value,
						INVALID_PARAMS,
						"Invalid initialize parameters",
					));
				};
				let negotiated_version = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested_version)
				{
					requested_version
				} else {
					LATEST_PROTOCOL_VERSION
				};
				*lifecycle = Lifecycle::Initializing;
				output.write_message(&success_response(
					id.value,
					json!({
						"protocolVersion": negotiated_version,
						"capabilities": { "tools": { "listChanged": false } },
						"serverInfo": {
							"name": "delver-mcp",
							"version": env!("CARGO_PKG_VERSION")
						}
					}),
				))
			}
			"ping" => output.write_message(&success_response(id.value, json!({}))),
			"tools/list" | "tools/call" if *lifecycle != Lifecycle::Ready => output.write_message(
				&error_response(id.value, NOT_INITIALIZED, "Server not initialized"),
			),
			"tools/list" => {
				if !valid_list_parameters(object.get("params")) {
					return output.write_message(&error_response(
						id.value,
						INVALID_PARAMS,
						"Invalid tools/list parameters",
					));
				}
				let Some(token) = insert_inflight(&inflight, &id) else {
					return output.write_message(&error_response(
						id.value,
						INVALID_REQUEST,
						"Request identifier is already in use",
					));
				};
				let backend = Arc::clone(&self.backend);
				workers.push(spawn_request(
					id,
					token,
					inflight,
					output,
					move |cancellation| match backend.list_tools(cancellation) {
						Ok(tools) => Ok(json!({ "tools": tools })),
						Err(error) => Err(error),
					},
					false,
				));
				Ok(())
			}
			"tools/call" => {
				let Some((name, arguments)) = call_parameters(object.get("params")) else {
					return output.write_message(&error_response(
						id.value,
						INVALID_PARAMS,
						"Invalid tools/call parameters",
					));
				};
				let Some(token) = insert_inflight(&inflight, &id) else {
					return output.write_message(&error_response(
						id.value,
						INVALID_REQUEST,
						"Request identifier is already in use",
					));
				};
				let backend = Arc::clone(&self.backend);
				workers.push(spawn_request(
					id,
					token,
					inflight,
					output,
					move |cancellation| {
						backend
							.call_tool(&name, &arguments, cancellation)
							.map(|result| {
								serde_json::to_value(result).expect("tool result is serializable")
							})
					},
					true,
				));
				Ok(())
			}
			_ => output.write_message(&error_response(
				id.value,
				METHOD_NOT_FOUND,
				"Method not found",
			)),
		}
	}

	fn handle_notification(
		&self,
		method: &str,
		params: Option<&Value>,
		lifecycle: &mut Lifecycle,
		inflight: Arc<Mutex<HashMap<String, Inflight>>>,
	) -> io::Result<()> {
		match method {
			"notifications/initialized"
				if *lifecycle == Lifecycle::Initializing && valid_object_params(params) =>
			{
				*lifecycle = Lifecycle::Ready;
			}
			"notifications/cancelled" => {
				if let Some(id) = cancellation_request_id(params) {
					let request = inflight
						.lock()
						.expect("inflight request lock poisoned")
						.remove(&id.key);
					if let Some(request) = request {
						request.cancellation.cancel();
					}
				}
			}
			_ => {}
		}
		Ok(())
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Lifecycle {
	Uninitialized,
	Initializing,
	Ready,
}

#[derive(Clone, Debug)]
struct RequestId {
	value: Value,
	key: String,
}

impl RequestId {
	fn from_value(value: &Value) -> Option<Self> {
		let key = match value {
			Value::String(value) => format!("s:{value}"),
			Value::Number(value) => format!("n:{value}"),
			_ => return None,
		};
		Some(Self {
			value: value.clone(),
			key,
		})
	}
}

struct Inflight {
	cancellation: CancellationToken,
}

enum LineRead {
	Eof,
	Line(Vec<u8>),
	Oversized,
}

fn read_bounded_line<R: BufRead>(input: &mut R, max_bytes: usize) -> io::Result<LineRead> {
	let mut line = Vec::new();
	let mut oversized = false;
	loop {
		let available = input.fill_buf()?;
		if available.is_empty() {
			return if line.is_empty() && !oversized {
				Ok(LineRead::Eof)
			} else if oversized {
				Ok(LineRead::Oversized)
			} else {
				Ok(LineRead::Line(line))
			};
		}
		let consumed = available
			.iter()
			.position(|byte| *byte == b'\n')
			.map_or(available.len(), |position| position + 1);
		if !oversized {
			let body_length = if available[consumed - 1] == b'\n' {
				consumed - 1
			} else {
				consumed
			};
			if line.len().saturating_add(body_length) > max_bytes {
				line.clear();
				oversized = true;
			} else {
				line.extend_from_slice(&available[..body_length]);
			}
		}
		let ended = available[consumed - 1] == b'\n';
		input.consume(consumed);
		if ended {
			if line.last() == Some(&b'\r') {
				line.pop();
			}
			return if oversized {
				Ok(LineRead::Oversized)
			} else {
				Ok(LineRead::Line(line))
			};
		}
	}
}

fn valid_response_id(id: Option<&Value>) -> Value {
	id.and_then(RequestId::from_value)
		.map_or(Value::Null, |id| id.value)
}

fn initialize_parameters(params: Option<&Value>) -> Option<&str> {
	let params = params?.as_object()?;
	let protocol_version = params.get("protocolVersion")?.as_str()?;
	params.get("capabilities")?.as_object()?;
	let client_info = params.get("clientInfo")?.as_object()?;
	let client_name = client_info.get("name")?.as_str()?;
	let client_version = client_info.get("version")?.as_str()?;
	if protocol_version.is_empty()
		|| protocol_version.len() > 64
		|| client_name.is_empty()
		|| client_name.len() > 256
		|| client_version.is_empty()
		|| client_version.len() > 256
	{
		return None;
	}
	Some(protocol_version)
}

fn valid_object_params(params: Option<&Value>) -> bool {
	params.is_none_or(Value::is_object)
}

fn valid_list_parameters(params: Option<&Value>) -> bool {
	let Some(params) = params else {
		return true;
	};
	let Some(params) = params.as_object() else {
		return false;
	};
	params
		.keys()
		.all(|key| matches!(key.as_str(), "cursor" | "_meta"))
		&& params
			.get("cursor")
			.is_none_or(|cursor| cursor.as_str().is_some())
		&& params.get("_meta").is_none_or(Value::is_object)
}

fn call_parameters(params: Option<&Value>) -> Option<(String, Map<String, Value>)> {
	let params = params?.as_object()?;
	let name = params.get("name")?.as_str()?;
	if name.is_empty()
		|| name.len() > 256
		|| !params
			.keys()
			.all(|key| matches!(key.as_str(), "name" | "arguments" | "_meta"))
		|| params
			.get("_meta")
			.is_some_and(|metadata| !metadata.is_object())
	{
		return None;
	}
	let arguments = match params.get("arguments") {
		Some(arguments) => arguments.as_object()?.clone(),
		None => Map::new(),
	};
	Some((name.to_owned(), arguments))
}

fn cancellation_request_id(params: Option<&Value>) -> Option<RequestId> {
	RequestId::from_value(params?.as_object()?.get("requestId")?)
}

fn insert_inflight(
	inflight: &Mutex<HashMap<String, Inflight>>,
	id: &RequestId,
) -> Option<CancellationToken> {
	let mut requests = inflight.lock().expect("inflight request lock poisoned");
	if requests.contains_key(&id.key) {
		return None;
	}
	let cancellation = CancellationToken::default();
	requests.insert(
		id.key.clone(),
		Inflight {
			cancellation: cancellation.clone(),
		},
	);
	Some(cancellation)
}

fn cancel_all(inflight: &Mutex<HashMap<String, Inflight>>) {
	let requests = std::mem::take(&mut *inflight.lock().expect("inflight request lock poisoned"));
	for request in requests.into_values() {
		request.cancellation.cancel();
	}
}

fn spawn_request<W, F>(
	id: RequestId,
	cancellation: CancellationToken,
	inflight: Arc<Mutex<HashMap<String, Inflight>>>,
	output: Arc<W>,
	operation: F,
	tool_error: bool,
) -> JoinHandle<io::Result<()>>
where
	W: ProtocolWriter + 'static,
	F: FnOnce(CancellationToken) -> Result<Value, BackendError> + Send + 'static,
{
	thread::spawn(move || {
		let result = operation(cancellation.clone());
		let was_active = inflight
			.lock()
			.expect("inflight request lock poisoned")
			.remove(&id.key)
			.is_some();
		if cancellation.is_cancelled() || !was_active {
			return Ok(());
		}
		// Every `BackendError` message is written to be safe to return to the
		// client, so the message survives whichever arm the failure takes. A
		// non-tool request — `tools/list` — used to be flattened to a bare
		// "Internal error", which turned the one class of failure the caller can
		// actually fix, a root that does not match any published window, into an
		// internal fault and sent them looking in the wrong place.
		match result {
			Ok(result) => output.write_message(&success_response(id.value, result)),
			Err(error) if error.kind == BackendErrorKind::InvalidParams => output.write_message(
				&error_response(id.value, INVALID_PARAMS, &error.to_string()),
			),
			Err(error) if tool_error => {
				let result = serde_json::to_value(ToolCallResult::error(error.to_string()))
					.expect("tool error result is serializable");
				output.write_message(&success_response(id.value, result))
			}
			Err(error) => output.write_message(&error_response(
				id.value,
				INTERNAL_ERROR,
				&error.to_string(),
			)),
		}
	})
}

fn drain_finished_workers(workers: &mut Vec<JoinHandle<io::Result<()>>>) -> io::Result<()> {
	let mut index = 0;
	while index < workers.len() {
		if workers[index].is_finished() {
			let worker = workers.swap_remove(index);
			join_worker(worker)?;
		} else {
			index += 1;
		}
	}
	Ok(())
}

fn finish_cancelled_workers(workers: &mut Vec<JoinHandle<io::Result<()>>>) -> io::Result<()> {
	let deadline = Instant::now() + Duration::from_millis(100);
	while !workers.is_empty() && Instant::now() < deadline {
		drain_finished_workers(workers)?;
		if !workers.is_empty() {
			thread::sleep(Duration::from_millis(1));
		}
	}
	drain_finished_workers(workers)
}

fn join_worker(worker: JoinHandle<io::Result<()>>) -> io::Result<()> {
	worker
		.join()
		.map_err(|_| io::Error::other("MCP backend worker panicked"))?
}

fn success_response(id: Value, result: Value) -> Value {
	json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
	json!({
		"jsonrpc": "2.0",
		"id": id,
		"error": { "code": code, "message": message }
	})
}

#[cfg(test)]
mod tests {
	use std::io::{Cursor, Read};
	use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
	use std::time::Duration;

	use super::*;

	#[derive(Default)]
	struct MemoryWriter {
		messages: Mutex<Vec<Value>>,
	}

	impl MemoryWriter {
		fn messages(&self) -> Vec<Value> {
			self.messages.lock().unwrap().clone()
		}
	}

	impl ProtocolWriter for MemoryWriter {
		fn write_message(&self, message: &Value) -> io::Result<()> {
			self.messages.lock().unwrap().push(message.clone());
			Ok(())
		}
	}

	struct EchoBackend;

	impl ToolBackend for EchoBackend {
		fn list_tools(&self, _cancellation: CancellationToken) -> Result<Vec<Tool>, BackendError> {
			Ok(vec![Tool::new(
				"echo",
				json!({ "type": "object", "properties": {} }),
			)])
		}

		fn call_tool(
			&self,
			name: &str,
			arguments: &Map<String, Value>,
			_cancellation: CancellationToken,
		) -> Result<ToolCallResult, BackendError> {
			if name == "fail" {
				return Err(BackendError::new("downstream refused the call"));
			}
			Ok(ToolCallResult::success(vec![json!({
				"type": "text",
				"text": arguments.get("text").and_then(Value::as_str).unwrap_or_default()
			})]))
		}
	}

	struct DelayedEofReader {
		inner: Cursor<Vec<u8>>,
		delayed: bool,
	}

	impl DelayedEofReader {
		fn new(bytes: Vec<u8>) -> Self {
			Self {
				inner: Cursor::new(bytes),
				delayed: false,
			}
		}
	}

	impl Read for DelayedEofReader {
		fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
			self.inner.read(buffer)
		}
	}

	impl BufRead for DelayedEofReader {
		fn fill_buf(&mut self) -> io::Result<&[u8]> {
			if !self.delayed && self.inner.position() == self.inner.get_ref().len() as u64 {
				self.delayed = true;
				thread::sleep(Duration::from_millis(75));
			}
			self.inner.fill_buf()
		}

		fn consume(&mut self, amount: usize) {
			self.inner.consume(amount);
		}
	}

	fn initialized_messages(version: &str) -> Vec<Value> {
		vec![
			json!({
				"jsonrpc": "2.0",
				"id": 1,
				"method": "initialize",
				"params": {
					"protocolVersion": version,
					"capabilities": {},
					"clientInfo": { "name": "test", "version": "1" }
				}
			}),
			json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
		]
	}

	fn run_session<B: ToolBackend>(server: McpServer<B>, messages: Vec<Value>) -> Vec<Value> {
		let mut input = Vec::new();
		for message in messages {
			serde_json::to_writer(&mut input, &message).unwrap();
			input.push(b'\n');
		}
		let output = Arc::new(MemoryWriter::default());
		server
			.run(DelayedEofReader::new(input), Arc::clone(&output))
			.unwrap();
		output.messages()
	}

	fn response(messages: &[Value], id: i64) -> &Value {
		messages
			.iter()
			.find(|message| message.get("id") == Some(&json!(id)))
			.unwrap()
	}

	#[test]
	fn negotiates_public_and_unknown_protocol_versions() {
		let public = run_session(
			McpServer::new(EchoBackend),
			initialized_messages("2025-03-26"),
		);
		let unknown = run_session(
			McpServer::new(EchoBackend),
			initialized_messages("2099-01-01"),
		);

		assert_eq!(
			(
				public[0]["result"]["protocolVersion"].clone(),
				public[0]["result"]["capabilities"].clone(),
				unknown[0]["result"]["protocolVersion"].clone(),
			),
			(
				json!("2025-03-26"),
				json!({ "tools": { "listChanged": false } }),
				json!(LATEST_PROTOCOL_VERSION),
			)
		);
	}

	#[test]
	fn enforces_lifecycle_and_reports_protocol_errors() {
		let messages = run_session(
			McpServer::new(EchoBackend),
			vec![
				json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
				json!({ "jsonrpc": "2.0", "id": 2, "method": "missing" }),
				json!({ "jsonrpc": "2.0", "id": 3, "method": "initialize", "params": {} }),
			],
		);

		assert_eq!(
			messages,
			vec![
				error_response(json!(1), NOT_INITIALIZED, "Server not initialized"),
				error_response(json!(2), METHOD_NOT_FOUND, "Method not found"),
				error_response(json!(3), INVALID_PARAMS, "Invalid initialize parameters"),
			]
		);
	}

	#[test]
	fn accepts_standard_list_tools_metadata() {
		let valid = json!({ "_meta": { "progressToken": "tools" } });
		let invalid_metadata = json!({ "_meta": "metadata" });
		let unknown_parameter = json!({ "unexpected": true });

		assert_eq!(
			(
				valid_list_parameters(Some(&valid)),
				valid_list_parameters(Some(&invalid_metadata)),
				valid_list_parameters(Some(&unknown_parameter)),
			),
			(true, false, false)
		);
	}

	#[test]
	fn rejects_malformed_and_oversized_physical_lines_then_continues() {
		let input = b"not-json\n012345678901234567890123456789012\n{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"ping\"}\n";
		let output = Arc::new(MemoryWriter::default());
		McpServer::new(EchoBackend)
			.with_max_line_bytes(32)
			.run(Cursor::new(input), Arc::clone(&output))
			.unwrap();

		assert_eq!(
			output.messages(),
			vec![
				error_response(Value::Null, PARSE_ERROR, "Parse error"),
				error_response(Value::Null, PARSE_ERROR, "Parse error"),
				error_response(Value::Null, PARSE_ERROR, "Parse error"),
			]
		);
	}

	#[test]
	fn lists_tools_and_returns_downstream_failures_as_tool_errors() {
		let mut input = initialized_messages(LATEST_PROTOCOL_VERSION);
		input.extend([
			json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }),
			json!({
				"jsonrpc": "2.0",
				"id": 3,
				"method": "tools/call",
				"params": { "name": "fail", "arguments": {} }
			}),
		]);
		let messages = run_session(McpServer::new(EchoBackend), input);

		assert_eq!(
			(
				response(&messages, 2)["result"]["tools"][0]["name"].clone(),
				response(&messages, 3)["result"].clone(),
			),
			(
				json!("echo"),
				json!({
					"content": [{ "type": "text", "text": "downstream refused the call" }],
					"isError": true
				}),
			)
		);
	}

	/// Fails discovery the way an unreachable or mismatched root does.
	struct UnavailableBackend;

	impl ToolBackend for UnavailableBackend {
		fn list_tools(&self, _cancellation: CancellationToken) -> Result<Vec<Tool>, BackendError> {
			Err(BackendError::new(
				"Delver rendezvous discovery is unavailable.",
			))
		}

		fn call_tool(
			&self,
			_name: &str,
			_arguments: &Map<String, Value>,
			_cancellation: CancellationToken,
		) -> Result<ToolCallResult, BackendError> {
			Err(BackendError::invalid_params("Unknown Delver tool."))
		}
	}

	#[test]
	fn non_tool_failures_keep_their_message_instead_of_reading_as_an_internal_fault() {
		let mut input = initialized_messages(LATEST_PROTOCOL_VERSION);
		input.push(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }));
		let messages = run_session(McpServer::new(UnavailableBackend), input);

		assert_eq!(
			response(&messages, 2).clone(),
			error_response(
				json!(2),
				INTERNAL_ERROR,
				"Delver rendezvous discovery is unavailable.",
			)
		);
	}

	struct CancellableBackend {
		observed: Arc<AtomicBool>,
	}

	impl ToolBackend for CancellableBackend {
		fn list_tools(&self, _cancellation: CancellationToken) -> Result<Vec<Tool>, BackendError> {
			Ok(Vec::new())
		}

		fn call_tool(
			&self,
			_name: &str,
			_arguments: &Map<String, Value>,
			cancellation: CancellationToken,
		) -> Result<ToolCallResult, BackendError> {
			for _ in 0..100 {
				if cancellation.is_cancelled() {
					self.observed.store(true, Ordering::Release);
					return Err(BackendError::new("cancelled"));
				}
				thread::sleep(Duration::from_millis(1));
			}
			Ok(ToolCallResult::success(Vec::new()))
		}
	}

	#[test]
	fn cancellation_reaches_backend_and_suppresses_late_response() {
		let observed = Arc::new(AtomicBool::new(false));
		let backend = CancellableBackend {
			observed: Arc::clone(&observed),
		};
		let mut input = initialized_messages(LATEST_PROTOCOL_VERSION);
		input.extend([
			json!({
				"jsonrpc": "2.0",
				"id": "call-1",
				"method": "tools/call",
				"params": { "name": "slow" }
			}),
			json!({
				"jsonrpc": "2.0",
				"method": "notifications/cancelled",
				"params": { "requestId": "call-1", "reason": "test" }
			}),
		]);
		let messages = run_session(McpServer::new(backend), input);

		assert_eq!(
			(observed.load(Ordering::Acquire), messages.len()),
			(true, 1)
		);
	}

	#[test]
	fn end_of_input_cancels_inflight_backend_work() {
		let observed = Arc::new(AtomicBool::new(false));
		let backend = CancellableBackend {
			observed: Arc::clone(&observed),
		};
		let mut input = initialized_messages(LATEST_PROTOCOL_VERSION);
		input.push(json!({
			"jsonrpc": "2.0",
			"id": "call-at-eof",
			"method": "tools/call",
			"params": { "name": "slow" }
		}));
		let messages = run_session(McpServer::new(backend), input);

		assert_eq!(
			(observed.load(Ordering::Acquire), messages.len()),
			(true, 1)
		);
	}

	struct NonCooperativeBackend;

	impl ToolBackend for NonCooperativeBackend {
		fn list_tools(&self, _cancellation: CancellationToken) -> Result<Vec<Tool>, BackendError> {
			Ok(Vec::new())
		}

		fn call_tool(
			&self,
			_name: &str,
			_arguments: &Map<String, Value>,
			_cancellation: CancellationToken,
		) -> Result<ToolCallResult, BackendError> {
			thread::sleep(Duration::from_millis(500));
			Ok(ToolCallResult::success(Vec::new()))
		}
	}

	#[test]
	fn end_of_input_does_not_wait_indefinitely_for_a_noncooperative_backend() {
		let mut input = initialized_messages(LATEST_PROTOCOL_VERSION);
		input.push(json!({
			"jsonrpc": "2.0",
			"id": "stuck-call",
			"method": "tools/call",
			"params": { "name": "slow" }
		}));
		let started = Instant::now();
		let messages = run_session(McpServer::new(NonCooperativeBackend), input);

		assert_eq!(
			(
				messages.len(),
				started.elapsed() < Duration::from_millis(300)
			),
			(1, true)
		);
	}

	struct ConcurrentBackend {
		active: Arc<AtomicUsize>,
		maximum: Arc<AtomicUsize>,
	}

	impl ToolBackend for ConcurrentBackend {
		fn list_tools(&self, _cancellation: CancellationToken) -> Result<Vec<Tool>, BackendError> {
			Ok(Vec::new())
		}

		fn call_tool(
			&self,
			_name: &str,
			_arguments: &Map<String, Value>,
			_cancellation: CancellationToken,
		) -> Result<ToolCallResult, BackendError> {
			let active = self.active.fetch_add(1, Ordering::AcqRel) + 1;
			self.maximum.fetch_max(active, Ordering::AcqRel);
			thread::sleep(Duration::from_millis(30));
			self.active.fetch_sub(1, Ordering::AcqRel);
			Ok(ToolCallResult::success(Vec::new()))
		}
	}

	#[test]
	fn tool_calls_are_concurrent_and_ping_remains_responsive() {
		let maximum = Arc::new(AtomicUsize::new(0));
		let backend = ConcurrentBackend {
			active: Arc::new(AtomicUsize::new(0)),
			maximum: Arc::clone(&maximum),
		};
		let mut input = initialized_messages(LATEST_PROTOCOL_VERSION);
		input.extend([
			json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "a" } }),
			json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "b" } }),
			json!({ "jsonrpc": "2.0", "id": 4, "method": "ping" }),
		]);
		let messages = run_session(McpServer::new(backend), input);
		let ping_index = messages
			.iter()
			.position(|message| message.get("id") == Some(&json!(4)))
			.unwrap();
		let first_call_index = messages
			.iter()
			.position(|message| matches!(message.get("id").and_then(Value::as_i64), Some(2 | 3)))
			.unwrap();

		assert_eq!(
			(
				maximum.load(Ordering::Acquire),
				ping_index < first_call_index
			),
			(2, true)
		);
	}

	#[test]
	fn ndjson_writer_emits_one_utf8_json_value_per_line() {
		let writer = NdjsonWriter::new(Vec::<u8>::new());
		writer
			.write_message(&json!({ "text": "first\nsecond", "value": "☃" }))
			.unwrap();
		let bytes = writer.inner.into_inner().unwrap();

		assert_eq!(
			String::from_utf8(bytes).unwrap(),
			"{\"text\":\"first\\nsecond\",\"value\":\"☃\"}\n"
		);
	}
}
