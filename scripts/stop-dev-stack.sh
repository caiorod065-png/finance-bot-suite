#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.runtime"

kill_by_pid_file() {
  local pid_file="$1"
  local label="$2"
  if [[ -f "${pid_file}" ]]; then
    local pid
    pid="$(cat "${pid_file}" || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
      kill "${pid}" >/dev/null 2>&1 || true
      echo "[ok] ${label} encerrado (${pid})."
    fi
    rm -f "${pid_file}"
  fi
}

kill_by_pid_file "${RUNTIME_DIR}/tunnel.pid" "Tunnel"
kill_by_pid_file "${RUNTIME_DIR}/admin.pid" "Admin"
kill_by_pid_file "${RUNTIME_DIR}/api.pid" "API"

# Fallback para processos órfãos.
pkill -f "cloudflared tunnel --url http://localhost:8080" >/dev/null 2>&1 || true
pkill -f "python3 -m http.server 8081" >/dev/null 2>&1 || true
pkill -f "tsx watch src/server.ts" >/dev/null 2>&1 || true

rm -f "${RUNTIME_DIR}/tunnel.url"

echo "[ok] Stack local parada."
