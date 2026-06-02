---
name: stream-consolidation-via-reroute-processor
description: Consolidate per-namespace Fleet data streams into one stream per subtype using a reroute processor wired via @custom hooks.
inputs:
  cluster: { type: string, required: true }
  integration: { type: string, required: true, default: kubernetes.state }
outputs:
  streams_collapsed: { type: integer }
---

# Stream consolidation via reroute processor

Source: `Elastic_Optimisation_Playbook_v12.docx` §6.7.

## Why / Pattern

A Fleet integration creates one data stream per resource type per namespace. With 9 namespaces × 16 resource types, that is ~85 streams just for `kubernetes.state_*`. Consolidating to one stream per resource type with namespace as a field reduces stream count ~9x and proportionally reduces backing index count.

## The consolidation pipeline (§6.7.1)

```
PUT _ingest/pipeline/metrics-kubernetes.state-consolidate
{
  "description": "Consolidate per-namespace kubernetes.state_* streams into one stream per subtype.",
  "processors": [
    { "set": { "field": "labels.environment",        "copy_from": "data_stream.namespace", "ignore_empty_value": true, "override": false } },
    { "set": { "field": "orchestrator.cluster.name", "copy_from": "data_stream.namespace", "ignore_empty_value": true, "override": false } },
    {
      "reroute": {
        "namespace": "default",
        "if": "ctx?.data_stream?.dataset != null && ctx.data_stream.dataset.startsWith('kubernetes.state_')"
      }
    }
  ],
  "on_failure": [
    { "set": { "field": "event.kind",    "value": "pipeline_error" } },
    { "set": { "field": "error.message", "value": "{{{ _ingest.on_failure_message }}}" } }
  ]
}
```

## Wire-in via @custom hooks (§6.7.2)

For each subtype (`state_pod`, `state_replicaset`, `state_container`, …):

```
PUT _ingest/pipeline/metrics-kubernetes.state_pod@custom
{
  "processors": [
    { "pipeline": { "name": "metrics-kubernetes.state-consolidate" } }
  ]
}
```

The Fleet integration's native pipeline calls `<dataset>@custom` as a final step, so this insertion is non-invasive and survives package upgrades.

## Risks and rollout (§6.7.3)

1. Audit Kibana dashboards that filter on `data_stream.namespace` before activation — those filters need to switch to `labels.environment`.
2. Convert RBAC roles scoped to specific namespaces by stream name to Document Level Security on `labels.environment`.
3. Inventory ML jobs and update feeds.
4. Roll out one subtype at a time; each `@custom` wiring is independently reversible via `DELETE _ingest/pipeline/<dataset>@custom`.

## Validation

Cross-ref §9.6 (After a reroute pipeline change):

- `GET _cat/indices/.ds-metrics-kubernetes.state_<subtype>-default-*` shows new backing indices created post-wire.
- Per-namespace `.ds-metrics-kubernetes.state_<subtype>-<ns>-*` indices stop growing after rollover.
- Dashboards and ML jobs render against the consolidated stream with no data gaps.

## Hand off

Open MR via `open-mr` skill to record the `@custom` pipeline list in IaC. Update `memory/runtime/context.md` with subtypes consolidated and dashboard owners notified of the `data_stream.namespace → labels.environment` switch. Stop.
