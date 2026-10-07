# Security Policy

## Scope

This repository is a lab: a gateway, a RAG application, CI gates and detection rules, run on the maintainer's own infrastructure. It is not a deployed product. Only the `main` branch is maintained.

Reports about the code, the CI configuration, the detection rules, or the documented guarantees are in scope. Findings already recorded in [docs/threat-model.md](docs/threat-model.md) with a status of mitigated or open are known; a new bypass of a recorded mitigation is in scope.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the Security tab of this repository and choose "Report a vulnerability". Do not open a public issue or pull request for a vulnerability.

Include the affected file or component, the steps to reproduce, and the observed and expected behavior. Do not include real credentials or personal data.

Reports are handled by a single maintainer. No response time is guaranteed.
