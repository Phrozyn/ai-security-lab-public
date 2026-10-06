# Data Card

Covers every dataset the deployed system actually reads or writes — the synthetic RAG test corpus, and the two audit-log streams the gateway and RAG app generate at runtime. None of this is real customer, employee, or business data; it's purpose-built test fixture material, and this card says so explicitly rather than leaving that ambiguous.

---

## RAG test corpus (`rag-app/corpus/`)

| | |
|---|---|
| **Composition** | 4 Markdown documents, entirely authored for this project — not sourced, scraped, or derived from any real company's records. All reference a fictional company, "Acme Robotics." |
| **Purpose** | Exercise retrieval-time ACL enforcement and injection containment under realistic-looking but synthetic conditions — see `rag-app/README.md` for the four live test cases run against this exact corpus. |
| **Schema** | Each file carries YAML frontmatter: `doc_id` (doc-001 through doc-004), `acl` (`public` \| `internal` \| `restricted`), `owner` (the fictional department — `hr`, `engineering`, `finance`). |
| **Contents by document** | `doc-001` (`public`, hr) — new-hire handbook excerpt. `doc-002` (`internal`, engineering) — deployment runbook excerpt. `doc-003` (`restricted`, finance) — draft Q3 financials, pre-release. `doc-004` (`public`, engineering) — vendor integration notes, and the document carrying the planted injection payload (see below). |
| **Known defect, planted intentionally** | `doc-004` is tagged `public` — retrievable by every simulated user — but contains an HTML-comment-embedded instruction telling the model to ignore its instructions and leak `doc-003`'s restricted financials. This is a deliberate test fixture, not an accidental leak: it exists specifically to prove whether retrieval-time ACL and the system prompt's "context is data" framing actually hold under a live attempt. It should never be "fixed" by removing the payload — doing so would silently delete the one test case that proves the injection defense works. |
| **Simulated identities** | `rag-app/corpus/users.yaml` maps 3 fictional users (`guest`, `alice_engineering`, `bob_exec`) to ACL tiers. These are not real accounts, credentials, or people — purely a lookup table for the ACL-filter test harness. |
| **Collection process** | Hand-authored for this repo. No web scraping, no real-document sourcing, no PII collection of any kind. |
| **Known limitations as a dataset** | 4 documents is enough to prove the ACL and injection-containment mechanisms work on the specific cases tested — it is not large enough, nor intended, to support any claim about retrieval quality, ranking behavior, or embedding performance at realistic corpus scale. See `model-cards.md`'s `nomic-embed-text` entry for the same caveat from the model side. |
| **License / sensitivity** | No license needed — wholly original, fictional content. Zero real-world sensitivity; safe to publish as-is, which is the point of using synthetic data for a public portfolio repo. |

---

## Gateway spend/audit logs (LiteLLM `LiteLLM_SpendLogs` table, Postgres on LLM_HOST)

| | |
|---|---|
| **What's collected** | Per-request metadata: virtual-key alias, model name, token counts, latency, timestamp, success/failure. Queryable live via the gateway's `/spend/logs` endpoint. |
| **What's deliberately not collected** | Prompt and completion text. `store_prompts_in_spend_logs: false` in `gateway/litellm_config.yaml` — a documented decision (see the comment above that line), not an oversight, pending an explicit retention policy that doesn't exist yet. |
| **Retention** | Lives in LLM_HOST's Postgres instance indefinitely at present — no retention/rotation policy has been implemented. Flagged here as a real gap rather than claimed as handled. |
| **Consumers** | Feeds the `detections/` Sigma rules (`gateway_auth_failure.yml`, `gateway_repeated_auth_failures.yml`, `gateway_admin_endpoint_abuse.yml`, `gateway_completion_request.yml`, `gateway_high_volume_completions.yml`) — see `detections/README.md` for exactly which fields each rule matches on. |
| **Sensitivity** | Low — metadata only, no prompt content, no real end-user identities (virtual keys map to test personas, not real people). |

---

## RAG app audit log (`rag-app/logs/audit.jsonl`, gitignored — runtime data, not checked into the repo)

| | |
|---|---|
| **What's collected** | One structured JSON line per query via `src/ragapp/audit.py`: timestamp, component, event type, severity level, and caller-supplied fields such as the acting user, which `doc_id`s were retrieved, and guardrail verdicts. |
| **What's deliberately not collected** | Question and answer text — the same stance as the gateway's `store_prompts_in_spend_logs: false`, stated explicitly in `audit.py`'s module docstring: "Question and answer text are deliberately never logged here." |
| **Enforcement mechanism worth noting** | `log_event()` raises `ValueError` if a caller tries to pass `timestamp` or `component` as a field — a deliberate fail-loud choice so a bad call site errors immediately instead of silently corrupting a log record that a Sigma rule downstream depends on. |
| **Consumers** | Feeds the three RAG-specific Sigma rules (`ragapp_input_guardrail_blocked.yml`, `ragapp_injection_doc_retrieved.yml`, `ragapp_unknown_user_attempt.yml`) — see `detections/README.md`. |
| **Retention** | Local file, append-only, no rotation implemented — same unaddressed-gap status as the gateway's Postgres logs. |
| **Sensitivity** | Low — no prompt/answer text, no real PII (corpus and users are synthetic). The one sensitive-shaped field, `doc_id`, only ever refers to the 4 fictional documents above. |
