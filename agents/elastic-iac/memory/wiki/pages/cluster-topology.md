---
sources:
  - knowledge/reference/cluster-inventory.md
  - knowledge/reference/conventions.md
updated: 2026-06-19T00:00:00.000Z
---

# Cluster Topology

Re-query Elastic Cloud on bootstrap; this page is for naming and intent, not
ground truth. Live in-flight state lives in `memory/runtime/context.md`.

## Live cluster set

- `gl-testing` -- IaC pre-check sandbox. Single-node, ~$37/mo. The mandatory
  first target for every change. Does NOT validate HA, tiering, replicas, or
  CCS/CCR.
- `eu-b2b` (+ `eu-b2b-dev`, `eu-b2b-stg`) -- primary EU B2B observability.
  Tiered hot/warm/cold/frozen with active ILM optimisation in progress.
- `eu-cld` (+ `eu-cld-monitor`) -- EU consumer/D2C.
- `us-cld` (+ `us-cld-monitor`) -- US consumer/D2C.
- `ap-cld` (+ `ap-cld-monitor`) -- APAC consumer/D2C.
- `eu-onboarding`, `gl-cld-reporting` -- supporting clusters.

## Standing gotchas (re-read before acting)

- **Frozen tier capacity:** `nodes_stats fs` shows the local LRU cache and is
  expected to fill -- it is not a capacity signal. True capacity is the Elastic
  Cloud console "Searchable object storage".
- **Single-node Fleet YELLOW:** on `gl-testing`, Fleet/system streams report
  YELLOW from `auto_expand_replicas: 0-1` inherited from `<type>@settings`. Not
  a fault; verify on the newest backing index, do not hunt for `@custom`
  overrides (empty by design).
- **eu-cld secret exposure:** WebSphere `process.command_line` logged
  `spi.password`/JWKS in plaintext. Forward redaction is deployed via
  `logs@custom`; historical logs still expose -- flag credential rotation in any
  MR touching eu-cld logs.
- **Validation scoping:** only flag tracker rows whose `Cluster` matches the
  cluster currently connected via MCP. Do not raise findings for other clusters.
- **Plan history beats trackers:** `elasticsearch_cloud_get_plan_history` is the
  source of truth for tier changes; tracker rows can lie, especially on reversed
  (downsize-then-upsize) tiers.

See [[iac-repo-layout]] for where these clusters' config lives and
[[maker-checker-workflow]] for how a change ships.
