# docs

- [`threat-model.md`](threat-model.md): **done.** OWASP LLM Top 10 (2025) and MITRE ATLAS mapping against the actual deployed gateway, with an honest findings list.
- [`model-cards.md`](model-cards.md): **done.** A card per model actually in use (`local-gemma`, `local-qwen`, `llama-guard3`, `nomic-embed-text`), each grounded in the real config and the live test results already recorded in `gateway/README.md` and `rag-app/README.md`.
- [`data-card.md`](data-card.md): **done.** Covers the synthetic RAG test corpus (including the intentionally planted injection payload) and both audit-log streams (gateway spend logs, RAG app query log), what's collected, what's deliberately not, and current retention gaps.
