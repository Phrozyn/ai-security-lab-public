# ai-security-lab

Portfolio repo demonstrating AI/ML security engineering practices: LLM gateway hardening, RAG-specific defenses, model/pipeline supply-chain integrity, and detection engineering for AI systems. Deploy target is LLM_HOST, a home LLM host running Ollama on an RTX 5070.

> **Placeholders.** This repo documents a real deployment but replaces machine-specific details. `LLM_HOST` is the host that runs Ollama, the gateway and Postgres (reachable only over a private network); `CI_RUNNER` is the self-hosted runner that executes the live red-team job. Substitute your own.

## Components

| Component | Status | Covers |
|-----------|--------|--------|
| [`gateway/`](gateway/) | **Built & deployed** | LLM gateway: virtual-key auth, per-key rate limits/budgets, audit logging (LiteLLM in front of Ollama). Live on LLM_HOST — real chat completion, auth rejection, and audit-log entry all verified. |
| [`rag-app/`](rag-app/) | **Built & tested** | RAG app with retrieval-time ACL enforcement, context redaction, input/output guardrail scanning. [4 live tests](rag-app/README.md#test-results-live-against-the-deployed-system) run against the real deployed system, including an indirect prompt-injection test — see the honest finding on what actually contained it. |
| [`ci-cd/`](ci-cd/) | **Built & verified** | GitHub Actions merge gates: secrets scan, model-artifact policy + ModelScan, Trivy/Syft/Grype container and dependency scanning, a hosted ACL/injection red-team harness against the real RAG app, a live promptfoo suite, and cosign signing. Gates proven to fail on planted violations. Live red-team and signing are built but not yet running — see `ci-cd/README.md`. |
| [`detections/`](detections/) | **Built & verified** | 8 Sigma detection rules for the gateway and RAG app logs, proven against real captured fixtures and independently cross-checked with `pySigma`. See `detections/README.md`. |
| [`docs/`](docs/) | **Done** | [Threat model](docs/threat-model.md) (OWASP LLM Top 10 + MITRE ATLAS against the real deployed system), [model cards](docs/model-cards.md) (every model actually in use), and [data card](docs/data-card.md) (synthetic RAG corpus + both audit-log streams). |

## Deploy target: LLM_HOST

LLM_HOST (`<gateway_ip>:<port>`, RTX 5070, Ollama) is the runtime host. The gateway is live on it: loopback-bound, virtual-key-authenticated, audit-logged. Ollama itself was found LAN-exposed during this build (a leftover from earlier model-storage migration work) and has since been rebound to loopback — see `docs/threat-model.md` for the full finding.

## Build order

1. **Gateway** (done, deployed) — the highest-leverage single artifact; everything else logs through it.
2. **RAG app** (done, tested) — retrieval ACL + redaction + guardrails, live-tested including an injection attempt.
3. **CI/CD pipeline** (done) — SHA-pinned Actions workflow gating every push/PR; negative-tested; live red-team and signing deferred (see `ci-cd/README.md`).
4. **Detections** (done) — 8 Sigma rules against the gateway's and RAG app's logs, fixture-verified and cross-checked with `pySigma`.
5. **Docs** (done) — threat model written early against the real system, now joined by model cards and a data card covering every model and dataset actually in use.
