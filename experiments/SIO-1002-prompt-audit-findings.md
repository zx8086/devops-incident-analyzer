# SIO-1002 — Prompt audit of the last 3 days of elastic-iac commits

Date: 2026-06-21 · Base: merged `main` @ `0baccab` · Files: `packages/agent/src/iac/nodes.ts` (parseIntent instruction + iacClassifier prompt), `state.ts`.

## TL;DR

The code-vs-prompt split is **sound overall** — the recent fixes are predominantly deterministic code, and the "remove vs set-null" prompt guidance (SIO-996/999) is correctly stated. The audit found **one verified shipped defect** plus a small set of prompt-clarity improvements.

The headline: the `parseIntent` instruction's **workflow enum omits `'cluster-settings-edit'`** — the same class of bug as SIO-1001 (prompt contradicts the shipped capability), invisible to the test suite because tests call `parseIntentJson` with pre-formed JSON and never exercise the real LLM instruction.

---

## F1 — VERIFIED DEFECT: `cluster-settings-edit` missing from the parseIntent workflow enum

- **Where:** `nodes.ts:788-789` — the instruction string the LLM is constrained by:
  `'tier-resize'|...|'cluster-default-edit'|'space-edit'|...` — **no `'cluster-settings-edit'`**.
- **But:** `IntentSchema` accepts it (`nodes.ts:~109`) and the prose fully documents it (`nodes.ts:~857-872`, SIO-994/996).
- **Impact:** When a user asks to edit cluster persistent/transient settings, the planner is told the only legal workflow values exclude the correct one. It tends to emit `cluster-default-edit` (wrong stack/file → wrong PUT surface) or `other` (capability refusal). No user rephrasing fixes it — identical failure mode to SIO-1001.
- **Why it shipped undetected:** every IaC test constructs the request via `parseIntentJson({ workflow: "cluster-settings-edit", ... })`, which **bypasses the instruction string**. No test drives the real `parseIntent` (LLM + enum). So the missing token is untested.
- **Fix:** add `'cluster-settings-edit'` to the enum in the instruction (one token, between `'cluster-default-edit'` and `'space-edit'`). Optionally add a regression guard that asserts the instruction-string enum and `IntentSchema` enum are in sync.
- **Confidence:** HIGH (verified by direct read; `grep` confirms the token is absent from the prose-facing enum line while present in the zod enum).

## F2 — CLARITY: user_settings_yaml modes (a1/a2/a3) don't state mutual exclusivity or target selection

- **Where:** `nodes.ts:~894-907` (SIO-997 a1 merge, a2 whole-block, SIO-999 a3 removal).
- **Gaps:** (a) the three modes are labelled but never declared mutually exclusive, so the planner could in principle set merge fields and removeKeys together; (b) the elasticsearch_config-vs-kibana target choice is only hinted, not given a decision rule.
- **Severity:** LOW-MEDIUM. The removal/null steering itself is correct (SIO-996/999 explicitly forbid null). This is about preventing a rare malformed combination, not a known failure.
- **Fix:** one sentence — "(a1)/(a2)/(a3) are mutually exclusive; use exactly one per request" + a target-selection hint ("xpack.*/cluster.*/indices.* → elasticsearch_config; Kibana features → kibana").
- **Confidence:** MEDIUM (no observed failure; preventive).

## F3 — CLARITY: `clusterDefaults[]` multi-file folding idiom not described to the planner

- **Where:** `nodes.ts:~884-891` (SIO-979). `ilmPolicies[]` gets an explicit "single → singular fields; ≥2 → array" rule; `clusterDefaults[]` does not, though `parseIntentJson` folds it identically.
- **Severity:** LOW. The fold is forgiving (0/1 entries collapse to singular), so the practical risk is small.
- **Fix:** mirror the ilmPolicies sentence for clusterDefaults.
- **Confidence:** MEDIUM.

## F4 — DOC-NICETY (not a defect): undocumented post-classification coercions

- `gitops-amend` is never LLM-emitted — the pre-LLM correction guard (`nodes.ts:623`) returns it before the classifier runs, so the classifier prompt correctly lists only the LLM-selectable intents. **Not a bug.**
- `coerceConverseIntent` downgrades a first-message `converse` → `info` (`nodes.ts:~596`); the fleet-status guard routes to `pipeline-status` from runtime state the LLM can't see. These are deliberate code overrides; the prompt needn't enumerate them.
- **Action:** none required. Optionally a one-line comment near the classifier prompt noting "amend/coercion are code-routed" for future maintainers. Confidence the current behavior is correct: HIGH.

## Clean bills (verified, no change needed)

- **SIO-996 / SIO-999 / SIO-997 removal & merge prompts** — explicitly forbid the tempting null shape and state "you do NOT reproduce the existing YAML". Prompt and code are in parity.
- **SIO-1000, SIO-989, SIO-985, SIO-969, SIO-979 writers/guards** — pure deterministic code, no un-instructed LLM dependency.
- **index-template-create (SIO-978)** — every schema field is described; disambiguation from cluster-default-edit / ilm-rollout bind is explicit.
- **cluster-settings-edit prose (SIO-994/996)** — complete and correctly disambiguated from cluster-default-edit (the *only* gap is the missing enum token, F1).
- **drift vs synthetics-drift, looksLike* guards** — pure regex with correct code tiebreaks; SIO-983 converse→gitops guard is a reasonable belt-and-braces over an inherently fuzzy boundary.

---

## Recommendation

- **Ship F1 now** as a small fix (it's a live defect): add the enum token + a sync-guard test. Worth its own child issue.
- **Bundle F2 + F3** as low-priority prompt-clarity polish (optional; one child issue or fold into F1's PR).
- **F4:** no action.
