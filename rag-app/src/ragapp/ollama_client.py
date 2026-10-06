"""Thin client for Ollama's own API: embeddings and the guardrail model.

Talks to Ollama directly (OLLAMA_BASE_URL, 127.0.0.1:11434 by default) rather
than through the LiteLLM gateway for these two calls: embeddings and safety
classification aren't end-user chat completions, and keeping them off the
gateway's virtual-key/budget accounting keeps that accounting meaningful for
user-facing generations, which do go through the gateway (see
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
    # cost (loading the model into GPU/RAM) on top of inference time,
    # hit a ReadTimeout at 30s on the very first embed call during testing.
    resp = httpx.post(
        f"{OLLAMA_BASE_URL}/api/embeddings",
        json={"model": EMBED_MODEL, "prompt": text},
        timeout=90,
    )
    resp.raise_for_status()
    return resp.json()["embedding"]


GUARDRAIL_ROLES = ("user", "assistant")


def _single_line(text: str) -> str:
    """Collapses every whitespace run, line breaks included, to one space.

    The llama-guard3 chat template in Ollama inserts message content as text
    between its <BEGIN CONVERSATION> and <END CONVERSATION> lines and then asks
    for a verdict on the last turn. Content with line breaks can add lines that
    read as an end marker, a verdict, and a new benign last turn (threat-model
    finding 7). With the content on one line, the 25 original payloads in
    ci-cd/redteam/guardrail-tests.yaml are classified unsafe. Rewriting the
    marker text does not stop the attack: square-bracket, fullwidth-bracket and
    bracketless markers flip the verdict the same way.

    This does not stop a fake last turn that is a longer benign question or
    answer; the three "open-ended" tests in guardrail-tests.yaml still return
    safe on one line and with JSON-quoted content.

    ci-cd/redteam/sync-guardrail-prompt.ts checks this body is unchanged and
    guardrail-provider.ts applies the same transform; change all three together.
    """
    return " ".join(text.split())


def guardrail_check(role: str, content: str) -> tuple[bool, str]:
    """Returns (is_safe, raw_verdict). role is 'user' or 'assistant';
    the model's chat template classifies the last message and labels it
    User or Agent from its role.

    Sent as one /api/chat message so the model's own chat template builds the
    Llama Guard prompt. The content is passed through _single_line() first.

    Any verdict that does not start with "safe" is unsafe. HTTP errors and
    responses without message.content raise.
    """
    if role not in GUARDRAIL_ROLES:
        raise ValueError(f"guardrail role must be one of {GUARDRAIL_ROLES}, got {role!r}")
    resp = httpx.post(
        f"{OLLAMA_BASE_URL}/api/chat",
        json={
            "model": GUARDRAIL_MODEL,
            "messages": [{"role": role, "content": _single_line(content)}],
            "stream": False,
        },
        timeout=90,
    )
    resp.raise_for_status()
    verdict = resp.json()["message"]["content"].strip()
    is_safe = verdict.lower().startswith("safe")
    return is_safe, verdict


def generate(system_prompt: str, user_message: str) -> str:
    """User-facing generation, routed through the gateway, not
    called against Ollama directly, so it's authenticated, rate-limited,
    budgeted, and audit-logged exactly like any other gateway caller.
    """
    if not GATEWAY_KEY:
        raise RuntimeError(
            "GATEWAY_VIRTUAL_KEY must be set; generate a key with "
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
