---
name: edit-alert-rule
description: Edit an EXISTING alert rule's threshold / window / enabled / interval in IaC (read-modify-write the per-rule JSON + open an MR). Does NOT create rules or touch connector wiring/secrets. Disabling a rule is flagged HIGH.
inputs:
  cluster: { type: string, required: true }
  rule_name: { type: string, required: true }             # rule file basename, e.g. "default__martech_cart_..._prd"
  alert_threshold: { type: number, required: false }      # params.threshold
  alert_window_size: { type: number, required: false }    # params.windowSize
  alert_window_unit: { type: string, required: false }    # params.windowUnit (m|h|s|d)
  alert_enabled: { type: boolean, required: false }       # false = disable / silence the rule
  alert_interval: { type: string, required: false }       # rule check interval, e.g. "5m"
---

# Edit an alert rule's threshold / window / enabled / interval

Source of truth: `environments/<cluster>/alerting/<space>__<rule-name>.json` — ONE file per rule. The filename carries the space prefix (`default__...`, `developer-experience__...`).

```json
{
  "name": "MarTech_Add_To_Wallet_Transactions_Failed_Status_PRD",
  "rule_type_id": "apm.transaction_error_rate",
  "enabled": true,
  "interval": "5m",
  "space_id": "default",
  "params": { "serviceName": "...", "threshold": 1, "windowSize": 5, "windowUnit": "m" },
  "actions": [ { "group": "threshold_met", "id": "<connector-id>", "params": { "body": { ... } } } ]
}
```

## Editable surface (safe scalar fields ONLY)

- `params.threshold` — the detection threshold (number).
- `params.windowSize` + `params.windowUnit` — the look-back window (number + 'm'|'h'|'s'|'d').
- `enabled` (top level) — `false` disables/silences the rule.
- `interval` (top level) — the rule check interval string ("5m").

NEVER touch: `actions[]` (connector wiring — changing `id` silently breaks notifications), `params.body` (the notification template), `params.searchConfiguration`, `rule_id`, or anything else. Some rule types (`.es-query`) have no `threshold` — if the user asks for a threshold on such a rule, confirm the field is meaningful for that `rule_type_id` first.

## The change (read-modify-write)

1. Read `environments/<cluster>/alerting/<space>__<rule>.json` via `gitlab_get_file_content`. A 404 means the rule file doesn't exist — STOP (creating a new rule is out of scope; it needs the full rule + connector wiring).
2. Set only the requested scalar field(s). Preserve every other field + 2-space indent + trailing newline.
3. Commit to a branch + open the MR. CI plans on the MR; a human merges and applies.

## Risk

- threshold / window / interval = **MEDIUM**. Raising a threshold or widening a window reduces sensitivity — verify it doesn't mute a real failure mode.
- **Disabling a rule** (`enabled:false`) = **HIGH**. It silences the rule's alerts entirely — surface as a leading risk line and confirm the gap is intended and time-bounded.
- Connectors/secrets are never touched (connector secrets live in tfvars/SSM, not these files).

## Anti-patterns — refuse to write

- Creating a NEW alert rule (out of scope — needs the rule type's full params + an existing connector to wire actions to).
- Editing `actions[].id` (connector wiring) or `params.body` (notification content) — out of scope; changing the connector id silently breaks delivery.
- Disabling a production rule with no stated reason — flag and require confirmation.

## MR body

Use `knowledge/mr-template.md` headings. Category: `alerting`. Risk: MEDIUM (HIGH when disabling). State the resolved change (`default__...: params.threshold 1 -> 5`), the single file touched, and the rollback (revert the MR).
