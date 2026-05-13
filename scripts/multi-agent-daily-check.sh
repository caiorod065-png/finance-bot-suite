#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/Users/felipegrigolettiguarde/Projects/finance-bot-suite"
API_DIR="$ROOT_DIR/apps/api"

echo "[1/5] Testes da API"
cd "$API_DIR"
npm test >/tmp/finance-api-test.log 2>&1 || {
  echo "Falha em testes. Veja: /tmp/finance-api-test.log"
  exit 1
}

echo "[2/5] Build da API"
npm run build >/tmp/finance-api-build.log 2>&1 || {
  echo "Falha em build. Veja: /tmp/finance-api-build.log"
  exit 1
}

echo "[3/5] Status stack local"
cd "$ROOT_DIR"
./scripts/status-dev-stack.sh || true

echo "[4/5] Erros recentes Twilio (local)"
./scripts/twilio-last-errors.sh || true

echo "[5/5] Check rápido de docs multiagente"
test -f "$ROOT_DIR/docs/multi-agent-ops.md" && echo "OK: docs/multi-agent-ops.md"

echo "Concluído: rotina diária multiagente."
