#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT_DIR/.env"
  set +a
fi

export API_BASE_URL="${API_BASE_URL:-http://localhost:8080}"
export SANDBOX_NAME="${SANDBOX_NAME:-Cliente Sandbox}"

node "$ROOT_DIR/scripts/sandbox-local-test.mjs"
