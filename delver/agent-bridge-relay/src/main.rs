//! Process boundary between the Delver bridge extension and an owner-only
//! local named pipe or Unix socket.

#![forbid(unsafe_code)]

use std::io::{self, Write};

use anyhow::Result;
use clap::Parser;
use delver_agent_relay::{
	peer_control_record, relay_once, relay_once_with_peer, READY_SIGNAL,
	REGISTRY_DIRECTORY_READY_SIGNAL,
};
use delver_rpc::Listener;

#[derive(Parser, Debug)]
#[command(name = "delver-agent-relay")]
#[command(about = "Relays one owner-only Delver agent connection over stdio")]
#[command(group(clap::ArgGroup::new("mode").required(true).args(["endpoint", "prepare_registry_directory"])))]
struct Args {
	/// Named-pipe or Unix-socket endpoint to bind.
	#[arg(long)]
	endpoint: Option<String>,

	/// Emit one OS-derived peer identity control record after accept.
	#[arg(long, default_value_t = false, requires = "endpoint")]
	report_peer: bool,

	/// Create and audit the deterministic current-user registry directory, then exit.
	#[arg(long, default_value_t = false, conflicts_with_all = ["endpoint", "report_peer"])]
	prepare_registry_directory: bool,
}

fn main() -> Result<()> {
	let args = Args::parse();
	if args.prepare_registry_directory {
		prepare_registry_directory()?;
		eprintln!("{REGISTRY_DIRECTORY_READY_SIGNAL}");
		io::stderr().flush()?;
		return Ok(());
	}
	let endpoint = args
		.endpoint
		.ok_or_else(|| anyhow::anyhow!("exactly one relay mode is required"))?;
	let listener = Listener::bind(&endpoint)?;
	eprintln!("{READY_SIGNAL}");
	io::stderr().flush()?;
	if args.report_peer {
		relay_once_with_peer(&listener, io::stdin(), io::stdout(), |peer| {
			eprintln!("{}", peer_control_record(peer)?);
			io::stderr().flush()?;
			Ok(())
		})?;
	} else {
		relay_once(&listener, io::stdin(), io::stdout())?;
	}
	Ok(())
}

#[cfg(windows)]
fn prepare_registry_directory() -> Result<()> {
	let local_app_data = std::env::var_os("LOCALAPPDATA")
		.ok_or_else(|| anyhow::anyhow!("the per-user registry location is unavailable"))?;
	let directory = std::path::PathBuf::from(local_app_data)
		.join("Delver")
		.join("agent-rendezvous")
		.join("v1")
		.join("entries");
	delver_rpc::ensure_private_directory(&directory)?;
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn relay_and_registry_modes_are_exactly_one() {
		assert!(Args::try_parse_from(["relay", "--endpoint", "pipe://test"]).is_ok());
		assert!(
			Args::try_parse_from(["relay", "--endpoint", "pipe://test", "--report-peer"]).is_ok()
		);
		assert!(Args::try_parse_from(["relay", "--prepare-registry-directory"]).is_ok());
		assert!(Args::try_parse_from(["relay"]).is_err());
		assert!(Args::try_parse_from([
			"relay",
			"--endpoint",
			"pipe://test",
			"--prepare-registry-directory",
		])
		.is_err());
		assert!(
			Args::try_parse_from(["relay", "--prepare-registry-directory", "--report-peer"])
				.is_err()
		);
	}
}

#[cfg(not(windows))]
fn prepare_registry_directory() -> Result<()> {
	Err(anyhow::anyhow!(
		"native registry directory preparation is only supported on Windows"
	))
}
