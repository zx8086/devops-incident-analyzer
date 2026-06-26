# Per-turn skill-application trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the dormant SIO-1016 skill confidence feedback loop by adding a per-turn signal for which catalog skills were active, so a tracked turn bumps each promoted skill's `SKILL.md` frontmatter counts.

**Architecture:** A new `skillsApplied: string[] | null` channel on `AgentState` (mirrors `selectedRunbooks`) is populated by the `aggregate` node from the manifest's active local skills, then read by `readCompletedTurnOutcome` (in the web runtime) which maps each name to its `agents/<agent>/skills/<name>/SKILL.md` path and returns them as `appliedSkills`. The existing `recordSkillOutcome` (untouched) self-filters body-only skills, so only learned-frontmatter skills get counted.

**Tech Stack:** TypeScript (strict, no `any`), Bun test, LangGraph `Annotation`, `@devops-agent/agent` workspace package consumed by `apps/web`.

## Global Constraints

- TypeScript strict mode, **never use `any`** (biome `noExplicitAny: "error"`). Use `unknown` + narrowing or `z.infer`.
- No emojis in code, logs, comments, or output.
- File header: single-line relative path comment only (e.g. `// packages/agent/src/skill-outcome.ts`). No multi-line JSDoc headers.
- Keep ticket references (`SIO-1018`) and business-logic "why" comments; drop comments that restate names.
- Run `bun run typecheck`, `bun run lint`, and the relevant `bun test` after every change.
- Named exports preferred.
- All new public symbols are re-exported from `packages/agent/src/index.ts` (the web app imports only from `@devops-agent/agent`, never relative agent paths).
- Attribution semantics (confirmed): **all active local skills** are captured each turn; the downstream `recordSkillOutcome` no-op on a file lacking learning frontmatter is the filter (do NOT add a separate frontmatter gate). Turn scope = all incident-analyzer turns.

---

### Task 1: Lift `skillFilePath` into `paths.ts` (shared layout primitive)

The name→path layout currently lives in `skill-promote-cli.ts`. The web reader (Task 4) needs the same layout but must not import a `*-cli.ts` module. Move the pure helper to `paths.ts` (already the home of `getWorkspaceRoot`/`getAgentsDir`) and re-export it from the CLI so the SIO-1017 call site and its tests are unchanged.

**Files:**
- Modify: `packages/agent/src/paths.ts` (add `skillFilePath`)
- Modify: `packages/agent/src/skill-promote-cli.ts:51-53` (replace local def with a re-export import)
- Modify: `packages/agent/src/index.ts:91-97` (export `skillFilePath`)
- Test: `packages/agent/src/skill-promote-cli.test.ts` (existing `skillFilePath` tests must still pass)

**Interfaces:**
- Produces: `skillFilePath(workspaceRoot: string, agent: string, skill: string): string` — returns `join(workspaceRoot, "agents", agent, "skills", skill, "SKILL.md")`. Now exported from `paths.ts` and re-exported from `skill-promote-cli.ts` (same signature) and the package index.

- [ ] **Step 1: Confirm the existing CLI test pins the layout**

Run: `bun test packages/agent/src/skill-promote-cli.test.ts -t skillFilePath`
Expected: PASS (these tests currently assert the `agents/<agent>/skills/<skill>/SKILL.md` shape; they are the regression guard for this move).

If no such test exists, add one first:

```ts
import { skillFilePath } from "./skill-promote-cli.ts";

test("skillFilePath builds the agents/<agent>/skills/<skill>/SKILL.md layout", () => {
  expect(skillFilePath("/repo", "incident-analyzer", "lag-correlation")).toBe(
    "/repo/agents/incident-analyzer/skills/lag-correlation/SKILL.md",
  );
});
```

Run it and confirm PASS before moving the function.

- [ ] **Step 2: Add `skillFilePath` to `paths.ts`**

In `packages/agent/src/paths.ts`, after `getAgentsDir` (line 56), add:

```ts
// SIO-1018: the on-disk SKILL.md layout, shared by the SIO-1017 promote CLI and the
// SIO-1016 outcome reader so the path is defined exactly once.
export function skillFilePath(workspaceRoot: string, agent: string, skill: string): string {
  return join(workspaceRoot, "agents", agent, "skills", skill, "SKILL.md");
}
```

(`join` is already imported in `paths.ts`.)

- [ ] **Step 3: Replace the CLI's local def with a re-export**

In `packages/agent/src/skill-promote-cli.ts`, delete the local `skillFilePath` function (lines 51-53) and import+re-export it from `paths.ts`. The existing import line is `import { getWorkspaceRoot } from "./paths.ts";` — extend it:

```ts
import { getWorkspaceRoot, skillFilePath } from "./paths.ts";
export { skillFilePath };
```

(The `export { skillFilePath }` keeps `import { skillFilePath } from "./skill-promote-cli.ts"` working for the existing test.)

- [ ] **Step 4: Export from the package index**

In `packages/agent/src/index.ts`, add a `paths.ts` export line near the other exports (e.g. after line 71):

```ts
export { getWorkspaceRoot, skillFilePath } from "./paths.ts";
```

(Verify `getWorkspaceRoot` is not already exported elsewhere in index.ts to avoid a duplicate; if it is, export only `skillFilePath`.)

- [ ] **Step 5: Run typecheck, lint, and the CLI test**

Run: `bun run typecheck && bun run lint && bun test packages/agent/src/skill-promote-cli.test.ts`
Expected: all PASS — the layout is unchanged, only its home moved.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/paths.ts packages/agent/src/skill-promote-cli.ts packages/agent/src/index.ts packages/agent/src/skill-promote-cli.test.ts
git commit -m "SIO-1018: lift skillFilePath into paths.ts as a shared layout primitive

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `skillsApplied` state channel

Add the per-turn trace channel to `AgentState`, mirroring `selectedRunbooks` (tri-state, last-write-wins).

**Files:**
- Modify: `packages/agent/src/state.ts:281-284` (add channel after `selectedRunbooks`)

**Interfaces:**
- Produces: `AgentStateType.skillsApplied: string[] | null` — `null` = not captured (default), `[]` = captured none, `[names]` = these active skill names.

- [ ] **Step 1: Add the annotation**

In `packages/agent/src/state.ts`, immediately after the `selectedRunbooks` annotation block (closes at line 284), add:

```ts
// SIO-1018: per-turn trace of the local skills active in this turn's orchestrator
// prompt. Drives the SIO-1016 confidence feedback loop (mapped to SKILL.md paths
// in the post-turn reader). Mirrors selectedRunbooks' tri-state.
//   null    -> not captured (default; e.g. simple turns that skip aggregate)
//   []      -> captured, no active skills
//   [names] -> these skill names were active this turn
skillsApplied: Annotation<string[] | null>({
  reducer: (_, next) => next,
  default: () => null,
}),
```

- [ ] **Step 2: Typecheck (compile-only verification of the channel)**

Run: `bun run typecheck`
Expected: PASS. (No standalone test for a bare annotation; Task 3's aggregator test exercises it.)

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/state.ts
git commit -m "SIO-1018: add skillsApplied state channel (mirrors selectedRunbooks)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `getActiveSkillNames()` + capture in the `aggregate` node

Add the manifest helper and populate `skillsApplied` from the `aggregate` node so every report-producing turn records the active skills.

**Files:**
- Modify: `packages/agent/src/prompt-context.ts` (add `getActiveSkillNames`)
- Modify: `packages/agent/src/index.ts` (export `getActiveSkillNames` from prompt-context line)
- Modify: `packages/agent/src/aggregator.ts:275-279` and `:414-419` (add `skillsApplied` to both returns)
- Test: `packages/agent/src/aggregator.test.ts` (assert the populated trace + add `skillsApplied: null` to `makeState`)

**Interfaces:**
- Consumes: `getAgent()` from `./prompt-context.ts` (returns `LoadedAgent` with `.skills: Map<string,string>`).
- Produces: `getActiveSkillNames(): string[]` — the active local skill names (`[...getAgent().skills.keys()]`), `[]` on any failure. The `aggregate` node now returns `skillsApplied` in its partial.

- [ ] **Step 1: Write the failing test for `getActiveSkillNames`**

In `packages/agent/src/aggregator.test.ts`, add a new describe block (the real `incident-analyzer` agent is already loadable in this suite — `getRunbookFilenames()` proves it). Use the known manifest skills:

```ts
import { getActiveSkillNames } from "./prompt-context.ts";

describe("getActiveSkillNames (SIO-1018)", () => {
  test("returns the manifest's active local skill names", () => {
    const names = getActiveSkillNames();
    // agents/incident-analyzer/agent.yaml lists these under skills:
    expect(names).toContain("aggregate-findings");
    expect(names).toContain("normalize-incident");
    expect(names).toContain("propose-mitigation");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/agent/src/aggregator.test.ts -t "getActiveSkillNames"`
Expected: FAIL — `getActiveSkillNames` is not exported from `./prompt-context.ts` (import error / not a function).

- [ ] **Step 3: Implement `getActiveSkillNames`**

In `packages/agent/src/prompt-context.ts`, after `getRunbookFilenames` (ends at line 155), add:

```ts
// SIO-1018: the local skill names active in the orchestrator prompt this turn --
// the same set buildSystemPrompt iterates (agent.skills keys). Promoted learned
// skills appear here once added to agent.yaml. Best-effort -> [] if the manifest
// can't be read, so a trace failure never breaks the turn.
export function getActiveSkillNames(): string[] {
  try {
    return [...getAgent().skills.keys()];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Export it from the package index**

In `packages/agent/src/index.ts` line 71, add `getActiveSkillNames` to the prompt-context export:

```ts
export {
  buildOrchestratorPrompt,
  buildSubAgentPrompt,
  getActiveSkillNames,
  getAgent,
  getAgentByName,
} from "./prompt-context.ts";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/agent/src/aggregator.test.ts -t "getActiveSkillNames"`
Expected: PASS.

- [ ] **Step 6: Write the failing test for the aggregate-node capture**

In `packages/agent/src/aggregator.test.ts`, add to the existing aggregator describe area:

```ts
describe("aggregate: skillsApplied trace (SIO-1018)", () => {
  test("populates skillsApplied with the active skill names", async () => {
    const result = await aggregate(makeState({}));
    expect(result.skillsApplied).toBeDefined();
    expect(result.skillsApplied).toContain("aggregate-findings");
  });

  test("populates skillsApplied even on the no-datasource-results path", async () => {
    const result = await aggregate(makeState({ dataSourceResults: [] }));
    expect(result.skillsApplied).toContain("aggregate-findings");
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `bun test packages/agent/src/aggregator.test.ts -t "skillsApplied trace"`
Expected: FAIL — `result.skillsApplied` is `undefined` (the aggregate node does not return it yet).

- [ ] **Step 8: Add `skillsApplied` to both aggregate returns**

In `packages/agent/src/aggregator.ts`, import the helper at the top (extend the existing prompt-context import on line 10):

```ts
import { buildOrchestratorPrompt, getActiveSkillNames } from "./prompt-context.ts";
```

Compute the trace once near the start of `aggregate` (just after line 272 `const results = state.dataSourceResults;`):

```ts
// SIO-1018: capture the active skills for the confidence feedback loop. Best-effort:
// a failure leaves it null (== "not captured"), never blocking the report.
let skillsApplied: string[] | null = null;
try {
  skillsApplied = getActiveSkillNames();
} catch {
  skillsApplied = null;
}
```

Add `skillsApplied` to the empty-results early return (currently lines 275-278):

```ts
return {
  messages: [new AIMessage({ content: "No datasource results to aggregate." })],
  finalAnswer: "No datasource results to aggregate.",
  skillsApplied,
};
```

And to the main return (currently lines 414-419):

```ts
return {
  messages: [new AIMessage({ content: finalAnswer })],
  finalAnswer,
  confidenceScore: cappedScore,
  skillsApplied,
  ...(anyCapTriggered && { confidenceCap: TOOL_ERROR_CONFIDENCE_CAP }),
};
```

- [ ] **Step 9: Add `skillsApplied: null` to the test's `makeState`**

In `packages/agent/src/aggregator.test.ts`, in `makeState` (after `selectedRunbooks: null,` on line 95), add:

```ts
skillsApplied: null,
```

(This keeps the `AgentStateType` cast honest now that the field exists.)

- [ ] **Step 10: Run the aggregator tests to verify they pass**

Run: `bun test packages/agent/src/aggregator.test.ts`
Expected: PASS (new `skillsApplied trace` tests plus all pre-existing aggregator tests).

- [ ] **Step 11: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS. Other `makeState` definitions across the suite (e.g. `mitigation.deadline.test.ts`) cast `as AgentStateType` and omit fields, so adding an optional-by-default channel does not break them; confirm typecheck is clean.

- [ ] **Step 12: Commit**

```bash
git add packages/agent/src/prompt-context.ts packages/agent/src/index.ts packages/agent/src/aggregator.ts packages/agent/src/aggregator.test.ts
git commit -m "SIO-1018: capture active skills as skillsApplied in the aggregate node

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `appliedSkillsForNames()` mapping helper

Add the pure name→`AppliedSkill[]` mapping in `skill-outcome.ts` (which already owns `AppliedSkill` and is re-exported), composing `getWorkspaceRoot` + `skillFilePath`.

**Files:**
- Modify: `packages/agent/src/skill-outcome.ts` (add `appliedSkillsForNames`, import path helpers)
- Modify: `packages/agent/src/index.ts:91-97` (export `appliedSkillsForNames`)
- Test: `packages/agent/src/skill-outcome.test.ts` (mapping cases)

**Interfaces:**
- Consumes: `getWorkspaceRoot()`, `skillFilePath()` from `./paths.ts` (Task 1); `AppliedSkill` from this file.
- Produces: `appliedSkillsForNames(agentName: string, names: string[]): AppliedSkill[]` — `names.map(name => ({ name, filePath: skillFilePath(getWorkspaceRoot(), agentName, name) }))`. Pure w.r.t. disk (resolves paths only; existence is checked downstream by `recordSkillOutcome`).

- [ ] **Step 1: Write the failing test**

In `packages/agent/src/skill-outcome.test.ts`, add:

```ts
import { appliedSkillsForNames } from "./skill-outcome.ts";
import { getWorkspaceRoot } from "./paths.ts";
import { join } from "node:path";

describe("appliedSkillsForNames (SIO-1018)", () => {
  test("maps each name to its agents/<agent>/skills/<name>/SKILL.md path", () => {
    const root = getWorkspaceRoot();
    const result = appliedSkillsForNames("incident-analyzer", ["lag-correlation"]);
    expect(result).toEqual([
      {
        name: "lag-correlation",
        filePath: join(root, "agents", "incident-analyzer", "skills", "lag-correlation", "SKILL.md"),
      },
    ]);
  });

  test("empty names -> empty list", () => {
    expect(appliedSkillsForNames("incident-analyzer", [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/agent/src/skill-outcome.test.ts -t "appliedSkillsForNames"`
Expected: FAIL — `appliedSkillsForNames` is not exported (import error).

- [ ] **Step 3: Implement the helper**

In `packages/agent/src/skill-outcome.ts`, add the import near the top (after the existing imports, line 18 area):

```ts
import { getWorkspaceRoot, skillFilePath } from "./paths.ts";
```

After the `AppliedSkill` interface (ends at line 113), add:

```ts
// SIO-1018: resolve active skill names to AppliedSkill[] for recordSkillOutcomesForTurn.
// Reuses the SIO-1017 skillFilePath layout. Resolves paths only -- existence and
// frontmatter are checked downstream by recordSkillOutcome (no-op on a missing or
// body-only file), so passing the full active set is safe.
export function appliedSkillsForNames(agentName: string, names: string[]): AppliedSkill[] {
  const root = getWorkspaceRoot();
  return names.map((name) => ({ name, filePath: skillFilePath(root, agentName, name) }));
}
```

- [ ] **Step 4: Export from the package index**

In `packages/agent/src/index.ts`, add `appliedSkillsForNames` to the `skill-outcome.ts` export block (lines 91-97):

```ts
export {
  appliedSkillsForNames,
  type AppliedSkill,
  computeConfidence,
  isSkillOutcomeTrackingEnabled,
  recordSkillOutcome,
  type SkillOutcome,
} from "./skill-outcome.ts";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/agent/src/skill-outcome.test.ts -t "appliedSkillsForNames"`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint + full skill-outcome test**

Run: `bun run typecheck && bun run lint && bun test packages/agent/src/skill-outcome.test.ts`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/skill-outcome.ts packages/agent/src/index.ts packages/agent/src/skill-outcome.test.ts
git commit -m "SIO-1018: add appliedSkillsForNames mapping helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Wire `readCompletedTurnOutcome` to populate `appliedSkills`

Replace the `appliedSkills: []` no-op in the web reader with the real trace, completing the loop.

**Files:**
- Modify: `apps/web/src/lib/server/agent.ts:3-24` (import `appliedSkillsForNames`)
- Modify: `apps/web/src/lib/server/agent.ts:519-541` (`readCompletedTurnOutcome` reads `skillsApplied`, updates the comment)

**Interfaces:**
- Consumes: `appliedSkillsForNames(agentName, names)` from `@devops-agent/agent` (Task 4); `values.skillsApplied` from the graph snapshot (Task 2/3).
- Produces: `readCompletedTurnOutcome` returns `OutcomeTurn` with a populated `appliedSkills`.

- [ ] **Step 1: Add the import**

In `apps/web/src/lib/server/agent.ts`, add `appliedSkillsForNames` to the `@devops-agent/agent` import block (alphabetical, near `type AppliedSkill`/`installSkillLearner`; insert after `getAgentByName` on line 8):

```ts
	appliedSkillsForNames,
```

- [ ] **Step 2: Populate `appliedSkills` in the reader**

In `readCompletedTurnOutcome` (lines 519-541), replace the body's return. Current:

```ts
		const confidenceScore = typeof values.confidenceScore === "number" ? values.confidenceScore : 0;
		// validationResult "fail" is the turn-level error signal the validator sets.
		const hadError = values.validationResult === "fail";
		return {
			hadError,
			confidenceScore,
			// No per-turn skill-application signal yet -> deliberate no-op (see note above).
			appliedSkills: [],
		};
```

New:

```ts
		const confidenceScore = typeof values.confidenceScore === "number" ? values.confidenceScore : 0;
		// validationResult "fail" is the turn-level error signal the validator sets.
		const hadError = values.validationResult === "fail";
		// SIO-1018: the aggregate node records the active skills onto skillsApplied;
		// map them to SKILL.md paths. recordSkillOutcome self-filters body-only files,
		// so the full active set is safe to pass.
		const skillsApplied = Array.isArray(values.skillsApplied) ? (values.skillsApplied as string[]) : [];
		return {
			hadError,
			confidenceScore,
			appliedSkills: appliedSkillsForNames(ctx.agentName, skillsApplied),
		};
```

- [ ] **Step 3: Update the stale doc comment above the function**

The block comment on lines 511-518 says `appliedSkills is [] -- a documented no-op` and references a follow-up ticket. Replace that paragraph so it reflects the now-active loop:

```ts
// SIO-1016 + SIO-1018: read the just-completed turn for the confidence feedback loop.
// Supplies the coarse success signal (validationResult === "fail" -> hadError, plus
// confidenceScore) AND the promoted skills active this turn. SIO-1018 closed the
// attribution gap: the aggregate node records active skills onto state.skillsApplied,
// which we map to SKILL.md paths here. Downstream recordSkillOutcome no-ops on any
// body-only skill, so only learned-frontmatter skills are counted. Scoped to
// incident-analyzer (matches readCompletedTurn).
```

- [ ] **Step 4: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS. (`values.skillsApplied` is read off the untyped snapshot `values` object the same way `values.confidenceScore`/`values.validationResult` are; the `Array.isArray` narrow keeps it `string[]` without `any`.)

- [ ] **Step 5: Run the agent-package + web tests touched by the wiring**

Run: `bun run --filter @devops-agent/agent test && bun run --filter @devops-agent/web test`
Expected: PASS (no behavior change for existing tests; the loop is still env-gated off by default).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/server/agent.ts
git commit -m "SIO-1018: populate appliedSkills from skillsApplied; activate the confidence loop

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end verification (manual, gated path)

Prove the full loop: a tracked turn that applied a learned-frontmatter skill bumps its counts. The unit path is already covered by `skill-learner-install.test.ts` (non-empty `appliedSkills` → file bump); this task verifies the *attribution* now flows from a real turn.

**Files:**
- Test (temporary scratch): a learned skill draft under `agents/incident-analyzer/skills/` (do NOT commit it)

**Interfaces:**
- Consumes: the full wired pipeline (Tasks 1-5).

- [ ] **Step 1: Scaffold a learned-skill draft with learning frontmatter**

Create `agents/incident-analyzer/skills/__e2e-probe/SKILL.md` (temporary, gitignored by being removed before commit):

```markdown
---
name: __e2e-probe
description: temporary SIO-1018 e2e probe
confidence: 0.5
usage_count: 0
success_count: 0
failure_count: 0
learned_from: thread:e2e
learned_at: 2026-06-26T00:00:00Z
---

# probe
```

Add `__e2e-probe` to `agents/incident-analyzer/agent.yaml` under `skills:` (temporary).

- [ ] **Step 2: Drive a unit-level e2e through the real reader path**

Because a full SSE turn needs live MCP servers, verify attribution with a focused integration test instead (add to `packages/agent/src/skill-outcome.test.ts`, then DELETE after observing PASS — or keep if it uses a temp dir). Use `recordSkillOutcomesForTurn` with `appliedSkillsForNames` to prove the composition:

```ts
test("SIO-1018 e2e: appliedSkillsForNames + recordSkillOutcomesForTurn bumps a real skill file", async () => {
  // requires SKILL_OUTCOME_TRACKING_ENABLED=true and the __e2e-probe skill on disk
  const prior = process.env.SKILL_OUTCOME_TRACKING_ENABLED;
  process.env.SKILL_OUTCOME_TRACKING_ENABLED = "true";
  try {
    const applied = appliedSkillsForNames("incident-analyzer", ["__e2e-probe"]);
    await recordSkillOutcomesForTurn(applied, "success");
    await recordSkillOutcomesForTurn(applied, "success");
    await recordSkillOutcomesForTurn(applied, "failure");
    const fm = parse(readFileSync(applied[0]!.filePath, "utf8").split("---")[1]!);
    expect(fm.usage_count).toBe(3);
    expect(fm.success_count).toBe(2);
    expect(fm.failure_count).toBe(1);
    expect(fm.confidence).toBeCloseTo(0.6, 5); // (2+1)/(3+2)
  } finally {
    if (prior === undefined) delete process.env.SKILL_OUTCOME_TRACKING_ENABLED;
    else process.env.SKILL_OUTCOME_TRACKING_ENABLED = prior;
  }
});
```

(`recordSkillOutcomesForTurn` and `parse` from `yaml` are already importable in this test file's siblings; add imports as needed.)

- [ ] **Step 3: Run the e2e test**

Run: `bun test packages/agent/src/skill-outcome.test.ts -t "SIO-1018 e2e"`
Expected: PASS — `usage=3, success=2, failure=1, confidence≈0.6`.

- [ ] **Step 4: Tear down the probe**

Remove `agents/incident-analyzer/skills/__e2e-probe/` and revert the `agent.yaml` addition. If the e2e test depended on the on-disk probe (Step 2 variant), either delete that test or rewrite it against a `mkdtempSync` temp file + a `__e2e-probe` path so it is self-contained. Confirm `git status` shows no probe artifacts.

- [ ] **Step 5: Full suite + lint + typecheck**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS. Compare against the known pre-existing failures (per `reference_main_preexisting_test_lint_failures` / its updates) — any red must match main, not be introduced here. `git stash && bun run test` on main to confirm if unsure.

- [ ] **Step 6: Commit (only committed artifacts)**

```bash
git add -A
git status   # verify NO __e2e-probe files staged
git commit -m "SIO-1018: e2e verification of the activated skill confidence loop

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(If Step 4 left a self-contained temp-dir test, it is committed here; otherwise this commit may be empty — skip it.)

---

## Self-Review

**Spec coverage:**
- `skillsApplied` channel → Task 2. ✓
- `getActiveSkillNames()` + aggregate capture → Task 3. ✓
- `appliedSkillsForNames()` reusing `getWorkspaceRoot`+`skillFilePath` (incl. the spec's "lift skillFilePath to paths.ts" option) → Tasks 1 + 4. ✓
- `readCompletedTurnOutcome` populates `appliedSkills` → Task 5. ✓
- Body-only skills never modified → relies on untouched `recordSkillOutcome` no-op (verified in Task 6 by using a *frontmatter* probe; the existing `skill-outcome.test.ts` already covers the body-only no-op). ✓
- Manual e2e `usage=3/success=2/failure=1/confidence=0.6` → Task 6. ✓
- All public symbols re-exported from index → Tasks 1, 3, 4. ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code; commands have expected output. ✓

**Type consistency:** `skillFilePath(workspaceRoot, agent, skill)`, `getActiveSkillNames(): string[]`, `appliedSkillsForNames(agentName, names): AppliedSkill[]`, `skillsApplied: string[] | null` are used identically across Tasks 1-5. The reader narrows `values.skillsApplied` with `Array.isArray` (no `any`). ✓

**Note on the SIO-1016 testing claim:** the spec listed "integration — `runSkillOutcomeTracking` with non-empty `appliedSkills`" as new work; it is in fact ALREADY covered by `skill-learner-install.test.ts:39-53`. Task 6 therefore verifies the *attribution flow* (names → paths → bump) rather than re-adding that test.
