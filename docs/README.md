# docs

- [`threat-model.md`](threat-model.md): **DONE** - OWASP LLM Top 10 (2025) and MITRE ATLAS mapped against the deployed gateway, with the findings list.
- [`model-cards.md`](model-cards.md): **DONE** - A card per model in use (`local-gemma`, `local-qwen`, `llama-guard3`, `nomic-embed-text`), each grounded in the config and the live test results recorded in `gateway/README.md` and `rag-app/README.md`.
- [`data-card.md`](data-card.md): **DONE** - Covers the synthetic RAG test corpus (including a deliberately planted injection payload) and both audit-log streams (gateway spend logs, RAG app query log), what's collected, what's not, and current retention gaps.
- [`distributed-intent-detection.md`](distributed-intent-detection.md): **DESIGN** - Generic design for detecting malicious intent spread across time, prompts, accounts and intermediate outputs: layers, privacy tiers, response ladder, evaluation harness, CI/CD, and a configuration section that names the groups of settings without values. Nothing in it is deployed.
- [`composition-function.md`](composition-function.md): **DESIGN** - Specification of the composition function: capability primitives, objectives, held capability, progress as a bottleneck, intent evidence kept separate, with a synthetic worked example. Nothing in it is deployed.
