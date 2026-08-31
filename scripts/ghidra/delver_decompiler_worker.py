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
# Ghidra prints a call whose target it recovered no function at as
# `func_0x<absolute>`, which is neither Delver's naming nor image-relative.
GHIDRA_UNRECOVERED_FUNCTION_PATTERN = re.compile(r"\bfunc_0x([0-9A-Fa-f]+)\b")
MAX_SEMANTIC_DECLARATIONS = 10000
MAX_DECLARATION_CHARACTERS = 2048
MAX_SEMANTIC_COMPOSITES = 1000
MAX_COMPOSITE_FIELDS = 1000
MAX_ENUM_MEMBERS = 4096
# 1, 2 and 4 byte enums only. An 8-byte value does not survive a JSON number
# above 2^53 (ADR 0001), and truncating a constant is how a comparison against
# it silently becomes a different comparison. Refused rather than narrowed.
ENUM_SIZES = (1, 2, 4)
MAX_COMPOSITE_SIZE_BYTES = 1024 * 1024
COMPOSITE_KINDS = ("struct", "union", "enum")
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Each accepted schema version pins its own key set. A sender whose payload does
# not match the version it claims is out of step with this worker, and guessing
# which half is right would decompile against a type model nobody authored.
SEMANTICS_SCHEMA_KEYS = {
	1: frozenset({"schemaVersion", "dataTypes", "functionPrototypes"}),
	2: frozenset({"schemaVersion", "dataTypes", "functionPrototypes", "composites"}),
}


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
		self._function_signature_parser_type: Any = None
		self._apply_function_signature_command_type: Any = None
		self._source_type: Any = None
		self._data_type_parser_type: Any = None
		self._allowed_data_types: Any = None
		self._structure_data_type_type: Any = None
		self._union_data_type_type: Any = None
		self._enum_data_type_type: Any = None
		self._data_type_conflict_handler: Any = None
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
				from ghidra.app.cmd.function import ApplyFunctionSignatureCmd
				from ghidra.app.util.parser import FunctionSignatureParser
				from ghidra.framework import Application
				from ghidra.program.model.data import DataTypeConflictHandler, EnumDataType, StructureDataType, UnionDataType
				from ghidra.program.model.symbol import SourceType
				from ghidra.util.data import DataTypeParser
		except Exception as error:
			raise WorkerError("backend_unavailable", f"Could not start PyGhidra: {error}") from error

		self._pyghidra = pyghidra
		self._application = Application
		self._decomp_interface_type = DecompInterface
		self._decompile_options_type = DecompileOptions
		self._pretty_printer_type = PrettyPrinter
		self._function_signature_parser_type = FunctionSignatureParser
		self._apply_function_signature_command_type = ApplyFunctionSignatureCmd
		self._source_type = SourceType
		self._data_type_parser_type = DataTypeParser
		self._allowed_data_types = DataTypeParser.AllowedDataTypes
		self._structure_data_type_type = StructureDataType
		self._union_data_type_type = UnionDataType
		self._enum_data_type_type = EnumDataType
		self._data_type_conflict_handler = DataTypeConflictHandler
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
				"listFunctions": True,
				"analyzeTarget": True,
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
		semantics = required_semantics(params)
		target = self._targets.get(target_id)
		if target is None:
			raise WorkerError("target_not_open", f"Target '{target_id}' is not open.")

		monitor = self._pyghidra.task_monitor()
		with self._monitor_lock:
			self._active_monitors[request_id] = monitor
		transaction_id: int | None = None
		try:
			recovery_started = time.perf_counter()
			function_address = target.program.getImageBase().add(function_rva)
			function = resolve_function(target, function_address, function_rva)
			function_recovery_ms = elapsed_ms(recovery_started)
			if semantics["composites"] or semantics["dataTypes"] or semantics["functionPrototypes"]:
				transaction_id = target.program.startTransaction("Apply Delver semantic interpretation")
				apply_semantics(self, target, semantics, monitor)

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
			if transaction_id is not None:
				# Accepted interpretation is an input to this decompilation, not a
				# mutation of the persistent content-hash project. Rolling it back
				# makes clearing or revising a declaration deterministic next time.
				target.program.endTransaction(transaction_id, False)
			with self._monitor_lock:
				self._active_monitors.pop(request_id, None)

	def analyze_target(self, request_id: str, params: dict[str, Any]) -> dict[str, Any]:
		"""Runs Ghidra's auto-analysis to completion on one open target.

		`open_target` deliberately imports with `analyze=False`, because full
		analysis takes minutes and pseudocode for one function does not need it.
		Anything that reasons about the backend's *whole* function set does, so
		this is the explicit, cancellable way to ask for it rather than a cost
		hidden inside another call (ADR 0017).

		Idempotent: a program Ghidra already analyzed returns immediately and
		says it did no work, so a caller may always ask.
		"""
		self.start()
		started = time.perf_counter()
		target_id = required_string(params, "targetId")
		target = self._targets.get(target_id)
		if target is None:
			raise WorkerError("target_not_open", f"Target '{target_id}' is not open.")
		if program_is_analyzed(target.program):
			return {
				"protocolVersion": PROTOCOL_VERSION,
				"schemaVersion": RESULT_SCHEMA_VERSION,
				"analysisComplete": True,
				"alreadyAnalyzed": True,
				"timings": {"analyzeMs": elapsed_ms(started)},
			}

		monitor = self._pyghidra.task_monitor()
		with self._monitor_lock:
			self._active_monitors[request_id] = monitor
		transaction_id: int | None = None
		try:
			transaction_id = target.program.startTransaction("Delver full analysis")
			with contextlib.redirect_stdout(sys.stderr):
				target.flat_api.analyzeAll(target.program)
				mark_program_analyzed(target.program)
		finally:
			if transaction_id is not None:
				# Committed, unlike the semantic snapshot a decompilation applies.
				# Analysis is a fact the backend derived from the bytes, not
				# authored interpretation, so the persistent content-hash project
				# is exactly where it belongs (ADR 0005, ADR 0013).
				target.program.endTransaction(transaction_id, True)
			with self._monitor_lock:
				self._active_monitors.pop(request_id, None)

		return {
			"protocolVersion": PROTOCOL_VERSION,
			"schemaVersion": RESULT_SCHEMA_VERSION,
			"analysisComplete": program_is_analyzed(target.program),
			"alreadyAnalyzed": False,
			"timings": {"analyzeMs": elapsed_ms(started)},
		}

	def list_functions(self, params: dict[str, Any]) -> dict[str, Any]:
		"""Every function Ghidra recovered in one target, as image-relative RVAs.

		The reference frame for the handshake is Delver's function set, so this
		reports what the backend believes and interprets nothing (ADR 0017). No
		function is created here — asking a backend what it recovered must not
		change what it recovered.
		"""
		self.start()
		started = time.perf_counter()
		target_id = required_string(params, "targetId")
		target = self._targets.get(target_id)
		if target is None:
			raise WorkerError("target_not_open", f"Target '{target_id}' is not open.")
		image_base = target.program.getImageBase()
		# `open_target` imports with `analyze=False` and recovers functions on
		# demand, so this list is whatever Ghidra happens to hold right now. On an
		# unanalyzed program that is a fraction of what it would find, and a
		# caller that compared it against a complete set would report the
		# difference as disagreement. Say which it is; do not let the caller guess.
		analysis_complete = program_is_analyzed(target.program)
		functions = []
		for function in target.program.getFunctionManager().getFunctions(True):
			entry = function.getEntryPoint()
			body = function.getBody()
			maximum = body.getMaxAddress() if body is not None else None
			# Ghidra's body max is inclusive and may be a later chunk, so the
			# exclusive end is one past it. A body Ghidra does not have is
			# reported as absent rather than guessed from the next entry.
			functions.append({
				"rva": encode_rva(int(entry.subtract(image_base))),
				"endRva": encode_rva(int(maximum.subtract(image_base)) + 1) if maximum is not None else None,
				"name": str(function.getName()),
			})
		return {
			"protocolVersion": PROTOCOL_VERSION,
			"schemaVersion": RESULT_SCHEMA_VERSION,
			"functions": functions,
			"analysisComplete": analysis_complete,
			"timings": {"listFunctionsMs": elapsed_ms(started)},
		}

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


def apply_semantics(driver: PyGhidraDriver, target: Target, semantics: dict[str, list[dict[str, Any]]], monitor: Any) -> None:
	"""Applies one validated semantic snapshot inside the caller's rollback transaction."""
	image_base = target.program.getImageBase()
	data_type_manager = target.program.getDataTypeManager()
	try:
		data_type_parser = driver._data_type_parser_type(
			data_type_manager,
			data_type_manager,
			None,
			driver._allowed_data_types.ALL,
		)
		apply_composites(driver, data_type_manager, data_type_parser, semantics["composites"])

		for authored in semantics["dataTypes"]:
			address = image_base.add(authored["rva"])
			block = target.program.getMemory().getBlock(address)
			if block is None or block.isExecute():
				raise WorkerError(
					"semantic_application_failed",
					f"Data type at {encode_rva(authored['rva'])} is not in mapped non-executable memory.",
				)
			data_type = data_type_parser.parse(authored["declaration"])
			length = int(data_type.getLength())
			if length <= 0:
				raise WorkerError(
					"semantic_application_failed",
					f"Data type at {encode_rva(authored['rva'])} has no fixed storage length.",
				)
			end = address.add(length - 1)
			if not block.contains(end):
				raise WorkerError(
					"semantic_application_failed",
					f"Data type at {encode_rva(authored['rva'])} crosses its mapped memory block.",
				)
			target.flat_api.clearListing(address, end)
			target.flat_api.createData(address, data_type)

		function_parser = driver._function_signature_parser_type(data_type_manager, None)
		for authored in semantics["functionPrototypes"]:
			address = image_base.add(authored["rva"])
			function = resolve_function(target, address, authored["rva"])
			signature = function_parser.parse(function.getSignature(), authored["declaration"])
			command = driver._apply_function_signature_command_type(address, signature, driver._source_type.USER_DEFINED)
			if not command.applyTo(target.program, monitor):
				raise WorkerError(
					"semantic_application_failed",
					f"Ghidra refused the function prototype at {encode_rva(authored['rva'])}.",
				)
	except WorkerError:
		raise
	except Exception as error:
		raise WorkerError("semantic_application_failed", f"Could not apply accepted semantic interpretation: {error}") from error


def apply_composites(driver: PyGhidraDriver, data_type_manager: Any, data_type_parser: Any, composites: list[dict[str, Any]]) -> None:
	"""Defines the snapshot's composites so later declarations can name them."""
	# Two passes, because a field typed 'Foo *' may name another composite from
	# this same snapshot, in either direction. Registering every name as an empty
	# structure first is what lets the parser resolve those references at all;
	# laying out fields in one pass would fail on the first forward reference.
	registered: dict[str, Any] = {}
	for composite in composites:
		try:
			if composite["kind"] == "enum":
				# An enum is complete at registration: it has no member that can
				# name another composite, so there is nothing for a second pass
				# to resolve.
				enumeration = driver._enum_data_type_type(composite["name"], composite["size"], data_type_manager)
				for member in composite["members"]:
					enumeration.add(member["name"], member["value"])
				registered[composite["name"]] = data_type_manager.addDataType(
					enumeration,
					driver._data_type_conflict_handler.REPLACE_HANDLER,
				)
				continue
			if composite["kind"] == "union":
				# A union has no offsets to preserve and Ghidra sizes it from its
				# largest member, so it takes the name alone.
				empty = driver._union_data_type_type(composite["name"], data_type_manager)
			else:
				empty = driver._structure_data_type_type(composite["name"], composite["size"], data_type_manager)
			# Padding in a real binary is something the analyst measured, not a
			# flaw to tidy up. Packing off means Ghidra keeps the declared size
			# and every field stays at the offset it was given.
			empty.setPackingEnabled(False)
			registered[composite["name"]] = data_type_manager.addDataType(
				empty,
				driver._data_type_conflict_handler.REPLACE_HANDLER,
			)
		except Exception as error:
			raise WorkerError(
				"semantic_application_failed",
				f"Could not define composite '{composite['name']}': {error}",
			) from error

	for composite in composites:
		if composite["kind"] == "enum":
			continue
		try:
			populate_composite(data_type_parser, registered[composite["name"]], composite)
		except WorkerError:
			raise
		except Exception as error:
			raise WorkerError(
				"semantic_application_failed",
				f"Could not lay out composite '{composite['name']}': {error}",
			) from error


def populate_composite(data_type_parser: Any, composite_type: Any, composite: dict[str, Any]) -> None:
	"""Places each field where the analyst put it, never where Ghidra inferred.

	A struct's field goes at its authored offset. A union's members all overlay
	the start, so each is appended and the offset — already required to be 0 —
	is not an address to place it at.
	"""
	is_union = composite["kind"] == "union"
	for field in composite["fields"]:
		field_type = data_type_parser.parse(field["type"])
		length = int(field_type.getLength())
		if length <= 0:
			raise WorkerError(
				"semantic_application_failed",
				f"Field '{field['name']}' of composite '{composite['name']}' has no fixed storage length.",
			)
		# For a union this bounds the member against the declared size, which is
		# the same claim as for a struct: nothing the analyst described may run
		# past what they said the type occupies.
		if field["offset"] + length > composite["size"]:
			raise WorkerError(
				"semantic_application_failed",
				f"Field '{field['name']}' of composite '{composite['name']}' runs past its declared size of {composite['size']} bytes.",
			)
		if is_union:
			composite_type.add(field_type, length, field["name"], None)
		else:
			composite_type.replaceAtOffset(field["offset"], field_type, length, field["name"], None)


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
		if method == "analyzeTarget":
			return self._driver.analyze_target(request_id, params)
		if method == "listFunctions":
			return self._driver.list_functions(params)
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


def required_semantics(params: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
	value = params.get("semantics")
	if not isinstance(value, dict):
		raise WorkerError("invalid_params", "semantics must be a versioned semantic snapshot object.")
	schema_version = value.get("schemaVersion")
	# Version 1 is accepted alongside version 2 because it is exactly version 2
	# with no composites: a snapshot saved before composites existed still
	# describes its whole type model, so honoring it can only decompile against
	# what the analyst actually accepted. A version 1 payload carrying composites
	# is refused all the same — that sender is confused about its own shape.
	keys = SEMANTICS_SCHEMA_KEYS.get(schema_version) if not isinstance(schema_version, bool) else None
	if keys is None:
		versions = ", ".join(str(version) for version in sorted(SEMANTICS_SCHEMA_KEYS))
		raise WorkerError("invalid_params", f"semantics.schemaVersion must be one of {versions}.")
	if set(value) != set(keys):
		names = ", ".join(sorted(keys - {"schemaVersion"}))
		raise WorkerError("invalid_params", f"semantics at schemaVersion {schema_version} must contain exactly schemaVersion and {names}.")
	return {
		"composites": required_semantic_composites(value.get("composites", []), "semantics.composites"),
		"dataTypes": required_semantic_declarations(value.get("dataTypes"), "semantics.dataTypes"),
		"functionPrototypes": required_semantic_declarations(value.get("functionPrototypes"), "semantics.functionPrototypes"),
	}


def required_semantic_declarations(value: Any, path: str) -> list[dict[str, Any]]:
	if not isinstance(value, list) or len(value) > MAX_SEMANTIC_DECLARATIONS:
		raise WorkerError("invalid_params", f"{path} must be an array with at most {MAX_SEMANTIC_DECLARATIONS} entries.")
	result: list[dict[str, Any]] = []
	previous_rva = -1
	for index, entry in enumerate(value):
		entry_path = f"{path}[{index}]"
		if not isinstance(entry, dict) or set(entry) != {"rva", "declaration"}:
			raise WorkerError("invalid_params", f"{entry_path} must contain exactly rva and declaration.")
		rva = required_rva(entry, "rva")
		declaration = entry.get("declaration")
		if not isinstance(declaration, str) or not declaration or len(declaration) > MAX_DECLARATION_CHARACTERS:
			raise WorkerError(
				"invalid_params",
				f"{entry_path}.declaration must be a non-empty string no longer than {MAX_DECLARATION_CHARACTERS} characters.",
			)
		if rva <= previous_rva:
			raise WorkerError("invalid_params", f"{path} must contain unique declarations in ascending RVA order.")
		result.append({"rva": rva, "declaration": declaration})
		previous_rva = rva
	return result


def required_semantic_composites(value: Any, path: str) -> list[dict[str, Any]]:
	if not isinstance(value, list) or len(value) > MAX_SEMANTIC_COMPOSITES:
		raise WorkerError("invalid_params", f"{path} must be an array with at most {MAX_SEMANTIC_COMPOSITES} entries.")
	result: list[dict[str, Any]] = []
	previous_name = ""
	for index, entry in enumerate(value):
		entry_path = f"{path}[{index}]"
		if not isinstance(entry, dict):
			raise WorkerError("invalid_params", f"{entry_path} must be an object.")
		# The kind is read before its shape is checked, so a kind this worker
		# does not implement is refused by name rather than by a key-set message
		# that reads like the sender got the spelling wrong.
		kind = entry.get("kind")
		if kind not in COMPOSITE_KINDS:
			kinds = ", ".join(COMPOSITE_KINDS)
			raise WorkerError("invalid_params", f"{entry_path}.kind must be one of {kinds}.")
		members_key = "members" if kind == "enum" else "fields"
		if set(entry) != {"name", "kind", "size", members_key}:
			raise WorkerError("invalid_params", f"{entry_path} must contain exactly name, kind, size and {members_key}.")
		name = required_identifier(entry, "name", entry_path)
		size = entry.get("size")
		if kind == "enum":
			if size not in ENUM_SIZES or isinstance(size, bool):
				sizes = ", ".join(str(value) for value in ENUM_SIZES)
				raise WorkerError("invalid_params", f"{entry_path}.size must be one of {sizes} bytes for an enum.")
		elif not isinstance(size, int) or isinstance(size, bool) or size <= 0 or size > MAX_COMPOSITE_SIZE_BYTES:
			raise WorkerError(
				"invalid_params",
				f"{entry_path}.size must be a positive integer no larger than {MAX_COMPOSITE_SIZE_BYTES} bytes.",
			)
		if name <= previous_name:
			raise WorkerError("invalid_params", f"{path} must contain unique composites in ascending name order.")
		composite = {"name": name, "kind": kind, "size": size}
		if kind == "enum":
			composite["members"] = required_enum_members(entry.get("members"), f"{entry_path}.members", size)
		else:
			composite["fields"] = required_composite_fields(entry.get("fields"), f"{entry_path}.fields", size, kind)
		result.append(composite)
		previous_name = name
	return result


def required_enum_members(value: Any, path: str, size: int) -> list[dict[str, Any]]:
	"""Validates one enum's members.

	Names are unique and ascending, which is what makes the snapshot canonical
	and therefore what makes its digest stable. Values may repeat: an alias for
	an existing constant is a real thing a header does, and refusing it would
	refuse the binary rather than the mistake.
	"""
	if not isinstance(value, list) or len(value) > MAX_ENUM_MEMBERS:
		raise WorkerError("invalid_params", f"{path} must be an array with at most {MAX_ENUM_MEMBERS} entries.")
	limit = 1 << (size * 8)
	result: list[dict[str, Any]] = []
	previous_name = ""
	for index, entry in enumerate(value):
		entry_path = f"{path}[{index}]"
		if not isinstance(entry, dict) or set(entry) != {"name", "value"}:
			raise WorkerError("invalid_params", f"{entry_path} must contain exactly name and value.")
		name = required_identifier(entry, "name", entry_path)
		if name <= previous_name:
			raise WorkerError("invalid_params", f"{path} must contain unique members in ascending name order.")
		member_value = entry.get("value")
		if not isinstance(member_value, int) or isinstance(member_value, bool):
			raise WorkerError("invalid_params", f"{entry_path}.value must be an integer.")
		# Accepts either signedness, because a constant written as -1 and one
		# written as 0xFFFFFFFF are the same bits and headers use both.
		if member_value >= limit or member_value < -(limit >> 1):
			raise WorkerError(
				"invalid_params",
				f"{entry_path}.value does not fit in the declared {size} bytes.",
			)
		result.append({"name": name, "value": member_value})
		previous_name = name
	return result


def required_composite_fields(value: Any, path: str, size: int, kind: str) -> list[dict[str, Any]]:
	"""Validates one composite's fields against the layout rule for its kind.

	A struct's fields occupy distinct ascending offsets. A union's all begin at
	zero — that is what a union *is*. The offset stays in the payload for a union
	rather than being dropped, and is required to be 0, so a sender that believes
	a member sits at offset 8 is refused rather than silently relocated to 0.
	"""
	if not isinstance(value, list) or len(value) > MAX_COMPOSITE_FIELDS:
		raise WorkerError("invalid_params", f"{path} must be an array with at most {MAX_COMPOSITE_FIELDS} entries.")
	result: list[dict[str, Any]] = []
	names: set[str] = set()
	previous_offset = -1
	for index, entry in enumerate(value):
		entry_path = f"{path}[{index}]"
		if not isinstance(entry, dict) or set(entry) != {"offset", "name", "type"}:
			raise WorkerError("invalid_params", f"{entry_path} must contain exactly offset, name and type.")
		offset = entry.get("offset")
		if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0 or offset >= size:
			raise WorkerError(
				"invalid_params",
				f"{entry_path}.offset must be a non-negative integer below the composite size of {size} bytes.",
			)
		if kind == "union":
			if offset != 0:
				raise WorkerError(
					"invalid_params",
					f"{entry_path}.offset must be 0: every member of a union begins at the start of it.",
				)
		elif offset <= previous_offset:
			raise WorkerError("invalid_params", f"{path} must contain unique fields in ascending offset order.")
		name = required_identifier(entry, "name", entry_path)
		if name in names:
			raise WorkerError("invalid_params", f"{path} must contain unique field names.")
		declaration = entry.get("type")
		if not isinstance(declaration, str) or not declaration or len(declaration) > MAX_DECLARATION_CHARACTERS:
			raise WorkerError(
				"invalid_params",
				f"{entry_path}.type must be a non-empty string no longer than {MAX_DECLARATION_CHARACTERS} characters.",
			)
		result.append({"offset": offset, "name": name, "type": declaration})
		names.add(name)
		previous_offset = offset
	return result


def required_identifier(entry: dict[str, Any], name: str, path: str) -> str:
	value = entry.get(name)
	if not isinstance(value, str) or len(value) > MAX_DECLARATION_CHARACTERS or not IDENTIFIER_PATTERN.match(value):
		raise WorkerError("invalid_params", f"{path}.{name} must be a C identifier no longer than {MAX_DECLARATION_CHARACTERS} characters.")
	return value


def sha256_file(path: Path) -> str:
	digest = hashlib.sha256()
	with path.open("rb") as stream:
		for chunk in iter(lambda: stream.read(1024 * 1024), b""):
			digest.update(chunk)
	return digest.hexdigest()


def program_is_analyzed(program: Any) -> bool:
	"""Whether Ghidra's auto-analysis has run to completion on this program.

	Ghidra records this as the `Analyzed` program-info option. A program that
	does not say so is one whose function list is still being discovered, and
	treating that as a complete answer is how a partial import gets reported as
	the backend disagreeing.
	"""
	try:
		options = program.getOptions("Program Information")
		return bool(options.getBoolean("Analyzed", False))
	except Exception:
		# Unable to tell, so claim the weaker thing. An unanalyzed program
		# reported as analyzed produces confident nonsense; the reverse only
		# declines to answer.
		return False


def mark_program_analyzed(program: Any) -> None:
	"""Records that auto-analysis has run, the way Ghidra's own tooling does.

	`analyzeAll` does not set the flag itself — the GUI sets it after the
	analysis task finishes. Without it every later `analyzeTarget` would run the
	whole analysis again on a program that is already complete.
	"""
	try:
		options = program.getOptions("Program Information")
		options.setBoolean("Analyzed", True)
	except Exception:
		# The flag is an optimisation; failing to set it costs a repeat analysis,
		# not correctness. `program_is_analyzed` still reads whatever is there.
		pass


def encode_rva(value: int) -> str:
	return f"0x{value:x}"


def normalize_generated_function_names(text: str, image_base: int) -> str:
	"""Convert Ghidra's absolute generated names to Delver's stable RVA placeholders.

	Two forms arrive and they make different claims. `FUN_<absolute>` is a
	function Ghidra recovered and did not name, and becomes `SUB_<rva>`.
	`func_0x<absolute>` is a call target Ghidra recovered *no* function at, and
	becomes `UNDEF_<rva>` — image-relative like everything else Delver renders,
	but deliberately not `SUB_`, because collapsing the two would present a
	non-function as a function (ADR 0017). Both spellings are owned by
	`platform/delver/common/naming.ts`; this worker must not invent a third.

	An address below the image base is not an RVA, so both forms are left alone.
	"""
	def rewrite(prefix: str):
		def replace(match: re.Match[str]) -> str:
			absolute_address = int(match.group(1), 16)
			if absolute_address < image_base:
				return match.group(0)
			return f"{prefix}{absolute_address - image_base:X}"

		return replace

	text = GHIDRA_GENERATED_FUNCTION_PATTERN.sub(rewrite("SUB_"), text)
	return GHIDRA_UNRECOVERED_FUNCTION_PATTERN.sub(rewrite("UNDEF_"), text)


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
