#!/usr/bin/env bash
# Create a virtual key with a rate limit and budget, via LiteLLM's admin API.
# Requires: the gateway stack running, LITELLM_MASTER_KEY set in your shell,
# and jq installed (falls back to raw output if jq is missing).
#
# Usage: LITELLM_MASTER_KEY=... ./create-key.sh "some-caller-name"

set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:4000}"
CALLER_NAME="${1:?usage: create-key.sh <caller-name>}"

if [[ -z "${LITELLM_MASTER_KEY:-}" ]]; then
  echo "LITELLM_MASTER_KEY must be set in the environment (never hardcode it here)." >&2
  exit 1
fi

RESPONSE=$(curl -sS -X POST "${GATEWAY_URL}/key/generate" \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"key_alias\": \"${CALLER_NAME}\",
    \"models\": [\"local-gemma\", \"local-qwen\"],
    \"rpm_limit\": 30,
    \"tpm_limit\": 20000,
    \"max_budget\": 5.0,
    \"budget_duration\": \"30d\"
  }")

if command -v jq >/dev/null 2>&1; then
  echo "$RESPONSE" | jq .
else
  echo "$RESPONSE"
fi

echo "" >&2
echo "The generated 'key' field above is the caller's virtual key — hand it to" >&2
echo "them directly, never log it, and it is separate from LITELLM_MASTER_KEY." >&2
