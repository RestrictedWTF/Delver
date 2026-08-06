use std::fs;
use std::path::PathBuf;

use schemars::schema_for;

use delver_protocol::{Request, Response};

fn main() -> Result<(), Box<dyn std::error::Error>> {
	let request_schema = schema_for!(Request);
	let response_schema = schema_for!(Response);

	let combined = serde_json::json!({
		"$schema": "http://json-schema.org/draft-07/schema#",
		"title": "Delver Protocol v0",
		"description": "Request and response messages for the Delver provider protocol.",
		"oneOf": [
			request_schema,
			response_schema,
		]
	});

	let out_dir = PathBuf::from("schema");
	fs::create_dir_all(&out_dir)?;
	let out_path = out_dir.join("protocol.schema.json");
	fs::write(&out_path, serde_json::to_string_pretty(&combined)?)?;

	println!("Wrote {}", out_path.display());
	Ok(())
}
