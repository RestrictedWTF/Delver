/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Delver's temporary P2a Ghidra 12.1 bridge. This script must be deleted when P2b ships.
// @category Delver

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.List;

import ghidra.app.decompiler.ClangLine;
import ghidra.app.decompiler.ClangToken;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.app.decompiler.PrettyPrinter;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.pcode.HighSymbol;

public class DelverDecompile extends GhidraScript {
	private static final int SCHEMA_VERSION = 1;
	private static final int DECOMPILE_TIMEOUT_SECONDS = 60;

	private record RvaRange(long start, long end) { }

	@Override
	public void run() throws Exception {
		String[] arguments = getScriptArgs();
		if (arguments.length != 2) {
			throw new IllegalArgumentException("Expected <function-rva> <output-path>");
		}

		long functionRva = parseRva(arguments[0]);
		Address functionAddress = currentProgram.getImageBase().add(functionRva);
		Function function = currentProgram.getFunctionManager().getFunctionAt(functionAddress);
		if (function == null) {
			disassemble(functionAddress);
			function = createFunction(functionAddress, null);
		}
		if (function == null) {
			Function containing = currentProgram.getFunctionManager().getFunctionContaining(functionAddress);
			if (containing != null) {
				long containingRva = containing.getEntryPoint().subtract(currentProgram.getImageBase());
				throw new IllegalArgumentException(
					"Ghidra considers RVA " + encodeRva(functionRva) + " part of the function at "
						+ encodeRva(containingRva) + " instead of a distinct function."
				);
			}
			throw new IllegalArgumentException("Ghidra could not find or create a function at RVA " + encodeRva(functionRva));
		}

		DecompInterface decompiler = new DecompInterface();
		try {
			DecompileOptions options = new DecompileOptions();
			options.grabFromProgram(currentProgram);
			decompiler.setOptions(options);
			decompiler.toggleCCode(true);
			decompiler.toggleSyntaxTree(true);
			decompiler.setSimplificationStyle("decompile");
			if (!decompiler.openProgram(currentProgram)) {
				throw new IOException("Could not open program in decompiler: " + decompiler.getLastMessage());
			}

			DecompileResults results = decompiler.decompileFunction(function, DECOMPILE_TIMEOUT_SECONDS, monitor);
			if (!results.decompileCompleted()) {
				throw new IOException("Could not decompile function: " + results.getErrorMessage());
			}

			PrettyPrinter printer = new PrettyPrinter(function, results.getCCodeMarkup(), options.getNameTransformer());
			DecompiledFunction decompiled = printer.print();
			writeOutput(
				Path.of(arguments[1]),
				functionRva,
				decompiled.getC(),
				printer.getLines(),
				results.getHighFunction().getLocalSymbolMap().getSymbols()
			);
		}
		finally {
			decompiler.dispose();
		}
	}

	private long parseRva(String value) {
		if (!value.matches("0x(?:0|[1-9a-f][0-9a-f]*)")) {
			throw new IllegalArgumentException("RVA must be canonical lowercase hexadecimal");
		}
		return Long.parseUnsignedLong(value.substring(2), 16);
	}

	private void writeOutput(Path outputPath, long functionRva, String text, List<ClangLine> lines, Iterator<HighSymbol> variables) throws IOException {
		try (BufferedWriter writer = Files.newBufferedWriter(outputPath, StandardCharsets.UTF_8)) {
			writer.write("{\"schemaVersion\":");
			writer.write(Integer.toString(SCHEMA_VERSION));
			writer.write(",\"functionRva\":");
			writeString(writer, encodeRva(functionRva));
			writer.write(",\"text\":");
			writeString(writer, text);
			writer.write(",\"lineMappings\":[");
			boolean firstMapping = true;
			for (int lineIndex = 0; lineIndex < lines.size(); lineIndex++) {
				List<RvaRange> ranges = rangesForLine(lines.get(lineIndex));
				if (ranges.isEmpty()) {
					continue;
				}
				if (!firstMapping) {
					writer.write(',');
				}
				firstMapping = false;
				writer.write("{\"line\":");
				writer.write(Integer.toString(lines.get(lineIndex).getLineNumber()));
				writer.write(",\"ranges\":[");
				for (int rangeIndex = 0; rangeIndex < ranges.size(); rangeIndex++) {
					if (rangeIndex > 0) {
						writer.write(',');
					}
					RvaRange range = ranges.get(rangeIndex);
					writer.write("{\"startRva\":");
					writeString(writer, encodeRva(range.start()));
					writer.write(",\"endRva\":");
					writeString(writer, encodeRva(range.end()));
					writer.write('}');
				}
				writer.write("]}");
			}
			writer.write("],\"variables\":[");
			boolean firstVariable = true;
			while (variables.hasNext()) {
				if (!firstVariable) {
					writer.write(',');
				}
				firstVariable = false;
				HighSymbol variable = variables.next();
				writer.write("{\"name\":");
				writeString(writer, variable.getName());
				writer.write(",\"typeName\":");
				writeString(writer, variable.getDataType().getDisplayName());
				writer.write(",\"storage\":");
				writeString(writer, variable.getStorage().toString());
				writer.write('}');
			}
			writer.write("]}");
		}
	}

	private List<RvaRange> rangesForLine(ClangLine line) {
		List<RvaRange> ranges = new ArrayList<>();
		for (int tokenIndex = 0; tokenIndex < line.getNumTokens(); tokenIndex++) {
			ClangToken token = line.getToken(tokenIndex);
			Address minimum = token.getMinAddress();
			Address maximum = token.getMaxAddress();
			if (minimum == null || maximum == null) {
				continue;
			}
			long start = minimum.subtract(currentProgram.getImageBase());
			long end = maximum.subtract(currentProgram.getImageBase()) + 1;
			if (Long.compareUnsigned(start, end) < 0) {
				ranges.add(new RvaRange(start, end));
			}
		}

		ranges.sort(Comparator.comparing(RvaRange::start, Long::compareUnsigned));
		List<RvaRange> merged = new ArrayList<>();
		for (RvaRange range : ranges) {
			if (merged.isEmpty()) {
				merged.add(range);
				continue;
			}
			RvaRange previous = merged.get(merged.size() - 1);
			if (Long.compareUnsigned(range.start(), previous.end()) <= 0) {
				long end = Long.compareUnsigned(range.end(), previous.end()) > 0 ? range.end() : previous.end();
				merged.set(merged.size() - 1, new RvaRange(previous.start(), end));
			}
			else {
				merged.add(range);
			}
		}
		return merged;
	}

	private String encodeRva(long rva) {
		return "0x" + Long.toUnsignedString(rva, 16);
	}

	private void writeString(BufferedWriter writer, String value) throws IOException {
		writer.write('"');
		for (int index = 0; index < value.length(); index++) {
			char character = value.charAt(index);
			switch (character) {
				case '"' -> writer.write("\\\"");
				case '\\' -> writer.write("\\\\");
				case '\b' -> writer.write("\\b");
				case '\f' -> writer.write("\\f");
				case '\n' -> writer.write("\\n");
				case '\r' -> writer.write("\\r");
				case '\t' -> writer.write("\\t");
				default -> {
					if (character < 0x20) {
						writer.write(String.format("\\u%04x", (int)character));
					}
					else {
						writer.write(character);
					}
				}
			}
		}
		writer.write('"');
	}
}
