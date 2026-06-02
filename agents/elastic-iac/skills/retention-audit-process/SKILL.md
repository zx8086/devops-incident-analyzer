---
name: retention-audit-process
description: Quarterly (or pressure-driven) ILM retention audit — scope the heaviest policies, gather requirement vs query pattern, propose reductions through the change register.
inputs:
  cluster: { type: string, required: true }
  trigger: { type: string, required: false }
outputs:
  proposed_changes: { type: array }
---

# Retention audit process

Source: `Elastic_Optimisation_Playbook_v12.docx` §8.3.

## Why / Pattern

Cadence: quarterly, or whenever cold/frozen pressure forces the conversation. Retention drift is invisible until storage hurts; the audit closes the loop between data-owner expectation and actual policy.

## Scope (§8.3.1)

1. Top 6 retention policies by index count cover 21,300 indices on eu-cld — audit these first.
2. Any policy with `delete.min_age > 90d` needs an explicit business justification.
3. Any policy with `delete.min_age < 14d` should be double-checked — is it really low-value, or did someone set it wrong?

Scope queries:

```
GET _cat/indices?h=index,ilm.policy&format=json
# group by ilm.policy, count indices, rank descending

GET _ilm/policy
# extract phases.delete.min_age per policy
```

## Steps (§8.3.2)

1. Pull retention requirement from data owner (SLA, regulation, analytics need).
2. Pull actual query pattern on data older than 30d — Kibana search activity, APIM logs to `_search`.
3. If regulatory: document the regulation, cite it in policy description.
4. If no regulatory or query pattern supports `>30d`: propose `delete.min_age` reduction in the policy change register.
5. Give data owner 2-week comment window before applying.

## Validation

Post-apply, cross-ref §9.1 (After an ILM policy change):

- Policy version bumped, `modified_date` matches apply timestamp.
- `_ilm/explain?only_errors=true` returns empty across affected backing indices.
- Storage delta visible within one retention cycle on `_cat/indices?bytes=gb`.

## Hand off

Record audit findings, proposed retention reductions, and comment-window deadline in `memory/runtime/context.md`. Each approved reduction goes through `open-mr` (IaC) and then `add-ilm-policy` / `validate-cluster-state` skills as appropriate. Stop.
