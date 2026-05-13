#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/deploy/docker-compose.vps.yml"
ENV_FILE="${ROOT_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" ps
echo
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" logs --tail=80 api caddy
echo
if [[ -n "${PUBLIC_DOMAIN:-}" ]]; then
  echo "[health] https://${PUBLIC_DOMAIN}/health"
  curl -sS "https://${PUBLIC_DOMAIN}/health" || true
  echo
fi
