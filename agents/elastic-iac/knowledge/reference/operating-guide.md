# Elastic IaC Operating Guide — START HERE

Purpose: a single grounding file to read at the start of any Elastic session so we are always
working from verified facts, not memory. It holds the deployment inventory, the operating
principles for making changes durable, the diagnostic method, and the traps we keep hitting.
It is **not** the issue register or the playbook — those remain the canonical record of specific
issues and step-by-step procedures. This file points to them.

Last grounded against live cluster state: 2026-05-20 (eu-b2b connected).

---

## 1. Deployment inventory (verified via Cloud deployment API)

Always match an alert, email, or AutoOps event to the **deployment ID** before acting. Names and
regions are easy to confuse; IDs are not. Cloud notification emails reference the **Elasticsearch
resource (cluster) ID**, which in older us-east-1 deployments also appears in the deployment URL path.

| Name | Deployment ID | ES cluster ID | Region |
|---|---|---|---|
| eu-b2b | 02655c3733ea471999d9cec39a17df32 | 71bdf337bb454d7ba192142d5a9925cf | aws-eu-central-1 |
| eu-cld | eda974d228284f99b9bd0fe737edf9b8 | 3935ab4a0d944f778c09ad1e1053c8e0 | aws-eu-central-1 |
| eu-cld-monitor | e0d0b78a2c5a4f67872cfe178289b070 | 6e0c520a021b4a4babd8f9029f87c06e | aws-eu-central-1 |
| eu-onboarding | e9187e63042544fbbe5505fec02fc769 | 37cb89c6b7ec4f32b563f8458353621b | aws-eu-central-1 |
| us-cld | 971a5b57d61d494ebf7bc144a5cf27b7 | 33175db28808456ba6545788430036db | us-east-1 |
| us-cld-monitor | 0169212bcb7043a2856a077652db1817 | e0d54b97b6b44402884a3f69f78195c5 | us-east-1 |
| ap-cld | fa4240079abc434f8a8dbd983cbdf4d7 | d0e5e14baddf4a7e9231bf209d061bd6 | aws-ap-east-1 |
| ap-cld-monitor | b55ebf42e3bb4f1cbbec3c06450a7f30 | 8c8d3a8067c044b39938172b2aa535a9 | aws-ap-east-1 |
| gl-cld-reporting | 4c3796f8ac2242a59416b2e6cb386207 | 5d01a25fd2284d6483e4daec47aae687 | aws-us-east-2 |
| gl-testing | f00e987c311f47ebaae49245d157f362 | 861aeefdf54848289fd1de104eda58d3 | aws-us-east-2 |

**Worked example of why this matters:** an OOM notification quoting cluster
`33175db28808456ba6545788430036db` in us-east-1 is **us-cld**, even if it arrives while you are
investigating eu-b2b. Do not attribute another cluster's OOM to the cluster you happen to be
looking at. Decode the ID first.

Validation discipline: only validate/triage rows for the cluster you are actually connected to.
Rows for other clusters are out of scope for the current session — don't flag them as "needs
investigation" just because you can't see them.

---

## 2. eu-b2b topology snapshot (the cluster usually connected)

- Version 9.4.1, hardware profile "Storage optimized", 15 nodes total (3 dedicated master,
  4 coordinating), 8 data nodes, 3 availability zones (eu-central-1a/b/c).
- Data tiers:
  - **Hot** — 3 × 15 GB RAM / 8 GB heap, `AWS.ES.DATAHOT.I3-V1`. Highest churn, runs hottest.
  - **Warm** — 2 × 8 GB RAM / 4 GB heap, `AWS.ES.DATAWARM.D3-V1`.
  - **Cold** — 2 × 4 GB RAM / 2 GB heap, `AWS.ES.DATACOLD.D3-V1`.
  - **Frozen** — 1 × 30 GB RAM / 15 GB heap, `AWS.ES.DATAFROZEN.I3EN-V1` (searchable snapshots).
- Dominant workloads, in order: `traces-apm`, `logs-aws_fargate_*`, `metrics-kubernetes.*`.
  APM traces alone can be ~30% of hot-tier storage. Tuning rollover/retention/allocation here is
  where the leverage is.

---

## 3. Operating principle — the three durability layers

Every fix should be placed in the **lowest layer that survives the relevant lifecycle event**.
Stopping at Layer 0 or 1 is why issues recur after a rollover or a Fleet package upgrade.

| Layer | Mechanism | Survives until | Use for |
|---|---|---|---|
| **0** | `PUT /<index>/_settings` on a live index | next ILM rollover | emergency one-shot only |
| **1** | one-shot `PUT _index_template` override | next Fleet package version (priority gets out-ranked) | stop-gap |
| **2** | **Terraform-managed `<type>@custom` component template** | Fleet upgrades (Fleet never overwrites `@custom`) | the durable answer |

For Fleet-managed data streams, Layer 2 is the home for shard-allocation and shaping settings.
For non-Fleet, Kibana-owned templates that have **no `@custom` hook** (e.g. `.kibana-event-log`),
durability lives in the **ILM policy** instead, or a higher-priority custom index template
(more fragile across Kibana upgrades — prefer the ILM route).

This is the same pattern proven on the single-node Fleet replica fix (codify
`auto_expand_replicas: "0-1"` in a `@custom` component template via Terraform; a one-shot PUT
regresses at the next rollover).

---

## 4. Fleet `@custom` composition hooks (eu-b2b, verified)

Fleet integration index templates compose a `@custom` component template by name — that named
component is the insertion point Fleet preserves across package upgrades.

- `traces-apm` (priority 200, Fleet-managed) composes `traces-apm@custom` and `traces@custom`.
- `traces-apm-override-shards` (priority 250, custom) also exists and composes the same `@custom`
  components — a prior local override layer; treat it as load-bearing, review before editing.
- `.kibana-event-log` (priority 50, Kibana-managed) and `.kibana-event-log-template` (priority 50)
  have **no `@custom` hook** — govern these via ILM, not a component template.

Anti-skew recipe for a high-volume data stream (place in `<type>@custom`):

```json
{
  "settings": {
    "index.routing.allocation.total_shards_per_node": 2,
    "index.number_of_shards": 2
  }
}
```

Rollover-shaping (place in the ILM policy, not the template) to cap shard size and force a daily
roll regardless of volume:

```json
{ "rollover": { "max_primary_shard_size": "25gb", "max_age": "1d" } }
```

---

## 5. Diagnostic method — AutoOps "alert storm" triage

When a cluster is flooding "Some <tier> nodes are more loaded than others", "index queue is high",
"CPU utilization high" on a recurring pair of nodes, the cause is usually **single-index shard
allocation skew on the dominant data stream**, not a need to resize. Method:

1. `cluster_health` — confirm GREEN and shard counts; rule out a real red/yellow incident.
2. `nodes_stats {metric: jvm,os}` — find which nodes are hot (system memory, heap, young-GC count).
   System memory near 100% on Linux is mostly page cache and not itself alarming; weight heap and
   GC frequency more heavily.
3. `list_indices {sortBy: size}` and `get_shards {sortBy: size}` — identify the dominant index and
   read its per-node shard placement. Skew (e.g. 3 / 2 / 1 shards across 3 hot nodes) is the tell.
4. Fix allocation structurally (Layer 2) before considering a resize. Resizing without fixing
   allocation just moves the bottleneck.

Resize is the last lever, not the first.

---

## 6. Known traps (read before changing anything)

- **Frozen "system memory 100%" / `nodes_stats fs` figure is the local LRU disk cache**, not S3
  searchable-snapshot capacity. The cache is expected to fill. For true frozen capacity use the
  Cloud console "Searchable object storage" figure.
- **Empty `@custom` / retention-fleet stubs.** A `@custom` (or PVH `*-nonprod-retention-fleet`,
  priority ~251) template can exist with an empty body and silently inherit an upstream policy
  (e.g. the 90d prod ILM). Always inspect the body — presence of the template name is not proof
  it carries settings. Worth a CI assertion that fails on empty expected `@custom` bodies.
- **Elastic Cloud tier downsize order.** When downsizing an autoscaling-enabled tier, reduce
  *Current size per zone first, then Maximum* (validation requires Max ≥ Current). Max-first fails.
- **Optimisation changes surface secondary effects — manage, don't halt.** Expect turbulence
  (e.g. an allocation change triggers shard relocation; an ILM frozen pull-in can cause a
  force-merge stampede → cold-node pressure). Flag as risks, mitigate, keep the process moving.
- **Land changes one at a time.** Don't bundle an allocation change with an ILM rollover-threshold
  change in the same apply; you lose the ability to attribute any fallout.

---

## 7. Change-safety workflow

1. **Plan in `gl-testing` first** — it is the mandatory IaC pre-check sandbox (kept alive ~$37/mo
   in lieu of decommission). It catches invalid template/ILM JSON. Caveat: it is single-node, so it
   does **not** validate HA, tiered allocation, replica, or CCS/CCR behaviour — only syntax/plan.
2. **Apply off-peak.** Structural allocation changes cause an immediate shard-relocation wave.
3. **Two-step sequencing.** Allocation first; confirm balance; then tighten ILM.
4. **Validate after.** Re-pull `get_shards` for the target index and confirm even per-node
   distribution; watch search latency on the affected tier for the secondary effects above.

---

## 8. Canonical documents (where the detail lives)

- **Issue register** — `Consolidated_Issue_Register_v<N>.docx` (highest N is current). The standing
  record of issues and resolutions across clusters.
- **Optimisation playbook** — `Elastic_Optimisation_Playbook_v<N>.docx`. Step-by-step procedures.
- **Optimisation tracker** — `Elastic_Optimisation_Tracker_v<N>.xlsx`. Per-row work items; the
  Cluster column scopes each row.
- File naming: version only (`v<N>`), no date suffix. The register/playbook stand alone — they do
  not narrate "what changed since vN-1"; use a separate changelog if traceability is needed.

---

## 9. MCP tooling quirks (Elastic server)

- `get_index_template` `name` accepts a single name or one wildcard — **commas are rejected**.
  Query patterns one at a time.
- `ilm_get_lifecycle` `policy` accepts a comma-separated list, but if any single name does not
  exist the whole call errors. Prefer `{summary: true, sortBy: indices_count}` to discover names
  first, then fetch specifics.
- `nodes_stats` without a `metric` filter returns a huge payload — always pass
  `{metric: 'jvm,os'}` (or similar) and `level: node`.
- `get_shards` requires a `limit` on clusters with >500 shards (eu-b2b has ~3,000+).

---

## 10. IaC repo helper verbs (read-only status & inspection)

Status and inspection do **not** require drafting a change. The elastic-iac server wraps the
repo's read-only Task helpers; reach for these when asked "what's the status", "what's deployed",
or "what does this stack own" — read and report, do not open a branch.

| Tool | Wraps | Use for |
|---|---|---|
| `iac_status` | `task status` | Reconcile state across deployments (optionally one `deployment`). |
| `iac_list_stacks` | `task list-stacks` | The stacks the repo manages. |
| `iac_list_deployments` | `task list-deployments` | The deployments the repo manages. |
| `iac_output` | `task output STACK=.. DEPLOYMENT=..` | A stack's outputs (IDs/endpoints). |
| `iac_state_list` | `task state-list STACK=.. DEPLOYMENT=..` | What a stack currently owns in state. |

For GitOps/MR status (open MRs, pipeline results) use the `review_pipeline` action
(`gitlab_get_merge_request`, `gitlab_get_merge_request_pipelines`). The repo tree and config blobs
read via `read_repo` (`gitlab_get_repository_tree`, `gitlab_get_file_content`) — `main` is the
live-cluster representation. Mutating verbs — apply, destroy, import, and state surgery
(`state-mv`/`state-rm`) — are intentionally absent; CI owns mutation behind the human gate.
