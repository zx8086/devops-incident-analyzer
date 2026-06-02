---
name: empty-retention-fleet-templates-inherit-prod-ilm
description: Detect priority-251 retention-fleet index templates with empty bodies that silently inherit prod ILM on dev/stg/test/nonprod streams; fix by PUTting the correct nonprod ILM into the template body. Likely repeats across the federation.
inputs:
  cluster: { type: string, required: true }
  nonprod_policy_name: { type: string, required: false, default: "eu-default-lifecycle-logs-nonprod" }
outputs:
  empty_templates_found: { type: array }
  mr_url: { type: string }
---

# Empty retention-fleet templates inherit prod ILM

Source: `knowledge/playbook/3-index-lifecycle-management-ilm.md` §3.13 (full chapter at `Elastic_Optimisation_Playbook_v12.docx` §3.13). Pattern observed on eu-cld; suspected on ap-cld and us-cld — audit each.

## The pattern

Templates at priority 250+ matching dev/stg/test/nonprod patterns can match the patterns yet have `template: {}` (empty body). They win the priority arbitration but do nothing — dev/stg streams inherit whatever the composed `<type>@settings` component specifies (typically the prod policy). Result: dev/stg streams silently inherit the prod 90-day ILM.

Memory cross-ref: `project_retention_fleet_templates_gotcha` — PVH `*-nonprod-retention-fleet` templates (priority 251) may be empty.

## §3.13.1 — Detect

```
GET _index_template/*nonprod-retention*
```

For each returned template: inspect `index_template.template`. If the body is `{}` (empty), the template is inert and its dev/stg index pattern is being routed to whatever default ILM the components specify (usually the prod policy).

Output the list of empty templates as `empty_templates_found`. If empty list → no action needed.

## §3.13.2 — Fix

For each empty template, draft the correct nonprod ILM body. Example for the `logs-nonprod-retention-fleet` template:

```json
PUT _index_template/logs-nonprod-retention-fleet
{
  "index_patterns": [
    "logs-*-eu_*_stg",
    "logs-*-eu_*_dev",
    "logs-*-eu_*_test",
    "logs-*-eu_*_nonprod",
    "logs-*-eu_*_backend_test"
  ],
  "priority": 251,
  "composed_of": [
    "logs@mappings",
    "logs@settings",
    "logs@custom",
    "ecs@mappings",
    ".fleet_globals-1",
    ".fleet_agent_id_verification-1"
  ],
  "template": {
    "settings": {
      "index": {
        "lifecycle": {
          "name": "{{ nonprod_policy_name }}"
        }
      }
    }
  },
  "data_stream": { "hidden": false, "allow_custom_routing": false }
}
```

Adapt the `index_patterns` array to the actual patterns the empty template matched. Adapt `composed_of` to the type prefix (`logs@*`, `metrics@*`, `traces@*`, `synthetics@*`). The `nonprod_policy_name` input drives `lifecycle.name`.

## Behaviour after apply

- Effect applies on **next rollover** for matching backing indices. Existing backing indices age out under their original (prod) policy until they roll over.
- No data loss; just a retention drift correction for new indices.
- If matching streams have `max_age` longer than the desired correction window, pair this with the §3.13 force-attach sub-procedure for existing backing indices.

## Codify in Terraform

After the live PUT validates, codify the same templates in `stacks/<cluster>/templates.tf` so they survive the next session and don't get re-overwritten by a Fleet package upgrade.

## Open the MR

Use the `open-mr` skill. MR-template category: `index-template`; risk: MEDIUM (retention math change affects future indices). Body must include:

- List of empty templates found (the detect output)
- The PUT bodies applied
- The expected effect ("retention will diverge from prod on next rollover of matching streams")
- Cross-federation audit recommendation: "audit ap-cld and us-cld for the same empty-body templates"

## Validation (post-MR)

- After next rollover on any matching stream: `GET <new-backing-index>/_settings.index.lifecycle.name` should report the nonprod policy.
- `_ilm/explain` on the new backing index should show the nonprod policy attached.
- Spot-check ingest rate and Kibana dashboards remain unaffected.

## Hand off

Post MR URL. Append to `memory/runtime/context.md` `## in-flight` with a 7-day check-back reminder to verify post-rollover state on the most-active matching stream.
