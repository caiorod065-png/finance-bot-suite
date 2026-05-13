#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
LOG_DIR="${RUNTIME_DIR}/logs"
CF_HOME="${RUNTIME_DIR}/cloudflared-home"

API_DIR="${ROOT_DIR}/apps/api"
ADMIN_DIR="${ROOT_DIR}/apps/admin"

mkdir -p "${LOG_DIR}" "${CF_HOME}"

api_log="${LOG_DIR}/api.log"
admin_log="${LOG_DIR}/admin.log"
tunnel_log="${LOG_DIR}/tunnel.log"

api_pid_file="${RUNTIME_DIR}/api.pid"
admin_pid_file="${RUNTIME_DIR}/admin.pid"
tunnel_pid_file="${RUNTIME_DIR}/tunnel.pid"
tunnel_url_file="${RUNTIME_DIR}/tunnel.url"

is_listening() {
  local port="$1"
  lsof -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
}

start_api() {
  if is_listening 8080; then
    echo "[ok] API já está ouvindo na porta 8080."
    return
  fi

  echo "[info] Subindo API (8080)..."
  (
    cd "${API_DIR}"
    nohup npm run dev >"${api_log}" 2>&1 &
    echo $! >"${api_pid_file}"
  )

  for _ in {1..30}; do
    if curl -fsS http://localhost:8080/health >/dev/null 2>&1; then
      echo "[ok] API ativa."
      return
    fi
    sleep 1
  done

  echo "[erro] API não respondeu em 30s. Veja: ${api_log}" >&2
  exit 1
}

start_admin() {
  if is_listening 8081; then
    echo "[ok] Painel admin já está ouvindo na porta 8081."
    return
  fi

  echo "[info] Subindo painel admin (8081)..."
  (
    cd "${ADMIN_DIR}"
    nohup python3 -m http.server 8081 >"${admin_log}" 2>&1 &
    echo $! >"${admin_pid_file}"
  )

  sleep 1
  if is_listening 8081; then
    echo "[ok] Painel admin ativo."
    return
  fi

  echo "[erro] Painel admin não subiu. Veja: ${admin_log}" >&2
  exit 1
}

start_tunnel() {
  if [[ -f "${tunnel_pid_file}" ]]; then
    local old_pid
    old_pid="$(cat "${tunnel_pid_file}" || true)"
    if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" >/dev/null 2>&1; then
      echo "[info] Encerrando túnel antigo (${old_pid})..."
      kill "${old_pid}" >/dev/null 2>&1 || true
      sleep 1
    fi
  fi

  echo "[info] Subindo túnel Cloudflare..."
  : >"${tunnel_log}"
  (
    cd "${ROOT_DIR}"
    nohup env HOME="${CF_HOME}" cloudflared tunnel --url http://localhost:8080 >"${tunnel_log}" 2>&1 &
    echo $! >"${tunnel_pid_file}"
  )

  local url=""
  for _ in {1..40}; do
    url="$(rg -o 'https://[a-z0-9-]+\.trycloudflare\.com' -N "${tunnel_log}" | head -n1 || true)"
    if [[ -n "${url}" ]]; then
      break
    fi
    sleep 1
  done

  if [[ -z "${url}" ]]; then
    echo "[erro] Não consegui obter URL do túnel. Veja: ${tunnel_log}" >&2
    exit 1
  fi

  echo "${url}" >"${tunnel_url_file}"
  if curl -fsS "${url}/health" >/dev/null 2>&1; then
    echo "[ok] Túnel ativo: ${url}"
  else
    echo "[warn] Túnel ativo, mas seu DNS local ainda não resolveu /health. Continue e teste no Twilio: ${url}" >&2
  fi
}

start_api
start_admin
start_tunnel

URL="$(cat "${tunnel_url_file}")"
echo
echo "============================================================"
echo "STACK LOCAL ATIVA"
echo "Admin: http://localhost:8081"
echo "API health: http://localhost:8080/health"
echo "Tunnel: ${URL}"
echo
echo "Webhook para Twilio Sandbox (POST):"
echo "${URL}/webhooks/whatsapp/twilio"
echo "============================================================"
