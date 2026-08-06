//! Hex-string serialization for `u64` addresses, lengths, and offsets.
//!
//! JSON numbers are IEEE 754 doubles and silently truncate integers above 2^53.
//! Every address-like value crosses the wire as a `"0x..."` string instead.

use serde::{de::Error, Deserialize, Deserializer, Serializer};

/// Serializes a `u64` as an uppercase `0x` hex string.
pub fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
	S: Serializer,
{
	serializer.serialize_str(&format!("0x{:X}", value))
}

/// Deserializes a `u64` from an uppercase or lowercase `0x` hex string.
pub fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
	D: Deserializer<'de>,
{
	let s = String::deserialize(deserializer)?;
	parse(&s).map_err(D::Error::custom)
}

/// Parses a `0x...` hex string into a `u64`.
pub fn parse(s: &str) -> Result<u64, String> {
	let digits = s
		.strip_prefix("0x")
		.ok_or_else(|| format!("hex string must start with '0x', got: {s}"))?;
	u64::from_str_radix(digits, 16).map_err(|e| format!("invalid hex string '{s}': {e}"))
}

/// Serializes an `Option<u64>` as an optional `0x` hex string.
pub mod option {
	use super::*;

	/// Serializes an optional `u64` as an optional `"0x..."` string.
	pub fn serialize<S>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: Serializer,
	{
		match value {
			Some(v) => super::serialize(v, serializer),
			None => serializer.serialize_none(),
		}
	}

	/// Deserializes an optional `u64` from an optional `"0x..."` string.
	pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
	where
		D: Deserializer<'de>,
	{
		let maybe = Option::<String>::deserialize(deserializer)?;
		maybe
			.as_deref()
			.map(parse)
			.transpose()
			.map_err(D::Error::custom)
	}
}

/// Serializes a `Vec<u64>` as an array of `0x` hex strings.
pub mod vec {
	use super::*;

	/// Serializes each element as a `"0x..."` string.
	pub fn serialize<S>(value: &Vec<u64>, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: Serializer,
	{
		use serde::ser::SerializeSeq;
		let mut seq = serializer.serialize_seq(Some(value.len()))?;
		for v in value {
			seq.serialize_element(&format!("0x{:X}", v))?;
		}
		seq.end()
	}

	/// Deserializes each element from a `"0x..."` string.
	pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u64>, D::Error>
	where
		D: Deserializer<'de>,
	{
		let raw = Vec::<String>::deserialize(deserializer)?;
		raw.iter()
			.map(|s| parse(s))
			.collect::<Result<Vec<_>, _>>()
			.map_err(D::Error::custom)
	}
}

#[cfg(test)]
mod tests {
	use serde::{Deserialize, Serialize};

	#[derive(Serialize, Deserialize, Debug, PartialEq)]
	struct Wrapper {
		#[serde(with = "crate::hex")]
		addr: u64,
	}

	#[derive(Serialize, Deserialize, Debug, PartialEq)]
	struct VecWrapper {
		#[serde(with = "crate::hex::vec")]
		addrs: Vec<u64>,
	}

	#[test]
	fn vec_round_trips_above_2_53() {
		let value = VecWrapper {
			addrs: vec![0, 0x7FFFFFFFFFFFFFFF],
		};
		let json = serde_json::to_string(&value).unwrap();
		assert_eq!(json, r#"{"addrs":["0x0","0x7FFFFFFFFFFFFFFF"]}"#);
		let back: VecWrapper = serde_json::from_str(&json).unwrap();
		assert_eq!(back, value);
	}

	#[test]
	fn round_trip_max_u64() {
		let value = Wrapper {
			addr: 0x7FFFFFFFFFFFFFFF,
		};
		let json = serde_json::to_string(&value).unwrap();
		assert_eq!(json, r#"{"addr":"0x7FFFFFFFFFFFFFFF"}"#);
		let back: Wrapper = serde_json::from_str(&json).unwrap();
		assert_eq!(back, value);
	}

	#[test]
	fn lowercase_input_accepted() {
		let back: Wrapper = serde_json::from_str(r#"{"addr":"0xabcdef"}"#).unwrap();
		assert_eq!(back.addr, 0xABCDEF);
	}

	#[test]
	fn missing_prefix_rejected() {
		let result: Result<Wrapper, _> = serde_json::from_str(r#"{"addr":"1234"}"#);
		assert!(result.is_err());
	}
}
