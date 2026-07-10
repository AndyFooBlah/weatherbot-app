#!/usr/bin/env bash
# Adds a user to the weatherbot-app allow-list.
#
# Writes `allowed_emails/<lowercased-email>` in Firestore via the REST
# API. Uses your gcloud OAuth access token, which (for an owner) has
# Datastore write permission. Safe to re-run — idempotent.
#
# Usage:
#   bash scripts/add-allowed-email.sh you@example.com

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-weatherbot-app}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <email>" >&2
  exit 1
fi

EMAIL_RAW="$1"
EMAIL="$(printf '%s' "${EMAIL_RAW}" | tr '[:upper:]' '[:lower:]')"

NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000000Z)"

echo "→ Adding ${EMAIL} to allowed_emails in ${PROJECT_ID}"

# Note: parentheses around "(default)" must be URL-encoded in some shells;
# curl handles bare parens fine on macOS/Linux.
RESP="$(mktemp)"
trap 'rm -f "${RESP}"' EXIT

HTTP_CODE="$(curl -s -o "${RESP}" -w "%{http_code}" \
  -X PATCH \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  "https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/allowed_emails/${EMAIL}" \
  -d "{\"fields\":{\"addedAt\":{\"timestampValue\":\"${NOW}\"}}}")"

if [[ "${HTTP_CODE}" == "200" ]]; then
  echo "✓ ${EMAIL} added (or updated)."
else
  echo "✗ HTTP ${HTTP_CODE}" >&2
  cat "${RESP}" >&2
  exit 1
fi
