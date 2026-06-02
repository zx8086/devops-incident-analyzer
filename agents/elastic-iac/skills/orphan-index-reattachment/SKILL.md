---
name: orphan-index-reattachment
description: Reattach indices whose index.lifecycle.name is unset back to the appropriate ILM policy, after ruling out enrich-source false positives.
inputs:
  cluster: { type: string, required: true }
  index_pattern: { type: string, required: true }
  target_policy: { type: string, required: true }
outputs:
  reattached_indices: { type: array }
---

# Orphan index reattachment

Source: `Elastic_Optimisation_Playbook_v12.docx` §3.8.

## Why / Pattern

Symptom: indices matching a known pattern have `index.lifecycle.name` unset. Observed on eu-b2b (14 indices) and on eu-cld (`storewatch-*` which turned out to be enrich sources — see §6.3 before reattaching).

Before reattaching anything, check §6.3 (Enrich policy source discovery — do not delete before checking). If the "orphan" is an enrich source it is correctly unmanaged; reattaching it to an ILM policy with a delete phase will destroy the enrich data.

## Detect (§3.8.1)

```
GET _cat/indices/<pattern>*?h=index,ilm.policy&v
# Filter rows where ilm.policy is blank or 'null'
```

For each candidate, confirm it is not an enrich source: `GET _enrich/policy` and look for any `indices` entry referencing the index.

## Reattach (§3.8.2)

```
PUT <index>/_settings
{
  "index.lifecycle.name": "<target-policy>",
  "index.lifecycle.rollover_alias": "<alias>"
}
```

Rules:

- The ILM age counter resets to 0 at reattachment — keep this in mind for delete timing on already-old data. If the index is already past its target retention, plan a manual delete instead of relying on ILM to catch up.
- Always reattach to the same policy the new indices in that stream are using — diverging policies cause split retention.
- For data-stream backing indices, prefer fixing at the data-stream level so future backing indices inherit correctly.

## Validation

```
GET <index>/_ilm/explain
```

Expect `policy` populated and `phase` one of `hot|warm|cold|frozen` (not `null`). Re-check 24h later that the index is progressing through phases as expected. Cross-ref §9.1 validation checklist.

## Hand off

Record reattached index list and target policy in `memory/runtime/context.md`. If the orphan root cause was a missing index template, open MR via `open-mr` skill to add it. Stop.
