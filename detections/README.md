# detections

Sigma-format detection rules for the gateway and RAG app, each proven against
a captured log line from the deployed system, not written
against an imagined log shape and left untested. Reviewed by Forge (GPT-5.4)
for correctness; findings and fixes are in the project ISA's Decisions log.
Independently validated against the `pySigma` library, not just the
scoped harness in this directory (see below).

## What's here

```
detections/
  rules/      8 Sigma rule files: 4 standalone alerting rules,
              2 correlation rules, and the 2 base rules they feed
  samples/    captured log fixtures the rules are tested against
  validate.ts bun-run test harness: schema check + fires every rule's
              detection logic against its fixtures (true-positive AND
              true-negative), run it with: bun detections/validate.ts
```

## Rules

| Rule | Log source | Detects | Fixture |
|------|-----------|---------|---------|
| `gateway_auth_failure.yml` | litellm docker JSON logs | Bearer token rejected: not a known virtual key (base; feeds the rule below) | `samples/gateway_auth_failure.jsonl` |
| `gateway_repeated_auth_failures.yml` | litellm docker JSON logs (correlation) | ≥5 auth failures from one source within 5 minutes | `samples/gateway_auth_failure.jsonl` |
| `gateway_admin_endpoint_abuse.yml` | litellm docker JSON logs | Failed call to `/key/*` admin endpoints | `samples/gateway_key_generate_failure.jsonl` |
| `gateway_completion_request.yml` | litellm `/spend/logs` | Base selection of completion calls, served or rejected (feeds the rule below, `level: informational`) | `samples/gateway_spend_logs.jsonl` |
| `gateway_high_volume_completions.yml` | litellm `/spend/logs` (correlation) | ≥30 completions from one virtual-key alias within 5 minutes | `samples/gateway_spend_logs.jsonl` |
| `ragapp_input_guardrail_blocked.yml` | RAG app query-audit log | Llama Guard flagged the input unsafe before retrieval ran | `samples/ragapp_audit.jsonl` |
| `ragapp_injection_doc_retrieved.yml` | RAG app query-audit log | A document known to carry an embedded prompt-injection payload entered a query's retrieved context | `samples/ragapp_audit.jsonl` |
| `ragapp_unknown_user_attempt.yml` | RAG app query-audit log | A query was attempted against a username not in the app's ACL map | `samples/ragapp_audit.jsonl` |

Each rule file's `x-fixtures:` field names the exact fixture(s) `validate.ts`
loads for it: open the rule next to the fixture to see what event it's
matching and what it correctly ignores. (`x-fixtures`, not Sigma's standard
`references:` field, which is reserved for links to outside documentation,
using it for fixture paths would be a non-standard overload a detection
engineer reading the rule would trip over.)

## Log sources

**Gateway** (`product: litellm`): two log surfaces.
- `service: docker-json`: the proxy's own structured stdout (`json_logs: true`
  in `gateway/litellm_config.yaml`), pulled via `docker logs`.
- `service: spend-logs`: the `LiteLLM_SpendLogs` Postgres table, queryable
  via `GET /spend/logs` with the master key. Richer per-request fields
  (virtual-key alias, token counts, timing) than the access log carries, which
  is why the volumetric rule targets this instead of the uvicorn access line.
  `samples/gateway_spend_logs.jsonl` is a flattened subset of the
  response, as a log-shipper/SIEM pipeline would normalize it before
  ingestion, not the full nested LiteLLM metadata blob. It includes calls the
  gateway rejected (401/429, `total_tokens: 0`) as well as served ones.

**RAG app** (`product: ragapp`, `service: query-audit`): did **not** exist
before this component. `query.py` previously only wrote to an interactive
terminal via `click.echo`; nothing was persisted. `src/ragapp/audit.py`
adds one JSON line per query to `logs/audit.jsonl` (gitignored; runtime log
data, not source). Logs counts and verdicts, never the raw
question/answer text, mirrors the gateway's own
`store_prompts_in_spend_logs: false` stance.

## Evidence from the deployed system

Every positive fixture came from running the deployed system:
- `ragapp_audit.jsonl`: captured by running `ragapp.cli query` against the
  live corpus on LLM_HOST: once asking about the vendor-integration doc
  (retrieves the injection-bearing doc-004), once with a guardrail-red-team
  prompt (Llama Guard returned `unsafe\nS2`), once with a nonexistent
  username, plus two further clean queries.
- `gateway_spend_logs.jsonl`: includes a 32-call burst fired at the
  gateway across ~6.7 seconds using the rag-app's own virtual key (30
  accepted, 2 rejected `429` once the key's own `rpm_limit: 30` kicked in).
  The correlation rule's threshold (30 in 5 minutes) isn't hypothetical:
  this burst crossed it, and the gateway's independent rate
  limiter agreed from a second angle, same burst, same threshold, two
  different enforcement points.
- `gateway_auth_failure.jsonl`: includes a 6-call burst of invalid
  bearer tokens fired at `/v1/chat/completions` in immediate succession,
  each logging its own `auth_exception_handler` entry. The hex string after
  `key=` in each line is LiteLLM's own SHA-256 hash of the invalid token
  presented, not a live credential, and not reversible to one.

## Independent validation against Sigma tooling

`validate.ts` is this project's own harness, useful for fixture-replay
proof, but it only proves the rules match *its own* interpretation of Sigma.
To check that independently, all 8 rules were also run through
`pySigma` library via `sigma-cli` (ephemeral install, `pipx run sigma-cli`,
nothing added to this repo or installed permanently):

```bash
pipx run sigma-cli check detections/rules/
# => Found 0 errors, 0 condition errors and 0 issues.
```

And converted to backend query languages to prove portability, not
just schema validity:

```bash
pipx run sigma-cli convert -t splunk --without-pipeline detections/rules/gateway_auth_failure.yml
# => component="LiteLLM Proxy" logger="auth_exception_handler*" level="ERROR"
#    message="*Authentication Error*" | table requester_ip,message

pipx run sigma-cli convert -t splunk --without-pipeline detections/rules/ragapp_injection_doc_retrieved.yml
# => event="query_completed" retrieved_doc_ids="doc-004" | table username,retrieved_doc_ids
```

Both single-event rules shown above convert cleanly to Splunk SPL.
**Limitation found during this check:** converting the two
correlation rules (`gateway_repeated_auth_failures.yml`,
`gateway_high_volume_completions.yml`) to a live backend (tried `splunk` and
`esql`) hit a `sigma-cli`/pySigma error: `Conversion result not available
in rule ...`, on the `level: informational` base rule they reference, even
with `--skip-unsupported` set. `sigma check` still validates both
correlation rules' schema and condition logic as fully correct (0 errors);
this is a backend-conversion tooling rough edge with informational-only
base rules, not a defect in the rules themselves, and it's
called out here rather than quietly worked around.

## What this doesn't cover

8 rules against 2 components is a start, not full coverage. Known gaps,
named rather than left implicit:
- No detection on the output side of the RAG pipeline, an *output*
  guardrail block (vs. the input block this component does detect) isn't
  covered; forcing one deterministically for a fixture proved unreliable in
  one test pass (see the project ISA's refinement note on ISC-54).
- No credential-access detection on the gateway's own Postgres (key
  encryption, DB access patterns), out of this component's log surface.
- No detection tied to the model-serving layer itself (Ollama), only the
  gateway and RAG app's own logs are covered.
- Admin endpoint abuse (`gateway_admin_endpoint_abuse.yml`) is single-event,
  not threshold-correlated like the two auth/volume rules; a single failed
  admin call is high-signal enough on this system's low admin-call
  volume that a correlation would just add latency to the alert, but a
  busier deployment might want one.

## Known limitations

- `ragapp_injection_doc_retrieved.yml` hardcodes `doc-004` as the known-bad
  document id. A production deployment would source that list from a
  content-scanning/tagging pipeline run at ingest time, not a manually
  maintained id in a rule file.
- The 30-in-5-minutes and 5-in-5-minutes thresholds are reasonable starting
  points for this lab's low-traffic demo corpus, not production-tuned
  baselines; a production deployment derives thresholds from observed baseline
  traffic.
- No ATT&CK/ATLAS technique IDs are cited anywhere in these rules. Tactic-
  level `tags:` (e.g. `attack.exfiltration`) are used where confident;
  specific technique IDs are left out rather than guessed, matching the
  discipline established in `docs/threat-model.md`.
- `validate.ts` is a scoped Sigma-subset evaluator (plain equality incl.
  Sigma's list-field "any element equals" semantics, `|contains` and
  `|startswith` on string fields, OR-lists, plus `event_count` correlation)
  it supports exactly the constructs these 8 rules use, not the full Sigma
  spec, and throws rather than silently mis-evaluating anything outside that
  (an unsupported modifier, `|contains` on a non-string field, a chained
  modifier). A production deployment converts these rules via `pySigma`/`sigma-cli`
  to a specific SIEM backend query language; this harness exists to prove
  the detection *logic* is sound against captured data before that conversion,
  which schema validation alone doesn't do.
- The matcher is case-sensitive; Sigma string matching is case-insensitive
  by default. Stricter-than-spec, so a passing true positive here still
  holds against a backend, but a case-variant true negative isn't
  exercised.

## Running the validator

```bash
bun detections/validate.ts
```

Exits 0 only if every rule's detection logic produces both a true-positive
match and a true-negative non-match against its fixtures. For a correlation
rule this means three checks: the burst crosses the threshold, the
historical-only slice of the same fixture stays under it, and the
burst trimmed to exactly one event short of the threshold also stays under
it (proves the comparison is an exact boundary, not just "big beats small").
