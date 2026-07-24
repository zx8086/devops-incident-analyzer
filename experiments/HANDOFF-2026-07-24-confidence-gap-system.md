# HANDOFF — Gap/confidence system overhaul (SIO-1194/1195/1198): what shipped, how to read it, what to follow up

- **Date:** 2026-07-24
- **Tickets (all Done):**
  - [SIO-1194](https://linear.app/siobytes/issue/SIO-1194) — confidence transparency + consistency (PR [#455](https://github.com/zx8086/devops-incident-analyzer/pull/455), squash `0e78852e`)
  - [SIO-1195](https://linear.app/siobytes/issue/SIO-1195) — two-class caps: integrity vs coverage (PR [#456](https://github.com/zx8086/devops-incident-analyzer/pull/456), squash `25b10d9f`)
  - [SIO-1197](https://linear.app/siobytes/issue/SIO-1197) — lint fallout fix from #456 (PR [#458](https://github.com/zx8086/devops-incident-analyzer/pull/458), squash `ec57a85f`)
  - [SIO-1198](https://linear.app/siobytes/issue/SIO-1198) — integrity-cap precision + capella index-first protocol (PR [#460](https://github.com/zx8086/devops-incident-analyzer/pull/460), squash `eba99e1d`; Part C recorded as an issue comment)
- **Repo state:** `main` @ `eba99e1d` (all four merged; no open confidence PRs/branches).
- **Runtime state:** the dev web server on :5173 was cold-restarted from `eba99e1d` (agent knowledge is cached per-process, so the capella SOUL/tool-belt changes required it). It runs DETACHED (nohup, started from `apps/web`), logs at `/tmp/devops-web-5173.log`. To reclaim it into a terminal: kill the vite pid on :5173 and run `bun run dev` from `apps/web`.
- **Suggested branch for follow-up work:** `claude/sio-XXXX-<topic>` off `main` (create the Linear issue first — repo rule).

## TL;DR

The confidence system was overhauled in three merged stages. Reports no longer print a bare 0.59: the confidence line self-explains, an LLM rubric calibrates the raw score, caps are split into integrity (hard, below the 0.6 gate) vs coverage (soft 0.75, passes the gate) classes with claim-level precision, and the couchbase agent now has a mandatory index-first query protocol so N1QL 4000 "no index" errors should never occur again. Everything is live on the dev server. **What remains is live verification and a small set of deliberately deferred v1 gaps (listed under "Open follow-ups").**

## Context — how this came to be

User complaint: detailed, accurate diagnoses printed `Confidence: 0.59`, making good reports look bad. Review found the cause architectural: ~9 deterministic cap triggers ALL clamped to 0.59 (just under the 0.6 HITL gate), conflating diagnosis-integrity guards with mere investigation-coverage noise; the UI dropped the `low_confidence` event and never rendered the score; the LLM had no scoring rubric. 8+ prior patches (SIO-709/860/1013/1085/1087/1106/1141/1149/1158/1162) had narrowed individual triggers without fixing the composition. Plan file (historical): `~/.claude/plans/can-we-review-the-precious-wall.md`.

The SIO-1198 stage was motivated by a live run (requestId `6d9729d1-74bb-4108-b3f7-bc3f6a8d51ac`, styles-v3 NoResourceFoundException): evidence score 0.82 hard-capped to 0.59 on `premature-absence` + `no-index-misread`, both couchbase-attributed while the root cause was elastic/gitlab/atlassian-grounded — plus 10 avoidable couchbase query failures (7 SQL++ parse, 3 no-index) because the sub-agent only consulted `capella_get_system_indexes` at iteration 11.

## How the system works now (post-eba99e1d)

**Score lifecycle:** aggregate LLM writes `Confidence: 0.XX` guided by `confidenceRubricRule` (anchor bands: 0.85-0.95 multi-source-confirmed root cause, 0.70-0.84 single-source, 0.40-0.60 unevidenced mechanism, ...) -> deterministic guards flag claims -> content rewriters correct flagged lines in place (`[SCOPE:]`/`[CORRECTION:]`/replacements) -> `decideConfidenceCap` picks none/hard/soft -> the printed line is rewritten with a self-explaining annotation -> SSE `done` carries `confidence`/`confidencePreCap`/`capReasons`/`lowConfidence` -> `ConfidenceBadge.svelte` renders it.

**Reading a capped line:** `Confidence: 0.59 (capped from evidence score 0.82 -- unverified absence claim, misread no-index result)` — first number = enforced value, second = the LLM's raw evidence score, labels from the shared map. `0.59` (strictly `min(0.59, threshold-0.01)`) = HARD cap; `0.75` (`min(0.95, max(threshold+0.1, 0.75))`) + a `_Coverage note:_` or `_Integrity note:_` line = SOFT cap that passes the review gate.

**Cap classes** (`packages/agent/src/confidence-policy.ts`):
- COVERAGE (`degraded-subagents`, `gaps`, `correlation-degraded`): soft only when every signal is deterministically attributable (snake_case tool prefixes + `ATTRIBUTION_KEYWORDS`) to datasources disjoint from `extractRootCauseDataSources(answer, dataSourcesWithReturnedData)` (walks `## Root Cause`, intersects with returned-data sources).
- INTEGRITY (`ungrounded-blocker`, `ungrounded-expiry`, `premature-absence`, `ungrounded-root-cause`, `no-index-misread`, `ungrounded-metrics`, unknown codes): hard by default; SIO-1198 tiers let a reason soften only when EVERY flagged claim was rewritten in place AND is not load-bearing (`isClaimLoadBearing` — LOCATION-based: line inside `## Root Cause`, or the section's raw prose attribution includes the claim's datasource; deliberately NOT the returned-data test, which would soften exactly the case where Root Cause cites an evidence-free datasource).
- Judges (Haiku, 8s, shrink-only, fail-closed): gaps judge (SIO-1149), absence judge contradicted arm (SIO-1158), absence judge overgeneralized arm (SIO-1198 — textual universal-vs-scoped).

**Kill switches (all default ON, read at call time):** `COVERAGE_CAP_SCOPING_ENABLED`, `INTEGRITY_CAP_TIERING_ENABLED`, `ABSENCE_JUDGE_ENABLED` (both arms), `GAPS_JUDGE_ENABLED`. Turning each off restores the respective prior behavior.

**Log signature:** one warn per capped run — `"Confidence cap decision" {capMode, capReasons, appliedCap, coverageScopingEnabled, rootCauseDataSources, degradedDataSources, originalScore, cappedScore}` (`agent:aggregator`). Judge activity: `absenceJudgeUsed/VetoedCount`, `overgeneralizedJudgeUsed/VetoedCount`, `gapsJudgeUsed/VetoedCount`.

**Capella index-first protocol (SIO-1198 Part C):** `agents/incident-analyzer/agents/capella-agent/SOUL.md` "Querying collections (MANDATORY PROTOCOL)" — list indexes ONCE before the first query of the turn; every WHERE leads on a mapped index's first key with a SARGABLE predicate (equality/range/prefix-LIKE); no usable index = don't run the query (fetch by key or report "not queryable on <field> (no usable index)" as a benign finding). Belt fix: `agents/incident-analyzer/tools/couchbase-health.yaml` `query_execution` group now carries `capella_get_system_indexes` / `capella_get_detailed_indexes` / `capella_get_document_by_id` (they previously shipped only with `index_analysis` — the action-group-gap class).

## Where the bodies are buried (key files)

| File | What lives there |
|---|---|
| `packages/agent/src/confidence-policy.ts` | `CAP_REASON_CLASS`, `decideConfidenceCap` (coverage + integrity tiers), `hardCapFor`/`softCapFor`, attribution (`TOOL_PREFIX_TO_DATASOURCE`, `ATTRIBUTION_KEYWORDS`), `extractRootCauseDataSources`, `isClaimLoadBearing`, `upsertCoverageNote`/`upsertIntegrityNote`, both kill switches |
| `packages/agent/src/aggregator.ts` | rubric + format prompt rules; guards/detectors; content rewrite chain (runs BEFORE the cap decision since SIO-1198 so `rewritten` is observed); `IntegritySignal[]` construction; annotated `rewriteConfidenceInAnswer(answer, score, {preCap, capReasons} \| "strip")`; `extractConfidenceScore` (exported) |
| `packages/agent/src/absence-judge.ts` | both judge arms + shared `mapVerdicts`; `judgeOvergeneralizedAbsenceClaims` is textual-only (tool INPUTS are not persisted in state) |
| `packages/agent/src/confidence-gate.ts` | `getConfidenceThreshold` (manifest), `deriveConfidenceCap` (0-clamped), non-blocking `checkConfidence` |
| `packages/agent/src/correlation/enforce-node.ts` | correlation re-cap (merges `correlation-degraded`, strips BOTH notes on hard-over-soft), SIO-1155 restore path (strips annotation + notes, clears `capReasons`), `correlationCoverageSignals`, `CorrelationRule.relevanceDataSources` (declared by NO rule in v1) |
| `packages/agent/src/validator.ts` | ungrounded-metrics cap; rewrites prose + merges `capReasons` (SIO-860 invariant holds on this path too) |
| `packages/shared/src/confidence.ts` | `CAP_REASON_INFO` (9 codes -> label/detail) — single source for prose + UI; Svelte imports via SUBPATH, never the barrel |
| `apps/web/src/lib/server/sse-pump.ts` -> `stream`/`topic-shift` routes -> `agent-reducer.ts` -> `agent.svelte.ts` -> `ConfidenceBadge.svelte` | cap-transparency plumbing (Zod-parsed per field; `[]` capReasons from the restore path clears) |
| `docs/architecture/agent-pipeline.md` (~confidence cap section + state table) | the canonical written policy incl. tier matrix |

Test anchors: `confidence-policy.test.ts` (full class matrix), `aggregator.test.ts` (`SIO-1195`/`SIO-1198` describes, annotation + extraction safety), `aggregator-grounding-integration.test.ts` (judge-veto wiring, pinned SIO-1085/1158 corpora), `absence-judge.test.ts`, `correlation/integration.test.ts`, `sse-pump.test.ts`, `agent.handleEvent.test.ts`, `ConfidenceBadge.test.ts` (component tests MUST run from `apps/web` — bunfig preload compiles .svelte).

## Open follow-ups (pick one per fresh session; create a Linear issue first)

1. **Live-verify Part C (highest priority — the user's explicit requirement: zero N1QL 4000s).** Run a couchbase-touching incident against :5173 and check the log: `capella_get_system_indexes` should appear at iteration 1-2 (not 11), `toolErrors` for couchbase should contain NO `kind: "no-index"` and materially fewer `bad-query` entries. Replay recipe below. If the agent still skips the protocol, next levers: repeat the protocol in the capella `agent.yaml` system prompt area, or a deterministic beforeToolCall guard in the couchbase MCP that rejects un-indexed SELECTs with a structured refusal (config must be TOP-LEVEL — see memory `reference_elastic_probe_cold_fork_connect_timeout`).
2. **Live-verify the soft-cap paths.** No live run has yet exercised coverage-soft (0.75 + `_Coverage note:_`) or integrity-soft (0.75 + `_Integrity note:_`). Watch `capMode:"soft"` in the cap-decision log and the amber badge with expandable reasons in the UI.
3. **Watch judge veto rates.** `overgeneralizedJudgeVetoedCount` / `absenceJudgeVetoedCount` / `gapsJudgeVetoedCount` in logs — sustained 100% veto means a regex arm is pure noise (candidate for removal); 0% veto with user complaints means the judge prompt needs tuning.
4. **Deferred v1 gaps (deliberate, documented in SIO-1198 out-of-scope):**
   - enforce-node/validator integrity reasons are UNSIGNALLED -> always hard (`skipCoverageCheck` correlation rules, `ungrounded-metrics`). Plumb `IntegritySignal`s if replay data shows over-capping there.
   - `CorrelationRule.relevanceDataSources` is declared by NO rule -> correlation degradation always hard. Opting a rule in is a one-field change (declare trigger-side AND required-side datasources).
   - The overgeneralized judge is textual-only; if it under-performs, persist tool INPUTS in state and add an evidence digest.
   - Rubric bands are v1 guesses; calibrate against LangSmith replay data if scores drift.
5. **If a good report still caps unfairly:** get the `"Confidence cap decision"` log line first — `capReasons`+`capMode`+`rootCauseDataSources`+`degradedDataSources` tell you which guard fired and why scoping didn't soften it. The known remaining shape: an integrity flag echoed in Root Cause (load-bearing by design) — that is intended behavior, argue policy not bug.

## Verification (copy-paste)

```bash
# Gates (run FULL lint on the final commit -- SIO-1197 lesson: targeted biome checks let #456 merge red)
bun run typecheck && bun run lint && bun run test && bun run yaml:check

# Live replay against the running dev server (server must be up on :5173)
curl -sS -X POST http://localhost:5173/api/agent/stream -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Investigate elevated HTTP 500 error rates for the prana-fashionmasters-afs service in the last 24 hours and identify the likely root cause."}],"dataSources":["elastic","couchbase"],"targetDeployments":["eu-b2b"]}' \
  --max-time 300 -o /tmp/replay-sse.txt
grep -o '"type":"done"[^\n]*' /tmp/replay-sse.txt          # expect confidence + confidencePreCap (+ capReasons when capped)
grep -o 'Confidence: [0-9.]*[^"]*' /tmp/replay-sse.txt | tail -1   # annotated line when capped

# Part C check (server log)
grep -n "capella_get_system_indexes" /tmp/devops-web-5173.log | head -3   # expect iteration 1-2
grep -c "no-index\|code 4000" /tmp/devops-web-5173.log                    # expect 0 for new runs
grep "Confidence cap decision" /tmp/devops-web-5173.log | tail -1
```

Worktree replay variant (changes not yet on the user's server): memory `reference_worktree_web_server_replay_env` — start :5174 from the worktree with MAIN/.env sourced + `KNOWLEDGE_GRAPH_ENABLED=false`.

## Risks / gotchas for the next session

| Risk | Mitigation |
|---|---|
| Agent prompt/YAML changes silently not live | Agent knowledge is cached per-process — COLD-restart the web server after touching `agents/**` |
| Full-state test fixtures break when adding state channels | ~11 test files enumerate EVERY channel; perl-insert after `confirmedDegradingGapBullets` (see SIO-1195 history) |
| `aggregator.test.ts` mocks the `@devops-agent/shared` barrel | import new shared symbols in aggregator.ts via SUBPATH (`@devops-agent/shared/src/confidence.ts`) |
| Merging with a red Lint CI check | main has NO branch protection; check the four CI checks on the FINAL commit, not an earlier one |
| Stacked-PR squash conflicts | after squash-merging PR1, PR2 shows CONFLICTING; `git merge origin/main`, resolve with `--ours` (branch is a superset), verify `git diff <pre-merge-sha> HEAD --stat` shows only main's own commits |
| CodeRabbit "pass (Review rate limited)" | no incremental is coming — do not wait; trigger `@coderabbitai review` only for stacked PRs (auto-review skips non-main bases) |
| bun full-suite exit 133 | known transient lbug/KG segfault flake — rerun before diagnosing |

## Out of scope of this handover

The styles-v3 incident ITSELF (routing miss in `pvh.services.styles` task def :47, Jira DEVOPS-1396/1397) — that is an application bug for the Blue Team, tracked in Jira, not part of the confidence-system work.

## Memory references

- `reference_confidence_two_class_policy_sio1194_1195` — the hub: full policy, diagnosis signatures, all gotchas, SIO-1198 status
- Pre-history: `reference_confidence_prose_vs_gate`, `reference_gaps_cap_counts_only_degrading`, `reference_grounded_gaps_confidence_cap`, `reference_absence_judge_premature_absence_veto`, `reference_streamed_confidence_bypasses_cap_rewrite`
- Ops: `reference_worktree_web_server_replay_env`, `reference_agent_knowledge_cached_per_process`, `reference_subagent_missing_tool_is_action_group_gap`, `reference_pr_merge_no_branch_protection_and_worktree_gh_quirk`, `reference_main_preexisting_test_lint_failures`
