#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/deploy/docker-compose.vps.yml"
ENV_FILE="${ROOT_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[erro] .env não encontrado em ${ROOT_DIR}"
  echo "Crie com: cp .env.example .env"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

required_vars=(
  PUBLIC_DOMAIN
  LETSENCRYPT_EMAIL
  POSTGRES_DB
  POSTGRES_USER
  POSTGRES_PASSWORD
  DATABASE_URL_VPS
  ADMIN_TOKEN
  ADMIN_EMAIL
  ADMIN_PASSWORD
  ADMIN_JWT_SECRET
  TWILIO_ACCOUNT_SID
  TWILIO_AUTH_TOKEN
  TWILIO_WHATSAPP_FROM
)

for var in "${required_vars[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    echo "[erro] Variável obrigatória ausente no .env: ${var}"
    exit 1
  fi
done

echo "[1/4] Subindo stack..."
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --build

echo "[2/4] Aguardando Postgres ficar saudável..."
for _ in {1..60}; do
  if docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
    pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
  pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1; then
  echo "[erro] Postgres não ficou pronto a tempo."
  exit 1
fi

echo "[3/4] Aplicando migrations..."
for file in "${ROOT_DIR}"/infra/migrations/*.sql; do
  echo " - $(basename "${file}")"
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" < "${file}"
done

echo "[4/4] Smoke test..."
curl -fsS "https://${PUBLIC_DOMAIN}/health" >/dev/null

echo
echo "[ok] Deploy concluído."
echo "Painel: https://${PUBLIC_DOMAIN}"
echo "Webhook Twilio Sandbox/Prod (POST): https://${PUBLIC_DOMAIN}/webhooks/whatsapp/twilio"
echo "Webhook Meta Cloud API: https://${PUBLIC_DOMAIN}/webhooks/whatsapp"
