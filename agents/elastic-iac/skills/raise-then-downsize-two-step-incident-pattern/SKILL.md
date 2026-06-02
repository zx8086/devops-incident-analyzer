---
name: raise-then-downsize-two-step-incident-pattern
description: Two-step pattern for cold-tier (or other autoscaling-ceiling) raises forced by an incident — raise tactically, then schedule the downsize once tuning/retention work has aged through. Prevents the incident raise becoming a permanent cost.
inputs:
  cluster: { type: string, required: true }
  tier: { type: string, required: true }                   # cold|frozen|warm
  incident_reason: { type: string, required: true }        # e.g. "watermark event 2026-04-21"
  ceiling_before_gb: { type: number, required: true }
  ceiling_after_gb: { type: number, required: true }
outputs:
  step1_mr_url: { type: string }
  step2_mr_url: { type: string }                           # opened later, after ≥14d
  policy_register_entry_id: { type: string }
---

# Raise-then-downsize two-step (incident pattern)

Source: `knowledge/playbook/7-infrastructure-and-cost.md` §7.2.3 (full chapter at `Elastic_Optimisation_Playbook_v12.docx` §7.2.3). Worked example: eu-cld 21 April 2026, cold ceiling 2.17 TB → 3.5 TB.

## Why this pattern

A ceiling raise under incident pressure is a tactical fix. Without follow-up, the estate pays for the higher ceiling permanently, even after the §3.3.2 frozen tuning, §8.3 retention audit, and stream-specific ILM changes land their savings. A permanent ceiling raise should require explicit cost-owner sign-off; the default posture is two MRs.

## Step 1 — Raise (incident-time MR)

1. Call `validate-cluster-state` skill with `change_type: "resize"`. Under incident conditions some gate conditions (b: breaker tripped, c: heap > 90%) may fail. **Allowed exception:** if the raise itself is the mitigation for those conditions, document the gate failures in the MR `## Risks` section and proceed — the maker step is not blocked under explicit incident framing.
2. Use the `resize-tier` skill to draft the raise. MR-template category: `tier-resize`; risk: HIGH (incident).
3. Record in the policy change register (per §8.1):
   - New ceiling value
   - Exact reason (watermark event, query pattern, breaker trip count, AutoOps event)
   - Date and cluster
   - Expected lifetime: "tactical — to be downsized once tuning ages in"
4. Open MR via `open-mr`. Title: `[<cluster>] <tier> ceiling raise — <before>GB → <after>GB (incident)`.
5. Append to `memory/runtime/context.md` `## in-flight` with explicit "scheduled downsize" reminder + a date ≥ 14 days out.

## Pre-Step-2 — Aging requirement (minimum 14 days)

Do not open Step 2 MR until:

- §3.3.2 frozen `min_age` tuning is applied AND ≥ 14 days have elapsed (frozen ILM age counter is from rollover, so new `min_age` takes effect as each index progresses, not immediately).
- §8.3 retention audit decisions are applied AND ≥ 14 days elapsed.
- Any stream-specific ILM changes have rolled over at least once.

Re-measure actual usage at this point — do not estimate from baseline.

## Step 2 — Downsize (planned MR)

1. Re-run `validate-cluster-state` with `change_type: "resize"`. All 5 gate conditions must pass cleanly now (no incident framing).
2. Compute the new ceiling as **`actual_usage × 1.25`** — not necessarily the original pre-incident value. The 25% buffer protects against the next legitimate growth event.
3. Use `resize-tier` skill. MR-template category: `tier-resize`; risk: MEDIUM.
4. Update the policy change register with before/after usage figures, the new ceiling, and the audit trail back to Step 1.
5. Open MR. Title: `[<cluster>] <tier> ceiling downsize — <step1_after>GB → <step2_target>GB (post-tuning right-size)`.
6. In the MR body, link to Step 1 MR for traceability.

## Hand off

Step 1: post MR URL, log in-flight entry with scheduled-downsize reminder.
Step 2: post MR URL, mark the matching in-flight entry as scheduled-to-close.

Both MRs go through `pre-check-gl-testing` before opening, per the standard `tier-resize` category rules.
