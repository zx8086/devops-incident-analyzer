# Conventions — local lore the agent needs

## Validation scoping

Tracker rows reference many clusters. Only flag rows whose `Cluster` column matches the cluster the agent is currently connected to via MCP. Do not raise "needs investigation" for rows from other clusters.

## Frozen tier capacity

`nodes_stats fs` on frozen nodes shows the local LRU cache (e.g. 4.34 TB). It is expected to fill. **Do not use it as a capacity signal.** True capacity is in the Elastic Cloud console under "Searchable object storage".

## Optimisation turbulence

Secondary effects are expected after optimisation MRs:

- ILM frozen pull-in can trigger force-merge stampedes
- Cold-node OOM can follow if heap is already tight
- Replica imbalance during tier transitions

Flag these as **risks**, recommend mitigation, but **do not halt** in-flight processes. Manage forward.

## Single-node Fleet cluster YELLOW

If `gl-testing` (single node) reports YELLOW on Fleet/system streams: it's `auto_expand_replicas: 0-1` inherited from the stack-shipped `<type>@settings`. Verify on the newest backing index. Don't look for `@custom` template overrides — they're empty by design.

## Artifact filenames

For artifacts produced for the user (issue register, playbook, tracker): version-only filenames (`v<N>`). No date suffix.

## Eu-cld secret exposure

WebSphere `process.command_line` field has logged `spi.password` and JWKS in plaintext. Forward redaction is deployed via `logs@custom`. Historical logs still contain the secrets — flag for credential rotation in any MR that touches eu-cld logs.

## Deployments stack: single shared state -> lock contention

The `deployments` stack holds ONE Terraform state for all 10 clusters (by design — every plan evaluates all 10). So two MRs touching that stack at the same time race the single state lock; a stale lock from a still-running (or abandoned) pipeline blocks the next plan. A failed plan job whose log shows `Error acquiring the state lock` / `already locked` is this contention, **not** a problem with the change itself. Recovery is an operator action: force-unlock in GitLab (or wait for the holding pipeline to finish), then re-run the plan. The agent reports this as a hint; it never force-unlocks or mutates state.

## Plan history beats trackers

When evaluating a tier change, `elasticsearch_cloud_get_plan_history` is the source of truth. Tracker rows can lie (especially on tiers that have been reversed: downsize then upsize). Cross-check plan_history before trusting a tracker.
