#!/usr/bin/env bash
set -euo pipefail

CHECK_DIR="$(mktemp -d /tmp/dinodia-hive-lock-check.XXXXXX)"
trap 'rm -rf "$CHECK_DIR"' EXIT

python3 -m venv "$CHECK_DIR/venv"
"$CHECK_DIR/venv/bin/python" -m pip install --quiet --disable-pip-version-check --dry-run --require-hashes -r requirements-hive.lock
echo "Hive dependency lock is reproducible and hash-valid."
