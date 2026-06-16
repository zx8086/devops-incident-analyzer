---
name: edit-deployment-topology
description: Edit an EXISTING deployment's elasticsearch topology in IaC -- toggle global autoscale and/or set a tier's zone_count / per-tier autoscale (read-modify-write the per-cluster _deployments JSON + open an MR). HIGH risk -- the _deployments file is a SINGLE shared Terraform state across all 10 clusters. NEVER deletes a deployment, never resizes tier size/instance config.
inputs:
  cluster: { type: string, required: true }
  autoscale_enabled: { type: boolean, required: false }   # global elasticsearch.autoscale
  topology_tier: { type: string, required: false }        # hot | warm | cold | frozen
  tier_zone_count: { type: number, required: false }      # integer 1-3 (HA zones)
  tier_autoscale: { type: boolean, required: false }       # per-tier autoscale flag
---

# Edit a deployment's elasticsearch topology (autoscale / zone_count)

Source of truth: `environments/<cluster>/_deployments/<cluster>.json` -- the per-cluster deployment manifest.

```json
{ "name": "...", "region": "...", "version": "...",
  "elasticsearch": {
    "autoscale": false,
    "hot":   { "size": "...", "max_size": "...", "instance_configuration_id": "...", "zone_count": 2 },
    "warm":  { ..., "zone_count": 1 },
    "cold":  { ... },
    "frozen":{ ... }
  },
  "kibana": { ... }, "integrations_server": { ... }
}
```

## The change (read-modify-write)

1. Read `_deployments/<cluster>.json` via `gitlab_get_file_content`. A 404 means the cluster has no deployment manifest -- STOP and tell the user.
2. Apply ONLY the requested edits:
   - `autoscale_enabled` -> set `elasticsearch.autoscale` (global).
   - `tier_zone_count` / `tier_autoscale` -> set `elasticsearch.<tier>.zone_count` / `.autoscale` on the named tier (`hot`/`warm`/`cold`/`frozen`). An unknown tier is a STOP (never invent a tier).
   - `zone_count` must be an integer 1-3. Anything else is a STOP.
   - Leave every other tier, every `size`/`max_size`/`instance_configuration_id`/`instance_configuration_version`, `user_settings_yaml`, and all sibling blocks (kibana, integrations_server, remote_clusters, trust_accounts) byte-for-byte identical. Preserve 2-space indent + trailing newline.
3. A no-op (the value already matches) is a STOP -- do not open an empty MR.
4. Commit to a branch + open the MR.

## Risk -- always HIGH

- The `_deployments/<cluster>.json` file is the input to a SINGLE Terraform state shared across ALL 10 clusters. A bad edit can stall or fail the apply for every deployment, and a topology change triggers a long-running Elastic Cloud plan (data migration across zones). Default risk **HIGH**; confirm the change is intended and that someone is watching the apply.
- `zone_count` raises/lowers HA: dropping zones reduces redundancy; raising zones rebalances shards (slow, I/O heavy). Surface this in the MR.
- The diff lists ONLY the changed `autoscale` / `zone_count` lines (never the whole file).

## Anti-patterns -- refuse to write

- **Deleting a deployment** (removing the file or a tier) -- categorically out of scope. NEVER propose a deployment delete.
- Resizing a tier's `size` / `max_size` / `instance_configuration_id` -- that is the resize-tier skill, not this one.
- Editing `user_settings_yaml`, kibana, integrations_server, remote_clusters, or trust_accounts.
- Setting `zone_count` outside 1-3, or to a non-integer.

## MR body

Use `knowledge/mr-template.md` headings. Category: `deployment-topology`. Risk: HIGH. State the resolved change (`eu-b2b: autoscale on; hot.zone_count 2 -> 3`), the single file touched, that this is a shared-state file with a long apply, and the rollback (revert the MR).
