# ---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------

from __future__ import annotations

import io
import json
from pathlib import Path
import sys
import unittest


sys.path.insert(0, str(Path(__file__).parent))

from delver_decompiler_worker import MAX_COMPOSITE_FIELDS, MAX_SEMANTIC_COMPOSITES, PROTOCOL_VERSION, WorkerError, WorkerServer, normalize_generated_function_names, parse_request, print_decompiled, required_rva, required_semantics, resolve_function


class FakeDriver:
	def __init__(self) -> None:
		self.cancelled: list[str] = []

	def hello(self) -> dict[str, object]:
		return {"protocolVersion": PROTOCOL_VERSION, "backend": {"id": "fake"}}

	def open_target(self, request_id: str, params: dict[str, object]) -> dict[str, object]:
		return {"targetId": params["targetId"]}

	def decompile_function(self, request_id: str, params: dict[str, object]) -> dict[str, object]:
		return {"schemaVersion": 1, "functionRva": params["functionRva"]}

	def close_target(self, params: dict[str, object]) -> dict[str, object]:
		return {"targetId": params["targetId"]}

	def cancel(self, request_id: str) -> bool:
		self.cancelled.append(request_id)
		return False


class ProtocolTests(unittest.TestCase):
	def test_generated_function_names_use_image_relative_delver_names(self) -> None:
		self.assertEqual(
			normalize_generated_function_names(
				"void FUN_140001080(void) { FUN_140002000(); }\nvoid meaningful_name(void);",
				0x140000000,
			),
			"void SUB_1080(void) { SUB_2000(); }\nvoid meaningful_name(void);",
		)

	def test_generated_function_name_before_image_base_is_left_untouched(self) -> None:
		self.assertEqual(normalize_generated_function_names("FUN_1000();", 0x140000000), "FUN_1000();")

	def test_distinct_entry_never_reuses_a_containing_function(self) -> None:
		class Address:
			def subtract(self, _other: object) -> int:
				return 0x1000

		class ContainingFunction:
			def getEntryPoint(self) -> Address:
				return Address()

		class Manager:
			def getFunctionAt(self, _address: object) -> None:
				return None

			def getFunctionContaining(self, _address: object) -> ContainingFunction:
				return ContainingFunction()

		class Program:
			def getFunctionManager(self) -> Manager:
				return Manager()

			def getImageBase(self) -> object:
				return object()

		class FlatApi:
			def disassemble(self, _address: object) -> None:
				return None

			def createFunction(self, _address: object, _name: object) -> None:
				return None

		class FakeTarget:
			program = Program()
			flat_api = FlatApi()

		with self.assertRaisesRegex(WorkerError, "part of the function at 0x1000"):
			resolve_function(FakeTarget(), object(), 0x1080)  # type: ignore[arg-type]

	def test_pretty_printer_uses_jpype_keyword_alias(self) -> None:
		class FakePrinter:
			def print_(self) -> str:
				return "decompiled"

		self.assertEqual(print_decompiled(FakePrinter()), "decompiled")

	def test_parse_request(self) -> None:
		request = json.dumps({"protocolVersion": 1, "id": "7", "method": "hello", "params": {}})
		self.assertEqual(parse_request(request), ("7", "hello", {}))

	def test_parse_request_rejects_protocol_mismatch(self) -> None:
		with self.assertRaisesRegex(WorkerError, "protocolVersion must be 1"):
			parse_request('{"protocolVersion":2,"id":"7","method":"hello"}')

	def test_rva_is_canonical(self) -> None:
		self.assertEqual(required_rva({"functionRva": "0x1af"}, "functionRva"), 0x1AF)
		for value in ("1af", "0x01", "0x1AF", "0x"):
			with self.subTest(value=value), self.assertRaises(WorkerError):
				required_rva({"functionRva": value}, "functionRva")

	def test_semantics_are_canonical_bounded_and_sorted(self) -> None:
		self.assertEqual(required_semantics({
			"semantics": {
				"schemaVersion": 1,
				"dataTypes": [{"rva": "0x2000", "declaration": "uint32_t"}],
				"functionPrototypes": [{"rva": "0x1000", "declaration": "int entry(uint32_t flags)"}],
			},
		}), {
			"composites": [],
			"dataTypes": [{"rva": 0x2000, "declaration": "uint32_t"}],
			"functionPrototypes": [{"rva": 0x1000, "declaration": "int entry(uint32_t flags)"}],
		})
		invalid = (
			{},
			{"semantics": {"schemaVersion": 3, "dataTypes": [], "functionPrototypes": [], "composites": []}},
			{"semantics": {"schemaVersion": 2, "dataTypes": [], "functionPrototypes": []}},
			{"semantics": {"schemaVersion": 1, "dataTypes": [], "functionPrototypes": [], "composites": []}},
			{"semantics": {"schemaVersion": 1, "dataTypes": [{"rva": "0x10", "declaration": "int"}, {"rva": "0x10", "declaration": "char"}], "functionPrototypes": []}},
			{"semantics": {"schemaVersion": 1, "dataTypes": [], "functionPrototypes": [{"rva": "0x1000", "declaration": ""}]}},
		)
		for params in invalid:
			with self.subTest(params=params), self.assertRaises(WorkerError):
				required_semantics(params)

	def test_composites_are_identified_bounded_and_offset_ordered(self) -> None:
		self.assertEqual(required_semantics({
			"semantics": {
				"schemaVersion": 2,
				"composites": [
					{"name": "Config", "kind": "struct", "size": 24, "fields": [
						{"offset": 0, "name": "flags", "type": "uint32_t"},
						{"offset": 8, "name": "label", "type": "char[16]"},
					]},
					{"name": "Empty", "kind": "struct", "size": 4, "fields": []},
				],
				"dataTypes": [{"rva": "0x2000", "declaration": "Config"}],
				"functionPrototypes": [],
			},
		}), {
			"composites": [
				{"name": "Config", "kind": "struct", "size": 24, "fields": [
					{"offset": 0, "name": "flags", "type": "uint32_t"},
					{"offset": 8, "name": "label", "type": "char[16]"},
				]},
				{"name": "Empty", "kind": "struct", "size": 4, "fields": []},
			],
			"dataTypes": [{"rva": 0x2000, "declaration": "Config"}],
			"functionPrototypes": [],
		})
		one_field = [{"offset": 0, "name": "flags", "type": "uint32_t"}]
		invalid = (
			[{"name": "Zeta", "kind": "struct", "size": 4, "fields": []}, {"name": "Alpha", "kind": "struct", "size": 4, "fields": []}],
			[{"name": "Config", "kind": "struct", "size": 4, "fields": []}, {"name": "Config", "kind": "struct", "size": 8, "fields": []}],
			[{"name": "0Config", "kind": "struct", "size": 4, "fields": []}],
			[{"name": "Config", "kind": "union", "size": 4, "fields": []}],
			[{"name": "Config", "kind": "struct", "size": 0, "fields": []}],
			[{"name": "Config", "kind": "struct", "size": 2 * 1024 * 1024, "fields": []}],
			[{"name": "Config", "kind": "struct", "size": 24, "fields": one_field * 2}],
			[{"name": "Config", "kind": "struct", "size": 24, "fields": [
				{"offset": 8, "name": "label", "type": "char[16]"},
				{"offset": 0, "name": "flags", "type": "uint32_t"},
			]}],
			[{"name": "Config", "kind": "struct", "size": 24, "fields": [
				{"offset": 0, "name": "flags", "type": "uint32_t"},
				{"offset": 8, "name": "flags", "type": "uint32_t"},
			]}],
			[{"name": "Config", "kind": "struct", "size": 24, "fields": [{"offset": 24, "name": "past", "type": "uint32_t"}]}],
			[{"name": "Config", "kind": "struct", "size": 24, "fields": [{"offset": -1, "name": "before", "type": "uint32_t"}]}],
			[{"name": "Config", "kind": "struct", "size": 24, "fields": [{"offset": 0, "name": "flags", "type": ""}]}],
			[{"name": "Config", "kind": "struct", "size": 24, "fields": [{"offset": 0, "name": "flags"}]}],
			[{"name": "Config", "kind": "struct", "size": 4}],
			[{"name": "Config", "kind": "struct", "size": 4, "fields": [], "comment": "extra"}],
			[{"name": "Config", "kind": "struct", "size": 4, "fields": one_field * (MAX_COMPOSITE_FIELDS + 1)}],
			[{"name": f"Type{index:05}", "kind": "struct", "size": 4, "fields": []} for index in range(MAX_SEMANTIC_COMPOSITES + 1)],
		)
		for composites in invalid:
			params = {"semantics": {"schemaVersion": 2, "composites": composites, "dataTypes": [], "functionPrototypes": []}}
			with self.subTest(composites=composites[:2]), self.assertRaises(WorkerError):
				required_semantics(params)

	def test_server_writes_versioned_success_and_structured_error(self) -> None:
		input_stream = io.StringIO(
			'{"protocolVersion":1,"id":"1","method":"hello","params":{}}\n'
			'{"protocolVersion":1,"id":"2","method":"missing","params":{}}\n'
		)
		output = io.StringIO()
		WorkerServer(FakeDriver(), output).run(input_stream)
		responses = [json.loads(line) for line in output.getvalue().splitlines()]
		self.assertEqual(responses, [
			{"protocolVersion": 1, "id": "1", "result": {"protocolVersion": 1, "backend": {"id": "fake"}}},
			{"protocolVersion": 1, "id": "2", "error": {"code": "method_not_found", "message": "Unsupported method 'missing'."}},
		])


if __name__ == "__main__":
	unittest.main()
