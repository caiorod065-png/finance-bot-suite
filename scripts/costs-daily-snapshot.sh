#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT_DIR/.env"
  set +a
fi

API_BASE_URL="${API_BASE_URL:-http://localhost:8080}"

if [[ -z "${ADMIN_TOKEN:-}" ]]; then
  echo "ADMIN_TOKEN ausente no .env"
  exit 1
fi

echo "[cost-snapshot] API: $API_BASE_URL"
RESULT="$(curl -sS -X POST "$API_BASE_URL/admin/costs/snapshots" -H "x-admin-token: $ADMIN_TOKEN")"
echo "[cost-snapshot] resposta: $RESULT"
