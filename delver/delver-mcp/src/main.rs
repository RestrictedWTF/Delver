// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

use std::io::{self, BufReader};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use clap::Parser;
use delver_mcp::backend::DelverBackend;
use delver_mcp::{McpServer, NdjsonWriter};

#[derive(Debug, Parser)]
#[command(
	name = "delver-mcp",
	version,
	about = "Expose one local Delver window through MCP"
)]
struct Args {
	/// The explicit local workspace root opened by the intended Delver window.
	#[arg(long)]
	root: PathBuf,
	/// Untrusted display label shown in Delver's one-time approval prompt.
	#[arg(long, default_value = "Delver MCP")]
	display_name: String,
}

fn main() -> ExitCode {
	match run() {
		Ok(()) => ExitCode::SUCCESS,
		Err(()) => {
			eprintln!("delver-mcp: the adapter stopped safely");
			ExitCode::FAILURE
		}
	}
}

fn run() -> Result<(), ()> {
	let args = Args::try_parse().map_err(|error| {
		let _ = error.print();
	})?;
	let backend = DelverBackend::new(&args.root, args.display_name).map_err(|_| ())?;
	let input = BufReader::new(io::stdin());
	let output = Arc::new(NdjsonWriter::new(io::stdout()));
	McpServer::new(backend).run(input, output).map_err(|_| ())
}
