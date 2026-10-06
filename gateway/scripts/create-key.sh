#!/usr/bin/env bash
# Create a virtual key with a rate limit and budget, via LiteLLM's admin API.
# Requires: the gateway stack running, LITELLM_MASTER_KEY set in your shell,
# curl and jq installed.
#
# Exits non-zero on an HTTP error or when the response has no key.
#
# Usage: LITELLM_MASTER_KEY=... ./create-key.sh "some-caller-name"

set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:4000}"
CALLER_NAME="${1:?usage: create-key.sh <caller-name>}"

if [[ -z "${LITELLM_MASTER_KEY:-}" ]]; then
  echo "LITELLM_MASTER_KEY must be set in the environment (never hardcode it here)." >&2
  exit 1
fi

for tool in curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required." >&2
    exit 1
  fi
done

# jq encodes the caller name, so quotes, backslashes and control characters
# stay inside the key_alias string.
PAYLOAD=$(jq -n --arg alias "$CALLER_NAME" '{
  key_alias: $alias,
  models: ["local-gemma", "local-qwen"],
  rpm_limit: 30,
  tpm_limit: 20000,
  max_budget: 5.0,
  budget_duration: "30d"
}')

# --fail-with-body makes curl exit non-zero on HTTP 4xx and 5xx and keeps the body.
if ! RESPONSE=$(curl -sS --fail-with-body --max-time 30 -X POST "${GATEWAY_URL}/key/generate" \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"); then
  echo "key request failed: ${RESPONSE}" >&2
  exit 1
fi

if ! jq -e '.key | type == "string" and length > 0' >/dev/null 2>&1 <<<"$RESPONSE"; then
  echo "response has no key field: ${RESPONSE}" >&2
  exit 1
fi

jq . <<<"$RESPONSE"

echo "" >&2
echo "The generated 'key' field above is the caller's virtual key; hand it to" >&2
echo "them directly, never log it, and it is separate from LITELLM_MASTER_KEY." >&2
