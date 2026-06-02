# RULES — Hard constraints

These are non-negotiable. Violating any of these blocks the change.

## Must always

1. **Pre-check on gl-testing first.** Any new stack module change goes through `gl-testing` before any other target. gl-testing is single-node, so it validates module syntax and provider plan only — *not* HA/tier/replica/CCS-CCR behaviour. State that limitation in the MR.
2. **Read live cluster state before writing the diff.** Use `elasticsearch_cloud_get_deployment`, `..._get_plan_history`, `..._get_cluster_health` for the target cluster. Do not rely on tracker rows or memory snapshots alone.
3. **One MR per wave.** Group related changes (e.g. Wave 2 = traces-apm + logs + logs-apm warm/cold accel) into a single MR. Do not split related changes across MRs; do not bundle unrelated changes.
4. **Validation scoped to connected cluster only.** When auditing tracker rows, only flag rows whose `Cluster` column matches the MCP-connected deployment. Do not raise issues for other clusters.
5. **Tier downsize order.** When reducing an autoscaling-enabled tier: reduce `Current size per zone` first, *then* `Maximum`. Validation requires `Max ≥ Current`. Max-first fails.
6. **Disclose secondary risks in the MR body.** If the change is likely to cause downstream effects (ILM phase transitions, force-merge load, replica re-balance), list them under a `## Risks` heading.
7. **Answer read-only questions without opening an MR.** A request that only asks about state — versions (single or across all deployments), topology, plan history, ILM, health — is answered directly from Elastic Cloud reads. Never create a branch, draft a diff, or open an MR for an info question. When intent is ambiguous between answering and changing, treat "should I…/recommend…" as a change and route through the plan/HITL pipeline.
8. **Propose via JSON edit + MR; never execute locally.** A change is a config edit on the GitOps repo: read the deployment JSON, change the field, create a branch and commit the edit through the GitLab API, then open an MR. I never run `terraform`, never clone a workspace, never push from a local checkout. CI computes the plan on the MR; a human merges and clicks the manual apply. Both supported edits live in the deployment JSON `environments/_deployments/<deployment>.json`: a version bump is `.version`; a tier resize is `elasticsearch.<tier>.size` / `.max_size` (string `"<N>g"`; reduce `size` before `max_size`, and `max_size >= size`). An ILM change edits the lifecycle-policy JSON `environments/<deployment>/lifecycle-policies/<policy>.json` (top-level phase keys hot/warm/cold/delete; retention is `delete.min_age`); reducing retention is irreversible data loss and is surfaced as HIGH risk for the human to confirm.

## Must never

1. **Never run `terraform apply`.** Plan is fine. Apply is human-gated through the pipeline.
2. **Never merge my own MR.** I open; a human approves.
3. **Never push to `main` directly.** Branches only.
4. **Never print or commit secrets.** If I encounter `spi.password`, JWKS, API keys, root passwords — redact in any output and flag for rotation in the MR description. Do not save the value to memory.
5. **Never change prod tier sizes without an explicit user instruction naming the prod cluster.** Dev/stg/gl-testing is fine on inferred intent; prod requires the user to name it.
6. **Never use frozen disk usage from `nodes_stats fs` as capacity signal.** That is the LRU cache. For true frozen capacity, read the Elastic Cloud console "Searchable object storage" figure.
7. **Never trust `*-nonprod-retention-fleet` templates have a body.** Priority-251 retention-fleet templates can be empty and silently inherit the 90d prod ILM. Always `GET _index_template/*nonprod-retention*` when auditing dev/stg shard sprawl.

## Conditional

- If `.alerts` indices are unmanaged, **gate Wave 3 hot 15→8GB downsize** until that is fixed. Do not propose hot tier downsize while `.alerts` is unmanaged.
- If a transform has been dormant > 30 days, do not restart it without first checking why it stopped — file an issue doc instead.
