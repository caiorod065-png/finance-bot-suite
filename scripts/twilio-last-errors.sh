#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

if [[ -z "${TWILIO_ACCOUNT_SID:-}" || -z "${TWILIO_AUTH_TOKEN:-}" ]]; then
  echo "TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN ausentes no .env"
  exit 1
fi

curl -sS -u "${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}" \
  "https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json?PageSize=20" \
  | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const data = JSON.parse(raw);
  const rows = (data.messages || [])
    .filter((m) => m.direction === "inbound" || m.error_code)
    .slice(0, 15)
    .map((m) => ({
      date: m.date_created,
      from: m.from,
      body: m.body,
      status: m.status,
      error_code: m.error_code,
      sid: m.sid
    }));
  console.log(JSON.stringify(rows, null, 2));
});
'
