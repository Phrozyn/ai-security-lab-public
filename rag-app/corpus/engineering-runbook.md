---
doc_id: doc-002
acl: internal
owner: engineering
---

# Acme Robotics — Deployment Runbook (excerpt)

Production deploys go through the `main` branch only, gated on CI passing and
one approving review. Rollbacks are triggered via the `deploy rollback
<version>` command in the internal CLI, which reverts traffic to the last
known-good tag within roughly 90 seconds.

On-call engineers carry the pager for one week at a time. The escalation path
is: on-call engineer → engineering lead → VP Engineering, with a 15-minute
timeout at each stage before escalating.
