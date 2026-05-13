#!/usr/bin/env bash
set -euo pipefail

PLIST_PATH="${HOME}/Library/LaunchAgents/com.financebot.devstack.plist"

if [[ -f "${PLIST_PATH}" ]]; then
  launchctl unload "${PLIST_PATH}" >/dev/null 2>&1 || true
  rm -f "${PLIST_PATH}"
  echo "[ok] Auto-start removido."
else
  echo "[info] Auto-start não estava instalado."
fi
