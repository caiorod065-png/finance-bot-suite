#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
URL_FILE="${RUNTIME_DIR}/tunnel.url"
LOG_DIR="${RUNTIME_DIR}/logs"

check_port() {
  local port="$1"
  if lsof -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "UP"
  else
    echo "DOWN"
  fi
}

echo "API (8080): $(check_port 8080)"
echo "ADMIN (8081): $(check_port 8081)"

if pgrep -f "cloudflared tunnel --url http://localhost:8080" >/dev/null 2>&1; then
  echo "TUNNEL: UP"
else
  echo "TUNNEL: DOWN"
fi

if [[ -f "${URL_FILE}" ]]; then
  URL="$(cat "${URL_FILE}" || true)"
  echo "TUNNEL_URL: ${URL}"
  if [[ -n "${URL}" ]]; then
    if curl -fsS "${URL}/health" >/dev/null 2>&1; then
      echo "TUNNEL_HEALTH: OK"
    else
      echo "TUNNEL_HEALTH: FAIL"
    fi
  fi
fi

echo
echo "Logs:"
echo "- API: ${LOG_DIR}/api.log"
echo "- Admin: ${LOG_DIR}/admin.log"
echo "- Tunnel: ${LOG_DIR}/tunnel.log"
