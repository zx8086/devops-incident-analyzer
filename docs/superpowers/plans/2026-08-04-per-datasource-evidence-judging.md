# Per-Datasource Evidence Judging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the incident-replay eval's judge to score per-datasource evidence quality and per-sub-agent report accuracy, isolating the sub-agent model (the A/B variable) from the Sonnet 5 aggregator (the constant) — plus fix the era-drift fabrication miscall from the SIO-1372 audit.

**Architecture:** Additive changes only, no rewrites. `HolisticGradeSchema` in `packages/agent/src/eval/evaluators.ts` gains an optional `datasourceVerdicts` map, judged in the SAME OpenAI call as the existing holistic score. A second, independent judge function grades each sub-agent's serialized `*Findings` object against a new `referenceFindings` map added to the dataset schema. `run-function.ts` gains a small helper to surface those per-sub-agent findings on `runAgent`'s output. All new logic is pure and unit-tested without network calls, following the existing `evaluators.test.ts` pattern.

**Tech Stack:** TypeScript (Bun), Zod, OpenAI SDK (`gpt-4o-mini`), LangSmith (`langsmith` package), Bun test runner.

## Global Constraints

- TypeScript strict mode, never use `any` (biome `noExplicitAny: "error"`).
- Zod for all runtime validation; no `.default()` in schemas that later feed judge tolerance logic (existing pattern uses `.optional()` + `.catch()`).
- Named exports preferred.
- No emojis in code, logs, comments, or output.
- File headers: single-line relative path comment only (e.g. `// packages/agent/src/eval/evaluators.ts`).
- The SIO-1372 root-cause gate semantics (`applyRootCauseCap`, `squareVerdictWithReference`, the `rootCauseMatch` field and its cap values) MUST NOT change. Every new field is additive to the existing schema and existing tests in `evaluators.test.ts` must continue to pass unmodified.
- Run `bun run typecheck && bun run lint && bun run test` after every task.
- LangSmith dataset re-upload is delete + re-upload — there is no upsert (`reference_langsmith_dataset_no_upsert`).

---

## File Structure

- **Modify** `packages/agent/src/eval/dataset.ts` — add `referenceFindings?: { [datasource: string]: string }` to `EvalExample.outputs`.
- **Modify** `packages/agent/src/eval/incident-replay-dataset.ts` — backfill `referenceFindings` on all 32 entries.
- **Modify** `packages/agent/src/eval/evaluators.ts` — extend `HolisticGradeSchema`, `HOLISTIC_JUDGE_SYSTEM_PROMPT`, `judgeFeedback`; add `judgeSubagentReports` (new sub-agent judge).
- **Modify** `packages/agent/src/eval/evaluators.test.ts` — unit tests for every new pure function.
- **Create** `packages/agent/src/eval/subagent-reports.ts` — the `buildSubagentReports(results: DataSourceResult[])` helper (kept out of `run-function.ts` so it stays a small, focused, independently testable file, matching the existing split between `evaluators.ts` and `run-function.ts`).
- **Create** `packages/agent/src/eval/subagent-reports.test.ts` — unit tests for `buildSubagentReports`.
- **Modify** `packages/agent/src/eval/run-function.ts` — call `buildSubagentReports` and add `subagentReports` to `runAgent`'s returned `output`.

---

### Task 1: Add `referenceFindings` to the dataset schema

**Files:**
- Modify: `packages/agent/src/eval/dataset.ts:7-31`
- Test: `packages/agent/src/eval/dataset.test.ts` (create — no existing test file for this module)

**Interfaces:**
- Produces: `EvalExample.outputs.referenceFindings?: { [datasource: string]: string }` — consumed by Task 2 (dataset backfill), Task 4 (judge schema/prompt), Task 6 (`buildSubagentReports` caller in `run-function.ts` reads it indirectly via the judge, not this file directly).

- [ ] **Step 1: Add the field to `EvalExample`**

Edit `packages/agent/src/eval/dataset.ts`, inside the `outputs` object of the `EvalExample` interface (after the existing `referenceReport?: string;` field, around line 23):

```ts
	outputs: {
		expectedDatasources: string[];
		minConfidence: number;
		qualityRubric: string;
		// SIO-1372: the real, human-curated ticket's own Executive Summary / root-cause text, used
		// by responseQualityJudge as a holistic reference answer instead of a per-clause checklist
		// (the earlier binary meets_rubric grading flattened real quality gradients between two
		// responses to a single 0/1 -- see evaluators.ts). Optional: only incident-replay-dataset.ts
		// entries (real tickets) have a real report to compare against; the synthetic dataset.ts
		// examples have no source ticket and omit this.
		referenceReport?: string;
		// SIO-1374: per-datasource ground truth, backfilled from each real ticket's own "Findings
		// by Datasource" section. Keys are datasource ids (elastic, kafka, couchbase, gitlab, aws,
		// atlassian) matching expectedDatasources entries. Used by the per-datasource evidence
		// verdicts (evaluators.ts datasourceVerdicts) and the per-sub-agent judge, which need
		// datasource-level ground truth that referenceReport's Executive-Summary-only text does not
		// provide. Optional: only incident-replay-dataset.ts entries have per-datasource source
		// material; the synthetic dataset.ts examples omit this.
		referenceFindings?: { [datasource: string]: string };
	};
```

- [ ] **Step 2: Write a test confirming the field is optional and passes through**

Create `packages/agent/src/eval/dataset.test.ts`:

```ts
// packages/agent/src/eval/dataset.test.ts
import { describe, expect, test } from "bun:test";
import type { EvalExample } from "./dataset.ts";

describe("EvalExample.outputs.referenceFindings (SIO-1374)", () => {
	test("referenceFindings is optional and can be omitted", () => {
		const example: EvalExample = {
			inputs: { query: "test" },
			outputs: { expectedDatasources: [], minConfidence: 0.6, qualityRubric: "check X" },
		};
		expect(example.outputs.referenceFindings).toBeUndefined();
	});

	test("referenceFindings accepts a per-datasource string map", () => {
		const example: EvalExample = {
			inputs: { query: "test" },
			outputs: {
				expectedDatasources: ["elastic", "kafka"],
				minConfidence: 0.6,
				qualityRubric: "check X",
				referenceFindings: {
					elastic: "the deadlock exception chain",
					kafka: "the DLQ headers showing CHANNEL_CLOSED",
				},
			},
		};
		expect(example.outputs.referenceFindings?.elastic).toBe("the deadlock exception chain");
		expect(Object.keys(example.outputs.referenceFindings ?? {})).toHaveLength(2);
	});
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `bun test packages/agent/src/eval/dataset.test.ts`
Expected: PASS (this is a type-level addition; the test exists to pin the shape, not to catch a failure)

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/eval/dataset.ts packages/agent/src/eval/dataset.test.ts
git commit -m "SIO-1374: add referenceFindings to EvalExample.outputs schema"
```

---

### Task 2: Backfill `referenceFindings` for all 32 incident-replay entries

**Files:**
- Modify: `packages/agent/src/eval/incident-replay-dataset.ts` (all 32 entries, lines 41-642)

**Interfaces:**
- Consumes: `EvalExample.outputs.referenceFindings?: { [datasource: string]: string }` from Task 1.
- Produces: every entry's `outputs.referenceFindings` populated, keyed by each of that entry's `expectedDatasources` values. This is what Task 4 (judge schema) and Task 7 (sub-agent judge) read.

**This is the largest chunk of work in the ticket.** It is source-material work, not mechanical code — each of the 32 entries needs its ticket's "Findings by Datasource" (or equivalent per-datasource evidence section) read from the real DEVOPS ticket and condensed into one string per expected datasource, at the same "specific finding, not full ticket text" scope as the existing `referenceReport` field.

**Sourcing procedure per entry:**

1. The ticket ID is in the entry's leading comment (e.g. `// DEVOPS-1353 -- RECONSTRUCTED. ...` at `incident-replay-dataset.ts:42`). Fetch that ticket via the Atlassian MCP (`mcp__mcp-server-atlassian__atlassian_getJiraIssue` or `atlassian_search`, per `reference_session_gitlab_mcp_is_stdio_not_9084` / prior Atlassian MCP usage in this repo) or, if already open in a browser tab, read it directly.
2. Locate the ticket's per-datasource findings (the section the `referenceReport` Executive Summary was condensed from — usually titled "Findings by Datasource", "Investigation Findings", or organized as sub-headings per tool/datasource).
3. For each datasource in that entry's `expectedDatasources` array (see the exact list per entry below), extract ONLY the finding text specific to that datasource — one to three sentences naming the concrete evidence (the specific exception, metric, log pattern, or config finding attributed to that datasource), not the whole section verbatim.
4. If a ticket's own findings section does not break out a specific datasource that is nonetheless in `expectedDatasources`, use the most specific sentence(s) from `referenceReport` that describe what that datasource showed — do not leave the key absent, since the per-datasource judge needs a ground-truth string for every expected datasource to grade against, and an absent key silently makes that datasource ungraded (see Task 4/7's degrade-not-fail behavior — an absent key is a legitimate "no ground truth for this one," but should be a deliberate omission, not an oversight).

**Per-entry `expectedDatasources` list (exact keys required in each entry's `referenceFindings`):**

| Entry (ticket) | Line | `expectedDatasources` (the required `referenceFindings` keys) |
|---|---|---|
| DEVOPS-1353 | 41 | `couchbase`, `aws`, `atlassian` |
| DEVOPS-1355 | 61 | `kafka`, `aws`, `gitlab` |
| DEVOPS-1356 | 80 | `aws`, `kafka`, `couchbase` |
| DEVOPS-1375 | 100 | `couchbase`, `aws` |
| DEVOPS-1376 | 117 | `elastic`, `aws`, `gitlab` |
| DEVOPS-1380 | 137 | `elastic`, `aws`, `couchbase`, `kafka` |
| DEVOPS-1381 | 157 | `elastic`, `aws` |
| DEVOPS-1385 | 177 | `aws`, `kafka`, `couchbase`, `gitlab` |
| DEVOPS-1386 | 197 | `elastic`, `aws` |
| DEVOPS-1387 | 215 | `elastic`, `aws`, `gitlab`, `atlassian` |
| DEVOPS-1388 | 235 | `elastic`, `kafka` |
| DEVOPS-1389 | 253 | `elastic`, `aws`, `atlassian` |
| DEVOPS-1390 | 271 | `elastic`, `aws`, `couchbase` |
| DEVOPS-1391 | 290 | `elastic`, `aws` |
| DEVOPS-1395 | 310 | `elastic`, `aws`, `kafka` |
| DEVOPS-1392 | 330 | `aws`, `elastic` |
| DEVOPS-1393 | 349 | `elastic`, `kafka`, `aws`, `atlassian` |
| DEVOPS-1396 | 367 | `elastic`, `kafka`, `couchbase`, `aws` |
| DEVOPS-1397 | 387 | `elastic`, `kafka`, `couchbase`, `gitlab`, `atlassian`, `aws` |
| DEVOPS-1398 | 406 | `aws`, `elastic`, `atlassian` |
| DEVOPS-1399 | 424 | `elastic`, `aws`, `gitlab` |
| DEVOPS-1400 | 442 | `couchbase`, `elastic`, `kafka` |
| DEVOPS-1402 | 460 | `elastic`, `gitlab`, `aws` |
| DEVOPS-1403 | 479 | `couchbase`, `elastic`, `aws` |
| DEVOPS-1404 | 497 | `aws`, `couchbase`, `elastic` |
| DEVOPS-1405 | 515 | `aws`, `elastic`, `atlassian` |
| DEVOPS-1407 | 533 | `couchbase`, `aws`, `kafka`, `atlassian` |
| DEVOPS-1408 | 551 | `elastic`, `aws`, `couchbase`, `atlassian` |
| DEVOPS-1410 | 569 | `elastic`, `aws`, `couchbase`, `atlassian` |
| DEVOPS-1411 | 587 | `elastic`, `aws`, `couchbase`, `atlassian` |
| DEVOPS-1412 | 605 | `couchbase`, `elastic`, `aws` |
| DEVOPS-1413 | 623 | `couchbase`, `elastic`, `aws` |

**Example of the target shape**, added as a new field immediately after each entry's `referenceReport` (using DEVOPS-1353 as the worked example — read the real ticket to replace this illustrative text with the ticket's actual per-datasource findings before landing):

```ts
outputs: {
	expectedDatasources: ["couchbase", "aws", "atlassian"],
	minConfidence: 0.6,
	qualityRubric: "Response should identify this as a client-side network/connectivity failure ...",
	referenceReport: "Executive Summary (DEVOPS-1353): pvh-services-styles-v3 is throwing ...",
	referenceFindings: {
		couchbase: "Cluster fully healthy: 12/12 nodes healthy, zero fatal N1QL requests, low CPU and memory pressure -- rules out a Couchbase server-side fault.",
		aws: "ECS security group sg-0aaaaaaaaaaaaaaaa (styles-v3-service-ecs-sg) has never been added to the inbound allowlist of the Couchbase Capella private endpoint's security group -- the primary root-cause hypothesis (confidence 0.82).",
		atlassian: "No prior related incident found on this endpoint at the time of this ticket (this later became the first in a recurring series -- DEVOPS-1375, 1407, 1412, 1413).",
	},
},
```

- [ ] **Step 1: Fetch and read all 32 source tickets**

For each of the 32 tickets listed in the table above, fetch via Atlassian MCP or existing open context. Do this in batches to manage context (e.g. 8 tickets at a time), extracting the per-datasource findings text for each.

- [ ] **Step 2: Add `referenceFindings` to each of the 32 entries in `incident-replay-dataset.ts`**

For each entry, insert the `referenceFindings` field (with real, ticket-sourced text) immediately after that entry's `referenceReport` field, using exactly the keys listed in the table above for that entry — no more, no fewer.

- [ ] **Step 3: Verify every entry has a `referenceFindings` key for every `expectedDatasources` value**

Run this check script to confirm no entry is missing a required key:

```bash
bun -e '
import { INCIDENT_REPLAY_DATASET } from "./packages/agent/src/eval/incident-replay-dataset.ts";
let problems = 0;
for (const [i, ex] of INCIDENT_REPLAY_DATASET.entries()) {
  const rf = ex.outputs.referenceFindings ?? {};
  for (const ds of ex.outputs.expectedDatasources) {
    if (!rf[ds]) {
      console.log(`entry ${i}: missing referenceFindings.${ds}`);
      problems++;
    }
  }
}
console.log(problems === 0 ? "OK: all entries have referenceFindings for every expectedDatasources key" : `${problems} missing keys`);
'
```

Expected: `OK: all entries have referenceFindings for every expectedDatasources key`. If any are deliberately omitted per the sourcing procedure's step 4 exception, confirm that omission was a deliberate choice (ticket genuinely has no datasource-specific findings for that source) and not an oversight, then re-run to confirm the remaining count is expected.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/eval/incident-replay-dataset.ts
git commit -m "SIO-1374: backfill referenceFindings across all 32 incident-replay entries"
```

---

### Task 3: Extend `HolisticGradeSchema` with `datasourceVerdicts`

**Files:**
- Modify: `packages/agent/src/eval/evaluators.ts:17-33`
- Test: `packages/agent/src/eval/evaluators.test.ts`

**Interfaces:**
- Consumes: nothing new from other tasks (schema-only change).
- Produces: `HolisticGradeSchema` parses an optional `datasourceVerdicts: { [datasource: string]: { verdict: "found"|"partial"|"missed", gapsHonest: boolean, fabricated: boolean } }`. `DatasourceVerdict` type exported. Consumed by Task 4 (`judgeFeedback` extension) and Task 5 (prompt asks the judge to populate it).

- [ ] **Step 1: Write the failing test**

Add to `packages/agent/src/eval/evaluators.test.ts`, after the existing `describe("HolisticGradeSchema rootCauseMatch tolerance (SIO-1372)", ...)` block:

```ts
describe("HolisticGradeSchema datasourceVerdicts (SIO-1374)", () => {
	test("datasourceVerdicts is optional and can be omitted", () => {
		const grade = HolisticGradeSchema.parse({ score: 7, rootCauseMatch: "correct", reasoning: "x" });
		expect(grade.datasourceVerdicts).toBeUndefined();
	});

	test("a well-formed datasourceVerdicts map parses through untouched", () => {
		const grade = HolisticGradeSchema.parse({
			score: 7,
			rootCauseMatch: "correct",
			reasoning: "x",
			datasourceVerdicts: {
				elastic: { verdict: "found", gapsHonest: true, fabricated: false },
				kafka: { verdict: "missed", gapsHonest: true, fabricated: false },
			},
		});
		expect(grade.datasourceVerdicts?.elastic).toEqual({ verdict: "found", gapsHonest: true, fabricated: false });
		expect(grade.datasourceVerdicts?.kafka.verdict).toBe("missed");
	});

	test("a bogus verdict enum value in one datasource degrades that entry only, does not fail the whole map", () => {
		const grade = HolisticGradeSchema.parse({
			score: 7,
			rootCauseMatch: "correct",
			reasoning: "x",
			datasourceVerdicts: {
				elastic: { verdict: "somewhat", gapsHonest: true, fabricated: false },
				kafka: { verdict: "found", gapsHonest: true, fabricated: false },
			},
		});
		expect(grade.datasourceVerdicts?.elastic.verdict).toBe("missed");
		expect(grade.datasourceVerdicts?.kafka.verdict).toBe("found");
	});

	test("missing gapsHonest/fabricated booleans degrade to false, not a parse failure", () => {
		const grade = HolisticGradeSchema.parse({
			score: 7,
			rootCauseMatch: "correct",
			reasoning: "x",
			datasourceVerdicts: { elastic: { verdict: "found" } },
		});
		expect(grade.datasourceVerdicts?.elastic).toEqual({ verdict: "found", gapsHonest: false, fabricated: false });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/agent/src/eval/evaluators.test.ts -t "datasourceVerdicts"`
Expected: FAIL — `datasourceVerdicts` does not exist on `HolisticGradeSchema`

- [ ] **Step 3: Extend the schema**

Edit `packages/agent/src/eval/evaluators.ts`. Add a new schema and field, right after the `HolisticGradeSchema` closing (before line 30's closing `});`, extend the object passed to `z.object`:

```ts
export const DatasourceVerdictSchema = z.object({
	verdict: z.enum(["found", "partial", "missed"]).catch("missed"),
	// SIO-1374: folded in from the section-judging idea rather than a separate graded pass --
	// see the design doc's non-goal on section-by-section grading. Missing/malformed booleans
	// degrade to false (not honest / not fabricated) rather than failing the entry, same
	// tolerance philosophy as the rest of this schema.
	gapsHonest: z.boolean().catch(false),
	fabricated: z.boolean().catch(false),
});
export type DatasourceVerdict = z.output<typeof DatasourceVerdictSchema>;

export const HolisticGradeSchema = z.object({
	score: z
		.number()
		.nullish()
		.transform((v) => (v === null || v === undefined ? 1 : Math.min(10, Math.max(1, Math.round(v))))),
	rootCauseMatch: z.enum(["correct", "partial", "incorrect", "not_determinable"]).catch("not_determinable"),
	// SIO-1374: for each expected datasource, did the response surface the evidence the real
	// ticket's referenceFindings says that datasource showed? Optional -- a judge response for
	// an example with no referenceFindings, or one that omits this field entirely, must not fail
	// the example (same graceful-degradation contract as rootCauseMatch). A per-key .catch()
	// on DatasourceVerdictSchema means one malformed datasource entry degrades only that key.
	datasourceVerdicts: z.record(z.string(), DatasourceVerdictSchema).optional(),
	reasoning: z
		.union([z.string(), z.number(), z.null()])
		.optional()
		.transform((v) => (v === null || v === undefined ? "" : String(v))),
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/agent/src/eval/evaluators.test.ts -t "datasourceVerdicts"`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full existing evaluators test suite to confirm no regression**

Run: `bun test packages/agent/src/eval/evaluators.test.ts`
Expected: all existing tests (root-cause cap, squareVerdictWithReference, judgeFeedback) still PASS unmodified

- [ ] **Step 6: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/eval/evaluators.ts packages/agent/src/eval/evaluators.test.ts
git commit -m "SIO-1374: add datasourceVerdicts to HolisticGradeSchema"
```

---

### Task 4: Emit per-datasource `evidence_<datasource>` LangSmith feedback keys

**Files:**
- Modify: `packages/agent/src/eval/evaluators.ts` (the `judgeFeedback` function, current lines 67-86)
- Test: `packages/agent/src/eval/evaluators.test.ts`

**Interfaces:**
- Consumes: `HolisticGrade.datasourceVerdicts` from Task 3.
- Produces: `judgeFeedback(grade: HolisticGrade)` returns additional `{ key: "evidence_<datasource>", score: number, comment: string }[]` entries when `datasourceVerdicts` is present. Consumed by `responseQualityJudge`'s return (no signature change needed there — `judgeFeedback`'s return array already flows straight through).

- [ ] **Step 1: Write the failing test**

Add to `packages/agent/src/eval/evaluators.test.ts`, inside (or after) the existing `describe("judgeFeedback (SIO-1372)", ...)` block:

```ts
describe("judgeFeedback datasourceVerdicts (SIO-1374)", () => {
	test("no datasourceVerdicts: no evidence_ keys emitted, existing keys unaffected", () => {
		const fb = judgeFeedback({ score: 8, rootCauseMatch: "correct", reasoning: "x" });
		expect(fb.some((f) => f.key.startsWith("evidence_"))).toBe(false);
		expect(fb).toHaveLength(2);
	});

	test("one evidence_<datasource> key per datasource in datasourceVerdicts", () => {
		const fb = judgeFeedback({
			score: 8,
			rootCauseMatch: "correct",
			reasoning: "x",
			datasourceVerdicts: {
				elastic: { verdict: "found", gapsHonest: true, fabricated: false },
				kafka: { verdict: "missed", gapsHonest: true, fabricated: false },
			},
		});
		const elastic = fb.find((f) => f.key === "evidence_elastic");
		const kafka = fb.find((f) => f.key === "evidence_kafka");
		expect(elastic?.score).toBe(1);
		expect(kafka?.score).toBe(0);
	});

	test("partial verdict scores 0.5", () => {
		const fb = judgeFeedback({
			score: 8,
			rootCauseMatch: "correct",
			reasoning: "x",
			datasourceVerdicts: { aws: { verdict: "partial", gapsHonest: false, fabricated: false } },
		});
		expect(fb.find((f) => f.key === "evidence_aws")?.score).toBe(0.5);
	});

	test("comment includes gapsHonest and fabricated flags", () => {
		const fb = judgeFeedback({
			score: 8,
			rootCauseMatch: "correct",
			reasoning: "x",
			datasourceVerdicts: { aws: { verdict: "found", gapsHonest: false, fabricated: true } },
		});
		const aws = fb.find((f) => f.key === "evidence_aws");
		expect(aws?.comment).toContain("gapsHonest=false");
		expect(aws?.comment).toContain("fabricated=true");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/agent/src/eval/evaluators.test.ts -t "judgeFeedback datasourceVerdicts"`
Expected: FAIL — no `evidence_` keys are emitted yet

- [ ] **Step 3: Extend `judgeFeedback`**

Edit `packages/agent/src/eval/evaluators.ts`, replacing the current `judgeFeedback` function (lines 67-86):

```ts
// Pure mapping from a parsed grade to LangSmith feedback entries, split out so the cap and the
// not_determinable omission are unit-testable without an OpenAI call. not_determinable emits NO
// root_cause_accuracy entry: the synthetic dataset.ts examples have no referenceReport to be
// right or wrong against, and a placeholder score would pollute the metric's average in the
// LangSmith Compare view.
export function judgeFeedback(grade: HolisticGrade): { key: string; score: number; comment: string }[] {
	const capped = applyRootCauseCap(grade.score, grade.rootCauseMatch);
	const capNote = capped < grade.score ? ` (capped from ${grade.score}/10: root cause ${grade.rootCauseMatch})` : "";
	const quality = {
		key: "response_quality",
		// SIO-1372: score is 1-10 from the judge; LangSmith feedback scores are conventionally
		// 0-1, so normalize here rather than changing every downstream consumer's expectation.
		score: (capped - 1) / 9,
		comment: `${capped}/10${capNote} -- rootCauseMatch=${grade.rootCauseMatch} -- ${grade.reasoning}`,
	};
	const feedback: { key: string; score: number; comment: string }[] = [quality];
	if (grade.rootCauseMatch !== "not_determinable") {
		feedback.push({
			key: "root_cause_accuracy",
			score: grade.rootCauseMatch === "correct" ? 1 : grade.rootCauseMatch === "partial" ? 0.5 : 0,
			comment: `rootCauseMatch=${grade.rootCauseMatch} -- ${grade.reasoning}`,
		});
	}
	// SIO-1374: one evidence_<datasource> key per datasource the judge scored, so LangSmith
	// Compare can filter per-datasource weaknesses across A/B legs (e.g. "haiku's gitlab
	// evidence is systematically weak") instead of only seeing one aggregate score.
	for (const [datasource, v] of Object.entries(grade.datasourceVerdicts ?? {})) {
		feedback.push({
			key: `evidence_${datasource}`,
			score: v.verdict === "found" ? 1 : v.verdict === "partial" ? 0.5 : 0,
			comment: `verdict=${v.verdict} gapsHonest=${v.gapsHonest} fabricated=${v.fabricated}`,
		});
	}
	return feedback;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/agent/src/eval/evaluators.test.ts -t "judgeFeedback datasourceVerdicts"`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full evaluators test suite**

Run: `bun test packages/agent/src/eval/evaluators.test.ts`
Expected: all tests PASS, including the pre-existing `judgeFeedback (SIO-1372)` block unmodified (note: the refactor from `if (grade.rootCauseMatch === "not_determinable") return [quality]; return [quality, {...}];` to a mutable array must preserve identical behavior — the `"not_determinable emits ONLY response_quality"` test at `evaluators.test.ts:123` must still pass with exactly length 1)

- [ ] **Step 6: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/eval/evaluators.ts packages/agent/src/eval/evaluators.test.ts
git commit -m "SIO-1374: emit evidence_<datasource> LangSmith feedback keys"
```

---

### Task 5: Update the judge prompt — datasourceVerdicts instructions + era-drift fix

**Files:**
- Modify: `packages/agent/src/eval/evaluators.ts` (`HOLISTIC_JUDGE_SYSTEM_PROMPT`, current lines 128-143; `responseQualityJudge`'s `userContent` construction, current lines 163-165)
- Test: `packages/agent/src/eval/evaluators.test.ts` (prompt-content assertions only — no network)

**Interfaces:**
- Consumes: `ExampleOutputsSchema` needs `referenceFindings` added (Task 1's dataset field must reach the judge call) so the prompt can pass per-datasource ground truth to the judge.
- Produces: `HOLISTIC_JUDGE_SYSTEM_PROMPT` (string, unchanged export shape) with two additions: the era-drift instruction and the `datasourceVerdicts` output-format instruction. `ExampleOutputsSchema` gains `referenceFindings` field.

- [ ] **Step 1: Extend `ExampleOutputsSchema` to include `referenceFindings`**

Edit `packages/agent/src/eval/evaluators.ts`, in `ExampleOutputsSchema` (current lines 150-153):

```ts
export const ExampleOutputsSchema = z.object({
	qualityRubric: z.string().trim().min(1),
	referenceReport: z.string().trim().min(1).optional(),
	// SIO-1374: per-datasource ground truth passed to the judge alongside referenceReport, so it
	// can populate datasourceVerdicts against real per-datasource evidence rather than inferring
	// it from the Executive-Summary-only referenceReport text.
	referenceFindings: z.record(z.string(), z.string().trim().min(1)).optional(),
});
```

- [ ] **Step 2: Write a failing test pinning the new prompt content**

Add to `packages/agent/src/eval/evaluators.test.ts` (needs a new import of the prompt constant — it is not currently exported, so export it first as part of this step):

```ts
describe("HOLISTIC_JUDGE_SYSTEM_PROMPT content (SIO-1374)", () => {
	test("instructs era-drift observations to be classified as outside-window, not fabrication", () => {
		expect(HOLISTIC_JUDGE_SYSTEM_PROMPT).toContain("outside the reference window");
		expect(HOLISTIC_JUDGE_SYSTEM_PROMPT.toLowerCase()).toContain("recurrence window");
	});

	test("instructs the judge to populate datasourceVerdicts with gapsHonest and fabricated flags", () => {
		expect(HOLISTIC_JUDGE_SYSTEM_PROMPT).toContain("datasourceVerdicts");
		expect(HOLISTIC_JUDGE_SYSTEM_PROMPT).toContain("gapsHonest");
		expect(HOLISTIC_JUDGE_SYSTEM_PROMPT).toContain("fabricated");
	});
});
```

Add `HOLISTIC_JUDGE_SYSTEM_PROMPT` to the existing import block at the top of `evaluators.test.ts`:

```ts
import {
	applyRootCauseCap,
	ExampleOutputsSchema,
	HolisticGradeSchema,
	HOLISTIC_JUDGE_SYSTEM_PROMPT,
	judgeFeedback,
	squareVerdictWithReference,
} from "./evaluators.ts";
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test packages/agent/src/eval/evaluators.test.ts -t "HOLISTIC_JUDGE_SYSTEM_PROMPT content"`
Expected: FAIL — `HOLISTIC_JUDGE_SYSTEM_PROMPT` is not currently exported (compile error) and does not yet contain the new instructions

- [ ] **Step 4: Export the prompt constant and extend it**

Edit `packages/agent/src/eval/evaluators.ts`: change `const HOLISTIC_JUDGE_SYSTEM_PROMPT = [` to `export const HOLISTIC_JUDGE_SYSTEM_PROMPT = [` (current line 128), and add two new lines to the array before the closing `'Respond with JSON: ...'` line (current line 142):

```ts
export const HOLISTIC_JUDGE_SYSTEM_PROMPT = [
	"You are an experienced incident-response reviewer grading an AI agent's investigation report against the real, human-curated investigation of the same incident.",
	"You will be given: the real incident's own report (written by a human analyst reviewing the actual production investigation), a rubric describing what a thorough answer for this specific incident should cover, per-datasource ground-truth findings when available, and the AI agent's response to grade.",
	"FIRST, before scoring anything else, determine whether the AI response's stated root cause matches the real report's root cause: 'correct' means it names the same specific mechanism/cause the real report identified; 'partial' means it lands in the right general category (e.g. both agree the driver is automated/internal/bulk traffic) but never names the specific mechanism the real report identified; 'incorrect' means it names a different or contradictory cause, or commits to no cause at all where the real report identified one; 'not_determinable' means no real report was provided to compare against.",
	"A thorough, well-organized response whose named cause is wrong is still a wrong answer -- do not let fluency, formatting, or investigative breadth pull the verdict toward 'correct'.",
	// SIO-1374 (audit example #8, DEVOPS-1386): live replays investigate CURRENT systems, so the
	// AI response may truthfully describe a live recurrence window with additional co-occurring
	// symptoms that the reference report's frozen era does not mention -- these must be classified
	// as observations "outside the reference window", NOT as fabrication, and must not by
	// themselves pull the root-cause verdict toward 'incorrect'. Judge the root-cause verdict on
	// mechanism category and naming as usual; only assertions that actively contradict the
	// reference report's own findings, or invent specifics with no supporting evidence, count as
	// fabrication.",
	"A response may describe a live recurrence window with additional co-occurring symptoms not present in the reference report's era -- classify such observations as 'outside the reference window', not as fabrication, and continue judging the root-cause verdict on mechanism category and naming as usual.",
	"Only after fixing that verdict, grade holistically, not as a checklist: judge overall investigative quality, evidence quality (specific, concrete findings vs vague assertions), and appropriate honesty about gaps/limitations -- the same way you would compare two colleagues' incident write-ups.",
	"A response that reaches the same substantive conclusion as the real report, with strong supporting evidence, should score highly even if it misses a minor rubric clause or a small point the real report happened to also make.",
	"A response that is vague, reaches the wrong conclusion, fabricates unsupported specifics, or omits a major finding the real report considered central should score low.",
	"Score on a 1-10 scale: 9-10 exceptional (matches or exceeds the real report's rigor), 7-8 solid (correct conclusion, good evidence, minor gaps), 5-6 mediocre (partially correct or thin evidence), 3-4 weak (misses the real root cause or is mostly vague), 1-2 poor (wrong, fabricated, or substantively empty).",
	// SIO-1374: per-datasource verdicts, folded gaps-honesty and fabrication checks in as extra
	// fields per datasource (not a separate graded section -- see the design doc's non-goal on
	// section-by-section grading, which would re-measure pipeline-enforced formatting instead of
	// evidence quality).
	"If per-datasource ground-truth findings are provided, ALSO determine, for each datasource named in the ground truth: whether the response surfaced that datasource's specific evidence ('found'), surfaced some but missed the key specific detail ('partial'), or did not surface it at all ('missed'); whether the response was honest about gaps for that datasource (gapsHonest: true if it did not overclaim confidence where the ground truth shows a gap, or if there was no gap to admit; false if it overclaimed); and whether the response fabricated a specific finding for that datasource unsupported by the ground truth (fabricated: true/false). Do not penalize truthful recurrence-window observations (see above) as fabrication.",
	'Respond with JSON: {"rootCauseMatch": "correct" | "partial" | "incorrect" | "not_determinable", "score": number (1-10), "datasourceVerdicts": { "<datasource>": { "verdict": "found" | "partial" | "missed", "gapsHonest": boolean, "fabricated": boolean }, ... } (omit entirely if no per-datasource ground truth was provided), "reasoning": string (2-4 sentences: first justify the rootCauseMatch verdict, then explain the score, then briefly note any datasourceVerdicts of note)}',
].join(" ");
```

- [ ] **Step 5: Update `responseQualityJudge`'s `userContent` construction to pass `referenceFindings`**

Edit `packages/agent/src/eval/evaluators.ts`, the `responseQualityJudge` function (current lines 155-165). Replace the destructure and `userContent` construction:

```ts
	const { qualityRubric: rubric, referenceReport, referenceFindings } = parsedOutputs.data;
	const openai = new OpenAI();
	const findingsBlock = referenceFindings
		? `\n\nPer-datasource ground-truth findings (what the real investigation found from each source):\n${Object.entries(
				referenceFindings,
			)
				.map(([ds, text]) => `- ${ds}: ${text}`)
				.join("\n")}`
		: "";
	const userContent = referenceReport
		? `Real incident report (written by a human analyst, the ground truth for this incident):\n${referenceReport}${findingsBlock}\n\nRubric (what a thorough answer for this incident should cover):\n${rubric}\n\nAI agent's response to grade:\n${response}\n\nScore the AI agent's response 1-10 by comparing it holistically to the real report and rubric above.${referenceFindings ? " Also populate datasourceVerdicts for each ground-truth datasource listed above." : ""}`
		: `Rubric (what a thorough answer for this incident should cover -- no real incident report is available for this synthetic example, grade against the rubric alone):\n${rubric}\n\nResponse to grade:\n${response}\n\nScore the response 1-10 against the rubric.`;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test packages/agent/src/eval/evaluators.test.ts -t "HOLISTIC_JUDGE_SYSTEM_PROMPT content"`
Expected: PASS (2 tests)

- [ ] **Step 7: Run the full evaluators test suite**

Run: `bun test packages/agent/src/eval/evaluators.test.ts`
Expected: all tests PASS

- [ ] **Step 8: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add packages/agent/src/eval/evaluators.ts packages/agent/src/eval/evaluators.test.ts
git commit -m "SIO-1374: era-drift prompt fix + datasourceVerdicts judge instructions"
```

---

### Task 6: `buildSubagentReports` helper — serialize per-datasource `*Findings` for grading

**Files:**
- Create: `packages/agent/src/eval/subagent-reports.ts`
- Create: `packages/agent/src/eval/subagent-reports.test.ts`

**Interfaces:**
- Consumes: `DataSourceResult` type from `packages/shared/src/agent-state.ts:447-474` (fields used: `dataSourceId`, `deploymentId`, `elasticFindings`, `kafkaFindings`, `couchbaseFindings`, `gitlabFindings`, `awsFindings`, `atlassianFindings`).
- Produces: `buildSubagentReports(results: DataSourceResult[]): { [dataSourceId: string]: string }` — consumed by Task 8 (`run-function.ts`) and Task 9 (the sub-agent judge).

- [ ] **Step 1: Write the failing test**

Create `packages/agent/src/eval/subagent-reports.test.ts`:

```ts
// packages/agent/src/eval/subagent-reports.test.ts
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { buildSubagentReports } from "./subagent-reports.ts";

function result(overrides: Partial<DataSourceResult>): DataSourceResult {
	return { dataSourceId: "elastic", status: "success", ...overrides };
}

describe("buildSubagentReports (SIO-1374)", () => {
	test("empty results produce an empty map", () => {
		expect(buildSubagentReports([])).toEqual({});
	});

	test("a result with no *Findings field produces no entry for that datasource", () => {
		const map = buildSubagentReports([result({ dataSourceId: "gitlab" })]);
		expect(map.gitlab).toBeUndefined();
	});

	test("serializes elasticFindings under the elastic key", () => {
		const map = buildSubagentReports([
			result({ dataSourceId: "elastic", elasticFindings: { errorRate: 0.42 } as never }),
		]);
		expect(map.elastic).toBe(JSON.stringify({ errorRate: 0.42 }));
	});

	test("serializes each of the six datasource Findings fields under its own key", () => {
		const results: DataSourceResult[] = [
			result({ dataSourceId: "elastic", elasticFindings: { a: 1 } as never }),
			result({ dataSourceId: "kafka", kafkaFindings: { b: 2 } as never }),
			result({ dataSourceId: "couchbase", couchbaseFindings: { c: 3 } as never }),
			result({ dataSourceId: "gitlab", gitlabFindings: { d: 4 } as never }),
			result({ dataSourceId: "aws", awsFindings: { e: 5 } as never }),
			result({ dataSourceId: "atlassian", atlassianFindings: { f: 6 } as never }),
		];
		const map = buildSubagentReports(results);
		expect(map.elastic).toBe(JSON.stringify({ a: 1 }));
		expect(map.kafka).toBe(JSON.stringify({ b: 2 }));
		expect(map.couchbase).toBe(JSON.stringify({ c: 3 }));
		expect(map.gitlab).toBe(JSON.stringify({ d: 4 }));
		expect(map.aws).toBe(JSON.stringify({ e: 5 }));
		expect(map.atlassian).toBe(JSON.stringify({ f: 6 }));
	});

	test("multiple deployments of the same datasource (e.g. elastic across estates) merge into one entry keyed by dataSourceId", () => {
		const results: DataSourceResult[] = [
			result({ dataSourceId: "elastic", deploymentId: "eu-b2b", elasticFindings: { a: 1 } as never }),
			result({ dataSourceId: "elastic", deploymentId: "us-cld", elasticFindings: { a: 2 } as never }),
		];
		const map = buildSubagentReports(results);
		// Both deployments' findings appear -- concatenated, not overwritten -- so the judge sees
		// evidence from every deployment this sub-agent's model was responsible for.
		expect(map.elastic).toContain(JSON.stringify({ a: 1 }));
		expect(map.elastic).toContain(JSON.stringify({ a: 2 }));
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/agent/src/eval/subagent-reports.test.ts`
Expected: FAIL — `packages/agent/src/eval/subagent-reports.ts` does not exist

- [ ] **Step 3: Implement `buildSubagentReports`**

Create `packages/agent/src/eval/subagent-reports.ts`:

```ts
// packages/agent/src/eval/subagent-reports.ts
import type { DataSourceResult } from "@devops-agent/shared";

// SIO-1374: DataSourceResult has no plain-text report field -- only the typed per-datasource
// *Findings objects (kafkaFindings, elasticFindings, etc.) and opaque toolOutputs[].rawJson. The
// per-sub-agent judge grades the serialized *Findings object as that datasource's "report": it is
// the sub-agent's own synthesized conclusion, uninfluenced by the aggregator, and the types
// already exist -- see docs/superpowers/specs/2026-08-04-per-datasource-evidence-judging-design.md.
// Mirrors the keyed [name, value] lookup pattern in absence-judge.ts:133-143.
const FINDINGS_FIELD_BY_DATASOURCE: Record<string, keyof DataSourceResult> = {
	elastic: "elasticFindings",
	kafka: "kafkaFindings",
	couchbase: "couchbaseFindings",
	gitlab: "gitlabFindings",
	aws: "awsFindings",
	atlassian: "atlassianFindings",
};

// Builds one serialized "report" string per datasource id from that datasource's structured
// findings across every DataSourceResult entry (a datasource can appear multiple times when the
// sub-agent fanned out across deployments/estates, e.g. elastic across eu-b2b and us-cld). Entries
// with no matching *Findings field are omitted, not padded with an empty string, so the judge can
// distinguish "this datasource genuinely produced nothing" the same way it would for a human
// report with a blank section -- an absent key, not a misleadingly present empty one.
export function buildSubagentReports(results: DataSourceResult[]): { [dataSourceId: string]: string } {
	const byDatasource = new Map<string, string[]>();
	for (const result of results) {
		const field = FINDINGS_FIELD_BY_DATASOURCE[result.dataSourceId];
		if (!field) continue;
		const findings = result[field];
		if (findings == null) continue;
		const serialized = JSON.stringify(findings);
		const existing = byDatasource.get(result.dataSourceId) ?? [];
		existing.push(serialized);
		byDatasource.set(result.dataSourceId, existing);
	}
	const report: { [dataSourceId: string]: string } = {};
	for (const [dataSourceId, parts] of byDatasource) {
		report[dataSourceId] = parts.join("\n");
	}
	return report;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/agent/src/eval/subagent-reports.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/eval/subagent-reports.ts packages/agent/src/eval/subagent-reports.test.ts
git commit -m "SIO-1374: add buildSubagentReports helper"
```

---

### Task 7: Sub-agent judge — `judgeSubagentReports`

**Files:**
- Modify: `packages/agent/src/eval/evaluators.ts` (new function, new schema)
- Test: `packages/agent/src/eval/evaluators.test.ts`

**Interfaces:**
- Consumes: `{ [dataSourceId: string]: string }` (sub-agent reports, shape from Task 6's `buildSubagentReports`), `{ [datasource: string]: string }` (`referenceFindings`, shape from Task 1).
- Produces: `SubagentGradeSchema` (exported Zod schema), `judgeSubagentReports(subagentReports: { [k: string]: string }, referenceFindings: { [k: string]: string }): Promise<{ key: string; score: number; comment: string }[]>` — emits `subagent_accuracy_<datasource>` feedback entries. Called from the eval run harness (wiring into the LangSmith evaluator registration is Task 10).

- [ ] **Step 1: Write the failing test for the pure mapping logic**

Add to `packages/agent/src/eval/evaluators.test.ts`:

```ts
describe("SubagentGradeSchema (SIO-1374)", () => {
	test("parses a well-formed per-datasource accuracy map", () => {
		const grade = SubagentGradeSchema.parse({
			datasourceAccuracy: {
				elastic: { accuracy: "correct", reasoning: "matched the deadlock chain" },
				kafka: { accuracy: "missing", reasoning: "no DLQ evidence surfaced" },
			},
		});
		expect(grade.datasourceAccuracy.elastic.accuracy).toBe("correct");
		expect(grade.datasourceAccuracy.kafka.accuracy).toBe("missing");
	});

	test("a bogus accuracy enum value degrades that entry to incorrect, not a parse failure", () => {
		const grade = SubagentGradeSchema.parse({
			datasourceAccuracy: { elastic: { accuracy: "sort of", reasoning: "x" } },
		});
		expect(grade.datasourceAccuracy.elastic.accuracy).toBe("incorrect");
	});

	test("missing datasourceAccuracy degrades to an empty object, not a parse failure", () => {
		const grade = SubagentGradeSchema.parse({});
		expect(grade.datasourceAccuracy).toEqual({});
	});
});

describe("subagentJudgeFeedback (SIO-1374)", () => {
	test("emits one subagent_accuracy_<datasource> key per graded datasource", () => {
		const fb = subagentJudgeFeedback({
			datasourceAccuracy: {
				elastic: { accuracy: "correct", reasoning: "matched" },
				kafka: { accuracy: "partial", reasoning: "half right" },
				aws: { accuracy: "missing", reasoning: "nothing surfaced" },
				gitlab: { accuracy: "incorrect", reasoning: "wrong conclusion" },
			},
		});
		expect(fb.find((f) => f.key === "subagent_accuracy_elastic")?.score).toBe(1);
		expect(fb.find((f) => f.key === "subagent_accuracy_kafka")?.score).toBe(0.5);
		expect(fb.find((f) => f.key === "subagent_accuracy_aws")?.score).toBe(0);
		expect(fb.find((f) => f.key === "subagent_accuracy_incorrect")).toBeUndefined();
		expect(fb.find((f) => f.key === "subagent_accuracy_gitlab")?.score).toBe(0);
	});

	test("empty datasourceAccuracy emits no feedback entries", () => {
		expect(subagentJudgeFeedback({ datasourceAccuracy: {} })).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/agent/src/eval/evaluators.test.ts -t "SubagentGradeSchema"`
Expected: FAIL — `SubagentGradeSchema` and `subagentJudgeFeedback` do not exist

- [ ] **Step 3: Implement the schema and pure feedback mapper**

Add to `packages/agent/src/eval/evaluators.ts`, after the `judgeFeedback` function from Task 4:

```ts
// SIO-1374: the per-sub-agent judge, grading each datasource's serialized *Findings object
// (buildSubagentReports) against referenceFindings, isolating the variable under test (sub-agent
// model) from the constant (Sonnet 5 aggregator prose) -- the measurement gap this ticket exists
// to close. A separate schema/prompt/call from the holistic judge: it grades raw sub-agent
// findings, not the aggregator's final response text.
export const SubagentGradeSchema = z.object({
	datasourceAccuracy: z
		.record(
			z.string(),
			z.object({
				accuracy: z.enum(["correct", "partial", "missing", "incorrect"]).catch("incorrect"),
				reasoning: z
					.union([z.string(), z.number(), z.null()])
					.optional()
					.transform((v) => (v === null || v === undefined ? "" : String(v))),
			}),
		)
		.catch({}),
});
export type SubagentGrade = z.output<typeof SubagentGradeSchema>;

// Pure mapping, unit-testable without an OpenAI call, same split as judgeFeedback.
export function subagentJudgeFeedback(grade: SubagentGrade): { key: string; score: number; comment: string }[] {
	return Object.entries(grade.datasourceAccuracy).map(([datasource, v]) => ({
		key: `subagent_accuracy_${datasource}`,
		score: v.accuracy === "correct" ? 1 : v.accuracy === "partial" ? 0.5 : 0,
		comment: `accuracy=${v.accuracy} -- ${v.reasoning}`,
	}));
}

const SUBAGENT_JUDGE_SYSTEM_PROMPT = [
	"You are grading raw sub-agent investigation findings (structured data one specialist tool-using agent produced for one datasource) against the real, human-curated ticket's own per-datasource findings for the same incident.",
	"You will be given, for each datasource: the sub-agent's own serialized findings (raw JSON, not prose -- do not penalize formatting or lack of narrative), and the real ticket's ground-truth finding for that same datasource.",
	"For EACH datasource provided, determine: 'correct' if the sub-agent's findings contain the same specific evidence/conclusion the ground truth describes; 'partial' if it contains related but incomplete or less specific evidence; 'missing' if the sub-agent produced no findings, or findings with no bearing on the ground truth, for that datasource; 'incorrect' if the sub-agent's findings actively contradict the ground truth.",
	"Grade each datasource independently -- do not let a strong result on one datasource influence the verdict on another.",
	'Respond with JSON: {"datasourceAccuracy": { "<datasource>": { "accuracy": "correct" | "partial" | "missing" | "incorrect", "reasoning": string (1-2 sentences) }, ... }}',
].join(" ");

// Batches every datasource's sub-agent report + reference finding into ONE OpenAI call per
// example (not one call per datasource) to keep cost trivial on gpt-4o-mini -- SIO-1374 design
// doc's ~$1-2/32-example-leg target. Only datasources present in BOTH maps are graded: a
// datasource missing from referenceFindings has no ground truth to grade against (see Task 2's
// deliberate-omission note), and a datasource missing from subagentReports produced no evidence
// to grade, which is exactly a "missing" verdict, but that requires an existing referenceFindings
// entry to be meaningful -- so the judge is only asked about datasources it can actually assess.
export async function judgeSubagentReports(
	subagentReports: { [dataSourceId: string]: string },
	referenceFindings: { [datasource: string]: string },
): Promise<{ key: string; score: number; comment: string }[]> {
	const datasources = Object.keys(referenceFindings);
	if (datasources.length === 0) return [];
	const openai = new OpenAI();
	const userContent = datasources
		.map((ds) => {
			const report = subagentReports[ds] ?? "(no findings produced by the sub-agent for this datasource)";
			return `Datasource: ${ds}\nSub-agent's raw findings:\n${report}\nGround truth (from the real ticket):\n${referenceFindings[ds]}`;
		})
		.join("\n\n");
	const r = await openai.chat.completions.create({
		model: "gpt-4o-mini",
		temperature: 0,
		response_format: { type: "json_object" },
		messages: [
			{ role: "system", content: SUBAGENT_JUDGE_SYSTEM_PROMPT },
			{ role: "user", content: userContent },
		],
	});
	const grade = parseLlmJson(r.choices[0]?.message?.content ?? "", SubagentGradeSchema);
	if (!grade.ok) return [];
	return subagentJudgeFeedback(grade.data);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/agent/src/eval/evaluators.test.ts -t "SubagentGradeSchema"`
Run: `bun test packages/agent/src/eval/evaluators.test.ts -t "subagentJudgeFeedback"`
Expected: both PASS

- [ ] **Step 5: Run the full evaluators test suite**

Run: `bun test packages/agent/src/eval/evaluators.test.ts`
Expected: all tests PASS (the `judgeSubagentReports` async function itself is not directly unit tested here — it makes a real OpenAI call — only its pure pieces, `SubagentGradeSchema` and `subagentJudgeFeedback`, are; this matches how `responseQualityJudge` itself is untested while `judgeFeedback`/`applyRootCauseCap`/etc. are)

- [ ] **Step 6: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/eval/evaluators.ts packages/agent/src/eval/evaluators.test.ts
git commit -m "SIO-1374: add judgeSubagentReports, the per-sub-agent evidence judge"
```

---

### Task 8: Surface `subagentReports` on `runAgent`'s output

**Files:**
- Modify: `packages/agent/src/eval/run-function.ts:45-85`

**Interfaces:**
- Consumes: `buildSubagentReports` from Task 6.
- Produces: `runAgent`'s return type gains `output.subagentReports: { [dataSourceId: string]: string }`. This is what the LangSmith run function evaluator (Task 9's wiring) reads to call `judgeSubagentReports`.

- [ ] **Step 1: Add the import and call**

Edit `packages/agent/src/eval/run-function.ts`. Add the import (alongside the existing `alignment.ts` import on line 4):

```ts
import { type FirstAttemptSummary, summarizeFirstAttempts } from "../alignment.ts";
import { buildSubagentReports } from "./subagent-reports.ts";
```

Update the return type and the return statement (current lines 45-84):

```ts
export async function runAgent(inputs: z.infer<typeof RunAgentInputsSchema>): Promise<{
	output: {
		response: string;
		targetDataSources: string[];
		confidenceCap?: number;
		firstAttempts: FirstAttemptSummary[];
		subagentReports: { [dataSourceId: string]: string };
	};
}> {
	const parsed = RunAgentInputsSchema.parse(inputs);
	await ensureMcpConnected();
	if (!cachedGraph) {
		cachedGraph = await buildGraph({ checkpointerType: "memory" });
	}
	const finalState = await cachedGraph.invoke(
		{
			messages: [new HumanMessage(parsed.query)],
			targetDataSources: parsed.uiSelectedDataSources ?? [],
			targetDeployments: parsed.uiSelectedElasticDeployments ?? [],
			uiAwsEstates: parsed.uiSelectedAwsEstates ?? [],
		},
		{ configurable: { thread_id: `eval-${crypto.randomUUID()}` } },
	);
	const lastMessage = finalState.messages.at(-1);
	const responseText = extractTextFromContent(lastMessage?.content);
	const firstAttempts = summarizeFirstAttempts(finalState.dataSourceResults ?? []);
	// SIO-1374: raw per-sub-agent findings, isolated from the aggregator's final response text,
	// so the per-sub-agent judge can grade the variable under test (sub-agent model) without the
	// constant (Sonnet 5 aggregator prose) diluting the signal.
	const subagentReports = buildSubagentReports(finalState.dataSourceResults ?? []);
	return {
		output: {
			response: responseText,
			targetDataSources: finalState.targetDataSources ?? [],
			confidenceCap: finalState.confidenceCap,
			firstAttempts,
			subagentReports,
		},
	};
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors (there is no existing unit test for `run-function.ts` itself — it requires a live graph/MCP connection, consistent with the file having no `.test.ts` sibling today; this task is verified by typecheck plus the live-run smoke check in Task 10)

- [ ] **Step 3: Lint**

Run: `bun run lint`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/eval/run-function.ts
git commit -m "SIO-1374: surface subagentReports on runAgent output"
```

---

### Task 9: Wire the sub-agent judge into the eval run

**Files:**
- Modify: wherever `responseQualityJudge` (and the other evaluators: `datasourcesCovered`, `confidenceThreshold`) are currently registered against the LangSmith `evaluate()` call. Locate this with:

```bash
grep -rn "responseQualityJudge\|datasourcesCovered\|confidenceThreshold" packages/agent/src --include="*.ts" | grep -v evaluators.ts | grep -v evaluators.test.ts
```

(This file was not read during planning — locate and confirm its exact name/path as the first step below before editing, since the exact registration site was outside this plan's read set.)

**Interfaces:**
- Consumes: `judgeSubagentReports` (Task 7), `runAgent`'s `output.subagentReports` (Task 8), `example.outputs.referenceFindings` (Task 1/2).
- Produces: a new evaluator function registered alongside `responseQualityJudge` in the same `evaluate()` call, so `subagent_accuracy_<datasource>` feedback appears in the same LangSmith run as `response_quality`/`evidence_<datasource>`.

- [ ] **Step 1: Locate the eval run registration file**

Run the grep command above. Read the file it identifies to see the exact shape passed to LangSmith's `evaluate()` (an array of evaluator functions, each `(run, example) => ...`, matching the signature of `datasourcesCovered`/`confidenceThreshold` in `evaluators.ts:88-112`).

- [ ] **Step 2: Add a `subagentEvidenceJudge` evaluator function**

Add to `packages/agent/src/eval/evaluators.ts`, after `judgeSubagentReports`:

```ts
// LangSmith run-evaluator entrypoint for the per-sub-agent judge (Task 7's judgeSubagentReports),
// mirroring responseQualityJudge's run/example -> feedback[] shape so it slots into the same
// evaluate() call registration as the existing evaluators.
export async function subagentEvidenceJudge(run: Run, example: Example) {
	const referenceFindings = (example.outputs?.referenceFindings ?? {}) as { [datasource: string]: string };
	const subagentReports =
		(run.outputs as { output?: { subagentReports?: { [k: string]: string } } } | undefined)?.output
			?.subagentReports ?? {};
	if (Object.keys(referenceFindings).length === 0) return [];
	return judgeSubagentReports(subagentReports, referenceFindings);
}
```

- [ ] **Step 3: Register `subagentEvidenceJudge` in the evaluate() call**

In the file located in Step 1, add `subagentEvidenceJudge` to the same array/list that already includes `responseQualityJudge`, `datasourcesCovered`, `confidenceThreshold`, importing it from `evaluators.ts` alongside the existing imports.

- [ ] **Step 4: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/eval/evaluators.ts <the-file-located-in-step-1>
git commit -m "SIO-1374: register subagentEvidenceJudge in the eval run"
```

---

### Task 10: Re-upload the LangSmith dataset and re-run both A/B legs

**Files:** none (operational task — LangSmith CLI/dashboard + eval run commands)

**Interfaces:**
- Consumes: the fully backfilled `INCIDENT_REPLAY_DATASET` from Task 2, all judge changes from Tasks 3-9.
- Produces: a new LangSmith dataset id (replacing the stale `6d433c9e-fbd0-4040-8be7-06de64dd383c`), two new eval run results (haiku-4-5 leg, sonnet-4-6 leg) with `evidence_<datasource>` and `subagent_accuracy_<datasource>` keys visible in Compare.

- [ ] **Step 1: Run the full test suite one more time before any live/network step**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all clean. This is the acceptance criterion's explicit gate before doing anything that costs money or touches LangSmith.

- [ ] **Step 2: Delete and re-upload the LangSmith dataset**

Use the `langsmith-dataset` skill's CLI workflow (per `reference_langsmith_dataset_no_upsert`: delete then create, there is no upsert). Locate the existing dataset creation/upload script the SIO-1372 cycle used (likely referenced in `experiments/HANDOFF-2026-08-03-SIO-1372-eval-judge-rework.md`) and re-run it against the now-backfilled `INCIDENT_REPLAY_DATASET`.

- [ ] **Step 3: Record the new dataset id**

Update the Linear ticket SIO-1374 with the new dataset id (per the ticket's own Step 5 instruction: "record the new id here"), and update this plan's reference below.

- [ ] **Step 4: Re-run both A/B legs**

Run the eval harness (same invocation used for the SIO-1372 gated A/B baseline: haiku-4-5 vs sonnet-4-6, n=32) against the new dataset.

- [ ] **Step 5: Spot-check the DEVOPS-1386 example (era-drift fix verification)**

In LangSmith, find the DEVOPS-1386 example's Sonnet-leg run result. Confirm:
- `rootCauseMatch` is no longer downgraded to `incorrect` purely because the response described the live recurrence window (the Price Indexing V2 Jenkins job) that the frozen `referenceReport`'s era didn't originally name.
- The `reasoning` field's explanation does not cite the recurrence-window detail as fabrication.

This is the acceptance criterion: "The #8-class era-drift miscall no longer grades truthful recurrence-window observations as fabrication (verified on the DEVOPS-1386 example)."

- [ ] **Step 6: Confirm SIO-1372 root-cause gate behavior is unchanged**

In the same run results, confirm `response_quality` scores are still capped per `applyRootCauseCap` (incorrect ≤4, partial ≤7) and `root_cause_accuracy` is still omitted for `not_determinable` verdicts — i.e., the cap and omission behavior from SIO-1372 is visibly intact in the live run output, not just in unit tests.

- [ ] **Step 7: Compare per-datasource keys across both legs in LangSmith Compare**

Confirm `evidence_<datasource>` and `subagent_accuracy_<datasource>` keys are visible and filterable per the acceptance criteria, and note any systematic per-datasource weakness surfaced (e.g. "haiku's gitlab evidence is systematically weak") for the ticket's final writeup.

- [ ] **Step 8: Update SIO-1374's Linear ticket with results**

Record: new dataset id, both legs' aggregate scores (quality, root_cause_accuracy, per-datasource evidence/subagent_accuracy averages), and the DEVOPS-1386 spot-check confirmation, appending to the existing ticket content (never replacing it, per this repo's Linear-update convention).

---

## Self-Review Notes

- **Spec coverage**: all three numbered items from the confirmed method (per-datasource verdicts in the same call, per-sub-agent judging, era-drift fix) map to tasks 3-5 (verdicts+prompt), 6-9 (sub-agent judging), and 5 (era-drift, bundled with the prompt task per the ticket's own "do together with 1" instruction). The `referenceFindings` prerequisite is Tasks 1-2. Re-upload and re-run is Task 10. Gaps-honesty/fabrication folded into `datasourceVerdicts` (Task 3), not a separate section-judging pass, per the explicit non-goal.
- **No placeholders**: every code step above is a complete, pasteable diff, not a description. Task 2 (the dataset backfill) is the one task that is intentionally *not* fully authored here, because it requires reading 32 real external ticket documents this plan does not have fetched content for — it is scoped with an exact sourcing procedure, an exact per-entry key requirement table, and a verification script, which is the correct level of detail for content-sourcing work (the same way a plan can't pre-write a blog post's real facts, but can specify exactly which facts are needed and where to get them).
- **Type consistency**: `DatasourceVerdict` (Task 3) is used identically in Task 4's `judgeFeedback` extension and Task 5's prompt-output-format instruction. `buildSubagentReports`'s return shape `{ [dataSourceId: string]: string }` (Task 6) matches exactly what Task 8 assigns to `output.subagentReports` and what Task 9's `subagentEvidenceJudge` reads back off `run.outputs.output.subagentReports`. `SubagentGradeSchema`/`subagentJudgeFeedback` (Task 7) are used identically in Task 9's `subagentEvidenceJudge`.
- **Root-cause gate integrity**: no task modifies `applyRootCauseCap` or `squareVerdictWithReference`. Task 4's refactor of `judgeFeedback` preserves the exact `not_determinable` -> length-1-array behavior the existing test at `evaluators.test.ts:123` pins.
