# AGENTS.md

Instructions for AI coding agents and reviewers working in this repository. Human contributors can follow the same rules.

## Repository Map

```
.
├── gateway/            LLM gateway: LiteLLM in front of Ollama, Postgres-backed virtual keys
│   ├── docker-compose.yml     images pinned by sha256 digest; litellm and postgres services
│   ├── litellm_config.yaml    model routes, auth and logging settings
│   ├── sql/gateway-role.sql   creates the non-superuser gateway_app role (run by a superuser)
│   └── scripts/create-key.sh  issues a virtual key through the admin API
├── rag-app/            RAG app: retrieval-time ACL, redaction, guardrails, output leak guard
│   ├── src/ragapp/            cli.py, query.py, ingest.py, db.py, ollama_client.py,
│   │                          redact.py, leakguard.py, audit.py
│   ├── sql/roles.sql          query role, per-scope roles and row-level security on chunks
│   ├── corpus/                test documents and users.yaml (users and allowed ACL scopes)
│   ├── tests/                 unit tests (unittest-compatible)
│   ├── pyproject.toml         dependencies and the security floor for cryptography
│   └── requirements-lock.txt  hash-pinned lock (pip-compile)
├── ci-cd/              merge gates and red-team suites
│   ├── acl-redteam/harness.ts       CLI-level ACL, injection, guardrail, audit and privilege checks
│   ├── redteam/                     promptfoo suites (gate, baseline, guardrail) and their prompt files
│   ├── scripts/                     model-artifact policy, model lock, compose image listing, ModelScan gate
│   └── models.lock.json             pinned model digests
├── detections/         Sigma rules for gateway and RAG app logs
│   ├── rules/                 8 rules
│   ├── samples/               captured log fixtures
│   └── validate.ts            replays fixtures against the rules
├── docs/               threat model, model cards, data card
├── .github/            ci.yml (SHA-pinned actions), dependabot.yml, actionlint.yaml
└── .trivyignore.yaml   dated, time-boxed vulnerability exceptions
```

Each component directory has its own `README.md`. `docs/threat-model.md` records the findings and the status of each fix.

Commands (run from the repository root):

| Purpose | Command |
|---------|---------|
| Validate detection rules against fixtures | `bun detections/validate.ts` |
| Check rules with the Sigma reference implementation | `pipx run sigma-cli check detections/rules/` |
| RAG app unit tests | `python -m pip install --require-hashes -r rag-app/requirements-lock.txt`, `python -m pip install --no-deps -e rag-app`, then `python -m unittest discover -s rag-app/tests -v` |
| ACL and privilege harness | `bun ci-cd/acl-redteam/harness.ts` (needs Postgres with pgvector, a superuser `RAGAPP_DATABASE_URL`, and `psql` 15+ or `RAGAPP_PG_CONTAINER`) |
| Red-team prompt drift checks | `bun ci-cd/redteam/sync-prompt.ts --check` and `bun ci-cd/redteam/sync-guardrail-prompt.ts --check` |
| Guardrail sync script tests | `bun test ci-cd/redteam/sync-guardrail-prompt.test.ts` |
| Compose and workflow images pinned by digest | `bun ci-cd/scripts/list-compose-images.ts` and `bun test ci-cd/scripts/list-compose-images.test.ts` |
| Key-creation script | `bun test gateway/scripts/create-key.test.ts` (needs bash, curl, jq) |
| Model lock validation | `bun ci-cd/scripts/validate-models-lock.ts` |

The live red-team suites need network access to `LLM_HOST`. The `redteam-live` CI job is skipped on repositories without a runner for it.

## Code Style and Conventions

- **Languages.** Tooling, harnesses and scripts are TypeScript run with Bun (`bun`, `bunx`). Python is limited to `rag-app/`. Shell is limited to `gateway/scripts/`. SQL lives in `sql/` directories.
- **Dependencies.** Python dependencies are declared in `rag-app/pyproject.toml` and locked with hashes in `rag-app/requirements-lock.txt`. Install with `--require-hashes`. GitHub Actions are pinned by commit SHA. Container images (the compose file and workflow services) are pinned by sha256 digest, and `ci-cd/scripts/list-compose-images.ts` fails on a runtime image (compose `services.*.image`, workflow `services.*.image`, `container`, `docker://` steps) that is not a static string pinned by digest, or on a workflow digest that differs from the compose digest. `bunx` tools are pinned to an exact version.
- **Fail loud.** Validators, harnesses and checks throw on any input they do not handle. A check names a positive control or an exact expectation, and the harness fails when fewer checks ran than expected (`EXPECTED_CHECKS` in `ci-cd/acl-redteam/harness.ts`). Do not add fallbacks that turn an unknown case into a pass.
- **Tests.** Behavior changes come with a test in the same change. Do not weaken, skip or delete an assertion to make a test pass. Negative tests assert the exact error (for example, SQLSTATE `42501`).
- **Generated files.** `ci-cd/redteam/prompt.json` and `prompt.guardrail.json` are generated from `rag-app/src/ragapp/query.py` and `ollama_client.py`. Edit the source, then run the matching `sync-*.ts` script. CI checks for drift.
- **SQL scripts.** Scripts in `sql/` are idempotent, take secrets from environment variables through `\getenv`, and fail when a required variable is missing or empty.
- **Secrets.** Configuration comes from environment variables. `.env.example` files hold placeholders. `.env` is gitignored.
- **Placeholders.** Documentation refers to `LLM_HOST` and `CI_RUNNER`. Do not add host names, IP addresses, account names or file-system paths from a specific machine.
- **Documentation.** State facts. Do not use emphasis, assurance or contrast framing ("honest", "real", "actually", "genuinely", "already", "not X, but Y"). Do not use em dashes in prose; use a colon, semicolon, comma or parentheses. Em dashes inside test inputs and model prompts are functional text and stay as written: the system prompt in `rag-app/src/ragapp/query.py`, `ci-cd/redteam/prompt.json`, `ci-cd/redteam/tests.yaml` and the corpus titles. Changing them requires re-running the live gate.
- **Comments.** Comments explain a constraint or a reason that the code does not show. Match the density and wording of the surrounding file.
- **Commits.** Messages describe what changed and why in plain sentences. Keep unrelated changes in separate commits.

## Guardrails and Boundaries

### 🟡 ASK FIRST:
* Ask for human approval before modifying anything.
* Ask before introducing any new external dependencies.
* Never hardcode API Keys, secrets, or JWT tokens.

### ✅ Always:
* Run the checks listed above that cover the files you changed, and report the output.
* Keep image digests, action SHAs and lock hashes intact; update them only through the lock or Dependabot workflow.
* Update the matching documentation (`README.md`, `docs/threat-model.md`) when behavior, privileges or test counts change.
* Keep the retrieval-time ACL (`WHERE acl = ANY(...)`, row-level security and the role switch in `db.search`) in place for every query path.
* Report what was not verified, and why.

### 🚫 Never:
* Commit `.env` files, credentials, tokens, private keys or captured logs that contain them.
* Replace placeholders with real host names, IP addresses or account identifiers.
* Weaken, skip or delete a test, assertion or CI gate to get a green result.
* Bind the gateway, Ollama or Postgres to `0.0.0.0` or any public address, or publish their ports.
* Trigger `redteam-live` from `pull_request` events. It runs on a self-hosted runner and is limited to pushes to `main`.
* Use floating image tags (`latest`, `main-stable` without a digest) or unpinned actions.
* Run `DROP`, `TRUNCATE` or `DELETE` against a database outside the test harness and `ingest`.
* Add an exception to `.trivyignore.yaml` without an expiry date and a reason.

## Code Review

When reviewing a change, use this brief:

```
Review this PR as a senior platform/security engineer.

Look for:
- security vulnerabilities
- authentication/authorization mistakes
- secrets or sensitive data exposure
- unsafe network behavior
- race conditions
- resource leaks
- missing error handling
- failure-mode problems
- infrastructure/configuration drift
- backwards compatibility issues
- insufficient logging/observability
- missing tests
- unnecessary complexity

Prioritize issues that could cause production incidents.
For every finding, explain the failure scenario and point to the relevant code.
Do not report stylistic issues unless they materially affect maintainability or correctness.
```
