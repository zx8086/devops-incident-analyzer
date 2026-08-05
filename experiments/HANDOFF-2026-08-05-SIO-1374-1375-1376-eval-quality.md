# Handover: per-datasource evidence judging + eval-quality regression fixes (SIO-1374/1375/1376)

**Date**: 2026-08-05
**Tickets**:
- [SIO-1374](https://linear.app/siobytes/issue/SIO-1374/per-datasource-evidence-judging-for-the-incident-replay-eval) — Done
- [SIO-1375](https://linear.app/siobytes/issue/SIO-1375/aggregator-maxtokensvalidatorgitlab-recursion-regression-found-via-sio) — Done
- [SIO-1376](https://linear.app/siobytes/issue/SIO-1376/eval-harness-missing-awsurl-in-createmcpclient-aws-evidence-always) — Done
- Parent epic: none (standalone eval-quality follow-on chain from [SIO-1372](https://linear.app/siobytes/issue/SIO-1372), judge root-cause gate, PR [#590](https://github.com/zx8086/devops-incident-analyzer/pull/590))

**Repo state**: all three PRs merged to `main`.
- PR [#591](https://github.com/zx8086/devops-incident-analyzer/pull/591) (SIO-1374 + SIO-1375) → `65b2857d`
- PR [#592](https://github.com/zx8086/devops-incident-analyzer/pull/592) (SIO-1376) → `ec45e58c` (current `main` tip as of this handover)

**Suggested branch for follow-up work**: `sio-1374-aws-eval-rerun` off `main` at `ec45e58c`.

## TL;DR

The incident-replay eval (32 real historical DevOps incidents, A/B-comparing sub-agent models) was silently unreliable in three independent ways, all now fixed and merged:

1. **Judge measured the wrong thing** (SIO-1374): a single holistic score over the final report partly measured the constant (Sonnet 5 aggregator's prose) instead of the variable (sub-agent evidence quality). Fixed by adding per-datasource evidence verdicts and a separate per-sub-agent judge, isolating the two.
2. **Aggregator had a real production bug** (SIO-1375): Sonnet 5's reasoning block was silently consuming the entire 16384-token output budget on ~20% of real calls, sometimes producing zero-content reports that a validator blind spot let ship as "passing." This wasn't a measurement artifact — it was actively corrupting the eval's A/B conclusion (haiku appeared to beat sonnet-4-6; after the fix, sonnet-4-6 clearly wins).
3. **The eval harness never actually queried AWS** (SIO-1376): a one-line config omission meant `evidence_aws`/`subagent_accuracy_aws` were 0.000 in every run, ever, silently — mistaken at first for an environment gap.

**What's NOT done**: the eval has never been re-run with all three fixes in place AND AWS actually connected. That's the concrete next step — see "Next steps" below.

## Context — how this came to be

This session started as a continuation of [SIO-1372](https://linear.app/siobytes/issue/SIO-1372)'s judge rework (see `experiments/HANDOFF-2026-08-03-SIO-1372-eval-judge-rework.md`), which added a root-cause-match gate to the eval's LLM-as-judge. A manual audit of that gated judge (artifact `https://claude.ai/code/artifact/c05d74e7-1d04-4b3c-b375-f041fda2f30e`) found 7/8 verdicts correct but exposed a structural gap — see SIO-1374 below.

## What was done, and why

### 1. SIO-1374 — per-datasource evidence judging

**Design doc**: `docs/superpowers/specs/2026-08-04-per-datasource-evidence-judging-design.md`
**Implementation plan**: `docs/superpowers/plans/2026-08-04-per-datasource-evidence-judging.md` (executed via `superpowers:subagent-driven-development`, 10 tasks, full ledger in the plan's own workspace — since deleted per that skill's finish step, the plan file itself + PR #591's commit history is the record)

**The problem**: the eval's A/B harness varies only the 7 sub-agent models; the final report is always synthesized by the same root Sonnet 5 aggregator. A holistic 1-10 score over that final report conflates "did the sub-agent find the right evidence" with "did the aggregator write it up well" — a weak sub-agent finding can be dressed up, a strong one buried.

**What shipped**:
- `packages/agent/src/eval/incident-replay-dataset.ts` — backfilled a new `referenceFindings: { [datasource]: string }` map on all 32 dataset entries, sourced from the real DEVOPS Jira tickets' own "Findings by Datasource" sections (via Atlassian MCP). This is the ground truth the new per-datasource judging grades against.
- `packages/agent/src/eval/evaluators.ts`:
  - `HolisticGradeSchema.datasourceVerdicts` — the existing holistic judge now ALSO grades per-datasource evidence in the same call (`found`/`partial`/`missed`, plus `gapsHonest`/`fabricated` flags folded in from an earlier section-judging idea). Emits `evidence_<datasource>` LangSmith feedback keys.
  - `judgeSubagentReports` / `subagentEvidenceJudge` — a **second, independent** judge that grades each sub-agent's own serialized findings (`buildSubagentReports`, `packages/agent/src/eval/subagent-reports.ts`) against `referenceFindings`, isolating the sub-agent model from the aggregator entirely. Emits `subagent_accuracy_<datasource>` keys.
  - Era-drift prompt fix: the judge previously misread truthful "this is a live recurrence, here's a co-occurring symptom not in the frozen reference" observation as fabrication (the audit's #8 miscall, DEVOPS-1386). Fixed with an explicit evidence-grounded exemption in the prompt.
- `packages/agent/src/eval/run-function.ts` — `runAgent` now also returns `subagentReports` on its output, surfacing each sub-agent's raw findings.
- Non-goal, explicitly: section-by-section (Timeline/Findings/Root Cause) grading — that structure is pipeline-enforced, so grading it would re-measure formatting, not investigation quality.

**Live-verified** (Task 10 of the plan, then re-verified after SIO-1375's fixes — see below): both A/B legs run end-to-end, per-datasource keys populated in real LangSmith run data, DEVOPS-1386 spot-check confirmed the era-drift fix works.

### 2. SIO-1375 — three real regressions found via the SIO-1374 eval run

Discovered because the first full A/B run (Task 10) showed **both legs underperforming the June-era human-curated ground truth** — the reverse of what should happen. A systematic sweep of every LLM role's config history since 2026-06-01 (DEVOPS-1353's creation date) found three unrelated real bugs, not a genuine capability regression:

- **Aggregator `maxTokens` undersized for Sonnet 5** (`packages/agent/src/llm.ts`): `ROLE_OVERRIDES.aggregator.maxTokens` had been `16384` unchanged since SIO-649, calibrated against a small synthetic probe prompt (~600 input tokens, 3874-4287 output tokens measured). The MODEL running under it changed `sonnet-4-6` → `sonnet-5` on 2026-07-26 (SIO-1213); Sonnet 5 has a documented stochastic reasoning-block-emission behavior that the small probe never exercised. On the real 32-incident eval (30-49K input tokens/call), the aggregator hit `max_tokens` on 13/64 calls — twice with the reasoning block alone consuming the whole budget, zero answer text. **Fixed**: raised to `32768`, with a regression test requiring real headroom above the observed eval ceiling.
- **Validator blind to the DDL backstop**: a deterministic post-processing step (`ensureVerbatimDdl`, SIO-1140) always appends a "## Server-computed index DDL (verbatim)" section to the aggregator's answer so a real DB recommendation is never silently dropped — even when the aggregator's own synthesis is EMPTY. That backstop text alone (1000+ chars) cleared `validator.ts`'s `answer.length < 50` retry gate, so a report that was ONLY a raw DDL dump passed validation and shipped as "complete." **Fixed**: `validate()` now strips the backstop section before measuring length.
- **gitlab recursion limit too tight**: `RECURSION_LIMIT_BY_DATASOURCE.gitlab` was `36` (SIO-1262), calibrated from one prior thrash incident. On the real eval, gitlab hit its `final_turn_reserved` warning at EXACTLY 12 LLM turns every time it triggered (19/64 total) — a hard ceiling on genuine investigations, not thrash. Per explicit user instruction: **a deep-agent architecture should bound LLM turns for cost/loop safety, never the evidence available per turn**. **Fixed**: raised to `60` (matching elastic/aws's tier), effective turn budget `12` → `20`.

**Re-run confirmed the fixes work** (comment on SIO-1375, dataset unchanged at `b6261da7-43bd-4f26-b1fe-44b1fef0022e`):

| Metric | Before fixes | After fixes |
|---|---|---|
| Aggregator `max_tokens` hits | 13/64 | **0/64** |
| DDL-only (empty) reports | non-zero | **0** |
| gitlab recursion-limit hits | 19/64 (always at old ceiling) | **1/64** (at the NEW ceiling — using full budget) |
| response_quality (haiku / sonnet) | 0.667 / 0.625 | 0.618 / **0.722** |
| root_cause_accuracy (haiku / sonnet) | 0.719 / 0.672 | 0.641 / **0.797** |

**The A/B conclusion flipped.** Pre-fix, haiku-4-5 appeared to beat sonnet-4-6 — an artifact of the aggregator bug hitting the sonnet leg 3x harder (10/32 vs 3/32 truncated). Post-fix, sonnet-4-6 clearly wins on both metrics. **If a sub-agent model decision had been made off the pre-fix numbers, it would have been backwards.**

### 3. SIO-1376 — AWS was never actually queried in any eval run

While reviewing the SIO-1375 re-run, `evidence_aws`/`subagent_accuracy_aws` were 0.000 in literally every run this whole session (both legs, before AND after SIO-1375's fixes). Root-caused via a **live curl** against the AWS MCP server (`http://localhost:3001/mcp`, `tools/list`) — **HTTP 200, 49 tools returned**, server fully healthy. So the "AWS MCP tool-availability gap" noted as a caveat in both SIO-1374 and SIO-1375's writeups was wrong — a genuine harness bug, not an environment issue.

`packages/agent/src/eval/run-function.ts`'s `ensureMcpConnected()` built its `McpClientConfig` with six datasource URLs and simply never included `awsUrl` — present since the file's first commit, unrelated to SIO-1374/1375. Production (`apps/web/src/lib/server/agent.ts:224`) had it right the whole time.

**Fixed**: added `awsUrl: process.env.AWS_MCP_URL`, extracted the whole env→config mapping into a new pure, exported `buildEvalMcpConfig()` function so the regression test needs zero mocking (see "gotchas" below for why that mattered).

**NOT yet re-verified live** — see next steps.

## Gotcha hit during SIO-1376: a real CI-only test failure, and how it was resolved

Worth flagging explicitly because it cost significant time and is a real, reusable lesson for this repo:

PR #592's CI `Test` check failed **deterministically, 3/3 times**, on `packages/agent/src/__tests__/mcp-bridge.boot-strict-integration.test.ts` — a file completely unrelated to the `awsUrl` change. It **never reproduced locally**, under any invocation (isolated file, filtered package, exact root `bun run test` command), same Bun version (`1.3.14`) both places.

- First hypothesis (wrong, but a real bug worth fixing anyway): the new test's `mock.module("../mcp-bridge.ts", () => ({ createMcpClient: ... }))` replaced the module's ENTIRE namespace for every OTHER test file loaded afterward in the same bun process — a documented pattern this repo has hit before (see memory `reference_bun_mock_namespace_live_binding_poisoning`). Fixed by spreading the real exports + `afterAll` restore, matching `resolve-identifiers.test.ts`'s established pattern. **CI still failed identically after this fix** — proving this wasn't the actual cause here.
- Real root cause: `packages/agent/src/__tests__/` has 4 files that mutate `global.fetch` with no isolation between them. CI's runner has more available parallelism than local dev machines; Bun's test runner schedules files across workers differently under real concurrency, causing a cross-file race that only manifests above some parallelism threshold. **Fix**: added `--isolate` to `packages/agent/package.json`'s `test` script (`bun test --isolate`) — the same fix this repo already used once before for this exact class of bug (memory `reference_bun_test_isolate_kills_mock_module_pollution`). This turned CI green immediately. Locally this also revealed 69 previously-silently-skipped tests were themselves victims of the same cross-file pollution (now `3740 pass / 0 skip` instead of `3671 pass / 69 skip`).
- **Separately**, also rewrote the SIO-1376 regression test to need zero mocking at all: extracted `buildEvalMcpConfig()` as its own pure, exported function, so the awsUrl mapping is testable with a plain object instead of `process.env`/`mock.module`. This removes the whole risk class for this specific test, independent of whether `--isolate` alone would have been sufficient.

**Takeaway for a future session**: if a CI-only, locally-unreproducible test failure shows up in this package, check (a) whether `packages/agent/package.json`'s `test` script still has `--isolate` (don't remove it without understanding why it's there), and (b) whether a new `mock.module()` call in a test file spreads the real module's exports and restores it in `afterAll` — the established, correct pattern, not a bare mock literal.

## Where the bodies are buried — file:line references

- `packages/agent/src/eval/evaluators.ts` — both judges live here. `HolisticGradeSchema` (~line 7-45), `judgeFeedback` (~line 97, now takes an optional `allowedDatasources` filter param added during CodeRabbit triage), `judgeSubagentReports`/`subagentEvidenceJudge` (~line 279-450), `truncateForJudge` (a payload-size cap added during CodeRabbit triage, ~line 320).
- `packages/agent/src/eval/incident-replay-dataset.ts` — 32-entry dataset, each with `referenceReport` (Executive-Summary-only) AND now `referenceFindings` (per-datasource). Line count ~800+ after the backfill.
- `packages/agent/src/eval/subagent-reports.ts` — `buildSubagentReports`, serializes each datasource's structured `*Findings` object.
- `packages/agent/src/eval/run-function.ts` — `runAgent` (the eval harness entrypoint), `ensureMcpConnected`, `buildEvalMcpConfig` (new, SIO-1376).
- `packages/agent/src/llm.ts:85` — `ROLE_OVERRIDES.aggregator.maxTokens: 32768` (was 16384).
- `packages/agent/src/validator.ts` — `VERBATIM_DDL_SECTION_RE` strip before the short-answer gate.
- `packages/agent/src/sub-agent.ts` — `RECURSION_LIMIT_BY_DATASOURCE.gitlab: 60` (was 36).
- `packages/agent/package.json:8` — `"test": "bun test --isolate"`.
- `packages/gitagent-bridge/src/model-registry.ts` — `claude-sonnet-5.longFormMinTokens: 8192` still has a caveat comment (not re-measured) noting it's proven only for small prompts — this is the one unaddressed acceptance-criterion follow-up from SIO-1375.

## Next steps (the actual reason this handover exists)

All three tickets are Done in Linear, but **the eval has never been run with all three fixes AND AWS actually connected at the same time**. That's real, concrete, unblocked follow-up work:

1. **Re-run the SIO-1374 incident-replay eval, both A/B legs, on current `main`** (`ec45e58c`). This is the SIO-1376 acceptance criterion left unchecked. Use the exact procedure documented in `experiments/HANDOFF-2026-08-03-SIO-1372-eval-judge-rework.md` and repeated in this session's own prior runs:
   ```bash
   # from packages/agent, with .env temporarily copied in from repo root (delete after)
   bun run --filter @devops-agent/agent eval:precheck   # confirm all 6+1 MCP servers reachable
   bun run eval:incident-replay -- --sub-agent-model claude-haiku-4-5
   bun run eval:incident-replay -- --sub-agent-model claude-sonnet-4-6
   ```
   Pull results via direct LangSmith REST (`POST /api/v1/runs/query`, `session:[id], is_root:true`), not console output — console output truncates. Check specifically: are `evidence_aws`/`subagent_accuracy_aws` non-zero now? Append results to SIO-1376 (or a new small follow-up ticket) — append, don't replace, don't set Done without user approval.
   **MANDATORY**: kill every MCP server you start yourself by tracked PID, prove ports free with `lsof -nP -iTCP:<port> -sTCP:LISTEN`, delete the temporary `.env`. See CLAUDE.md's "Critical Rules > Workflow" for the exact non-negotiable discipline.

2. **`claude-sonnet-5`'s `longFormMinTokens` probe re-run** (SIO-1375's second unchecked acceptance criterion). Currently `8192` in `packages/gitagent-bridge/src/model-registry.ts`, annotated as proven only for a ~600-token synthetic prompt, not real 30-49K-token workloads. Re-run `bun run model:probe` (see `packages/agent/src/eval/probe-model.ts`) against a realistically large prompt and update the registry figure + its `verifiedAt`/`probeReport` fields.

3. **Investigate the `subagent_accuracy` vs `evidence_*` gap** (noted in SIO-1374's final comment, not yet a ticket). `subagent_accuracy_elastic` was ~0.04-0.06 while `evidence_elastic` (aggregator-mediated) was ~0.8 in the same runs — the aggregator successfully narrates sub-agent findings that the raw findings alone don't reproduce closely enough to earn `correct`/`partial` from the stricter per-sub-agent judge. Worth a manual read of 2-3 concrete low-scoring `subagent_accuracy_elastic` examples to determine if this is genuine sub-agent weakness or judge over-strictness — this is exactly the signal SIO-1374 was built to surface, so it deserves a look before being dismissed as judge noise.

## Verification block

```bash
bun run typecheck && bun run lint && bun run test
```
Expected: clean, 0 errors, 0 lint issues. Test count as of `ec45e58c`: agent package `3740 pass / 0 skip / 0 fail` (with `--isolate`), web package `271 pass / 0 fail`.

Manual probes for the next-steps work:
- `curl -s -X POST http://localhost:3001/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'` — confirms the AWS MCP proxy is live before assuming any AWS-related failure is environmental (this exact check is what root-caused SIO-1376 instead of chasing a phantom environment gap).
- `langsmith dataset get incident-replay-eval` — confirms current live dataset id before assuming it needs re-upload (it does NOT need re-upload for the next-steps work above — SIO-1374/1375/1376's fixes are all code-side; the dataset id `b6261da7-43bd-4f26-b1fe-44b1fef0022e` is still correct).

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| A fresh session assumes `evidence_aws=0` is still an environment gap (the SIO-1374/1375 caveat text says this) | Medium — the SIO-1374/1375 Linear comments still contain the now-outdated "AWS MCP tool-availability gap" framing | This handover and SIO-1376 both correct the record; read SIO-1376 before trusting SIO-1374/1375's caveat wording verbatim |
| Re-running the eval without confirming `awsUrl` actually applies (e.g. stale `.env`, wrong `AWS_MCP_URL`) | Low | The `eval:precheck` script explicitly checks AWS reachability (`packages/agent/src/eval/precheck.ts:40`, `required: true`) — it will fail loudly if AWS isn't wired, don't skip it |
| Removing `--isolate` from `packages/agent/package.json` to "speed up" local iteration | Medium if someone hits the ~30s vs ~4.5s runtime difference and doesn't know why it's there | This handover's "Gotcha" section explains why; also see memory `reference_bun_test_isolate_kills_mock_module_pollution` |
| Treating the flipped A/B conclusion (sonnet-4-6 now wins) as final at n=32 | Medium | SIO-1374's own comment already flags this as "the gap closed/reversed, not a confident model-decision basis" — a larger n or repeated run would strengthen confidence before using this for a real model swap decision |

## Out of scope

- Any further model-swap decision (haiku-4-5 vs sonnet-4-6 for sub-agents) — this handover's job was to make the eval trustworthy, not to make that decision. That's separate, future work once next-step #1 above confirms clean numbers with AWS included.
- The `evidence_elasticsearch` vs `evidence_elastic` key-naming drift noted in SIO-1374's comment (cosmetic, freeform judge JSON output, 2-5/32 examples) — flagged but not fixed, low priority.
- Any change to the `gitlab`/other datasource recursion limits beyond what SIO-1375 already did — SIO-1375's fix used the generic tier value (60) rather than deriving a new bespoke number from a dedicated probe; a tighter, evidence-derived value is a possible future refinement but not required.

## Related code references (patterns already correct, worth reading before changing anything nearby)

- `packages/agent/src/resolve-identifiers.test.ts:1-20` — the correct `mock.module` spread + `afterAll` restore pattern, referenced above.
- `packages/agent/src/eval/evaluators.test.ts` — the established no-network, pure-function-only test convention every new judge-logic test in this session followed.
- `packages/agent/src/eval/precheck.ts` — the MCP-reachability gate the eval scripts run before spending real API cost; extend this file, not the eval scripts themselves, if a new datasource ever needs a precheck.

## Memory references

- `reference_bun_mock_namespace_live_binding_poisoning` — the cross-file `mock.module` leak pattern hit during SIO-1376.
- `reference_bun_test_isolate_kills_mock_module_pollution` — why `--isolate` was the actual fix, and that this repo has needed it before.
- `reference_holistic_judge_missing_rootcause_gate` — SIO-1372 predecessor context (root-cause gate, `applyRootCauseCap`/`squareVerdictWithReference`, untouched by all three tickets in this handover).
- `feedback_repo_is_public_sanitize_before_commit` — relevant if touching `incident-replay-dataset.ts` again; a real AWS account id slipped through once during SIO-1374's dataset backfill and had to be caught/fixed in CodeRabbit review.
- `feedback_no_handover_for_completed_work` — the reason this handover explicitly earns its keep via the "Next steps" section rather than being a pure closed-program summary.
