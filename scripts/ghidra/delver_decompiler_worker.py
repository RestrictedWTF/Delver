#!/usr/bin/env python3
# ---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
"""Persistent, backend-neutral JSON Lines host for Delver's PyGhidra driver."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import queue
import re
import shutil
import sys
import tempfile
import threading
import time
from typing import Any, TextIO


PROTOCOL_VERSION = 1
RESULT_SCHEMA_VERSION = 1
DECOMPILE_TIMEOUT_SECONDS = 60
BACKEND_ID = "ghidra-pyghidra"
GHIDRA_GENERATED_FUNCTION_PATTERN = re.compile(r"\bFUN_([0-9A-Fa-f]+)\b")


class WorkerError(Exception):
	"""An expected failure that can safely cross the worker protocol."""

	def __init__(self, code: str, message: str, data: dict[str, Any] | None = None):
		super().__init__(message)
		self.code = code
		self.data = data


class Target:
	"""Resources retained for one open target."""

	def __init__(
		self,
		target_id: str,
		context: Any,
		program: Any,
		flat_api: Any,
		decompiler: Any,
		project_directory: Path,
		temporary_project: bool,
	):
		self.target_id = target_id
		self.context = context
		self.program = program
		self.flat_api = flat_api
		self.decompiler = decompiler
		self.project_directory = project_directory
		self.temporary_project = temporary_project

	def close(self) -> None:
		try:
			self.decompiler.dispose()
		finally:
			self.context.__exit__(None, None, None)
			if self.temporary_project:
				shutil.rmtree(self.project_directory, ignore_errors=True)


class PyGhidraDriver:
	"""Owns the single JVM and all Ghidra programs for this process."""

	def __init__(self, ghidra_home: Path | None):
		self._ghidra_home = ghidra_home
		self._pyghidra: Any = None
		self._application: Any = None
		self._decomp_interface_type: Any = None
		self._decompile_options_type: Any = None
		self._pretty_printer_type: Any = None
		self._targets: dict[str, Target] = {}
		self._active_monitors: dict[str, Any] = {}
		self._monitor_lock = threading.Lock()
		self._backend_version = "unknown"
		self._started = False

	def start(self) -> None:
		if self._started:
			return
		try:
			import pyghidra
		except ImportError as error:
			raise WorkerError(
				"backend_unavailable",
				"PyGhidra is not installed in this Python environment. Run 'python -m pip install pyghidra'.",
			) from error

		try:
			with contextlib.redirect_stdout(sys.stderr):
				pyghidra.start(install_dir=self._ghidra_home)
				from ghidra.app.decompiler import DecompInterface, DecompileOptions, PrettyPrinter
				from ghidra.framework import Application
		except Exception as error:
			raise WorkerError("backend_unavailable", f"Could not start PyGhidra: {error}") from error

		self._pyghidra = pyghidra
		self._application = Application
		self._decomp_interface_type = DecompInterface
		self._decompile_options_type = DecompileOptions
		self._pretty_printer_type = PrettyPrinter
		self._backend_version = str(Application.getApplicationVersion())
		self._started = True

	def hello(self) -> dict[str, Any]:
		self.start()
		try:
			pyghidra_version = importlib.metadata.version("pyghidra")
		except importlib.metadata.PackageNotFoundError:
			pyghidra_version = "unknown"
		return {
			"protocolVersion": PROTOCOL_VERSION,
			"backend": {
				"id": BACKEND_ID,
				"label": f"Ghidra {self._backend_version} (PyGhidra)",
				"version": self._backend_version,
				"adapterVersion": pyghidra_version,
			},
			"capabilities": {
				"decompileFunction": True,
				"cancel": True,
				"persistentTargets": True,
				"addressMappings": True,
				"variables": True,
				"intermediateRepresentations": [],
			},
		}

	def open_target(self, request_id: str, params: dict[str, Any]) -> dict[str, Any]:
		self.start()
		target_id = required_string(params, "targetId")
		target_path = Path(required_string(params, "targetPath")).resolve()
		content_hash = required_hash(params, "contentHash")
		if target_id in self._targets:
			raise WorkerError("target_already_open", f"Target '{target_id}' is already open.")
		if not target_path.is_file():
			raise WorkerError("target_not_found", f"Target does not exist: {target_path}")
		if sha256_file(target_path) != content_hash:
			raise WorkerError("content_mismatch", "The target content does not match the requested SHA-256 hash.")

		configured_project = optional_string(params, "projectDirectory")
		if configured_project is None:
			project_directory = Path(tempfile.mkdtemp(prefix="delver-ghidra-project-"))
			temporary_project = True
		else:
			project_directory = Path(configured_project).resolve()
			project_directory.mkdir(parents=True, exist_ok=True)
			temporary_project = False

		project_name = f"delver-{content_hash}"
		program_context: Any = None
		decompiler: Any = None
		try:
			# open_program is retained by PyGhidra for the important import-or-open project behavior.
			# Keeping its context alive retains the analyzed Program until closeTarget.
			program_context = self._pyghidra.open_program(
				target_path,
				project_location=project_directory,
				project_name=project_name,
				# Full auto-analysis can take minutes even for small installer-style
				# binaries. Import immediately and recover the requested function on
				# demand; the persistent project retains everything we discover.
				analyze=False,
				nested_project_location=True,
			)
			with contextlib.redirect_stdout(sys.stderr):
				flat_api = program_context.__enter__()
			program = flat_api.getCurrentProgram()

			decompiler = self._decomp_interface_type()
			options = self._decompile_options_type()
			options.grabFromProgram(program)
			decompiler.setOptions(options)
			decompiler.toggleCCode(True)
			decompiler.toggleSyntaxTree(True)
			decompiler.setSimplificationStyle("decompile")
			if not decompiler.openProgram(program):
				raise WorkerError(
					"backend_error",
					f"Could not open the program in Ghidra's decompiler: {decompiler.getLastMessage()}",
				)
			if sha256_file(target_path) != content_hash:
				raise WorkerError("content_mismatch", "The target changed while Ghidra was opening it.")

			target = Target(target_id, program_context, program, flat_api, decompiler, project_directory, temporary_project)
			self._targets[target_id] = target
			return {
				"targetId": target_id,
				"imageBase": encode_rva(int(program.getImageBase().getOffset())),
			}
		except WorkerError:
			if decompiler is not None:
				decompiler.dispose()
			if program_context is not None:
				program_context.__exit__(*sys.exc_info())
			if temporary_project:
				shutil.rmtree(project_directory, ignore_errors=True)
			raise
		except Exception as error:
			if decompiler is not None:
				decompiler.dispose()
			if program_context is not None:
				program_context.__exit__(*sys.exc_info())
			if temporary_project:
				shutil.rmtree(project_directory, ignore_errors=True)
			raise WorkerError("backend_error", f"Could not open target with PyGhidra: {error}") from error

	def decompile_function(self, request_id: str, params: dict[str, Any]) -> dict[str, Any]:
		target_id = required_string(params, "targetId")
		function_rva = required_rva(params, "functionRva")
		target = self._targets.get(target_id)
		if target is None:
			raise WorkerError("target_not_open", f"Target '{target_id}' is not open.")

		monitor = self._pyghidra.task_monitor()
		with self._monitor_lock:
			self._active_monitors[request_id] = monitor
		try:
			recovery_started = time.perf_counter()
			function_address = target.program.getImageBase().add(function_rva)
			function = resolve_function(target, function_address, function_rva)
			function_recovery_ms = elapsed_ms(recovery_started)

			decompilation_started = time.perf_counter()
			with contextlib.redirect_stdout(sys.stderr):
				results = target.decompiler.decompileFunction(function, DECOMPILE_TIMEOUT_SECONDS, monitor)
			decompilation_ms = elapsed_ms(decompilation_started)
			if monitor.isCancelled():
				raise WorkerError("cancelled", "The decompilation was cancelled.")
			if not results.decompileCompleted():
				raise WorkerError("decompilation_failed", f"Ghidra could not decompile the function: {results.getErrorMessage()}")

			serialization_started = time.perf_counter()
			options = self._decompile_options_type()
			options.grabFromProgram(target.program)
			printer = self._pretty_printer_type(function, results.getCCodeMarkup(), options.getNameTransformer())
			decompiled = print_decompiled(printer)
			result = {
				"schemaVersion": RESULT_SCHEMA_VERSION,
				"functionRva": encode_rva(function_rva),
				"text": normalize_generated_function_names(
					str(decompiled.getC()),
					int(target.program.getImageBase().getOffset()),
				),
				"lineMappings": line_mappings(printer.getLines(), target.program),
				"variables": variables(results.getHighFunction().getLocalSymbolMap().getSymbols()),
			}
			result["timings"] = {
				"functionRecoveryMs": function_recovery_ms,
				"decompilationMs": decompilation_ms,
				"serializationMs": elapsed_ms(serialization_started),
			}
			return result
		finally:
			with self._monitor_lock:
				self._active_monitors.pop(request_id, None)

	def close_target(self, params: dict[str, Any]) -> dict[str, Any]:
		target_id = required_string(params, "targetId")
		target = self._targets.pop(target_id, None)
		if target is None:
			raise WorkerError("target_not_open", f"Target '{target_id}' is not open.")
		target.close()
		return {"targetId": target_id}

	def cancel(self, request_id: str) -> bool:
		with self._monitor_lock:
			monitor = self._active_monitors.get(request_id)
			if monitor is None:
				return False
			monitor.cancel()
			return True

	def close(self) -> None:
		with self._monitor_lock:
			for monitor in self._active_monitors.values():
				monitor.cancel()
		for target in list(self._targets.values()):
			try:
				target.close()
			except Exception as error:
				print(f"Could not close PyGhidra target '{target.target_id}': {error}", file=sys.stderr)
		self._targets.clear()


def resolve_function(target: Target, function_address: Any, function_rva: int) -> Any:
	"""Resolves only the requested entry, never a different containing function."""
	manager = target.program.getFunctionManager()
	function = manager.getFunctionAt(function_address)
	if function is not None:
		return function
	target.flat_api.disassemble(function_address)
	function = target.flat_api.createFunction(function_address, None)
	if function is not None:
		return function
	containing = manager.getFunctionContaining(function_address)
	if containing is not None:
		containing_rva = int(containing.getEntryPoint().subtract(target.program.getImageBase()))
		raise WorkerError(
			"function_boundary_conflict",
			f"Ghidra considers RVA {encode_rva(function_rva)} part of the function at {encode_rva(containing_rva)} instead of a distinct function.",
		)
	raise WorkerError("function_not_found", f"Ghidra could not find or create a function at RVA {encode_rva(function_rva)}.")


class WorkerServer:
	"""Reads requests concurrently while serializing all backend work."""

	def __init__(self, driver: Any, output: TextIO):
		self._driver = driver
		self._output = output
		self._output_lock = threading.Lock()
		self._requests: queue.Queue[tuple[str, str, dict[str, Any]] | None] = queue.Queue()
		self._pending: set[str] = set()
		self._cancelled: set[str] = set()
		self._state_lock = threading.Lock()

	def run(self, input_stream: TextIO) -> None:
		# JPype must initialize and invoke Ghidra on the process main thread. A dedicated
		# reader still lets cancellation reach the monitor while that thread is busy.
		reader = threading.Thread(
			target=self._read_requests,
			args=(input_stream,),
			name="delver-decompiler-input",
			daemon=True,
		)
		reader.start()
		self._run_requests()
		reader.join()

	def _read_requests(self, input_stream: TextIO) -> None:
		# TextIO iteration can read ahead until EOF on a Windows anonymous pipe.
		# Node deliberately keeps this pipe open for the persistent protocol, so
		# use readline() to release each newline-terminated request immediately.
		while True:
			line = input_stream.readline()
			if line == "":
				break
			if not line.strip():
				continue
			try:
				request_id, method, params = parse_request(line)
				if method == "cancel":
					self._handle_cancel(request_id, params)
					continue
				with self._state_lock:
					if request_id in self._pending:
						raise WorkerError("duplicate_request", f"Request '{request_id}' is already pending.")
					self._pending.add(request_id)
				self._requests.put((request_id, method, params))
			except WorkerError as error:
				self._write_error(request_id_from_invalid_line(line), error)
		self._requests.put(None)

	def _run_requests(self) -> None:
		while True:
			item = self._requests.get()
			if item is None:
				return
			request_id, method, params = item
			try:
				with self._state_lock:
					cancelled = request_id in self._cancelled
				if cancelled:
					raise WorkerError("cancelled", "The request was cancelled.")
				result = self._dispatch(request_id, method, params)
				self._write({"protocolVersion": PROTOCOL_VERSION, "id": request_id, "result": result})
			except WorkerError as error:
				self._write_error(request_id, error)
			except Exception as error:
				print(f"Unhandled worker error for request '{request_id}': {error}", file=sys.stderr)
				self._write_error(request_id, WorkerError("internal_error", "The decompiler worker failed unexpectedly."))
			finally:
				with self._state_lock:
					self._pending.discard(request_id)
					self._cancelled.discard(request_id)

	def _dispatch(self, request_id: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
		if method == "hello":
			return self._driver.hello()
		if method == "openTarget":
			return self._driver.open_target(request_id, params)
		if method == "decompileFunction":
			return self._driver.decompile_function(request_id, params)
		if method == "closeTarget":
			return self._driver.close_target(params)
		raise WorkerError("method_not_found", f"Unsupported method '{method}'.")

	def _handle_cancel(self, request_id: str, params: dict[str, Any]) -> None:
		cancelled_request_id = required_string(params, "requestId")
		with self._state_lock:
			pending = cancelled_request_id in self._pending
			if pending:
				self._cancelled.add(cancelled_request_id)
		active = self._driver.cancel(cancelled_request_id)
		self._write({
			"protocolVersion": PROTOCOL_VERSION,
			"id": request_id,
			"result": {"requestId": cancelled_request_id, "cancelled": pending or active},
		})

	def _write_error(self, request_id: str | None, error: WorkerError) -> None:
		encoded: dict[str, Any] = {"code": error.code, "message": str(error)}
		if error.data is not None:
			encoded["data"] = error.data
		self._write({"protocolVersion": PROTOCOL_VERSION, "id": request_id, "error": encoded})

	def _write(self, response: dict[str, Any]) -> None:
		with self._output_lock:
			self._output.write(json.dumps(response, separators=(",", ":"), ensure_ascii=False) + "\n")
			self._output.flush()


def parse_request(line: str) -> tuple[str, str, dict[str, Any]]:
	try:
		value = json.loads(line)
	except json.JSONDecodeError as error:
		raise WorkerError("invalid_request", f"Request is not valid JSON: {error.msg}.") from error
	if not isinstance(value, dict):
		raise WorkerError("invalid_request", "Request must be a JSON object.")
	if value.get("protocolVersion") != PROTOCOL_VERSION:
		raise WorkerError("unsupported_protocol", f"protocolVersion must be {PROTOCOL_VERSION}.")
	request_id = value.get("id")
	if not isinstance(request_id, str) or not request_id:
		raise WorkerError("invalid_request", "id must be a non-empty string.")
	method = value.get("method")
	if not isinstance(method, str) or not method:
		raise WorkerError("invalid_request", "method must be a non-empty string.")
	params = value.get("params", {})
	if not isinstance(params, dict):
		raise WorkerError("invalid_request", "params must be an object.")
	return request_id, method, params


def request_id_from_invalid_line(line: str) -> str | None:
	try:
		value = json.loads(line)
	except json.JSONDecodeError:
		return None
	if isinstance(value, dict) and isinstance(value.get("id"), str) and value["id"]:
		return value["id"]
	return None


def required_string(params: dict[str, Any], name: str) -> str:
	value = params.get(name)
	if not isinstance(value, str) or not value:
		raise WorkerError("invalid_params", f"{name} must be a non-empty string.")
	return value


def optional_string(params: dict[str, Any], name: str) -> str | None:
	value = params.get(name)
	if value is None:
		return None
	if not isinstance(value, str) or not value:
		raise WorkerError("invalid_params", f"{name} must be a non-empty string when provided.")
	return value


def required_hash(params: dict[str, Any], name: str) -> str:
	value = required_string(params, name)
	if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
		raise WorkerError("invalid_params", f"{name} must be a lowercase SHA-256 hash.")
	return value


def required_rva(params: dict[str, Any], name: str) -> int:
	value = required_string(params, name)
	if not value.startswith("0x") or len(value) < 3:
		raise WorkerError("invalid_params", f"{name} must be a canonical lowercase hexadecimal RVA.")
	digits = value[2:]
	if (len(digits) > 1 and digits[0] == "0") or any(character not in "0123456789abcdef" for character in digits):
		raise WorkerError("invalid_params", f"{name} must be a canonical lowercase hexadecimal RVA.")
	return int(digits, 16)


def sha256_file(path: Path) -> str:
	digest = hashlib.sha256()
	with path.open("rb") as stream:
		for chunk in iter(lambda: stream.read(1024 * 1024), b""):
			digest.update(chunk)
	return digest.hexdigest()


def encode_rva(value: int) -> str:
	return f"0x{value:x}"


def normalize_generated_function_names(text: str, image_base: int) -> str:
	"""Convert Ghidra's absolute FUN names to Delver's stable RVA placeholders."""
	def replace(match: re.Match[str]) -> str:
		absolute_address = int(match.group(1), 16)
		if absolute_address < image_base:
			return match.group(0)
		return f"SUB_{absolute_address - image_base:X}"

	return GHIDRA_GENERATED_FUNCTION_PATTERN.sub(replace, text)


def elapsed_ms(started: float) -> int:
	return round((time.perf_counter() - started) * 1000)


def line_mappings(lines: Any, program: Any) -> list[dict[str, Any]]:
	image_base = program.getImageBase()
	mappings: list[dict[str, Any]] = []
	for line in lines:
		ranges: list[tuple[int, int]] = []
		for token_index in range(line.getNumTokens()):
			token = line.getToken(token_index)
			minimum = token.getMinAddress()
			maximum = token.getMaxAddress()
			if minimum is None or maximum is None:
				continue
			start = int(minimum.subtract(image_base))
			end = int(maximum.subtract(image_base)) + 1
			if start < end:
				ranges.append((start, end))
		merged: list[tuple[int, int]] = []
		for start, end in sorted(ranges):
			if merged and start <= merged[-1][1]:
				merged[-1] = (merged[-1][0], max(merged[-1][1], end))
			else:
				merged.append((start, end))
		if merged:
			mappings.append({
				"line": int(line.getLineNumber()),
				"ranges": [{"startRva": encode_rva(start), "endRva": encode_rva(end)} for start, end in merged],
			})
	return mappings


def variables(symbol_iterator: Any) -> list[dict[str, str]]:
	encoded: list[dict[str, str]] = []
	while symbol_iterator.hasNext():
		symbol = symbol_iterator.next()
		encoded.append({
			"name": str(symbol.getName()),
			"typeName": str(symbol.getDataType().getDisplayName()),
			"storage": str(symbol.getStorage()),
		})
	return encoded


def print_decompiled(printer: Any) -> Any:
	"""Call Java's print(), which JPype renames because print is a Python keyword."""
	return printer.print_()


def parse_arguments() -> argparse.Namespace:
	parser = argparse.ArgumentParser(description="Run Delver's persistent PyGhidra decompiler worker.")
	parser.add_argument("--ghidra-home", type=Path, help="Path to the Ghidra installation directory.")
	return parser.parse_args()


def main() -> int:
	arguments = parse_arguments()
	driver = PyGhidraDriver(arguments.ghidra_home)
	try:
		# JPype/JVM initialization must finish before the persistent Windows stdin
		# reader blocks in a background thread. Starting both concurrently can
		# deadlock until Node closes the pipe, which a persistent host never does.
		driver.start()
		WorkerServer(driver, sys.stdout).run(sys.stdin)
	finally:
		driver.close()
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
