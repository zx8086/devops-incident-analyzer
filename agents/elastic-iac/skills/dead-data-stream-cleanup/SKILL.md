---
name: dead-data-stream-cleanup
description: Detect and remove data streams whose application stopped writing, where ILM keeps rolling empty write indices forever.
inputs:
  cluster: { type: string, required: true }
  stream_pattern: { type: string, required: false }
outputs:
  removed_streams: { type: array }
---

# Dead data stream cleanup

Source: `Elastic_Optimisation_Playbook_v12.docx` §3.7.

## Why / Pattern

Symptom: a data stream has an empty write index rolling over every day. Observed on eu-b2b (19 deprecated streams).

Cause: application stopped writing but the data stream was never deleted. ILM keeps rolling the empty write index because `max_age` fires.

## Detect (§3.7.1)

```
GET _data_stream/*?filter_path=data_streams.name,data_streams.generation,data_streams.indices.index_name

# Cross-reference against indices with 0 docs in last 7 days:
GET _cat/indices/.ds-*?h=index,docs.count,creation.date&s=creation.date&format=json
```

A high generation number combined with a write index of 0 docs is the canonical fingerprint.

## Remove (§3.7.2)

1. Confirm with stream owner the application is gone — check Fleet agent policies, CI job schedules, Boomi processes. Do not delete before owner confirmation.
2. If managed by ILM, move the write index to a terminal step first so ILM does not fight the delete:

   ```
   POST _ilm/move/.ds-<stream>-2026.04.21-000042
   {
     "current_step": { "phase": "hot",   "action": "rollover", "name": "check-rollover-ready" },
     "next_step":    { "phase": "delete","action": "delete",   "name": "delete" }
   }
   ```

3. Delete the data stream:

   ```
   DELETE _data_stream/<stream-name>
   ```

4. Verify no matching index templates will re-create it on next ingest. Audit `_index_template/*` for any `index_patterns` that would match.

## Validation

Re-run the detect query — the stream should not reappear. Watch `_cat/indices` for 24h: no new `.ds-<stream>-*` backing index should be created. If one is, an upstream producer is still alive or a Fleet integration is rehydrating it; abort and re-investigate before re-deleting.

Cross-reference §9.1 (After an ILM policy change) for any downstream policy-level validation if the stream was tied to a custom policy.

## Hand off

Open MR via `open-mr` skill if the change is recorded in IaC (deleting a stream from a managed template list). Update `memory/runtime/context.md` with the removed stream names and the owner who confirmed retirement. Stop.
