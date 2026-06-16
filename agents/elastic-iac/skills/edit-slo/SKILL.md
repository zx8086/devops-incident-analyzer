---
name: edit-slo
description: Edit an EXISTING SLO's objective target / time-window / tags in IaC (read-modify-write the per-SLO JSON override + open an MR). Does NOT create SLOs. Lowers-the-bar edits are flagged.
inputs:
  cluster: { type: string, required: true }
  slo_name: { type: string, required: true }              # SLO file basename, e.g. "ds-authentication"
  slo_target: { type: number, required: false }           # 99.5 (percent) or 0.995 (fraction)
  slo_window: { type: string, required: false }           # duration string, e.g. "60d"
  slo_tags: { type: array, required: false }              # full new tag array (replaces file-level tags)
---

# Edit an SLO target / window / tags

Source of truth: `environments/<cluster>/slos/<slo>.json` — ONE file per SLO. Each file inherits `objective.target`, `time_window`, `budgeting_method`, `settings` from `environments/_shared/slo-defaults.json`; an edit OVERRIDES a nested block in the per-SLO file.

```json
// per-SLO file (inherits defaults; no objective block by default):
{ "name": "...", "space_id": "developer-experience", "tags": [...], "indicator": { "type": "synthetics_availability", "monitor_id": "...", "monitor_display_name": "..." } }
// _shared/slo-defaults.json:
{ "budgeting_method": "occurrences", "objective": { "target": 0.99 }, "time_window": { "duration": "30d", "type": "rolling" }, ... }
```

## Merge semantics (CRITICAL)

The `modules/slo` module shallow-merges PER nested block: `objective = merge(defaults.objective, file.objective)`. So:
- To set the target, write `"objective": { "target": 0.995 }` in the per-SLO file. (objective only holds target + optional timeslice fields, so a shallow override loses nothing.)
- To change the window, write `"time_window": { "duration": "60d", "type": "rolling" }` — include `type` (shallow merge replaces the whole block).
- `tags` REPLACE the file-level tags; the module then concats the `managed-by:terraform` default.

`slo_target` accepts a percent (99.5) or a fraction (0.995) — values > 1 are treated as percent and divided by 100, then stored as the 0-1 fraction the config uses.

## The change (read-modify-write)

1. Read `environments/<cluster>/slos/<slo>.json` via `gitlab_get_file_content`. A 404 means the SLO file doesn't exist — STOP (creating a new SLO is out of scope for this skill; it needs the indicator block + the module's monitor_id UUID guard).
2. Set the requested override block(s). Leave the indicator, name, space_id, and unrelated blocks untouched. Preserve 2-space indent + trailing newline.
3. Commit to a branch + open the MR. CI plans on the MR; a human merges and applies.

## Risk

- Target/window/tags edits = **MEDIUM**. They do NOT delete data, but they change error-budget burn-rate and alerting behavior as the new objective takes effect.
- **Lowering the target** (e.g. 0.995 -> 0.99) relaxes the reliability bar and widens the error budget — surface this as a leading risk line and confirm it's intended.
- A synthetics SLO goes through `restapi` (Mastercard provider); the JSON you edit is the same regardless of transport.

## Anti-patterns — refuse to write

- Creating a NEW SLO file (out of scope — use a creation skill once it exists; it must set the indicator + pass the module's monitor.id UUID guard at `modules/slo/main.tf`).
- Renaming an SLO (changing `name`) — that can orphan the live SLO; flag and decline unless explicitly confirmed.
- A target ≥ 1.0 (100%) or ≤ 0 — physically impossible error budget; refuse.

## MR body

Use `knowledge/mr-template.md` headings. Category: `slo`. Risk: MEDIUM (HIGH framing if lowering the bar materially). State the resolved override (`ds-authentication: objective.target 0.99 -> 0.995`), the single file touched, and the rollback (revert the MR).
