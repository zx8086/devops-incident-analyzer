---
name: edit-deployment-topology
description: Edit an EXISTING deployment's topology in IaC -- autoscale, a tier's zone_count / per-tier autoscale, the SSO user_settings_yaml (SAML/OIDC realm or Kibana auth providers), or integrations_server/kibana sizing (read-modify-write the _deployments JSON + open an MR). HIGH risk -- the _deployments file is a SINGLE shared Terraform state across all 10 clusters; SSO edits can lock out login. NEVER deletes a deployment, never resizes a data tier's size/instance config.
inputs:
  cluster: { type: string, required: true }
  autoscale_enabled: { type: boolean, required: false }    # global elasticsearch.autoscale
  topology_tier: { type: string, required: false }         # hot|warm|cold|frozen|master|ml|coordinating
  tier_zone_count: { type: number, required: false }       # integer 1-3 (HA zones)
  tier_autoscale: { type: boolean, required: false }        # per-tier autoscale flag
  user_settings_target: { type: string, required: false }  # elasticsearch_config | kibana
  user_settings_yaml: { type: string, required: false }    # raw YAML string (verbatim)
  size_component: { type: string, required: false }        # integrations_server | kibana
  component_size: { type: string, required: false }        # e.g. "2g"
  component_zone_count: { type: number, required: false }  # integer 1-3
---

# Edit a deployment's topology (autoscale / zone_count / SSO / component sizing)

Source of truth: `environments/_deployments/<cluster>.json` -- the per-deployment manifest. NOTE the path is FLAT under `environments/_deployments/`, NOT `environments/<cluster>/...`. All 10 deployments share this stack's schema and a SINGLE Terraform state.

```json
{ "name": "...", "region": "...", "version": "...",
  "elasticsearch": {
    "autoscale": false,
    "hot": { "size": "8g", "max_size": "116g", "instance_configuration_id": "...", "zone_count": 2 },
    "warm": { ... }, "cold": { ... }, "frozen": { ... },
    "master": { ... }, "ml": { ... }, "coordinating": { ... }
  },
  "elasticsearch_config": { "plugins": [], "user_settings_yaml": "xpack.security.authc.realms.saml...." },
  "integrations_server": { "size": "1g", "zone_count": 1 },
  "kibana": { "size": "1g", "zone_count": 1, "user_settings_yaml": "xpack.security.authc.providers...." }
}
```

## The change (read-modify-write)

1. Read `_deployments/<cluster>.json` via `gitlab_get_file_content`. A 404 means the deployment has no manifest -- STOP and tell the user.
2. Apply ONLY the requested edits (any combination in one MR):
   - **autoscale**: `autoscale_enabled` -> `elasticsearch.autoscale` (global).
   - **tier**: `tier_zone_count` / `tier_autoscale` -> `elasticsearch.<tier>.zone_count` / `.autoscale` on the named tier (`hot|warm|cold|frozen|master|ml|coordinating`). Unknown tier -> STOP (never invent one). `zone_count` must be an integer 1-3.
   - **SSO**: `user_settings_target` (`elasticsearch_config` for the ES SAML/OIDC realm, `kibana` for the Kibana auth providers) + `user_settings_yaml` -> replace that block's `user_settings_yaml` with the raw string VERBATIM. It is YAML inside a JSON string -- never reformat, never parse, never split it. The proposer stores it as one escaped string.
   - **sizing**: `size_component` (`integrations_server`|`kibana`) + `component_size` / `component_zone_count` -> set that component's `size` / `zone_count`. `zone_count` must be an integer 1-3.
   - Leave every OTHER field byte-for-byte identical (other tiers, all `size`/`max_size`/`instance_configuration_id`, the OTHER `user_settings_yaml`, remote_clusters, trust_accounts, version). Preserve 2-space indent + trailing newline.
3. A no-op (every requested value already matches) is a STOP -- do not open an empty MR.
4. Commit to a branch + open the MR.

## Risk -- always HIGH

- **Shared state + long apply**: `_deployments/<cluster>.json` feeds a SINGLE Terraform state across ALL 10 deployments. CI's plan evaluates every deployment; a topology apply triggers a long-running Elastic Cloud plan (zone rebalance / data migration), up to 4-8h on the largest. Apply off-peak; confirm no other deployment change is in flight.
- **SSO `user_settings_yaml` can lock out login**: a malformed or wrong SAML/OIDC realm or Kibana auth-providers block can break authentication for ALL users. This is the most acute failure mode -- lead the MR risk list with "COULD LOCK OUT LOGIN", RECOMMEND HUMAN REVIEW of the YAML, and confirm a break-glass path. The diff NEVER echoes the YAML value (it can carry idp/sp identifiers) -- it shows only the target block + a length delta.
- **autoscale** lets the cluster grow toward its max_size ceiling automatically -- confirm the ceiling + cost.
- **zone_count** raises/lowers HA: dropping zones reduces redundancy; raising zones rebalances shards.
- The diff lists ONLY the changed scalars (never the whole file).

## Anti-patterns -- refuse to write

- **Deleting a deployment** (removing the file, a tier, or a component) -- categorically out of scope. NEVER propose a deployment delete; cluster deletion is Cloud-Console-only.
- Resizing a DATA tier's `size` / `max_size` / `instance_configuration_id` -- that is the resize-tier skill, not this one.
- A version upgrade -- that is the version-upgrade skill.
- Editing `remote_clusters` or `trust_accounts` (cross-cluster trust; out of scope this cut).
- **Container / Wolfi agent image-tag bumps are NOT here**: those tags do NOT live in the `_deployments` JSON (they are Fleet/agent-policy config). If the user asks to bump a service's container/agent image, that is a different surface -- do not attempt it from this file.
- Setting any `zone_count` outside 1-3, or to a non-integer.

## MR body

Use `knowledge/mr-template.md` headings. Category: `deployment-topology`. Risk: HIGH (lead with the login-lockout line when SSO is touched). State the resolved change (`eu-b2b: autoscale on; hot.zone_count 2 -> 3`, or `eu-onboarding: kibana.user_settings_yaml updated (SSO; value withheld)`), the single file touched, that this is a shared-state file with a long apply, and the rollback (revert the MR).
