# gateway

LLM gateway fronting Ollama with [LiteLLM](https://github.com/BerriAI/litellm) as the proxy. Implements:

- **Auth**: per-caller virtual keys (Postgres-backed), never the raw Ollama endpoint or the master key.
- **Quotas**: per-key rate limits (`rpm_limit`/`tpm_limit`) and budgets (`max_budget`) enforced by LiteLLM.
- **Audit logging**: every request logged to `LiteLLM_SpendLogs` in Postgres, keyed by virtual key; structured JSON logs for the underlying process.

## Setup (local dry-run, no LLM_HOST needed)

Requires Docker + Docker Compose. Not installed on this dev machine by design; the stack only ever runs on LLM_HOST. This section is for whoever runs it there (or you, once LLM_HOST is up).

```bash
cp .env.example .env
# Edit .env: generate new values for LITELLM_MASTER_KEY, LITELLM_SALT_KEY, POSTGRES_PASSWORD,
# GATEWAY_DB_PASSWORD
#   openssl rand -hex 32   (run twice, once per key)
#   openssl rand -hex 24   (database passwords)

# Postgres first, then the role LiteLLM connects as (psql 15+ runs inside the container):
docker compose up -d postgres
set -a; . ./.env; set +a
docker compose exec -T -e GATEWAY_DB_PASSWORD postgres \
  sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -f -' < sql/gateway-role.sql

docker compose up -d
docker compose logs -f litellm   # confirm it comes up healthy
curl http://127.0.0.1:4000/health/liveliness
```

## Create a virtual key

```bash
export LITELLM_MASTER_KEY=<the value from your .env>
./scripts/create-key.sh "some-caller-name"
```

This issues a key with a 30 requests/min, 20k tokens/min rate limit and a $5/30-day budget (nominal, see `input_cost_per_token`/`output_cost_per_token` in `litellm_config.yaml`, since Ollama models have no per-token cost). Adjust the limits in `scripts/create-key.sh` per caller as needed.

Call the gateway with the issued key exactly like the OpenAI API:

```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer <virtual-key>" \
  -H "Content-Type: application/json" \
  -d '{"model": "local-gemma", "messages": [{"role": "user", "content": "hello"}]}'
```

## Deploy to LLM_HOST

```bash
scp docker-compose.yml litellm_config.yaml .env.example scripts/create-key.sh LLM_HOST:~/ai-security-lab-gateway/
ssh LLM_HOST "cd ~/ai-security-lab-gateway && cp .env.example .env"
# then edit .env on LLM_HOST directly with generated secrets before starting
ssh LLM_HOST "cd ~/ai-security-lab-gateway && docker compose up -d"
```

> **Bind address (2026-10-06):** `LITELLM_BIND_ADDR` and `OLLAMA_BASE_URL` in `.env` now point at LLM_HOST's Tailscale address, not loopback, so the CI runner can reach the gateway; the healthcheck follows `LITELLM_BIND_ADDR`. The loopback examples in this file apply only if you set them back.

**Why `network_mode: host` on the litellm service:** Ollama listens on the host itself (`127.0.0.1:11434` by default, or the host's private network address as set in `.env`, see the note above). A container on Docker's default bridge network reaches the host through a gateway IP that is *not* the host's own loopback, so it would get connection-refused talking to a loopback-only service. Host networking puts litellm in the host's own network namespace instead, so `127.0.0.1` inside the container is the host's loopback. Postgres stays on the isolated bridge network and publishes its port to `127.0.0.1:5432` only, so litellm (host-networked) can still reach it over loopback without bridge DNS.

## Known gaps / TODOs for a reviewer

- **Ollama itself has no authentication.** Callers who can reach it can bypass this gateway entirely, so its access control is its bind address plus network ACLs. In the current deployment it listens on a private network address only, and Tailscale ACLs limit which nodes can reach it. If it listened on `0.0.0.0:11434`, any caller on the network could bypass the gateway; fixing that is a host-firewall/Ollama-config change outside this repo's scope.
- **`litellm --host` flag.** The command relies on LiteLLM's proxy CLI accepting `--host` to bind to a chosen address (loopback by default) under host networking. This is a documented uvicorn-style option in LiteLLM's proxy CLI as of this writing, but wasn't independently re-verified against the exact `main-stable` image tag. Confirm the gateway only listens on the address set in `LITELLM_BIND_ADDR` (not `0.0.0.0:4000`) on first deploy: `ss -tlnp | grep 4000` on LLM_HOST.
- **Budget enforcement uses nominal internal pricing**, since Ollama has no token cost. If per-token cost tracking ever matters (e.g. mixing in a paid model route), revisit `input_cost_per_token`/`output_cost_per_token`.
- **Two model routes** (`local-gemma`, `local-qwen`) match what's on LLM_HOST. `deepseek-v3` (404GB) is not routed, see `litellm_config.yaml` comment.
- **Docker/Compose was not available to test locally** on this dev machine (by design, see repo root README). All validation before first deploy was YAML-syntax checking, not a `docker compose config`/`up` run.
