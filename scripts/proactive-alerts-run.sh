#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Arquivo .env não encontrado em ${ROOT_DIR}" >&2
  exit 1
fi

API_BASE_URL="${API_BASE_URL:-http://localhost:8080}"
ADMIN_TOKEN_VALUE="${ADMIN_TOKEN:-$(grep -E '^ADMIN_TOKEN=' "${ENV_FILE}" | head -n1 | cut -d= -f2-)}"
DRY_RUN="${DRY_RUN:-false}"
CUSTOMER_LIMIT="${CUSTOMER_LIMIT:-1000}"

if [[ -z "${ADMIN_TOKEN_VALUE}" ]]; then
  echo "ADMIN_TOKEN ausente. Defina no .env ou exporte ADMIN_TOKEN." >&2
  exit 1
fi

curl -fsS -X POST "${API_BASE_URL}/admin/automation/proactive/run" \
  -H "x-admin-token: ${ADMIN_TOKEN_VALUE}" \
  -H "Content-Type: application/json" \
  -d "{\"dryRun\": ${DRY_RUN}, \"customerLimit\": ${CUSTOMER_LIMIT}}"

