---
name: add-ilm-policy
description: Add or modify an ILM policy in IaC. Uses the §3.1 classic 4-phase or §3.6 Path B template depending on stream characteristics. Validates drift, anti-patterns, and target indices first.
inputs:
  cluster: { type: string, required: true }
  policy_name: { type: string, required: true }
  pattern: { type: string, required: true }              # "classic-4phase" | "path-b" | "custom"
  phases_override: { type: object, required: false }     # only when pattern: custom
  target_indices_pattern: { type: string, required: true }
  delete_after_days: { type: number, required: true }
---

# Add or modify ILM policy

Source of truth: `knowledge/playbook/3-index-lifecycle-management-ilm.md` §3.1–§3.6, §9.1.

## Decision: which pattern

Read the playbook chapter first — it carries the canonical JSON. Quick guide:

- **§3.1 classic 4-phase** — use when the stream writes > 10 GB/day per shard and has a clear warm query window. Default for eu-cld/us-cld application logs. Rollover 25 GB / 1 day, warm at 3d with forcemerge+shrink, cold at 10d, frozen at 30d, delete at 90d.
- **§3.6 Path B (consolidated)** — use when primary shard size at warm entry is < 5 GB, OR the estate has > 20 similar policies to unify, OR the stream has no concurrent heavy search load. Warm phase does allocation + priority only; merge happens at frozen transition via `force_merge_index: true`. Cheaper, simpler, fewer rollover jams.
- **Custom** — only with explicit user spec. Cite which standard pattern it diverges from and why in the MR body.

## Pre-flight

1. `elasticsearch_ilm_get_lifecycle` → does this policy name exist? If yes, this is a MODIFY (state in MR title).
2. `elasticsearch_list_indices` matching `target_indices_pattern` → confirm what this policy will attach to. If > 50 indices, recommend staggering (don't roll out to all at once).
3. **§3.4 drift check** — if the policy name matches one of the 8 built-ins that auto-revert on upgrade (`metrics`, `logs`, `synthetics`, `profiling`, `@lifecycle`, `ilm-history`, `watch-history`), warn the user and prefer a custom-named policy. Built-ins revert silently on stack upgrade.
4. **Retention-fleet template gotcha** — `GET _index_template/*nonprod-retention*`. Any priority-251 template with an empty body silently inherits the prod 90d policy. Flag separately in the MR; do not bundle the fix.
5. **§3.3.1 cold-migration pre-flight** (only if introducing a new cold phase or shortening cold min_age):
   - `GET _snapshot/found-snapshots/_status` is green.
   - Cold-tier disk < 70% used.
   - Autoscaling ceiling above current + expected migration: `GET _autoscaling/capacity`.
   - Do not flip cold min_age on > 2 policies the same day.

## §3.5 anti-patterns — refuse to write

The agent must refuse to draft an MR that introduces any of:

| Anti-pattern | Refusal message |
|---|---|
| Rollover threshold < 5 GB on a stream writing > 1 GB/day | "2 GB rollover floor caused us-cld shard sprawl (IR-028); raise to ≥ 10 GB" |
| Forcemerge in warm on shards likely < 2 GB at warm entry | "shard-size-at-warm-entry is below 5 GB — use Path B instead" |
| New policy without a delete phase | "every policy must have an explicit delete phase" |
| Policy lacks any non-default name and matches a built-in | "use a custom-named policy; built-ins auto-revert on upgrade (§3.4)" |
| Multiple small policies with identical phases | "collapse to a single shared policy aliased via template" |

## Build the diff

Stack module path: `stacks/<cluster>/ilm.tf`.

For Terraform, the resource is typically:

```hcl
resource "elasticstack_elasticsearch_index_lifecycle" "<policy_name>" {
  name = "<policy_name>"
  # Paste the JSON body from knowledge/playbook/3-index-lifecycle-management-ilm.md §3.1 or §3.6
  # Substitute only: max_primary_shard_size, min_age values, delete_after_days
}
```

Cite the playbook section in a `# ref:` comment above the resource block so future readers know which pattern this implements.

## Open the MR

Use the `open-mr` skill. MR-template category: `ilm`. Risk default MEDIUM; HIGH for retention reduction (delete_after_days going down). Body must include:

- Pattern: classic-4phase / path-b / custom (and why)
- Resulting total retention (recompute the rollover + min_age math)
- Drift-check evidence (built-in names checked)
- Target index count and largest 5 streams in `target_indices_pattern`
- Anti-pattern check: PASS

## §9.1 — Post-apply validation (in MR body)

- `GET _ilm/policy/<name>` — phases match intent.
- `GET _ilm/explain/<pattern>` — target indices picked up new phases, no errors in `step_info`.
- Watch phase transitions for 24–48h.
- Cluster stays GREEN.
- Ingest rate unchanged ±5% (a drop means a stream stopped being written).

## Risks to surface

- Frozen phase pull-in can trigger a force-merge stampede in warm — lower frozen min_age in stages, not all at once.
- ILM age counter is based on rollover date, not current time — changes take effect as each index progresses, not immediately.
- For shrinking retention: cite which IR (issue register) row drove the decision; data is irrecoverable once delete fires.

## Hand off

Open MR via `open-mr` skill. Stop.
