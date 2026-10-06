"""Thin client for Ollama's own API — embeddings and the guardrail model.

Deliberately talks to Ollama directly (127.0.0.1:11434, loopback-only) rather
than through the LiteLLM gateway for these two calls: embeddings and safety
classification aren't end-user chat completions, and keeping them off the
gateway's virtual-key/budget accounting keeps that accounting meaningful for
actual user-facing generations, which do go through the gateway (see
generate() below).
"""

import os

import httpx

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
GATEWAY_BASE_URL = os.environ.get("GATEWAY_BASE_URL", "http://127.0.0.1:4000")
GATEWAY_KEY = os.environ.get("GATEWAY_VIRTUAL_KEY")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "nomic-embed-text")
GUARDRAIL_MODEL = os.environ.get("GUARDRAIL_MODEL", "llama-guard3")
GENERATION_MODEL = os.environ.get("GENERATION_MODEL", "local-gemma")


def embed(text: str) -> list[float]:
    # 90s, not 30s: a model's first call after being idle pays Ollama's cold-load
    # cost (loading the model into GPU/RAM) on top of actual inference time —
    # hit a ReadTimeout at 30s on the very first embed call during real testing.
    resp = httpx.post(
        f"{OLLAMA_BASE_URL}/api/embeddings",
        json={"model": EMBED_MODEL, "prompt": text},
        timeout=90,
    )
    resp.raise_for_status()
    return resp.json()["embedding"]


def guardrail_check(role: str, content: str) -> tuple[bool, str]:
    """Returns (is_safe, raw_verdict). role is 'user' or 'assistant' —
    Llama Guard's chat template expects that distinction to know which
    turn it's classifying.
    """
    prompt = (
        f"Task: Check if there is unsafe content in '{role}' messages in "
        "conversations according to our safety policy.\n\n"
        f"<BEGIN CONVERSATION>\n{role}: {content}\n<END CONVERSATION>\n\n"
        "Provide your safety assessment. First line must read 'safe' or "
        "'unsafe'."
    )
    resp = httpx.post(
        f"{OLLAMA_BASE_URL}/api/generate",
        json={"model": GUARDRAIL_MODEL, "prompt": prompt, "stream": False},
        timeout=90,
    )
    resp.raise_for_status()
    verdict = resp.json()["response"].strip()
    is_safe = verdict.lower().startswith("safe")
    return is_safe, verdict


def generate(system_prompt: str, user_message: str) -> str:
    """Real user-facing generation — routed through the gateway, not
    called against Ollama directly, so it's authenticated, rate-limited,
    budgeted, and audit-logged exactly like any other gateway caller.
    """
    if not GATEWAY_KEY:
        raise RuntimeError(
            "GATEWAY_VIRTUAL_KEY must be set — generate a key with "
            "gateway/scripts/create-key.sh and export it, never the master key."
        )
    resp = httpx.post(
        f"{GATEWAY_BASE_URL}/v1/chat/completions",
        headers={"Authorization": f"Bearer {GATEWAY_KEY}"},
        json={
            "model": GENERATION_MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
        },
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]
