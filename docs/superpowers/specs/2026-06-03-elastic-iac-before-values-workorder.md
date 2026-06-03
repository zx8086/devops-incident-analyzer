# elastic-iac work order: emit terraform-plan `before` values in drift-report.json

- Target repo: `siobytes/elastic-iac` (GitLab project id 71488350)
- Owner: elastic-iac team
- Consumer: devops-incident-analyzer agent (SIO-889, Approach B) — PR #187
- Companion design: `docs/superpowers/specs/2026-06-03-live-reconcile-multistack-design.md`
- Status: DELIVERED (elastic-iac commit `0f845a3`, 2026-06-03) — retained for reference. Note: implemented in `scripts/drift-check.ts` + `scripts/drift-values.ts`, not `tf-report.jq` as assumed below; the field contract matches.

## Why this is needed

The incident agent's **Reconcile to Live** rewrites repo config JSON to match the live cluster. For the `deployments` + `lifecycle-policies` stacks it reads live state from ES/EC APIs directly. To extend it to the Kibana-backed stacks (`dataviews` first, then `alerting`, `agent-policies`, `fleet-integrations`, …), the agent needs the **live values** — which the drift-check `terraform plan` already computed (the provider refresh *is* the live read). Today the `drift-report.json` the agent consumes drops those values and keeps only the changed key *names*. This work order adds the live (`before`) values to the report.

The agent cannot get these values any other way: there is no Kibana read tool in its MCP servers, and it only ever receives `drift-report.json` (never the raw plan).

## Current report shape (what the agent parses today)

Produced by `scripts/tf-report.jq` -> `drift-report.json`:

```json
{
  "has_actionable_drift": true,
  "totals": { "create": 0, "update": 1, "destroy": 0, "replace": 0, "noop": 17, "known-noise": 0 },
  "resources": [
    {
      "address": "module.alerting...[\"foo\"]",
      "category": "update",
      "actions": ["update"],
      "changedKeys": ["schedule"],
      "reason": "..."
    }
  ]
}
```

## Required change (additive)

For each `resources[]` entry that is an `update` or `replace` (i.e. has `changedKeys`), add a `values` object keyed by the **same `changedKeys`**, carrying the live (`before`) and declared (`after`) values, narrowed to those changed keys:

```json
{
  "address": "module.alerting...[\"foo\"]",
  "category": "update",
  "actions": ["update"],
  "changedKeys": ["schedule"],
  "values": {
    "schedule": { "before": { "interval": "5m" }, "after": { "interval": "1m" } }
  },
  "reason": "..."
}
```

- `before` = **live** (current cluster value) — this is the reconcile-to-live source the agent writes back.
- `after` = **declared** (repo) — optional but useful for the agent's empty-diff guard and MR summary.
- Narrow to `changedKeys` only. Do **not** dump whole `before`/`after` objects (size + secret exposure).

## Hard requirements

1. **Additive / backward compatible.** All existing fields unchanged; `values` is new and optional. The agent tolerates its absence (reconcile-to-live for that stack simply stays unavailable — no regression). Safe to roll out independently.
2. **Secret redaction (REQUIRED).** The terraform plan marks sensitive values via `before_sensitive` / `after_sensitive`. Any key flagged sensitive (at the key level or nested) MUST be emitted as a sentinel (e.g. `"<redacted:sensitive>"`), never raw. Stacks such as `action-connectors`, `security`, and `siem` carry tokens/secrets; the report is a CI artifact read by the agent, so raw secrets must not leak. When unsure, redact.
3. **Size cap.** Cap each emitted value (e.g. if a serialized key value exceeds ~8 KB, replace with `"<omitted:too-large>"`) and keep the overall report within the size the agent already consumes. The largest drifting stack today is `agent-policies`.
4. **Actionable updates only.** No `values` for `create` (no live `before`), `destroy`, `noop`, or `known-noise`.
5. **Exact key alignment.** `values` keys MUST match the `changedKeys` strings exactly (same normalization you already use), so the agent can line them up 1:1.

## Suggested jq (starting point — adapt to the existing tf-report.jq)

Assuming the source is `terraform show -json <plan>` exposing `.resource_changes[]`. Reuse your existing `changedKeys` computation rather than re-deriving keys; this only shows the narrowing + redaction:

```jq
def redact($sensitive): if ($sensitive == true) then "<redacted:sensitive>" else . end;

# Per changed resource, build values{} for the already-computed $changedKeys:
($res.change.before // {})           as $before
| ($res.change.after  // {})         as $after
| ($res.change.before_sensitive // {}) as $bsens
| ($res.change.after_sensitive  // {}) as $asens
| reduce $changedKeys[] as $k ({};
    .[$k] = {
      before: ($before[$k] | redact($bsens[$k])),
      after:  ($after[$k]  | redact($asens[$k]))
    })
```

Add the resulting object as `values` on each emitted resource. (Apply the size cap from requirement 3 when serializing each value.)

## Acceptance criteria

- A `dataviews` drift on a sandbox deployment (e.g. `gl-testing`) yields a `drift-report.json` where each updated resource has `values[<changedKey>].before` equal to the live cluster value.
- A resource with a sensitive changed key shows `"<redacted:sensitive>"`, never the raw secret.
- The existing consumer keeps working: all pre-existing fields are byte-identical in shape; only the new optional `values` is added.
- Report size on the largest drifting stack stays within current limits.

## Out of scope (handled in devops-incident-analyzer, not this repo)

- `parseDriftReport` reading the optional `values` map.
- The per-stack projection mapping `values[*].before` (provider-schema) onto the repo JSON config file shape.
- The gate/label changes. Until this report change ships, reconcile-to-live stays unavailable for these stacks (no regression).
