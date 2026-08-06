#!/usr/bin/env bash
# Pre-commit hook for Delver changes.
# Install: cp scripts/delver-pre-commit.sh .git/hooks/pre-commit
set -euo pipefail

DELVER_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^(delver/|src/vs/.*/delver/|build/lib/delver/|\.eslint-plugin-local/delver-)' || true)

if [ -z "$DELVER_FILES" ]; then
	exit 0
fi

echo "[delver pre-commit] checking Delver changes..."

cd delver
cargo fmt --check
cargo clippy -- -D warnings
cargo test
cd ..

# Run ESLint on touched Delver TypeScript files.
TS_FILES=$(echo "$DELVER_FILES" | grep '\.ts$' || true)
if [ -n "$TS_FILES" ]; then
	npx eslint $TS_FILES
fi
