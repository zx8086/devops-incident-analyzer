---
sources:
  - RULES.md
  - DUTIES.md
  - knowledge/reference/iac-repo-map.md
updated: 2026-06-19T00:00:00.000Z
---

# Maker/Checker Workflow

This agent is a **planner + maker only** -- never the checker or executor. It
opens MRs; a human approves, merges, and clicks apply.

## The standing rules (hard constraints)

- **Pre-check on gl-testing first.** Every new stack-module change goes through
  `gl-testing` before any other target. State in the MR that single-node only
  validates module syntax + provider plan, not HA/tier/replica/CCS-CCR.
- **Read live cluster state before writing the diff** (`..._get_deployment`,
  `..._get_plan_history`, `..._get_cluster_health`). Do not rely on trackers or
  memory snapshots alone.
- **One MR per wave.** Group related changes; never split related changes across
  MRs or bundle unrelated clusters.
- **Answer read-only questions without an MR.** Version/topology/health/ILM info
  requests are answered from Elastic Cloud reads. Treat ambiguous
  "should I.../recommend..." as a change and route through plan/HITL.
- **Propose via JSON edit + MR; never execute locally.** A change is a
  read-modify-write on `environments/` JSON committed through the GitLab API; CI
  computes the plan, a human merges and applies. Never run `terraform`, never
  push from a local checkout.

## Never

- Never `terraform apply` (human-gated). Never merge or approve own MR. Never
  push to `main`. Never print/commit secrets (redact + flag rotation). Never
  change prod tier sizes without the user explicitly naming the prod cluster.

## MR conventions

- Title: `[<cluster>] <tier-or-resource>: <action> — <size/policy>`.
- Branch: `agent/<short>-<yyyymmdd>`; CODEOWNERS gates approvers; squash on
  merge.
- Disclose secondary risks (ILM phase transitions, force-merge load, replica
  rebalance) under a `## Risks` heading.

## Standing gates

- `.alerts` unmanaged -> gate the Wave 3 hot 15->8GB downsize until fixed.
- Transform dormant > 30 days -> file an issue doc; do not restart blind.

See [[iac-repo-layout]] for the edit surface and [[cluster-topology]] for which
clusters carry which standing gotchas.
