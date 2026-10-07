# Contributing

This repository is a portfolio project: an LLM gateway, a RAG application with retrieval-time access control, CI gates, and detection rules. Issues and pull requests are welcome.

## How changes reach this repository

This repository is generated from the maintainer's working repository. A script removes machine-specific details and writes the result here. Changes made only here are overwritten by the next sync, so an accepted pull request is applied to the working repository by the maintainer and arrives here in a later sync. The commit that lands on `main` may differ from the pull request commit.

## Before opening a pull request

1. Open an issue first for anything larger than a fix to a single file.
2. Fork the repository and branch from `main`.
3. Run the checks that cover the files you changed. The commands are listed in [AGENTS.md](AGENTS.md#repository-map).
4. Add or update a test in the same change when behavior changes. Do not weaken or skip an assertion to make a test pass.
5. Update the matching documentation (`README.md`, `docs/threat-model.md`) when behavior, privileges or test counts change.

## Conventions

- Tooling is TypeScript run with Bun. Python is limited to `rag-app/`, shell to `gateway/scripts/`.
- GitHub Actions are pinned by commit SHA, container images by sha256 digest, and Python dependencies by hash. Update them through the lock or Dependabot workflow.
- Checks fail on input they do not handle. Do not add a fallback that turns an unknown case into a pass.
- Documentation states facts. It avoids emphasis and assurance wording and uses no em dashes in prose. [AGENTS.md](AGENTS.md#code-style-and-conventions) lists the full rules and the files where em dashes are functional text.
- Documentation refers to `LLM_HOST` and `CI_RUNNER`. Do not add host names, IP addresses, account names or file-system paths from a specific machine.
- Never commit secrets. `.env` files are gitignored and `.env.example` files hold placeholders.

## What runs on a pull request

The CI workflow runs the merge gates on hosted runners: secrets scan, model-artifact policy, container and dependency scanning, detection rule validation, the ACL and privilege harness, and the Python dependency scan. The `redteam-live` job needs a self-hosted runner with access to the model host, so it does not run for pull requests from forks. Workflows from first-time and other external contributors wait for maintainer approval.

## Reporting a security problem

See [SECURITY.md](SECURITY.md). Do not open a public issue for a vulnerability.

## License

Contributions are licensed under GPL-3.0, the license of this repository.
