# docs

- [`threat-model.md`](threat-model.md): **DONE** - OWASP LLM Top 10 (2025) and MITRE ATLAS mapped against the deployed gateway, with the findings list.
- [`model-cards.md`](model-cards.md): **DONE** - A card per model in use (`local-gemma`, `local-qwen`, `llama-guard3`, `nomic-embed-text`), each grounded in the config and the live test results are recorded in `gateway/README.md` and `rag-app/README.md`.
- [`data-card.md`](data-card.md): **DONE** - Covers the synthetic RAG test corpus (including a deliberately planted injection payload) and both audit-log streams (gateway spend logs, RAG app query log), what's collected, what's not, and current retention gaps.
