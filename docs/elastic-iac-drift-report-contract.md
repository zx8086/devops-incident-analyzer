# `drift-report.json` enrichment contract for the incident agent

A self-contained specification for the `observability-elastic-iac` team. It describes the data contract
between the drift-check pipeline and the devops incident-analyzer agent, what has already shipped,
and one proposed additive change. You can implement the proposed change from this document alone.

| | |
|---|---|
| **Target repo** | `pvhcorp/dhco/observability/observability-elastic-iac` (GitLab project id `82850717`) |
| **Producer** | `scripts/drift-check.ts --format=json` + `scripts/drift-values.ts` (redaction) -> `drift-report.json` |
| **Consumer** | the devops incident-analyzer agent (reads `drift-report.json` only; never the raw `terraform plan`) |
| **Increment 1 — `values`** | DELIVERED (commit `0f845a3`) |
| **Increment 2 — `changes[]`** | PROPOSED (this document) |
| **Compatibility** | every change here is additive and backward-compatible |

---

## 1. Background — why the report needs more than `changedKeys`

The incident agent consumes **only** `drift-report.json` (the drift-check pipeline artifact). It
never receives the raw `terraform plan`, and it has no Kibana/Elasticsearch read path of its own for
these stacks. It uses the report for two things:

1. **Explain drift to a human** in a chat/drift UI — one readable line per change.
2. **Reconcile** a stack by opening a merge request — either back toward *live* (write the live value
   into the repo config) or back toward *declared* (re-assert the repo). The agent **never merges or
   applies**; CI computes the plan on the MR.

Both need information that exists only inside the `terraform plan`: the provider refresh during
`plan` already read the live cluster, so the plan carries `before` (live) and `after` (declared) for
every resource. The report must surface that, narrowed and redacted, because the agent cannot get it
any other way.

Increment 1 surfaced the live/declared **values**. Increment 2 surfaces **where, within a large
attribute, the change actually is** — so a single resource whose `inputs` attribute holds 20 monitors
becomes 20 readable changes instead of one opaque "attributes changed: inputs".

---

## 2. Current report shape (baseline)

```json
{
  "has_actionable_drift": true,
  "totals": { "create": 0, "update": 1, "destroy": 0, "replace": 0, "noop": 17, "known-noise": 0 },
  "resources": [
    {
      "address": "module.agent_policies.elasticstack_fleet_agent_policy.this[\"eu-oit-prd\"]",
      "type": "elasticstack_fleet_agent_policy",
      "category": "update",
      "actions": ["update"],
      "changedKeys": ["name"],
      "reason": "attributes changed: name"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `has_actionable_drift` | the single boolean to branch on — already excludes `noop` + `known-noise` |
| `totals` | per-category counts (`known-noise` is the kibana/stack-monitoring churn bucket) |
| `resources[].address` | full Terraform address incl. the module + `for_each` index key |
| `resources[].category` | `create` \| `update` \| `destroy` \| `replace` \| `known-noise` |
| `resources[].actions` | raw Terraform actions, e.g. `["update"]`, `["delete","create"]` (= replace) |
| `resources[].changedKeys` | the top-level attribute names that changed |
| `resources[].reason` | human reason string, e.g. `"attributes changed: name"` |
| `resources[].noiseTag` | present only when `category == known-noise` (e.g. `kibana-churn`) |

---

## 3. Increment 1 — per-changed-key `values` (DELIVERED, commit `0f845a3`)

Documented here so the contract is complete in one place. For each `update` / `replace` resource,
the report carries a `values` object keyed by the **same `changedKeys`**, narrowed to those keys:

```json
{
  "address": "module.agent_policies.elasticstack_fleet_agent_policy.this[\"eu-oit-prd\"]",
  "category": "update",
  "actions": ["update"],
  "changedKeys": ["name"],
  "reason": "attributes changed: name",
  "values": {
    "name": { "before": "eu-oit.prd - SM ", "after": "eu-oit.prd - SM" }
  }
}
```

- `before` = **live** (current cluster value).
- `after` = **declared** (repo value).
- Narrowed to `changedKeys`; whole objects are never dumped.
- Sensitive and oversize values are replaced by sentinels (see section 5).

This is sufficient for scalar / small attributes. It is **not** sufficient when one attribute holds a
collection — that is what Increment 2 addresses.

---

## 4. Increment 2 — path-level `changes[]` decomposition (PROPOSED)

### The problem

Several stacks have resources whose single attribute is a whole collection:

- synthetics monitors batched into one resource's `inputs`,
- a Fleet integration policy's `inputs` (a list of inputs/streams),
- any `for_each` map captured as one attribute.

Today such a drift is reported as `changedKeys: ["inputs"]` with
`values.inputs.{before,after}` carrying the **entire** before/after blob. The agent can only render
"attributes changed: inputs" — it cannot tell the operator **which** of the 20 monitors changed or
**what** changed inside them, and it cannot reconcile at element granularity.

### The change

For each `update` / `replace` resource, **in addition to** `values`, emit a `changes[]` array — a
deterministically-ordered, bounded list of **leaf-level** diffs — plus two envelope fields.

```json
{
  "address": "module.agent_policies.elasticstack_fleet_integration_policy.this[\"eu-mendix-platform-dev-kubernetes\"]",
  "category": "update",
  "actions": ["update"],
  "changedKeys": ["description", "inputs"],
  "reason": "attributes changed: description, inputs",
  "changeCount": 4,
  "truncated": false,
  "changes": [
    { "path": "description", "op": "update",
      "before": "Kubernetes monitoring", "after": "Kubernetes monitoring (prod-aligned)" },
    { "path": "inputs[\"kubelet/metrics\"].streams[\"kubernetes.pod\"].period", "op": "update",
      "before": "10s", "after": "30s" },
    { "path": "inputs[\"kube-state-metrics/metrics\"].enabled", "op": "update",
      "before": true, "after": false },
    { "path": "inputs[\"audit-logs\"]", "op": "remove" }
  ]
}
```

### Field reference

| Field | Required | Meaning |
|---|---|---|
| `changes[].path` | yes | Stable, human-readable locator from the resource root to the changed leaf, e.g. `inputs["audit-logs"].enabled`. **The first segment MUST be one of `changedKeys`**, so the consumer can group `changes[]` under their attribute. |
| `changes[].op` | yes | `update` (exists in both, differs) \| `remove` (in live, not declared) \| `add` (in declared, not live). Direction is fixed: `before` = live, `after` = declared. |
| `changes[].before` | when `op != add` | The **live** leaf value at `path` (scalar or small object). Omitted for `add`. |
| `changes[].after` | when `op != remove` | The **declared** leaf value at `path`. Omitted for `remove`. |
| `changes[].unstableIndex` | optional | `true` when `path` had to use a numeric array index (no stable identity key was available); signals the locator may shift between runs (see section 5.7). |
| `changes[].label` | optional | A short human label when derivable (e.g. a monitor's display name). |
| `changeCount` | yes (with `changes`) | True total leaf changes detected, **before** truncation (lets the UI show "showing 8 of 21"). |
| `truncated` | yes (with `changes`) | `true` when `changes[]` was capped (see section 5.5). |

`values` (attribute grain) stays exactly as in Increment 1 — `changes[]` is the finer view layered on
top, and the coarse fallback when a consumer ignores it.

---

## 5. Hard requirements (apply to both `values` and `changes[]`)

1. **Additive / backward-compatible.** All pre-existing fields stay byte-identical in shape. `values`,
   `changes`, `changeCount`, `truncated`, `unstableIndex` are new and optional. A consumer that does
   not read them keeps working unchanged. Safe to roll out independently.
2. **Direction is fixed.** `before` = live cluster, `after` = declared repo — everywhere (`values` and
   `changes[]`), so the two line up.
3. **Secret redaction (REQUIRED).** The plan marks sensitive values via `before_sensitive` /
   `after_sensitive`. Any leaf flagged sensitive at any nesting level along its path MUST be emitted as
   the sentinel string `"<redacted:sensitive>"`, never raw. Stacks such as `action-connectors`,
   `security`, and `siem` carry tokens/secrets, and the report is a CI artifact the agent reads — raw
   secrets must not leak. **When unsure, redact.**
4. **Per-leaf size cap.** If a single serialized leaf value exceeds ~8 KB, replace it with the sentinel
   string `"<omitted:too-large>"`.
5. **Per-resource change cap + truncation.** Cap `changes[]` at `N` entries (suggest `N = 50`,
   configurable). When the true total exceeds `N`, emit the first `N` (by the deterministic order
   below), set `truncated: true`, and set `changeCount` to the true total. This bounds a pathological
   attribute (hundreds of elements) so the report stays within the size the agent already consumes
   (the largest drifting stack today is `agent-policies`).
6. **Deterministic ordering.** Order `changes[]` by `path` (stable sort) so that two runs over
   identical drift produce identical output and truncation is stable.
7. **Path stability / identity.** For an element inside a collection, prefer a **stable identity key**
   over an array index: use `inputs["<id>"]` keyed by the element's natural identity
   (`name` / `id` / `monitor_id` / `policy_id` / `type`, in that priority) rather than `inputs[3]`.
   Only fall back to a numeric index when no stable key exists, and then set `unstableIndex: true` on
   that entry. (This keeps the door open for a future reconcile that writes back by `path`.)
8. **Actionable updates only.** `values` and `changes[]` are emitted only for `update` / `replace`
   resources (those with `changedKeys`). Do **not** emit them for `create` (no live `before`),
   `destroy`, `noop`, or `known-noise`. For `replace` (`["delete","create"]`), decompose the attribute
   diff the same way as `update`.
9. **Exact key alignment.** `values` keys and the first segment of each `changes[].path` MUST match the
   `changedKeys` strings exactly (same normalization already used), so the consumer can line them up
   1:1.

---

## 6. Suggested implementation (starting point)

The producer is TypeScript (`scripts/drift-check.ts` + `scripts/drift-values.ts`), so this is a
TS-flavored sketch — reuse the same `terraform show -json` parse and redaction/size-cap helpers you
already wrote for `values`. For each changed resource you already compute `changedKeys` from
`resource_changes[].change`. Extend the per-key narrowing to a recursive leaf diff:

```ts
// before = change.before, after = change.after (already parsed for `values`)
// bSens  = change.before_sensitive, aSens = change.after_sensitive (mirror the structure)
// CAP, SIZE_CAP, REDACTED = "<redacted:sensitive>", TOO_LARGE = "<omitted:too-large>"

type Leaf = { path: string; op: "add" | "remove" | "update";
              before?: unknown; after?: unknown; unstableIndex?: boolean };

function leafDiff(path, before, after, bSens, aSens, out: Leaf[]) {
  if (sensitive(bSens) || sensitive(aSens))      // redact whole subtree if flagged
    return push(out, path, "update", REDACTED, REDACTED);
  if (isLeaf(before) || isLeaf(after)) {         // scalar / array-of-scalars / small object
    if (deepEqual(before, after)) return;
    if (before === undefined) return push(out, path, "add", undefined, cap(after));
    if (after === undefined)   return push(out, path, "remove", cap(before), undefined);
    return push(out, path, "update", cap(before), cap(after));
  }
  // object / array-of-objects: recurse, keying by stable identity when possible
  for (const key of unionKeys(before, after)) {
    const seg = identitySegment(before?.[key], after?.[key], key); // -> { seg: 'inputs["id"]'|'[3]', unstable }
    leafDiff(join(path, seg), before?.[key], after?.[key], bSens?.[key], aSens?.[key], out);
  }
}

// then, per resource:
const all = []; for (const k of changedKeys) leafDiff(k, before[k], after[k], bSens[k], aSens[k], all);
all.sort(byPath);
const changeCount = all.length;
const truncated = changeCount > CAP;
const changes = truncated ? all.slice(0, CAP) : all;
// cap(v) = serialize; if > SIZE_CAP bytes -> TOO_LARGE
```

Apply the existing sensitivity + size-cap logic inside `cap(...)` and `sensitive(...)`; reuse your
identity-key resolution if you already have one for addresses.

---

## 7. Worked examples

**(a) Collection attribute — Fleet integration policy `inputs` (the motivating case).**
See the JSON in section 4: `changedKeys: ["description","inputs"]` expands to four leaf changes — a
description edit, two nested stream edits keyed by input id, and a removed input — instead of one
opaque "inputs" line.

**(b) Scalar attribute — the model subsumes the simple case.**

```json
{
  "address": "module.agent_policies.elasticstack_fleet_agent_policy.this[\"eu-oit-prd\"]",
  "category": "update", "actions": ["update"], "changedKeys": ["name"],
  "values": { "name": { "before": "eu-oit.prd - SM ", "after": "eu-oit.prd - SM" } },
  "changeCount": 1, "truncated": false,
  "changes": [ { "path": "name", "op": "update", "before": "eu-oit.prd - SM ", "after": "eu-oit.prd - SM" } ]
}
```

(The live value has a trailing space the repo trimmed — exactly the kind of detail the per-leaf view
makes visible.)

**(c) Sensitive and oversize leaves -> sentinels.**

```json
{
  "address": "module.action_connectors.elasticstack_kibana_action_connector.this[\"slack\"]",
  "category": "update", "actions": ["update"], "changedKeys": ["secrets","config"],
  "changeCount": 2, "truncated": false,
  "changes": [
    { "path": "secrets.webhookUrl", "op": "update", "before": "<redacted:sensitive>", "after": "<redacted:sensitive>" },
    { "path": "config.headers",     "op": "update", "before": "<omitted:too-large>",  "after": "<omitted:too-large>" }
  ]
}
```

---

## 8. Acceptance criteria

Validate on a sandbox deployment (e.g. `gl-testing`):

- A synthetics or `agent-policies` drift yields `changes[]` with **one entry per actually-changed
  leaf**; `changeCount` equals the true total; `truncated` is correct.
- A sensitive changed leaf shows `"<redacted:sensitive>"`, never the raw secret; an oversize leaf
  shows `"<omitted:too-large>"`.
- A pathological resource (more than `N` changed leaves) is capped with `truncated: true`, and the
  overall report stays within current size limits.
- **Backward compatibility:** every pre-existing field is byte-identical in shape; `changes[]`,
  `changeCount`, `truncated`, `unstableIndex` are purely additive.
- **Determinism:** two runs over identical drift produce byte-identical `changes[]` order.

---

## 9. How the agent consumes it (context only)

For your situational awareness — nothing here is a requirement on the producer:

- The agent **tolerates absence** of every optional field; reports without `values` / `changes[]`
  render at today's attribute grain (no regression).
- It groups `changes[]` under their attribute via the first `path` segment (== a `changedKeys` entry),
  and renders bounded "showing X of N" per-leaf lines so an operator sees *which* element changed and
  *what* changed.
- It may use `before` (live) to reconcile a stack toward live, or `after` (declared) to reconcile
  toward the repo, by opening a merge request. The sentinels `"<redacted:sensitive>"` and
  `"<omitted:too-large>"` are recognized and **never written back** into config. The agent never
  merges or applies — CI computes the plan on the MR.
