# Model Cards

Covers every model the deployed system calls, not a survey of what Ollama can run. Each card reflects the config (`gateway/litellm_config.yaml`, `rag-app/.env.example`) and the live test results recorded in `gateway/README.md` and `rag-app/README.md`.

---

## local-gemma (generation)

| | |
|---|---|
| **Model** | `gemma4:e2b` via Ollama, routed through the gateway as `local-gemma` |
| **Role in system** | Default generation model for both the gateway's direct chat-completion route and the RAG app's answer synthesis step |
| **Provider** | Google, pulled from Ollama's public registry, not fine-tuned, not modified |
| **Intended use** | Local, low-cost generation for portfolio demonstration traffic: gateway smoke tests and RAG app query answering. Not sized or evaluated for production load. |
| **Out-of-scope use** | Anything requiring guaranteed factual accuracy, safety-critical decisions, or handling of non-synthetic sensitive data, the RAG corpus is synthetic test data (see `data-card.md`), and nothing here has been evaluated against real PII or business-sensitive content. |
| **Known limitations** | Hallucination is out of scope for this system to mitigate (see `threat-model.md`, LLM09); no fact-checking or citation-grounding is layered on top of raw generation. `e2b` (~2B effective params) trades capability for being able to fit the host GPU's VRAM alongside the embedding and guardrail models running on the same box. |
| **Evaluation** | No formal benchmark run. Behavioral evidence only: `rag-app/README.md` test #4 shows the model correctly refusing to act on an injected instruction embedded in retrieved context, and correctly answering only the asked question, see that doc for the exact transcript. This is one observed data point, not a systematic robustness evaluation. |
| **Resource footprint** | Selected because it fits alongside `nomic-embed-text` and `llama-guard3` in the host GPU's VRAM; models that do not fit are not routed (see comment in `litellm_config.yaml`). |

---

## local-gemma-e4b (generation, larger gemma route)

| | |
|---|---|
| **Model** | `gemma4:e4b` via Ollama, routed through the gateway as `local-gemma-e4b` (added 2026-11-05) |
| **Role in system** | Generation route on the gateway, available to any caller with a virtual key, not used by the RAG app, which is hardcoded to `local-gemma` (`gemma4:e2b`) via `GENERATION_MODEL`. |
| **Provider** | Google, pulled from Ollama's public registry, not fine-tuned, not modified |
| **Intended use** | The larger sibling of `local-gemma` on the same virtual-key auth, rate limits, and audit logging, for callers comparing model sizes. |
| **Out-of-scope use** | Same constraints as `local-gemma` above, portfolio/demo traffic only. |
| **Known limitations** | Uses 6.6 GB of the host GPU's 12 GB. Not exercised by any live test suite; no behavioral evaluation has been run against this route. |
| **Evaluation** | Measured 173 tokens/s decode on LLM_HOST, 100% GPU (2026-11-05). No behavioral evaluation. |

---

## local-qwen (generation, alternate route)

| | |
|---|---|
| **Model** | `qwen3.5:9b` via Ollama, routed through the gateway as `local-qwen` (replaced `qwen3.8` on 2026-11-04, which did not fit the host GPU) |
| **Role in system** | Second generation route on the gateway, available to any caller with a virtual key, not currently used by the RAG app, which is hardcoded to `local-gemma` via `GENERATION_MODEL`. |
| **Provider** | Alibaba, pulled from Ollama's public registry, not fine-tuned, not modified |
| **Intended use** | Demonstrates the gateway's multi-model routing (`model_list` in `litellm_config.yaml`) rather than serving a distinct product need. A caller can request it by name through the same virtual-key auth, rate limits, and audit logging as `local-gemma`. |
| **Out-of-scope use** | Same constraints as `local-gemma` above, portfolio/demo traffic only. |
| **Known limitations** | Not exercised by any of the live test suites in `gateway/README.md` or `rag-app/README.md` beyond basic routing; no behavioral evaluation has been run against this specific route. |
| **Evaluation** | None beyond confirming the route resolves and responds through the gateway. |

---

## local-deepseek (generation, reasoning route)

| | |
|---|---|
| **Model** | `deepseek-r1:14b` via Ollama, routed through the gateway as `local-deepseek` (added 2026-11-05; replaces `deepseek-v3`, which did not fit the host GPU and was never routed) |
| **Role in system** | Third generation route on the gateway, available to any caller with a virtual key, not used by the RAG app, which is hardcoded to `local-gemma` via `GENERATION_MODEL`. |
| **Provider** | DeepSeek, distilled onto a Qwen base, pulled from Ollama's public registry, not fine-tuned, not modified |
| **Intended use** | A reasoning model on the same virtual-key auth, rate limits, and audit logging as `local-gemma`. Answers include the model's reasoning text before the final answer. |
| **Out-of-scope use** | Same constraints as `local-gemma` above, portfolio/demo traffic only. |
| **Known limitations** | The reasoning text counts toward `tpm_limit` and the nominal budget, so a call uses more tokens than the visible answer. Uses 9.5 GB of the host GPU's 12 GB, so it does not stay loaded alongside another generation model and a switch reloads it (about 6 s). Not exercised by any live test suite; no behavioral evaluation has been run against this route. |
| **Evaluation** | Measured 64 tokens/s decode on LLM_HOST, 100% GPU (2026-11-05). No behavioral evaluation. |

---

## llama-guard3 (input/output guardrail)

| | |
|---|---|
| **Model** | `llama-guard3` via Ollama, called directly (not through the gateway, see `rag-app/ollama_client.py` comment: embeddings and guardrail classification bypass the gateway since neither is end-user generation) |
| **Role in system** | Classifies RAG app input (the user's question) and output (the generated answer) as safe/unsafe before and after generation |
| **Provider** | Meta, pulled from Ollama's public registry, not fine-tuned, not modified |
| **Intended use** | General content-safety screening (violence, weapons, sexual content, and similar categories) on RAG app traffic. |
| **Out-of-scope use** | **This is not a prompt-injection detector**, and it is not being represented as one. `rag-app/README.md` records the result: Llama Guard returned `safe` on every one of the four live tests, including the two carrying the planted injection payload. It did not catch the injection, because that is not the category of harm it classifies. Anyone evaluating this system's defenses should attribute injection containment to retrieval-time ACL enforcement and the system prompt's "context is data" framing, not to this model. |
| **Known limitations** | Single general-purpose safety classifier with no injection-specific or jailbreak-specific detection layered on top. If injection detection is required, this needs a dedicated classifier or pattern-based check in addition to, not instead of, Llama Guard. |
| **Evaluation** | 4/4 live calls returned `safe`, logged in `rag-app/README.md`. No true-positive case for this model's detection category (e.g. violent content) was tested, the corpus has no content designed to trigger it, so recall within its own domain is unverified here. |

---

## nomic-embed-text (embedding)

| | |
|---|---|
| **Model** | `nomic-embed-text` via Ollama, called directly (bypasses the gateway for the same reason as the guardrail model) |
| **Role in system** | Embeds both the RAG corpus at ingest time and incoming questions at query time. Output dimension (768) is hardcoded in `rag-app/src/ragapp/db.py` as the pgvector column width, swapping embedding models requires a matching schema change, not just an env var flip. |
| **Provider** | Nomic AI, pulled from Ollama's public registry, not fine-tuned, not modified |
| **Intended use** | Semantic retrieval over the small, fixed, synthetic test corpus described in `data-card.md`. |
| **Out-of-scope use** | Not evaluated for retrieval quality at any scale beyond the 4-document test corpus; no recall/precision benchmark exists here, because the corpus is small and fixed for test-case reproducibility rather than representative of production-scale retrieval. |
| **Known limitations** | Retrieval-time ACL enforcement happens in the SQL `WHERE` clause after the vector search, not inside the embedding model; the embedding model itself has no concept of document sensitivity. All access control shown in `rag-app/README.md`'s test results is a property of the query layer, not this model. |
| **Evaluation** | Indirect only: the four live query tests in `rag-app/README.md` show retrieval returning the expected documents per user/question pair, which is evidence the embedding + ACL-filtered search pipeline works end-to-end for this corpus, not a standalone embedding-quality evaluation. |
