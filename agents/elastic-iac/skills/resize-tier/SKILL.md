---
name: resize-tier
description: Resize a hot/warm/cold/frozen/coord/ML tier in an Elastic Cloud deployment via Terraform diff. Handles autoscaling Current/Max ordering, warm-disk-full gate, ML shutdown workaround. Always pre-checks on gl-testing first.
inputs:
  cluster: { type: string, required: true }       # e.g. "eu-b2b", "us-cld"
  tier: { type: string, required: true }          # hot|warm|cold|frozen|coord|ml
  new_size_gb: { type: number, required: true }
  new_max_gb: { type: number, required: false }   # for autoscaling
  reason: { type: string, required: true }
outputs:
  mr_url: { type: string }
  branch: { type: string }
---

# Resize tier

Source of truth: `knowledge/playbook/7-infrastructure-and-cost.md` §7.1–§7.3, `knowledge/playbook/9-validation-checklists.md` §9.3, `knowledge/issues/cross-cluster.md` IR-174.

## Pre-flight

1. Call `validate-cluster-state` skill with `change_type: "resize"`. If `gate_passed: false`, abort and return failures to the user — do not draft a diff.
2. **§7.1.1 — Warm-disk-full check.** Cloud refuses ANY plan change while any warm node is above the watermark. Inspect `nodes/stats.fs` for warm tier. If any node > 85% disk:
   - Abort with the message "warm-disk-full blocks plan changes — free warm tier first (drop replica count on a warm-heavy policy, or accelerate the cold migration on the oldest indices)".
3. **§7.1.2 — ML jobs.** If the deployment has ML nodes, instruct the user to close ML jobs (`POST _ml/anomaly_detectors/*/_close`) before the apply. ES 9.2.x has a known shutdown-API bug. Note this in the MR body. Re-open after.
4. **Hot-tier downsize specifically:** confirm `.alerts` indices are managed by an ILM policy. If unmanaged, abort: "hot downsize gated on `.alerts` unmanaged fix (Wave 3 pre-req)".
5. **§7.3 — Hot-tier downsize after over-migration:** check 7-day peak disk used_percent < 70% AND peak heap < 65% on the hot tier. If either is higher, the tier is NOT a downsize candidate; ask the user to confirm intent.
6. **§7.1.3 — Resize vs remove.** To remove a node, reduce tier to `current_size - 1`; never attempt direct node-ID removal. To change instance type, do it as a SEPARATE plan from any size change.

## Locate the module

Verify the layout with `gitlab_get_repository_tree` first. Typical paths in the IaC repo:

```
stacks/<cluster>/topology.tf       # tier sizing
stacks/<cluster>/ilm.tf            # ILM policies
modules/elastic-cloud-deployment/  # shared module
```

The MR-template category for this skill is `tier-resize`. See `knowledge/reference/mr-template.md`.

## Build the diff — autoscaling-aware

The Cloud API enforces `max_size_per_zone >= size_per_zone`. The Terraform provider mirrors this.

| Scenario | MR strategy |
|---|---|
| Downsize: `new_size < current_size` | **Two MRs.** MR1 lowers `size`; MR2 (separate, after MR1 lands and stabilises 24h) lowers `max_size`. Max-first fails validation. |
| Upsize: `new_size > current_size` | Single MR; bump `max_size` first if needed (provider may auto-bump). |
| Max-only change | Single MR. |
| Non-autoscaling tier (coord/ml on some plans) | Single MR. |
| Combined size + instance-type change | **Forbidden in one MR** per §7.1.3 — split. |

## §7.2.3 — Raise-then-downsize two-step pattern (referenced)

When a tier needs temporary capacity during an incident (e.g. ILM phase-shift causing force-merge surge), and the user agrees to give it back: open two MRs back-to-back. MR1 raises; MR2 (gated on incident-clear evidence) downsizes back. Each carries the matching observation criteria in `## Risks`. See `skills/raise-then-downsize-two-step-incident-pattern/` for the full procedure.

## Open the MR

Use the `open-mr` skill. Title format from `knowledge/reference/mr-template.md`: `[<cluster>] <tier> tier: <up|down>size — <old>GB → <new>GB`. Body is built from `mr-template.md` with:

- **Category**: `tier-resize`
- **Risk**: MEDIUM by default; **HIGH** for hot-tier downsize, any prod cold tier change, or any change to coord on us-cld (cluster-shape-dependent — see IR-114).
- **Pre-flight evidence**: paste the `validate-cluster-state` gate result (all 5 conditions).
- **gl-testing**: required (the template enforces this for `tier-resize`).
- **Rollback**: cite the previous plan_id from `elasticsearch_cloud_get_plan_history` so a human can reapply it.
- **Risks**: warm-disk-watermark trajectory, ML job state, force-merge load, GC pressure, replica imbalance, plan reversals in last 14d.

## §9.3 — Post-apply validation (cited in MR body so the checker runs it)

- Cluster health green within 30 min.
- `cluster/health?wait_for_no_relocating_shards=true` returns within 60 min.
- All nodes reporting; no missing.
- ML jobs reopened (if closed in step 3).
- Monitoring data still flowing to the monitor cluster.

## Hand off

Post the MR URL. Append to `memory/runtime/context.md` `## in-flight`. Stop. Do not approve, do not merge.
