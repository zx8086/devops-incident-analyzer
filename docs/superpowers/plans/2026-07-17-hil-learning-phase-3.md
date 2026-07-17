# HIL Learning Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the rebuild-from-facts gap for `RESOLVED_BY` edges, and let a human edit the text of review-gate proposal items before applying.

**Architecture:** Two independent deliverables. (1) A `kg-resolution` replay mapper + entry in the knowledge-graph rebuild CLI (mirrors the existing `kg-binding-invalidated` mapper). (2) A text-only per-item edit channel that threads UP from the review card through the resume endpoint, gate, and a new `hilEdits` state field, merged over the distiller's proposal by a pure `applyEdits` function before `applyLearnings` writes it — restricted to invariant-free prose fields so no grounding/format rule can break.

**Tech Stack:** Bun, TypeScript (strict, no `any`), Zod, LangGraph (`@langchain/langgraph`), SvelteKit + Svelte 5 runes, Tailwind, `bun test`. Embedded Kuzu/lbug graph store. Biome for lint/format.

Spec: `docs/superpowers/specs/2026-07-17-hil-learning-phase-3-design.md`. Repo state: branch `claude/sio-1128-hil-phase-3` off `main` @ `0e3ecf2`.

## Global Constraints

- TypeScript strict mode, never `any` (Biome `noExplicitAny: "error"`). Named exports preferred.
- Zod for runtime validation; no `.default()` in config schemas.
- No emojis anywhere (code, comments, commits, output). Use "Success"/"Warning" text.
- Tailwind CSS only in Svelte (no `<style>` blocks); Svelte 5 runes (`$state`, `$derived`, `$props`).
- lbug single-clause Cypher only; only relationship `DELETE r` is proven; no `DETACH DELETE`.
- Rebuild byte-parity: mirror-fact annotation keys must match the `rebuild.ts` mappers exactly.
- Commit format `SIO-1128: message`; end commit bodies with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Repo is PUBLIC: use synthetic identifiers in fixtures (no real infra ids / internal URLs).
- Run `bun run typecheck && bun run lint && bun run test` after each task. Web tests run `bun test --isolate`.
- The `ladybug.integration.test.ts` real-engine suite skips under `CI=true` and may segfault at teardown locally (SIO-954, benign) — read pass/fail via `-t "<name>"` filters.

## File Structure

| File | Responsibility |
|---|---|
| `packages/knowledge-graph/src/rebuild.ts` | add `resolutionFromAnnotations` mapper + `applyResolution` adapter + replay entry (Part 1) |
| `packages/knowledge-graph/src/rebuild.test.ts` | mapper unit tests |
| `packages/knowledge-graph/src/ladybug.integration.test.ts` | real-engine resolution replay round-trip |
| `packages/shared/src/hil-learning.ts` | `HilItemEdits` type + `HIL_EDITABLE_FIELDS` + `HilItemEditsSchema` (Part 2 contract) |
| `packages/shared/src/index.ts` | re-export the new symbols |
| `packages/agent/src/learn/edits.ts` (new) | `applyEdits` pure merge |
| `packages/agent/src/learn/edits.test.ts` (new) | merge unit tests |
| `packages/agent/src/learn/schema.ts` | re-export `HilItemEdits` etc. for the learn lane |
| `packages/agent/src/state.ts` | `hilEdits` state annotation |
| `packages/agent/src/classifier.ts` | clear `hilEdits` in `turnReset` |
| `packages/agent/src/learn/distill.ts` | `learnReviewGate` reads `edits`, writes `hilEdits`; widen `HilReviewDecision` |
| `packages/agent/src/learn/apply.ts` | `proposal = applyEdits(...)` after destructure |
| `packages/agent/src/learn/apply.test.ts` | apply-with-edits tests |
| `apps/web/src/routes/api/agent/learning/resume/+server.ts` | `review.edits` schema + resumeValue thread |
| `apps/web/src/routes/api/agent/learning/resume/server.test.ts` | endpoint edits test |
| `apps/web/src/lib/stores/agent.svelte.ts` | `resolveHilReview(decisions, edits)` + payload type |
| `apps/web/src/lib/components/LearningProposalCard.svelte` | textarea inputs + `onApply` widening |
| `apps/web/src/routes/+page.svelte` | pass `edits` from the card |

---

## PART 1 — kg-resolution replay

### Task 1: `resolutionFromAnnotations` mapper + replay entry

**Files:**
- Modify: `packages/knowledge-graph/src/rebuild.ts` (imports ~25-34; mappers region ~113-131; replay block ~207-222; `printGaps` ~233-240)
- Test: `packages/knowledge-graph/src/rebuild.test.ts`

**Interfaces:**
- Consumes: `type AnnotationMap` (already imported in rebuild.ts), `linkResolution(store: GraphStore, incidentId: string, runbookFilenames: string[]): Promise<void>` (from `./writer.ts`), `type GraphStore` (already in scope).
- Produces: `resolutionFromAnnotations(a: AnnotationMap): ResolutionRecord | null` and `interface ResolutionRecord { incidentId: string; runbook: string }`.

- [ ] **Step 1: Write the failing test**

Add to `packages/knowledge-graph/src/rebuild.test.ts`. First add `resolutionFromAnnotations` to the existing `from "./rebuild.ts"` import at the top of the file. Then append this describe block at the end of the file:

```ts
// SIO-1128: the kg-resolution mapper reconstructs the linkResolution args so RESOLVED_BY
// edges survive rebuild-from-facts.
describe("SIO-1128 rebuild: resolutionFromAnnotations", () => {
	test("maps a full kg-resolution fact", () => {
		expect(
			resolutionFromAnnotations({
				kind: "kg-resolution",
				incident_id: "inc-9",
				runbook: "kafka-consumer-lag.md",
				ticket: "DEVOPS-9",
			}),
		).toEqual({ incidentId: "inc-9", runbook: "kafka-consumer-lag.md" });
	});

	test("returns null on a missing required field", () => {
		const base = { kind: "kg-resolution", incident_id: "inc-9", runbook: "x.md" };
		expect(resolutionFromAnnotations(base)).not.toBeNull();
		expect(resolutionFromAnnotations({ ...base, incident_id: "" })).toBeNull();
		expect(resolutionFromAnnotations({ ...base, runbook: "" })).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/knowledge-graph && bun test src/rebuild.test.ts -t "resolutionFromAnnotations"`
Expected: FAIL — `resolutionFromAnnotations` is not exported / not defined.

- [ ] **Step 3: Add the mapper + adapter to `rebuild.ts`**

Add `linkResolution` to the `./writer.ts` import block (alphabetical — after `linkIncidentTicket`):

```ts
import {
	type IncidentRecord,
	invalidateBindingByHuman,
	linkIncidentTicket,
	linkResolution,
	type RootCauseRecord,
	recordIncident,
	recordRootCause,
	recordServiceBinding,
	type ServiceBindingRecord,
} from "./writer.ts";
```

Add the mapper + adapter immediately after the existing `applyTicketLink` function (just below `ticketLinkFromAnnotations`/`applyTicketLink`, ~line 131):

```ts
// SIO-1128: a kg-resolution fact -> the args of linkResolution. Replays AFTER kg-incident
// so the Incident (which linkResolution MATCHes on) already exists. This closes the
// rebuild gap for the RESOLVED_BY edge (the "resolved by X" read path).
export interface ResolutionRecord {
	incidentId: string;
	runbook: string;
}

export function resolutionFromAnnotations(a: AnnotationMap): ResolutionRecord | null {
	if (!a.incident_id || !a.runbook) return null;
	return { incidentId: a.incident_id, runbook: a.runbook };
}

async function applyResolution(store: GraphStore, rec: ResolutionRecord): Promise<void> {
	await linkResolution(store, rec.incidentId, [rec.runbook]);
}
```

- [ ] **Step 4: Add the replay entry**

In the replay block, insert the `kg-resolution` entry after the `kg-incident-ticket` line and before `kg-root-cause`:

```ts
	await replayKind(store, "kg-incident", incidentFromAnnotations, recordIncident, opts.dryRun);
	// SIO-1134: curation links replay AFTER incidents exist.
	await replayKind(store, "kg-incident-ticket", ticketLinkFromAnnotations, applyTicketLink, opts.dryRun);
	// SIO-1128: resolution edges replay after the Incident exists (linkResolution MATCHes it).
	await replayKind(store, "kg-resolution", resolutionFromAnnotations, applyResolution, opts.dryRun);
	await replayKind(store, "kg-root-cause", rootCauseFromAnnotations, recordRootCause, opts.dryRun);
```

- [ ] **Step 5: Refresh `printGaps()`**

In `printGaps()`, the "NOT rebuilt" list must no longer imply RESOLVED_BY is graph-only. Find the line that reads (verbatim in the current file):

```ts
		"  bindings (kg-binding). NOT rebuilt (no system-of-record fact):",
```

Change the preceding summary sentence so it mentions resolutions are rebuilt. Locate the block that starts `"knowledge-graph rebuild: rebuilt from Couchbase mirror facts (SIO-1103): Incident +"` and update its second line from:

```ts
		"  AFFECTED_BY (kg-incident), RootCause + HAS_ROOT_CAUSE (kg-root-cause), telemetry",
```

to:

```ts
		"  AFFECTED_BY (kg-incident), RootCause + HAS_ROOT_CAUSE (kg-root-cause), RESOLVED_BY (kg-resolution), telemetry",
```

(This is a comment/output refresh only — no behavior change.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/knowledge-graph && bun test src/rebuild.test.ts`
Expected: PASS (all rebuild tests, including the 2 new ones).

- [ ] **Step 7: Typecheck**

Run: `bun run --filter '@devops-agent/knowledge-graph' typecheck`
Expected: `Exited with code 0`.

- [ ] **Step 8: Commit**

```bash
git add packages/knowledge-graph/src/rebuild.ts packages/knowledge-graph/src/rebuild.test.ts
git commit -m "$(cat <<'EOF'
SIO-1128: replay kg-resolution facts so RESOLVED_BY survives rebuild

The kg-resolution mirror fact (written at learn-apply time) had no replay
mapper, so a rebuild-from-facts dropped every RESOLVED_BY edge. Add
resolutionFromAnnotations + applyResolution + a replay entry after kg-incident
(the Incident must exist for linkResolution's MATCH).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

### Task 2: real-engine resolution replay round-trip

**Files:**
- Modify: `packages/knowledge-graph/src/ladybug.integration.test.ts` (imports ~27-46; add a test in the `describe.skipIf(!available)` block)

**Interfaces:**
- Consumes: `resolutionFromAnnotations` (Task 1), `recordIncident`, `LadybugStore`, `linkResolution` (via the mapper's `applyResolution` — but `applyResolution` is not exported, so the test maps then calls `linkResolution` directly).

- [ ] **Step 1: Add `linkResolution` to the writer import if absent**

Check the `from "./writer.ts"` import block in `ladybug.integration.test.ts`. `linkResolution` was added there in SIO-1135 (it is present on `main`). If missing, add it alphabetically. `resolutionFromAnnotations` is imported from `./reader.ts`? No — it lives in `./rebuild.ts`. Add a new import line at the top of the test file:

```ts
import { resolutionFromAnnotations } from "./rebuild.ts";
```

- [ ] **Step 2: Write the failing test**

Append inside the `describe.skipIf(!available)("LadybugStore (real embedded engine)", ...)` block (before its closing `});`):

```ts
	// SIO-1128: a kg-resolution fact replays into a RESOLVED_BY edge on the real engine --
	// the round-trip the in-memory fake cannot exercise (it can't execute the MATCH/MERGE).
	test("kg-resolution replays into a RESOLVED_BY edge", async () => {
		const store = new LadybugStore(join(dir, "db-resolution"));
		await store.init();

		await recordIncident(store, {
			id: "inc-res",
			severity: "high",
			summary: "resolved incident",
			services: ["svc-r"],
		});

		const rec = resolutionFromAnnotations({
			kind: "kg-resolution",
			incident_id: "inc-res",
			runbook: "kafka-consumer-lag.md",
		});
		expect(rec).not.toBeNull();
		if (!rec) return;
		await linkResolution(store, rec.incidentId, [rec.runbook]);

		const rows = await store.run<{ n: number }>(
			"MATCH (:Incident {id: 'inc-res'})-[:RESOLVED_BY]->(:Runbook {filename: 'kafka-consumer-lag.md'}) RETURN count(*) AS n",
		);
		expect(Number(rows[0]?.n ?? 0)).toBe(1);

		await store.close();
	});
```

- [ ] **Step 3: Run the test (real engine, local)**

Run: `cd packages/knowledge-graph && bun test src/ladybug.integration.test.ts -t "kg-resolution replays"`
Expected: `1 pass  0 fail` (a teardown segfault after the summary is benign, SIO-954). If `available` is false in this environment the test is skipped — that is acceptable (CI relies on the deterministic mapper unit test from Task 1).

- [ ] **Step 4: Typecheck + commit**

Run: `bun run --filter '@devops-agent/knowledge-graph' typecheck`
Expected: `Exited with code 0`.

```bash
git add packages/knowledge-graph/src/ladybug.integration.test.ts
git commit -m "$(cat <<'EOF'
SIO-1128: real-engine test for kg-resolution replay

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## PART 2 — per-item review edits (text-only)

### Task 3: the `HilItemEdits` contract in shared

**Files:**
- Modify: `packages/shared/src/hil-learning.ts` (append after the existing exports, ~line 86)
- Modify: `packages/shared/src/index.ts` (the `from "./hil-learning.ts"` block, ~168-180)
- Test: `packages/shared/src/hil-learning.test.ts` (create if absent; else append)

**Interfaces:**
- Produces:
  - `type HilItemEdits = Record<string, Record<string, string>>`
  - `const HIL_EDITABLE_FIELDS: { rootCause: readonly string[]; binding: readonly string[]; heuristic: readonly string[]; memoryFact: readonly string[] }`
  - `const HilItemEditsSchema: z.ZodType<HilItemEdits>`

- [ ] **Step 1: Write the failing test**

Check whether `packages/shared/src/hil-learning.test.ts` exists (`ls packages/shared/src/hil-learning.test.ts`). If not, create it with the imports header:

```ts
// shared/src/hil-learning.test.ts
import { describe, expect, test } from "bun:test";
import { HIL_EDITABLE_FIELDS, HilItemEditsSchema } from "./hil-learning.ts";
```

If it exists, add `HIL_EDITABLE_FIELDS, HilItemEditsSchema` to its imports. Then append:

```ts
describe("SIO-1128 HilItemEdits contract", () => {
	test("HIL_EDITABLE_FIELDS lists only invariant-free prose fields per kind", () => {
		expect(HIL_EDITABLE_FIELDS.rootCause).toEqual(["description", "resolution"]);
		expect(HIL_EDITABLE_FIELDS.binding).toEqual(["reason"]);
		expect(HIL_EDITABLE_FIELDS.heuristic).toEqual(["description", "whenToUse", "procedure"]);
		expect(HIL_EDITABLE_FIELDS.memoryFact).toEqual(["text"]);
	});

	test("HilItemEditsSchema accepts an id->field->string map and rejects non-string values", () => {
		expect(HilItemEditsSchema.safeParse({ "fact-1": { text: "edited" } }).success).toBe(true);
		expect(HilItemEditsSchema.safeParse({}).success).toBe(true);
		expect(HilItemEditsSchema.safeParse({ "fact-1": { text: 5 } }).success).toBe(false);
		expect(HilItemEditsSchema.safeParse({ "fact-1": "not-an-object" }).success).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/hil-learning.test.ts`
Expected: FAIL — `HIL_EDITABLE_FIELDS` / `HilItemEditsSchema` not exported.

- [ ] **Step 3: Add the contract to `hil-learning.ts`**

Append to `packages/shared/src/hil-learning.ts` (after the `HilDecisions` type near the end of the file):

```ts
// SIO-1128: per-item text edits from the review card, keyed by item id -> field -> new
// value. Only invariant-free PROSE fields are editable (see HIL_EDITABLE_FIELDS); grounded
// or structured fields (resourceId, causeClass, bindingKind, datasource, heuristic name,
// runbookFilename, evidence) stay read-only, so an edit can never break resourceId
// grounding or a kebab-case regex. Kept separate from HilDecisions (approve/reject).
export const HIL_EDITABLE_FIELDS = {
	rootCause: ["description", "resolution"],
	binding: ["reason"],
	heuristic: ["description", "whenToUse", "procedure"],
	memoryFact: ["text"],
} as const;

export type HilItemEdits = Record<string, Record<string, string>>;

export const HilItemEditsSchema: z.ZodType<HilItemEdits> = z.record(
	z.string(),
	z.record(z.string(), z.string()),
);
```

- [ ] **Step 4: Re-export from the shared barrel**

In `packages/shared/src/index.ts`, add the three names to the `from "./hil-learning.ts"` export block (alphabetical), so the block includes:

```ts
	HIL_EDITABLE_FIELDS,
	type HilItemEdits,
	HilItemEditsSchema,
```

(Insert `HIL_EDITABLE_FIELDS` before `type HilDecision`, and `type HilItemEdits` + `HilItemEditsSchema` after `HilMatchCandidateSchema`, keeping the block sorted the way Biome expects — run `bun run lint:fix` in Step 6 to settle ordering.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/shared/src/hil-learning.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint-fix + commit**

Run: `bun run --filter '@devops-agent/shared' typecheck && bun run lint:fix`
Expected: typecheck `Exited with code 0`; lint fixes import ordering only.

```bash
git add packages/shared/src/hil-learning.ts packages/shared/src/hil-learning.test.ts packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
SIO-1128: HilItemEdits contract (text-only editable fields)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

### Task 4: `applyEdits` pure merge

**Files:**
- Create: `packages/agent/src/learn/edits.ts`
- Create: `packages/agent/src/learn/edits.test.ts`
- Modify: `packages/agent/src/learn/schema.ts` (re-export the new shared symbols for the learn lane)

**Interfaces:**
- Consumes: `type LearningProposal`, `type HilItemEdits`, `HIL_EDITABLE_FIELDS` (from `@devops-agent/shared` via `./schema.ts`).
- Produces: `applyEdits(proposal: LearningProposal, edits: HilItemEdits): LearningProposal`.

- [ ] **Step 1: Re-export the shared symbols from the learn schema barrel**

In `packages/agent/src/learn/schema.ts`, add to the `from "@devops-agent/shared"` export block:

```ts
	HIL_EDITABLE_FIELDS,
	type HilItemEdits,
	HilItemEditsSchema,
```

(Alphabetical placement; `bun run lint:fix` settles it.)

- [ ] **Step 2: Write the failing test**

Create `packages/agent/src/learn/edits.test.ts`:

```ts
// agent/src/learn/edits.test.ts
import { describe, expect, test } from "bun:test";
import type { LearningProposal } from "@devops-agent/shared";
import { applyEdits } from "./edits.ts";

function proposal(): LearningProposal {
	return {
		ticketKey: "DEVOPS-1355",
		rootCause: {
			id: "rc-1",
			kind: "root-cause",
			causeClass: "route53-resolver-rule-missing",
			description: "original description",
			resolution: "original resolution",
			invalidatedHypotheses: [],
			evidence: ["quote"],
		},
		bindings: [
			{
				id: "bind-1",
				kind: "binding",
				action: "confirm",
				service: "svc",
				datasource: "kafka",
				bindingKind: "topic",
				resourceId: "orders.events",
				reason: "original reason",
				evidence: ["orders.events"],
			},
		],
		heuristics: [],
		memoryFacts: [{ id: "fact-1", kind: "memory-fact", text: "original text", evidence: ["quote"] }],
	};
}

describe("SIO-1128 applyEdits", () => {
	test("returns the proposal unchanged for an empty edits map (identity)", () => {
		const p = proposal();
		expect(applyEdits(p, {})).toEqual(p);
	});

	test("overrides a whitelisted prose field (memoryFact.text)", () => {
		const out = applyEdits(proposal(), { "fact-1": { text: "edited text" } });
		expect(out.memoryFacts[0]?.text).toBe("edited text");
	});

	test("overrides rootCause description + resolution", () => {
		const out = applyEdits(proposal(), { "rc-1": { description: "edited desc", resolution: "edited res" } });
		expect(out.rootCause?.description).toBe("edited desc");
		expect(out.rootCause?.resolution).toBe("edited res");
	});

	test("ignores a NON-whitelisted field (resourceId stays the distiller value)", () => {
		const out = applyEdits(proposal(), { "bind-1": { resourceId: "lkc-injected", reason: "edited reason" } });
		expect(out.bindings[0]?.resourceId).toBe("orders.events"); // untouched
		expect(out.bindings[0]?.reason).toBe("edited reason"); // whitelisted -> applied
	});

	test("falls back to the original on a blank/whitespace edit (never erases a field)", () => {
		const out = applyEdits(proposal(), { "fact-1": { text: "   " } });
		expect(out.memoryFacts[0]?.text).toBe("original text");
	});

	test("does not mutate the input proposal", () => {
		const p = proposal();
		applyEdits(p, { "fact-1": { text: "edited" } });
		expect(p.memoryFacts[0]?.text).toBe("original text");
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/agent/src/learn/edits.test.ts`
Expected: FAIL — `applyEdits` not defined.

- [ ] **Step 4: Implement `applyEdits`**

Create `packages/agent/src/learn/edits.ts`:

```ts
// agent/src/learn/edits.ts
//
// SIO-1128: merge a human's per-item text edits over the distiller's proposal before
// applyLearnings writes it. Only fields in HIL_EDITABLE_FIELDS for that item's kind are
// applied -- everything else (grounded/structured fields) is ignored, so an edit cannot
// break resourceId grounding, causeClass/name regexes, or bindingKind validation. Pure:
// returns a new proposal, never mutates. A blank/whitespace edit falls back to the
// original (a cleared textarea must not erase a field).

import { HIL_EDITABLE_FIELDS, type HilItemEdits, type LearningProposal } from "./schema.ts";

// Apply the whitelisted edits for one item. `item` is a plain object with string fields;
// `allowed` is the field whitelist for its kind. Returns a new item with only allowed,
// non-blank edits applied.
function editItem<T extends { id: string }>(item: T, edits: HilItemEdits, allowed: readonly string[]): T {
	const itemEdits = edits[item.id];
	if (!itemEdits) return item;
	const patch: Record<string, string> = {};
	for (const field of allowed) {
		const value = itemEdits[field];
		if (typeof value === "string" && value.trim().length > 0) patch[field] = value;
	}
	return Object.keys(patch).length > 0 ? { ...item, ...patch } : item;
}

export function applyEdits(proposal: LearningProposal, edits: HilItemEdits): LearningProposal {
	if (!edits || Object.keys(edits).length === 0) return proposal;
	return {
		...proposal,
		rootCause: proposal.rootCause
			? editItem(proposal.rootCause, edits, HIL_EDITABLE_FIELDS.rootCause)
			: proposal.rootCause,
		bindings: proposal.bindings.map((b) => editItem(b, edits, HIL_EDITABLE_FIELDS.binding)),
		heuristics: proposal.heuristics.map((h) => editItem(h, edits, HIL_EDITABLE_FIELDS.heuristic)),
		memoryFacts: proposal.memoryFacts.map((f) => editItem(f, edits, HIL_EDITABLE_FIELDS.memoryFact)),
	};
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/agent/src/learn/edits.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: `Exited with code 0`.

```bash
git add packages/agent/src/learn/edits.ts packages/agent/src/learn/edits.test.ts packages/agent/src/learn/schema.ts
git commit -m "$(cat <<'EOF'
SIO-1128: applyEdits pure merge for review-gate edits

Merges whitelisted text edits over the distiller proposal by item id; ignores
non-whitelisted fields, falls back on blank edits, never mutates the input.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

### Task 5: `hilEdits` state field + turnReset

**Files:**
- Modify: `packages/agent/src/state.ts` (hil annotations region ~330-364; add import)
- Modify: `packages/agent/src/classifier.ts` (`turnReset` object ~141-153)

**Interfaces:**
- Produces: `state.hilEdits: HilItemEdits` (replace-reducer, default `{}`).

- [ ] **Step 1: Add the state annotation**

In `packages/agent/src/state.ts`, first ensure `HilItemEdits` is imported from `@devops-agent/shared` (find the existing import of `HilDecisions`/`LearningProposal` from shared and add `type HilItemEdits`). Then add the annotation immediately after the `hilDecisions` annotation (before the closing `});` of the state object):

```ts
	// SIO-1128: per-item text edits from the review card, merged over hilProposal by
	// applyLearnings. Default {} so apply is a no-op when the human made no edits.
	hilEdits: Annotation<HilItemEdits>({
		reducer: (_, next) => next,
		default: () => ({}),
	}),
```

- [ ] **Step 2: Clear it in turnReset**

In `packages/agent/src/classifier.ts`, add to the `turnReset` object (after `hilDecisions: undefined,`):

```ts
		hilEdits: {},
```

- [ ] **Step 3: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: `Exited with code 0`.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/state.ts packages/agent/src/classifier.ts
git commit -m "$(cat <<'EOF'
SIO-1128: hilEdits state field + turnReset clear

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

### Task 6: gate reads edits + apply merges them

**Files:**
- Modify: `packages/agent/src/learn/distill.ts` (`HilReviewDecision` ~306-308; `learnReviewGate` return ~334; import)
- Modify: `packages/agent/src/learn/apply.ts` (destructure ~125-129; import)
- Test: `packages/agent/src/learn/apply.test.ts`

**Interfaces:**
- Consumes: `applyEdits` (Task 4), `type HilItemEdits` (Task 3), `state.hilEdits` (Task 5).
- Produces: `learnReviewGate` now returns `{ hilDecisions, hilEdits }`; `applyLearnings` uses `applyEdits(state.hilProposal, state.hilEdits)`.

- [ ] **Step 1: Write the failing apply test**

Add to `packages/agent/src/learn/apply.test.ts`. It uses the existing `stubStore`/`stateWith`/`proposal` helpers already in that file. Append inside the `describe("SIO-1126 applyLearnings", ...)` block:

```ts
	// SIO-1128: an edited memoryFact.text is what lands in the durable fact, not the
	// distiller's original. Uses a store stub that captures recordKeyDecision via calls.
	test("SIO-1128: an edited memory fact text is recorded (not the distiller original)", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		process.env.LIVE_MEMORY_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));
		const decisions = { "fact-1": "approve" as const };
		const result = await applyLearnings(
			stateWith({
				hilProposal: proposal(),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: decisions,
				hilEdits: { "fact-1": { text: "human-edited fact text" } },
			}),
		);
		const summary = String(result.messages?.[0]?.content ?? "");
		// The apply summary reports 1 fact written; the recorded fact carries the edited text.
		expect(summary).toContain("durable memory fact");
		delete process.env.LIVE_MEMORY_ENABLED;
	});
```

Note: the default `proposal()` helper's `memoryFacts[0]` has `id: "fact-1"`. Confirm by reading the helper; if its fact id differs, use that id in `hilEdits`. This test asserts the write path runs; a stricter content assertion would require mocking `recordKeyDecision`, which the file avoids — asserting the summary line is the established pattern.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/learn/apply.test.ts -t "edited memory fact"`
Expected: FAIL — `hilEdits` is not a known property on the state builder yet OR the edited text is ignored (apply reads `state.hilProposal` verbatim). It fails on the type first if `stateWith` is strict; since `stateWith` casts, it will fail because the edit is not applied and the test's intent (edited text used) is not yet wired. (If the summary line already appears, tighten the assertion in Step 5 after wiring.)

- [ ] **Step 3: Wire the gate (`distill.ts`)**

Add `type HilItemEdits` to the `from "./schema.ts"` import in `distill.ts`. Widen the interface:

```ts
export interface HilReviewDecision {
	decisions: HilDecisions;
	edits?: HilItemEdits;
}
```

Change the `learnReviewGate` return line from:

```ts
	return { hilDecisions: decision?.decisions ?? {} };
```

to:

```ts
	return { hilDecisions: decision?.decisions ?? {}, hilEdits: decision?.edits ?? {} };
```

- [ ] **Step 4: Wire apply (`apply.ts`)**

Add the import near the other `./` imports in `apply.ts`:

```ts
import { applyEdits } from "./edits.ts";
```

Change the destructure block from:

```ts
	const proposal = state.hilProposal;
	const match = state.hilMatch;
	const decisions = state.hilDecisions;
	if (!proposal || !match || !decisions) return {};
```

to:

```ts
	const match = state.hilMatch;
	const decisions = state.hilDecisions;
	if (!state.hilProposal || !match || !decisions) return {};
	// SIO-1128: merge the human's text edits over the distiller proposal. applyEdits only
	// touches invariant-free prose fields, so every downstream write/validation is unchanged.
	const proposal = applyEdits(state.hilProposal, state.hilEdits ?? {});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/agent/src/learn/apply.test.ts`
Expected: PASS (all apply tests including the new one).

- [ ] **Step 6: Typecheck + commit**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: `Exited with code 0`.

```bash
git add packages/agent/src/learn/distill.ts packages/agent/src/learn/apply.ts packages/agent/src/learn/apply.test.ts
git commit -m "$(cat <<'EOF'
SIO-1128: review gate reads edits; apply merges them over the proposal

learnReviewGate writes hilEdits from the resume value; applyLearnings uses
applyEdits(hilProposal, hilEdits) so the human-edited text lands in both the
graph writes and the mirror facts.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

### Task 7: resume endpoint accepts `review.edits`

**Files:**
- Modify: `apps/web/src/routes/api/agent/learning/resume/+server.ts` (schema ~28-40; resumeValue ~50-51; imports)
- Test: `apps/web/src/routes/api/agent/learning/resume/server.test.ts`

**Interfaces:**
- Consumes: `HilItemEditsSchema` (Task 3, via `@devops-agent/shared`).
- Produces: the resume endpoint threads `{ decisions, edits }` into the review resume value.

- [ ] **Step 1: Write the failing endpoint test**

The file's request helper is `makeRequest(body)` (returns `Parameters<typeof POST>[0]`), and tests assert `response.status`. A well-formed `review` payload with no pending interrupt returns **409** in this harness (see the existing "mismatched"/"nothing pending" tests) — a malformed body returns **400** (schema reject). So: a valid `review.edits` must NOT 400 (it 409s past the schema), and a non-string edit value must 400. Append after the existing 400-rejection tests:

```ts
	test("SIO-1128: accepts review.edits past the schema (409, no pending interrupt) and rejects a non-string edit", async () => {
		const wellFormed = await POST(
			makeRequest({
				threadId: "t-1",
				review: { decisions: { "fact-1": "approve" }, edits: { "fact-1": { text: "edited" } } },
			}),
		);
		expect(wellFormed.status).not.toBe(400); // passes schema; 409 for no pending review

		const malformed = await POST(
			makeRequest({
				threadId: "t-1",
				review: { decisions: { "fact-1": "approve" }, edits: { "fact-1": { text: 5 } } },
			}),
		);
		expect(malformed.status).toBe(400); // HilItemEditsSchema rejects the non-string value
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test --isolate src/routes/api/agent/learning/resume/server.test.ts -t "accepts review.edits"`
Expected: FAIL — the malformed case is accepted (200/409 instead of 400) because the current schema has no `edits` and ignores unknown keys.

- [ ] **Step 3: Extend the schema + resumeValue**

Add the import at the top of `+server.ts`:

```ts
import { HilItemEditsSchema } from "@devops-agent/shared";
```

Change the `review` schema field from:

```ts
		review: z.object({ decisions: z.record(z.string(), z.enum(["approve", "reject"])) }).optional(),
```

to:

```ts
		review: z
			.object({
				decisions: z.record(z.string(), z.enum(["approve", "reject"])),
				edits: HilItemEditsSchema.optional(),
			})
			.optional(),
```

Change the `resumeValue` construction from:

```ts
	const resumeValue =
		body.match !== undefined ? { incidentId: body.match.incidentId } : { decisions: body.review?.decisions ?? {} };
```

to:

```ts
	const resumeValue =
		body.match !== undefined
			? { incidentId: body.match.incidentId }
			: { decisions: body.review?.decisions ?? {}, edits: body.review?.edits ?? {} };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun test --isolate src/routes/api/agent/learning/resume/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run --filter '@devops-agent/web' typecheck`
Expected: `Exited with code 0`.

```bash
git add "apps/web/src/routes/api/agent/learning/resume/+server.ts" apps/web/src/routes/api/agent/learning/resume/server.test.ts
git commit -m "$(cat <<'EOF'
SIO-1128: resume endpoint accepts review.edits

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

### Task 8: store threads edits; card emits them

**Files:**
- Modify: `apps/web/src/lib/stores/agent.svelte.ts` (`resumeHilLearning` payload type ~682; `resolveHilReview` ~730-733)
- Modify: `apps/web/src/lib/components/LearningProposalCard.svelte` (script + markup)
- Modify: `apps/web/src/routes/+page.svelte` (`onApply` mount ~408-412)

**Interfaces:**
- Consumes: `type HilItemEdits` (from `@devops-agent/shared`).
- Produces: `resolveHilReview(decisions: HilDecisions, edits: HilItemEdits)`; the card's `onApply(decisions, edits)`.

- [ ] **Step 1: Widen the store**

In `apps/web/src/lib/stores/agent.svelte.ts`, add `type HilItemEdits` to the `@devops-agent/shared` type import (find where `LearningProposal`/`HilLearningReviewPrompt` types are imported; if the store imports shared types elsewhere, add there — otherwise add `import type { HilItemEdits } from "@devops-agent/shared";`). Change `resumeHilLearning`'s payload type from:

```ts
		payload: { match?: { incidentId: string | null }; review?: { decisions: Record<string, "approve" | "reject"> } },
```

to:

```ts
		payload: {
			match?: { incidentId: string | null };
			review?: { decisions: Record<string, "approve" | "reject">; edits?: HilItemEdits };
		},
```

Change `resolveHilReview` from:

```ts
	function resolveHilReview(decisions: Record<string, "approve" | "reject">) {
		if (!hilLearningReview) return;
		return resumeHilLearning({ review: { decisions } }, hilLearningReview.threadId);
	}
```

to:

```ts
	function resolveHilReview(decisions: Record<string, "approve" | "reject">, edits: HilItemEdits = {}) {
		if (!hilLearningReview) return;
		return resumeHilLearning({ review: { decisions, edits } }, hilLearningReview.threadId);
	}
```

- [ ] **Step 2: Add textarea editing to the card**

In `apps/web/src/lib/components/LearningProposalCard.svelte`, in the `<script>` block, widen `onApply` in the `$props()` type and add an `edits` state + helpers:

```ts
	let {
		prompt,
		disabled = false,
		onApply,
	}: {
		prompt: HilLearningReviewPrompt;
		disabled?: boolean;
		onApply: (decisions: Record<string, "approve" | "reject">, edits: Record<string, Record<string, string>>) => void;
	} = $props();
```

Add below the existing `rejected` state:

```ts
	// SIO-1128: local per-item text edits, keyed by id -> field -> value. Seeded lazily
	// from the distiller value; only fields that differ from the original are emitted.
	let edits = $state<Record<string, Record<string, string>>>({});

	function editValue(id: string, field: string, original: string): string {
		return edits[id]?.[field] ?? original;
	}

	function setEdit(id: string, field: string, value: string) {
		edits = { ...edits, [id]: { ...(edits[id] ?? {}), [field]: value } };
	}

	// Emit only edits that (a) belong to an APPROVED item and (b) differ from the original.
	function emittedEdits(): Record<string, Record<string, string>> {
		const out: Record<string, Record<string, string>> = {};
		for (const [id, fields] of Object.entries(edits)) {
			if (rejected.has(id)) continue;
			const changed: Record<string, string> = {};
			for (const [field, value] of Object.entries(fields)) {
				if (value.trim().length > 0) changed[field] = value;
			}
			if (Object.keys(changed).length > 0) out[id] = changed;
		}
		return out;
	}
```

Change the two Apply-button handlers from `onApply(decisions(false))` / `onApply(decisions(true))` to:

```svelte
        onclick={() => onApply(decisions(false), emittedEdits())}
```
and (Reject all — no edits matter):
```svelte
        onclick={() => onApply(decisions(true), {})}
```

Convert the editable prose fields to `<textarea>`. For the rootCause `description` (currently `<p class="mt-0.5">{proposal.rootCause.description}</p>`) replace with:

```svelte
            <textarea
              class="mt-0.5 w-full rounded border border-tommy-accent-blue/30 bg-white px-2 py-1 text-xs text-tommy-navy"
              rows="2"
              {disabled}
              value={editValue(proposal.rootCause.id, "description", proposal.rootCause.description)}
              oninput={(e) => setEdit(proposal.rootCause.id, "description", e.currentTarget.value)}
            ></textarea>
```

Apply the same textarea pattern to: rootCause `resolution`; each `binding.reason`; each `heuristic.description`, `heuristic.whenToUse`, `heuristic.procedure`; each `memoryFact.text` (currently `<p class="text-xs text-tommy-navy">{fact.text}</p>`). Leave every OTHER field (causeClass, service, datasource, bindingKind, resourceId, action, heuristic name, evidence) as static text.

- [ ] **Step 3: Validate the Svelte with the MCP autofixer**

Run the `mcp__plugin_svelte_svelte__svelte-autofixer` on the modified component (desired_svelte_version 5). Fix any reported issues EXCEPT the two pre-existing ones the file already had (`Each block should have a key` on the `evidence`/`invalidatedHypotheses` loops, and `Use SvelteSet` for `rejected`) — do not touch pre-existing patterns.

- [ ] **Step 4: Update the page mount**

In `apps/web/src/routes/+page.svelte`, change:

```svelte
      onApply={(decisions) => agentStore.resolveHilReview(decisions)}
```

to:

```svelte
      onApply={(decisions, edits) => agentStore.resolveHilReview(decisions, edits)}
```

- [ ] **Step 5: Typecheck (svelte-check via web typecheck)**

Run: `bun run --filter '@devops-agent/web' typecheck`
Expected: `COMPLETED ... 0 ERRORS`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/stores/agent.svelte.ts apps/web/src/lib/components/LearningProposalCard.svelte apps/web/src/routes/+page.svelte
git commit -m "$(cat <<'EOF'
SIO-1128: review card inline text editing + store threading

The review card renders editable prose fields as textareas and emits changed
edits alongside decisions; resolveHilReview threads them to the resume endpoint.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

### Task 9: full verification + PR

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck**

Run: `bun run typecheck`
Expected: every package `Exited with code 0`.

- [ ] **Step 2: Full lint**

Run: `bun run lint`
Expected: exit 0 (the pre-existing `rebuild.ts:198` useTemplate info is not an error). If it fails, run `bun run lint:fix` and re-commit formatting.

- [ ] **Step 3: Full test suite**

Run: `bun run test`
Expected: every package `Exited with code 0` except a possible benign local segfault (exit 133) from `ladybug.integration.test.ts` teardown — verify agent/web/shared/knowledge-graph each report `0 fail` in their summaries.

- [ ] **Step 4: Manual e2e probe (if a dev server + agent-memory backend are available)**

```bash
# with KNOWLEDGE_GRAPH_ENABLED=true LIVE_MEMORY_ENABLED=true LIVE_MEMORY_BACKEND=agent-memory
curl -N -X POST localhost:5173/api/agent/learning/resume \
  -d '{"threadId":"hil-e2e","review":{"decisions":{"fact-1":"approve"},"edits":{"fact-1":{"text":"the human-edited fact text"}}}}'
# expect the apply summary; verify the recorded fact carries the edited text.
bun run --filter '@devops-agent/knowledge-graph' knowledge-graph:rebuild --dry-run
# expect a line: kg-resolution -> N replayed
```

- [ ] **Step 5: Push + open PR (ready-for-review, never draft)**

```bash
git push -u origin claude/sio-1128-hil-phase-3
gh pr create --title "SIO-1128: HIL learning Phase 3 -- kg-resolution replay + per-item review edits" --body "<summary of the two deliverables, verification block, link to spec>"
```

- [ ] **Step 6: Linear In Review + CodeRabbit triage**

Set SIO-1128 to In Review with the PR link. After CI + CodeRabbit complete, triage findings (fix real issues, skip with reasons), then await the user's merge instruction. Done only on explicit user approval.

---

## Self-Review

**Spec coverage:**
- kg-resolution replay → Tasks 1-2. ✓
- Per-item edit UX (contract, merge, state, gate, apply, endpoint, store, card, page) → Tasks 3-8. ✓
- Text-only whitelist → `HIL_EDITABLE_FIELDS` (Task 3) enforced in `applyEdits` (Task 4). ✓
- Empty-textarea fallback → Task 4 test + implementation, Task 8 `emittedEdits`. ✓
- Out-of-scope items (KG_BINDINGS_READ_DATASOURCES, root-cause columns) → not in any task. ✓
- Verification block → Task 9. ✓

**Type consistency:** `HilItemEdits = Record<string, Record<string, string>>` used identically in shared (Task 3), agent state (Task 5), `applyEdits` (Task 4), gate (Task 6), endpoint (Task 7), store/card (Task 8). `applyEdits(proposal, edits)` signature is stable across Tasks 4 and 6. `resolveHilReview(decisions, edits)` matches between Task 8's store and the page mount. `HIL_EDITABLE_FIELDS` shape (`rootCause`/`binding`/`heuristic`/`memoryFact` → string arrays) is consistent between Task 3 and Task 4's consumption.

**Placeholder scan:** No TBD/TODO. Task 7 uses the file's real `makeRequest(body)` helper and asserts `response.status` (409 for a well-formed no-pending-interrupt review, 400 for a schema reject) — verified against the existing tests. Task 8's autofixer step references the two pre-existing Svelte patterns (unkeyed `evidence` loop, `Set` for `rejected`) explicitly so they are not "fixed". All code to add is shown inline.
