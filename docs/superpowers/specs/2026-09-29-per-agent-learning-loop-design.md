# Per-agent learning loop and reviewed fleet knowledge channel (agent-beacon elements)

Status: approved design, 2026-09-29. Implementation tracked as a Linear epic with one child issue per slice.

Base commit `93383bcf`. All paths are relative to the repo root.

## Context

The user asked how to take elements of [agent-beacon](https://github.com/Asymptote-Labs/agent-beacon) so that each of the four main agents (incident-analyzer, elastic-iac, landing-zone-terraform, pi-fleet-console) improves after each session, and so that pi-coms spoke learnings are reused by later spoke sessions. Two levels: main agents, and the fleet.

**What agent-beacon actually is** (source-verified in the local checkout): about 86k lines of Go telemetry capture, plus a 1.8k-line, fully human-gated learning feature. Worth borrowing, and only these:

1. The record model `candidate -> approved | rejected | superseded` with `Evidence[]` provenance (`pkg/asymptoteobserve/learning.go`).
2. The hard `task_success` precondition on the judge gate that a mean score cannot override (`internal/learning/candidate.go:19-47`).
3. The lesson-quality rubric (`agent-skills/skills/beacon-memory-distill/references/lesson-quality.md`): imperative title under 80 chars, applicability starts with when/before/after, body 3-10 lines (what, why, how to confirm), every claim tied to evidence.
4. Exporting approved lessons as SKILL.md / runbook markdown with provenance frontmatter.

Not worth borrowing: its telemetry, MCP recall (substring match, newest-first), or anything it claims but lacks (ranking, decay, dedupe, usage feedback, cross-machine sync).

**What this repo already has** and this plan generalises rather than duplicates: `kind:skill` facts + `skill-learner.ts` + `skill:promote` CLI (SIO-1015/1017), the HIL lane `packages/agent/src/learn/*` with `draftSkillPr` / `draftRunbook`, memory-pr with a dead-ended `/api/agent/memory/promote` route, reflect A1-A4, the Jev seam + `decision_metrics`, the agent-memory backend with one identity per agent, the fleet monitor journal checkpointed to S3, and the `deploy/suppressions.yaml` reviewed-bundle precedent.

**Root-cause gaps found** (the real problems, fixed first):

- `getAgentsDir()` defaults to `incident-analyzer` (`packages/agent/src/paths.ts:54`) and `runtimeDir()` in `memory-writer.ts:66` calls it with no name, so on the file backend every agent's runtime memory lands in incident-analyzer's files.
- `getRecalledMemoryContext` (`lifecycle.ts:86`) is read only by `aggregator.ts:1725`; elastic-iac, landing-zone and pi-fleet-console compute recall at bootstrap and never read it.
- Every learning loop is hard-wired to incident-analyzer: `LEARNER_AGENT` (`skill-learner.ts:24`), `SKILL_PR_AGENT` (`learn/skill-pr.ts:18-20`), `readCompletedTurn` returns null unless `hasConfidence` (`apps/web/src/lib/server/agent.ts:580`).
- Thumbs feedback goes to LangSmith only (`apps/web/src/routes/api/agent/feedback/+server.ts`).
- Fleet: no cross-session learning path exists beyond the reviewed bundle.

**User decisions** (2026-09-29): fleet channel = reviewed bundle; human gate = in-app review pane (plus the CLI); thumbs feedback = the `task_success` signal; Jev decides which learnings qualify at both seams (post-turn learner and fleet harvest); scope = one Linear epic with one child ticket per slice, implemented in order.

## The Jev learning gate (shared by S3 and S6)

agent-beacon's three yes/no questions map directly onto the existing `askSystemOne` seam (`packages/agent/src/typesafe-client.ts:95`, `{state, questions, apiKey}`; throws mean "fall back to the deterministic path", which every caller already does). One pure module, `packages/agent/src/learning-gate.ts`:

```ts
export const LEARNING_QUESTIONS = {
  task_success:        { prompt: "Did this session complete the user's engineering task successfully?" },
  reusable_correction: { prompt: "Does it contain a correction, gotcha or procedure future sessions should reuse?" },
  evidence_supported:  { prompt: "Is that lesson supported by concrete events in the transcript?" },
};
// Beacon rule (candidate.go:19-47): task_success >= 0.5 is a hard precondition; only then
// is the mean of the three compared with 0.6. A thumbs score, when present, replaces
// the task_success probability (1 or 0) rather than averaging with it.
export function judgeLearning(probs, thumbs?): { qualifies: boolean; score: number; reason: string }
```

- State = a head-plus-tail projection (first 40 + last 40 events, 1200-char field cap, PII-redacted) of the turn transcript or, for the fleet, the already-redacted journal group. Same shape as beacon's `BuildProjection`.
- Flag `LEARNING_JEV_GATE_ENABLED`, default ON, kill-switch read; also self-skips without `TYPESAFE_API_KEY` (as `resolveTypeSafeApiKey` does today). Fallback when off, keyless, or thrown: the S3 rubric checklist alone, with `task_success` left empty until thumbs arrive.
- Every verdict is a `decision_metrics` row: `seam:"learning-gate"`, `outcome: qualifies|skipped|fallback`, `topScore: mean`, `note` naming the failing question. Thresholds are then tunable from the table, the same way `RERANK_DROP_BELOW` was calibrated.
- Scope of the judgement is "reusable and evidence-backed", never "important": SIO-1883 measured that Jev cannot judge urgency from a summary. Priority stays human, in the S5 pane.

## Invariants that bind every slice

- Propose-only: PR merge is the only activation. Nothing auto-applies.
- Capability flags default ON with kill-switch reads (`v !== "false" && v !== "0"`), no `.default()` in Zod schemas. Availability still follows infrastructure (learner self-skips on the file backend, as today).
- Hub replies and spoke-authored text are data, never LLM input, except through `wrapUntrusted` (`packages/agent/src/pi-fleet/tools.ts:57`). The fleet slice never puts spoke text in front of a model.
- The pi-fleet exporter keeps refusing `learned_from` skills (`packages/gitagent-bridge/src/pi-package-export.ts:80-82`). Fleet knowledge ships as runbook markdown, which aws-spoke already references (`agents/pi-fleet/agents/aws-spoke/agent.yaml:21`).
- No new store, no new IAM, no new deps, Tailwind only, Svelte 5 runes.

## The unified candidate record

Lives in the existing agent-memory fact stream, one identity per agent. Facts are immutable, so a state change appends a fact with the same `skill_name` and a later `learned_at`; readers take the latest via `dedupePreferring` (`memory-backend.ts:693`). Add a sibling `kind:"runbook"` sharing the vocabulary.

```ts
// packages/agent/src/skill-learner.ts, next to SkillProposalSchema
export const LearningCandidateSchema = z.object({
  kind: z.enum(["skill", "runbook"]),
  skill_name: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().max(80),                 // imperative (rubric)
  applicability: z.string(),                 // starts with when/before/after
  body: z.string(),                          // 3-10 lines: what, why, how to confirm
  evidence: z.array(z.object({ ref: z.string(), excerpt: z.string().max(400) })).min(1).max(5),
  source: z.enum(["turn", "hil", "reflect", "fleet"]),
  learned_from: z.string(),                  // thread:<id> | ticket:<key> | reflect:<id> | fleet:<acct>/<agent>
  status: z.enum(["candidate", "approved", "rejected", "superseded"]),
  task_success: z.enum(["", "0", "1"]),
  task_success_source: z.enum(["", "jev", "feedback", "hil", "iac-outcome", "fleet-verdict"]),
  // precedence when several arrive: feedback > hil > iac-outcome/fleet-verdict > jev
  supersedes: z.string().optional(),
  target_dir: z.string().optional(),         // runbook kind only
  agent: z.string(),
});
```

Annotations (strings, `AnnotationMap` in `packages/shared/src/agent-memory.ts:52`): existing `kind, skill_name, task_category, confidence, learned_from, learned_at, usage_count, success_count, failure_count` plus new `status, source, task_success, task_success_source, supersedes, target_dir`. Title/applicability/body/evidence live in the fact text, parsed by `parseSkillFactBody` (`skill-promote.ts:34`) extended with an `Evidence:` section. `buildSkillFrontmatter` (`skill-promote.ts:71-77`) adds `status` and `evidence` so provenance ships in the exported markdown.

Producers: post-turn learner (`source:turn`), HIL `applyHeuristic` (`learn/apply.ts:600`, born `approved`, `task_success_source:hil`), reflect A5, fleet harvest, and thumbs feedback (transition facts only).

## Slices (one Linear child ticket each, in order)

### S1. Per-agent runtime memory dir (root fix, no flag)

Add `agentName?: string` to `RequestContext` (`packages/shared/src/request-context.ts:4-8`); set it at the five `runWithRequestContext` call sites (`apps/web/src/routes/api/agent/stream/+server.ts:122` and `topic-shift/+server.ts:43` from the request body; `iac/resume`, `landing-zone/resume`, `learning/resume` from their `AGENT` const). Then the one shared fix:

```ts
// packages/agent/src/memory-writer.ts:66
function runtimeDir(baseDir?: string): string {
  return join(baseDir ?? getAgentsDir(getCurrentRequestContext()?.agentName), "memory", "runtime");
}
```

and in `lifecycle.ts` pass `getAgentsDir(ctx.agentName)` at `:137` (`readLiveMemory`) and `:225` (`appendDailyLog`), which run outside a request context. Fold in the `docs/architecture/agent-memory.md` drift fixes (identity table has 4 agents, mirror facts removed by SIO-1135, `recordKeyDecision` is on the hot path).

Verify: new test that `recordKeyDecision` inside `runWithRequestContext({agentName:"elastic-iac"})` lands in `agents/elastic-iac/memory/runtime/key-decisions.md`; `cd packages/agent && bun run test src/memory-writer`; typecheck.

### S2. Recall reaches the other three prompts (root fix, no flag)

Export a `buildRecalledMemorySection(agentName, threadId)` helper from `prompt-context.ts` (reuse `buildLiveMemorySection`, `:76-78`) and append it to: `iac/nodes.ts:2248` (`sysWithContext`), `landing-zone/answer.ts:246-248` (inside its existing "memory text is untrusted" framing), and `pi-fleet/graph.ts:68-73` (`messageModifier` built per call, not at graph build). Thread id via `getCurrentRequestContext()?.threadId`, so no node signature changes.

Verify: unit test per agent stubbing `getRecalledMemoryContext` and asserting the system prompt contains it; live on dev Capella: second session of elastic-iac shows the `## Live Memory` recall block in the LangSmith trace.

### S3. Learner generalised to four agents, candidate state, rubric (flag `SKILL_LEARNING_ENABLED` flipped to kill-switch)

`skill-learner.ts`: `isSkillLearningEnabled` becomes kill-switch (`:31-34`); drop `LEARNER_AGENT` (`:24`); `preGateSkip` (`:80`) keeps the confidence/datasource gate for `hasConfidence` agents and requires `turn.outcome === "completed"` for the others; then the Jev learning gate (`learning-gate.ts`, above) runs on the projected transcript BEFORE the full-model judge, so turns with no reusable correction cost one Jev call and no LLM call. Its `task_success` probability is stored as the candidate's initial `task_success` (`task_success_source:"jev"`, added to the enum) and is overwritten by thumbs (S4). `buildSkillAnnotations` / `buildSkillFactText` (`:184-209`) gain the state fields and rubric-shaped body; new pure `lessonQuality(candidate)` checklist (title, applicability, body length, evidence present) runs on the judge's proposal, failures recorded as `recordDecision({seam:"learning-gate", outcome:"skipped"})` with no fact written; `listSkillProposals` (`:173`) becomes `listLearningCandidates(agent, {status?})` using deterministic `searchAgentMemory` + `dedupePreferring`.

`apps/web/src/lib/server/agent.ts:578-580` `readCompletedTurn`: branch per agent instead of returning null (incident-analyzer as today; elastic-iac via `getIacTurnOutcome` `:809`; landing-zone via its outcome in `landing-zone/memory.ts:165`; pi-fleet-console transcript only, thumbs is its success signal).

`learn/skill-pr.ts:18-20`: `SKILL_PR_AGENT` becomes an `agent` parameter of `buildSkillPrFiles`; `learn/apply.ts:600` annotations add `status:"approved", task_success:"1", task_success_source:"hil"`.

Verify: `cd packages/agent && bun run test src/skill-learner src/learn/skill-pr`; `bun run --filter @devops-agent/agent skill:promote -- --list --agent elastic-iac` lists a candidate after one IaC turn on dev Capella; `SKILL_LEARNING_ENABLED=false` disables.

### S4. Thumbs feedback as the task_success precondition (no flag)

`apps/web/src/lib/stores/agent.svelte.ts:507-513`: add `threadId` and `agentName` to the POST body. `feedback/+server.ts`: schema gains both (optional); keep the LangSmith write; then `recordTurnFeedback(agentName, threadId, score)` in `skill-learner.ts`: write a `kind:feedback` fact, and for every candidate with `learned_from === "thread:<id>"` append a transition fact: score 1 sets `task_success:"1", task_success_source:"feedback"`; score 0 sets `status:"rejected", task_success:"0"`. Thumbs-down always wins.

Verify: `curl -X POST localhost:5173/api/agent/feedback -d '{"runId":"r","score":0,"threadId":"t1","agentName":"incident-analyzer"}'` then `skill:promote --list` shows `rejected`; unit test with `__setAgentMemoryClient` stub.

### S5. Learning review pane (flag `LEARNING_REVIEW_ENABLED`, default ON)

Routes: `apps/web/src/routes/api/agent/memory/candidates/+server.ts`. `GET ?agent=` returns `listLearningCandidates` mapped to `{skillName, kind, status, source, score, taskSuccess, evidenceSummary, learnedAt, title, body}`. `POST {agent, skillName, action: approve|reject|supersede, edits?, supersedes?}`. Approve refuses with 409 unless `taskSuccess === "1"`; writes the `approved` transition (edits applied); then opens the PR through hoisted helpers `openSkillPromotionPr(agent, candidate)` (from `learn/apply.ts:619-663`) or `openRunbookPr(dir, candidate)` (from `:666-700`), both ending in the existing `promoteToMemory`. Reject/supersede write the transition fact only. The existing promote route stays.

UI: `apps/web/src/lib/components/LearningReviewPane.svelte`, mounted in `+page.svelte` beside `PiFleetPane` (`:858-878`), toggled like `showGraphPane` (`:38-47`), offered for every agent. One `$state` list fetched on open; rows show agent, kind, score, task-success chip, evidence count; expand shows editable title/body and Approve / Reject / Supersede (target select).

Verify: component test (two candidates; approve without task_success renders the 409 message); live on dev with `MEMORY_PR_ENABLED=true`: approve one candidate, PR URL appears. `LEARNING_REVIEW_ENABLED=false` hides the pane and 404s the routes.

### S6. Fleet harvest to reviewed runbook candidates (operator CLI, no runtime reads, no IAM change)

`packages/pi-coms/scripts/fleet-harvest.ts`, run by an operator with the same credentials `publish-fleet.sh` uses: for each `<account>/<agent>`, `restoreCheckpoint(s3Store(client), statePrefix(bundleUri, acct, agent), tmpDb)` (`monitor/checkpoint.ts:58,198,246`); open `MonitorState`; take `journalRows(windowMs, "finding")` with a `diagnosis` (`coms-net-monitor.ts:500-509`), join `actionability_verdict` rows by `dedup_key`; group by `(family, probable_cause)` (`ponytail:` naive text grouping, upgrade to family+resource keys if noisy); keep groups seen in 2+ accounts or 3+ times; pass every string through `redactMonitorText` (`actionability-judge.ts:65`, covers ARNs and 12-digit ids) BEFORE anything leaves the box; then score each redacted group with the Jev learning gate (`learning-gate.ts`, same three questions, state = the group's redacted diagnoses and evidence lines), following the redaction-then-Jev discipline `actionability-judge.ts:139-172` already uses; drop groups that do not qualify, keep the score; emit JSON `LearningCandidate[]` with `kind:"runbook"`, `source:"fleet"`, `target_dir:"agents/incident-analyzer/knowledge/aws/runbooks"`, evidence refs `journal:<acct>/<agent>#<id>`, `task_success` from Jev (`task_success_source:"jev"`), raised to `"1"` with source `fleet-verdict` when the monitor verdict was actionable and diagnosis confidence >= 0.7. Without a key or on a throw, all groups pass through unscored for the human to rank in the pane.

`packages/agent/src/learn-ingest-cli.ts` (`bun run --filter @devops-agent/agent learn:ingest -- --file out.json --agent incident-analyzer`): validate with `LearningCandidateSchema`, apply the S3 rubric, `recordAgentFactNow` per candidate. These bodies reach no model in this epic; if a scorer is ever added it goes through `wrapUntrusted`.

Rollout after approval is all existing machinery: PR into `knowledge/aws/runbooks/` -> merge -> `publish-fleet.sh` -> knowledge tail rendered into `aws-spoke/AGENTS.override.md` (`pi-package-export.ts:46`) -> spokes at next relaunch (`agent-bootstrap.sh:255-260`). Exporter unchanged; `assertNoAccountIds` (`:149`) remains the last guard.

Verify: offline fixture run `bun packages/pi-coms/scripts/fleet-harvest.ts --db <fixture state.db> --out $TMPDIR/c.json`; `grep -E '\b[0-9]{12}\b' $TMPDIR/c.json` is empty; `learn:ingest` then the S5 pane lists it as `candidate/fleet`; approving opens a PR under `knowledge/aws/runbooks/`.

### S7. Reflect A5 through the same ingest (no flag)

`reflect/aggregate.ts:206-208` `create` items are emitted by `analyze-cli.ts --emit-candidates out.json` as `LearningCandidate{kind:"skill", source:"reflect", learned_from:"reflect:<id>", evidence from signal.evidence}`; sessions with a `user-feedback-low` signal get `task_success:"0"`. Ingest via S6's CLI. Closes the A5 item in `experiments/HANDOFF-2026-09-20-skill-autoreflection.md`.

### S8. "Did it help" rows (no flag)

`recordDecision` (`decision-recorder.ts:18`) at three seams: `learning-gate` (S3), `learning-review` (S5 approve/reject), `learning-feedback` (S4). Measurement protocol, no code: run `bun run eval:incident-replay` on main before and after each merged skill/runbook PR; experiments are already tagged by git rev (`eval/run-incident-replay-eval.ts:136`).

## Not built (YAGNI)

A new candidate table or DB; a Jev call anywhere other than the two gate seams (no Jev in the pane, no Jev ranking of approved knowledge); spoke-side memory or runtime cross-spoke reads; hub changes; new IAM; agent-beacon telemetry, MCP recall, decay or dedupe beyond `skill_name`; exporting learned skills to the fleet; fixing `checkpoint_key_decisions` / `queueMemoryProposal` or the fleet checkpoint IAM over-grant (`modules/agent/main.tf:684-687`, flagged for its own ticket).

## Risks

- File-backend deployments produce no candidates (as today); the pane is empty there.
- Pane approve needs `MEMORY_PR_ENABLED` and reachable GitHub; two approvals off one base need "Update branch" (already accepted at `apply.ts:615-617`).
- `readCompletedTurn` for landing-zone depends on its outcome shape; verify against `landing-zone/memory.ts:165` before wiring.
- Jev gate thresholds (0.5 / 0.6) are beacon's, not measured here; calibrate from the `learning-gate` decision_metrics rows after the first week, as `RERANK_DROP_BELOW` was. A TypeSafe outage degrades to the checklist, never blocks a turn.

## Workflow

Create the epic and eight child issues in Linear (project DevOps Incident Analyzer, team Siobytes) before the first edit; claim each child (In Progress, assigned) before starting it. One branch and PR per slice off main, `SIO-XXX: message` commits, PRs ready for review, Greptile check as the gate, verify-before-apply on findings. Per-package test runs: `cd packages/agent && bun run test`, `cd apps/web && bun run test`, plus `bun run typecheck && bun run lint`.
