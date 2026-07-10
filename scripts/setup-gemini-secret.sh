#!/usr/bin/env bash
# Store the Gemini AI Studio API key as a Secret Manager secret in the
# weatherbot-app project, where the Firebase Functions runtime can mount it.
#
# Prompts interactively so the key never appears in shell history. Safe to
# re-run: adds a new version (Secret Manager keeps prior versions).

set -euo pipefail

PROJECT_ID="${1:-weatherbot-app}"
SECRET_NAME="GEMINI_API_KEY"

gcloud config set project "${PROJECT_ID}" >/dev/null

echo "Paste your Gemini API key when prompted (https://aistudio.google.com/apikey)."
echo "Input is hidden."
printf "API key: "
read -rs KEY
echo

if [[ -z "${KEY}" ]]; then
  echo "✗ Empty input — aborting." >&2
  exit 1
fi

if gcloud secrets describe "${SECRET_NAME}" >/dev/null 2>&1; then
  echo "→ Adding new version to existing secret ${SECRET_NAME}..."
  printf '%s' "${KEY}" \
    | gcloud secrets versions add "${SECRET_NAME}" --data-file=- >/dev/null
else
  echo "→ Creating secret ${SECRET_NAME}..."
  printf '%s' "${KEY}" \
    | gcloud secrets create "${SECRET_NAME}" \
        --replication-policy=automatic \
        --data-file=- >/dev/null
fi

echo "✓ Stored ${SECRET_NAME} in project ${PROJECT_ID} (length=${#KEY})."
