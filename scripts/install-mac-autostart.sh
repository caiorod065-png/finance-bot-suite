#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${LAUNCH_AGENTS_DIR}/com.financebot.devstack.plist"
LOG_DIR="${ROOT_DIR}/.runtime/logs"
AUTOSTART_LOG="${LOG_DIR}/autostart.log"

mkdir -p "${LAUNCH_AGENTS_DIR}" "${LOG_DIR}"

cat >"${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.financebot.devstack</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/zsh</string>
      <string>-lc</string>
      <string>cd "${ROOT_DIR}" &amp;&amp; ./scripts/start-dev-stack.sh &gt;&gt; "${AUTOSTART_LOG}" 2&gt;&amp;1</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${AUTOSTART_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${AUTOSTART_LOG}</string>
  </dict>
</plist>
EOF

launchctl unload "${PLIST_PATH}" >/dev/null 2>&1 || true
launchctl load "${PLIST_PATH}"

echo "[ok] Auto-start instalado no login."
echo "Plist: ${PLIST_PATH}"
echo "Para remover: ./scripts/uninstall-mac-autostart.sh"
