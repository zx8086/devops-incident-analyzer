---
name: built-in-ilm-policy-revalidation-after-upgrade
description: After any stack upgrade or Fleet package install, re-check that built-in ILM policies have not silently reverted to the hot-only shipped definition.
inputs:
  cluster: { type: string, required: true }
  upgrade_version: { type: string, required: false }
outputs:
  policies_drifted: { type: array }
---

# Built-in ILM policy revalidation after upgrade

Source: `Elastic_Optimisation_Playbook_v12.docx` §3.9.

## Why / Pattern

Elastic ships seven built-in policies (`metrics`, `logs`, `synthetics`, `profiling`, `@lifecycle`, `ilm-history`, `watch-history`). An upgrade or Fleet package install silently re-applies the shipped definition, which is hot-only with no delete phase. If these were customised, customisations are lost and data accumulates on hot.

Note (per §12.28): the 9.3 → 9.4 upgrade did NOT auto-recreate built-in ILM policies — the assumption from earlier upgrades is now soft. Still run this check after every upgrade.

## Post-upgrade check (§3.9.1)

```
GET _ilm/policy/metrics
GET _ilm/policy/logs
GET _ilm/policy/synthetics
GET _ilm/policy/profiling
GET _ilm/policy/@lifecycle
GET _ilm/policy/ilm-history
GET _ilm/policy/watch-history
```

Compare phases against the git-stored baseline. Alert if phase count differs from the baseline, or if `phases.delete` is missing on any policy that previously had one.

## Permanent fix (§3.9.2)

1. Never depend on built-in policies for production data. Copy each to a custom name (e.g. `logs-custom`, `metrics-custom`) and update index templates to reference the custom one.
2. Leave the built-ins as Elastic ships them so upgrades do not conflict.
3. Add a weekly scheduled check in the monitoring cluster: assert phase count and `phases.delete.min_age` on custom policies are unchanged since the last baseline commit. Fire on drift.

## Validation

Cross-ref §9.1 (After an ILM policy change) and §3.4 (Policy migration drift — the checklist):

- `GET _ilm/explain/.ds-*?only_errors=true` returns empty.
- `_cat/indices?h=index,ilm.policy` shows production indices on the custom policy names, not the built-ins.
- `_index_template/*` references custom policy names in `template.settings.index.lifecycle.name`.

## Hand off

If any policy drifted, restore from git baseline via `PUT _ilm/policy/<name>` with the saved JSON. Open MR via `open-mr` skill to record the recovery in IaC. Update `memory/runtime/context.md` with the upgrade version and drift findings. Stop.
