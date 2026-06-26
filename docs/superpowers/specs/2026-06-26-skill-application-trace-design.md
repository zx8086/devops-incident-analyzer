# Per-turn skill-application trace — design

Date: 2026-06-26
Ticket: [SIO-1018](https://linear.app/siobytes/issue/SIO-1018) — Per-turn skill-application trace to activate the SIO-1016 confidence loop
Parent: [SIO-1016](https://linear.app/siobytes/issue/SIO-1016) — Skill confidence feedback loop (PR #307)

Follow-up to SIO-1016, which shipped the skill confidence feedback loop but left it dormant. This ticket adds the one missing piece: a per-turn signal for which catalog skill the model applied, so the loop runs end-to-end.

## The gap

SIO-1016 built the full mutable-counter mechanism in `packages/agent/src/skill-outcome.ts`:
`recordSkillOutcome` reads a promoted `SKILL.md`, bumps `usage_count` and `success_count`/`failure_count`, recomputes `confidence` with Laplace smoothing `(success + 1) / (usage + 2)`, and rewrites the frontmatter — gated by `SKILL_OUTCOME_TRACKING_ENABLED`, serialized per-path by an in-process mutex, best-effort. It is wired into the post-turn learner: `installSkillLearner(readCompletedTurn, undefined, readCompletedTurnOutcome)` in `apps/web/src/lib/server/agent.ts`, where `runSkillOutcomeTracking` fans the turn's outcome across `turn.appliedSkills`.

But `readCompletedTurnOutcome` returns `appliedSkills: []` — a deliberate no-op. There is **no per-turn "this catalog skill was applied" signal** in graph state. Promoted learned-skills are entries in the `## Skills` catalog and full `## Skill: <name>` bodies baked into the orchestrator system prompt (`buildSystemPrompt` in `packages/gitagent-bridge/src/skill-loader.ts`); the model reads them passively and consults them at its discretion. Unlike `selectedRunbooks` — which an explicit selector node chooses via an LLM call and records in `state.ts` — skill application leaves no trace. With `appliedSkills` always empty, `runSkillOutcomeTracking` early-returns and no counter ever moves.

Everything downstream of the signal is already shipped and unit-tested (`recordSkillOutcomesForTurn`, `outcomeForTurn`, `computeConfidence`, the mutex, the `OutcomeTurn`/`appliedSkills` plumbing). **This ticket is purely producing the attribution signal.**

## Decisions

Confirmed with the user:

- **Attribution = all active promoted skills.** A turn bumps every promoted skill active in that turn's orchestrator prompt — not a per-skill LLM judge, not a runbook-overlap heuristic. The SIO-1016 design noted "bump every manifest skill every turn would make the counters noise" and rejected it; the user chose it explicitly, and it is made meaningful by the refinement below.
- **Refinement that keeps counters honest:** only skills whose `SKILL.md` carries the learning frontmatter (`confidence`/`usage_count`/…) are actually counted. `recordSkillOutcome` already no-ops on a file with no parseable learning frontmatter (`rewriteFrontmatter` returns the content unchanged), so the 6 hand-authored, body-only skills (`aggregate-findings`, `normalize-incident`, `propose-mitigation`, `wiki-ingest`, `wiki-query`, `wiki-lint`) are self-filtered out. "All active promoted skills" therefore resolves cleanly to "all skills promoted from a learned proposal and active this turn" — exactly the set the loop is meant to score. No new gating logic is needed; the no-op is the filter.
- **Turn scope = all incident-analyzer turns** (simple or complex). Matches the agent scoping of `readCompletedTurn`/`readCompletedTurnOutcome` (`ctx.agentName !== "incident-analyzer"` → `null`). A simple turn whose `confidenceScore` is 0 will read as a failure, but simple turns also do not run the aggregate node, so `skillsApplied` will be `null`/absent and nothing is bumped — the scope choice is moot in practice but recorded for completeness.

## Architecture

Three small, independently-testable changes plus tests. No change to `skill-outcome.ts`'s core.

### 1. State channel — `packages/agent/src/state.ts`

Add a channel mirroring `selectedRunbooks` exactly:

```ts
// SIO-1018: per-turn trace of promoted skills active in this turn's orchestrator
// prompt. Drives the SIO-1016 confidence feedback loop.
//   null    -> not captured (default; e.g. simple turns that skip aggregate)
//   []      -> captured, no active skills
//   [names] -> these skill names were active this turn
skillsApplied: Annotation<string[] | null>({
  reducer: (_, next) => next,
  default: () => null,
}),
```

Last-write-wins, set once when the aggregate node builds the prompt. The tri-state (`null` vs `[]`) matches the runbook idiom so the reader can distinguish "not captured" from "captured none".

### 2. Capture point — `aggregate` node + `getActiveSkillNames()` helper

The `aggregate` node (`packages/agent/src/aggregator.ts`) builds the orchestrator prompt (which embeds the active skill bodies) and produces the final report. It is the turn's substantive skill-consultation moment and runs on every complex turn. There the node captures the active skill names into `skillsApplied`.

To avoid the aggregator reaching into manifest internals, add an exported helper in `packages/agent/src/prompt-context.ts`:

```ts
// SIO-1018: the local skill names active in the orchestrator prompt this turn.
// Same source the prompt builder uses (agent.skills keys); promoted learned skills
// live here once added to agent.yaml. Best-effort -> [] if the manifest can't be read.
export function getActiveSkillNames(): string[] {
  try {
    return [...getAgent().skills.keys()];
  } catch {
    return [];
  }
}
```

`getAgent().skills` is the `Map<string, string>` of local skill name → content that `buildSystemPrompt` iterates; its keys are exactly the active local skill names (shared skills are not promoted learned skills, so they are out of scope for tracking). The aggregate node adds `skillsApplied` to its returned partial:

```ts
let skillsApplied: string[] | null = null;
try {
  skillsApplied = getActiveSkillNames();
} catch {
  skillsApplied = null; // never break the report over a trace field
}
return { ...existingPartial, skillsApplied };
```

The guard is belt-and-suspenders (the helper is already total) and documents that the trace is non-critical.

### 3. Reader wiring — `readCompletedTurnOutcome` + name→path mapping

In `apps/web/src/lib/server/agent.ts`, `readCompletedTurnOutcome` reads `values.skillsApplied` and maps each name to its on-disk `SKILL.md` absolute path. **Reuse the existing path primitives** rather than inventing new ones:

- `getWorkspaceRoot()` from `packages/agent/src/paths.ts` (cached monorepo-root resolver, runtime-agnostic — already used by the SIO-1017 CLI).
- `skillFilePath(workspaceRoot, agent, skill)` from `packages/agent/src/skill-promote-cli.ts` (already exported + unit-tested: `join(workspaceRoot, "agents", agent, "skills", skill, "SKILL.md")`).

A thin pure mapping helper composes them so the reader stays declarative and the mapping is unit-testable without a graph:

```ts
// SIO-1018: active skill names -> AppliedSkill[] for the outcome loop. Reuses the
// SIO-1017 skillFilePath layout; existence + frontmatter are checked downstream by
// recordSkillOutcome (no-ops on a missing/body-only file), so this never touches disk.
export function appliedSkillsForNames(agentName: string, names: string[]): AppliedSkill[] {
  const root = getWorkspaceRoot();
  return names.map((name) => ({ name, filePath: skillFilePath(root, agentName, name) }));
}
```

`readCompletedTurnOutcome` then becomes:

```ts
const skillsApplied = Array.isArray(values.skillsApplied) ? (values.skillsApplied as string[]) : [];
return {
  hadError,
  confidenceScore,
  appliedSkills: appliedSkillsForNames(ctx.agentName, skillsApplied),
};
```

Downstream, `recordSkillOutcome` self-filters: a missing file (unpromoted/never-scaffolded) or a body-only file (no learning frontmatter) is a logged no-op, so passing the full active set is safe.

> Note: `skillFilePath` currently lives in `skill-promote-cli.ts`. If importing from a `*-cli.ts` module into the web runtime is undesirable (it is `import.meta.main`-guarded, so importing it is side-effect-free and safe), the trivially-pure `skillFilePath` may be lifted into `paths.ts` alongside `getAgentsDir` during implementation. Either way the layout string is defined once, never duplicated.

## Data flow

1. **Turn runs** → `aggregate` builds the prompt, captures `getActiveSkillNames()` → `{ skillsApplied: [names] }`.
2. **Turn completes** → `runPostTurn` fires `readCompletedTurnOutcome` → reads `skillsApplied`, maps to `AppliedSkill[]`, returns `{ hadError, confidenceScore, appliedSkills }`.
3. **`runSkillOutcomeTracking`** (gated on `SKILL_OUTCOME_TRACKING_ENABLED`) → `recordSkillOutcomesForTurn(appliedSkills, outcomeForTurn(turn))` → per path, `recordSkillOutcome` bumps counts on files with learning frontmatter, no-ops the rest.

## Error handling

Every layer is best-effort and already established:
- `getActiveSkillNames()` is total (try/catch → `[]`); the aggregate-node guard sets `skillsApplied: null` on any failure, identical to "not captured" — the report always emits.
- `readCompletedTurnOutcome` returns `null` on any failure (unchanged), skipping the turn.
- `recordSkillOutcome` swallows read/parse/write errors and no-ops on missing/body-only files.
- The whole loop is inert unless `SKILL_OUTCOME_TRACKING_ENABLED=true`.

## Testing

- **Unit — `getActiveSkillNames()`** (`prompt-context.test.ts` or a focused test): returns the manifest's active local skill names; `[]` when the manifest is unavailable.
- **Unit — `appliedSkillsForNames()`**: maps names to the correct `agents/<agent>/skills/<name>/SKILL.md` paths (via the existing `skillFilePath` layout); empty input → empty output; does not touch disk. (`skillFilePath` itself is already covered by the SIO-1017 tests.)
- **Unit — aggregate node**: the returned partial includes `skillsApplied` equal to the active skill names (mock `getActiveSkillNames`/manifest).
- **Integration — `runSkillOutcomeTracking`** (existing test seam in `skill-learner-install.test.ts`): feed a stub `OutcomeTurn` with non-empty `appliedSkills` pointing at a temp `SKILL.md` that has learning frontmatter; assert success bumps `usage`+`success` and failure bumps `usage`+`failure`, and that a body-only temp file is untouched. This proves the *non-empty* attribution path the no-op previously skipped.
- **Manual e2e**: scaffold a learned-skill draft (SIO-1017 `skill:promote`) with learning frontmatter, add it to `agent.yaml`, run with `SKILL_OUTCOME_TRACKING_ENABLED=true`: 2 success + 1 failure turns → `usage=3, success=2, failure=1, confidence=0.6` in the file.

## Acceptance criteria

- With `SKILL_OUTCOME_TRACKING_ENABLED=true`, a successful turn that applied a promoted skill bumps `usage_count`+`success_count` and recomputes `confidence`; a failed turn bumps `usage_count`+`failure_count`.
- The recomputed frontmatter still parses cleanly under `SkillFrontmatterSchema`.
- Body-only skills (no learning frontmatter) are never modified.
- `skillsApplied` defaults to `null` and a failure capturing it never breaks the report.
- `getActiveSkillNames()` and `appliedSkillsForNames()` are unit-tested in isolation (no network, no LLM, no disk for the mapping).
- `bun run typecheck && bun run lint && bun run test` pass.

## Files

| File | Change |
| -- | -- |
| `packages/agent/src/state.ts` | NEW `skillsApplied` annotation (mirrors `selectedRunbooks`) |
| `packages/agent/src/prompt-context.ts` | NEW exported `getActiveSkillNames()` |
| `packages/agent/src/aggregator.ts` | capture `skillsApplied` in the aggregate node partial (guarded) |
| `apps/web/src/lib/server/agent.ts` | NEW exported `appliedSkillsForNames()` (reusing `getWorkspaceRoot` + `skillFilePath`); `readCompletedTurnOutcome` reads `skillsApplied` → returns populated `appliedSkills` |
| `packages/agent/src/skill-promote-cli.ts` → `paths.ts` (optional) | lift the pure `skillFilePath` to `paths.ts` if a `*-cli.ts` import into the web runtime is undesirable |
| `packages/agent/src/prompt-context.test.ts` | `getActiveSkillNames()` cases |
| `packages/agent/src/aggregator.test.ts` | aggregate partial includes `skillsApplied` |
| `apps/web/.../agent.test.ts` (or a focused unit) | `appliedSkillsForNames()` mapping |
| `packages/agent/src/skill-learner-install.test.ts` | `runSkillOutcomeTracking` end-to-end with non-empty `appliedSkills` |

## Out of scope

- A per-skill LLM outcome judge (coarse turn-level success signal stays the first cut).
- Tracking confidence for unpromoted proposals (immutable agent-memory facts; Option 1/2 territory in the SIO-1016 design, explicitly rejected).
- Cross-process write safety for `SKILL.md` (in-process mutex only).
- Auto-loading or auto-promoting skills into live prompts (propose-only invariant holds).

## Memory references

- `reference_skill_promotion_and_confidence` — SIO-1017+SIO-1016; the known no-op (`appliedSkills=[]` until a `skillsApplied` state channel lands) this ticket closes.
- `reference_agent_memory_recall_dedup` — durable facts are immutable; why confidence lives in the promoted file, not the fact.
