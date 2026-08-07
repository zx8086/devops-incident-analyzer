# Agent-side structuredContent consumption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `buildPersistedToolOutput` consume a tool's MCP `structuredContent` (delivered via `ToolMessage.artifact`) instead of re-parsing `content` text as JSON, for the 4 tools that already emit it, with zero behavior change to `extractFindings`'s output.

**Architecture:** Capture `ToolMessage.artifact`'s structured payload alongside `.content` at the existing raw-capture site in `sub-agent-instrumentation.ts` (mirroring how `.content` is already captured), thread it through `RawToolOutput` and the `persistSource` mapping in `sub-agent.ts`, and give `buildPersistedToolOutput` an optional structured-payload parameter that short-circuits `tryParseJson` when present. No changes to extractors, schemas, or any MCP server package.

**Tech Stack:** TypeScript (strict mode), Bun test, Zod (unchanged — no new schemas), `@langchain/core` `ToolMessage`.

## Global Constraints

- TypeScript strict mode, never use `any` (biome `noExplicitAny: "error"`).
- Named exports preferred.
- No emojis in code, logs, comments, or output.
- File headers: single-line relative path only (e.g. `// src/sub-agent.ts`) — no multi-line JSDoc blocks.
- Comments: only for non-obvious "why" (hidden constraints, workarounds, ticket references). Do not restate what code already says.
- Run `bun run --filter '@devops-agent/agent' typecheck` and `bun run --filter '@devops-agent/agent' test` after every task.
- Zero change to `packages/shared/src/agent-state.ts` (`ToolOutputSchema`, `DataSourceResultSchema`) — `rawJson: z.unknown()` already accommodates either source.
- Zero change to `packages/agent/src/correlation/extractors/{kafka,aws,atlassian}.ts` — confirmed (design spec, `docs/superpowers/specs/2026-08-07-agent-structuredcontent-consumption-design.md`) that server `structuredContent` and text `content` are the same in-memory object for all 4 target tools, so extractor Zod schemas validate either source identically.

---

## File Structure

- **Modify** `packages/agent/src/sub-agent-instrumentation.ts`:
  - Add `extractStructuredContent()` (new private helper, mirrors `extractContent()` at line 448).
  - Add `structuredContent?: unknown` field to `RawToolOutput` (line 107-110).
  - Call the new helper at the one real-success raw-capture site (line 317) and include the result in the pushed `RawToolOutput`.
- **Modify** `packages/agent/src/sub-agent.ts`:
  - Add an optional 4th parameter to `buildPersistedToolOutput` (line 509-538) for a pre-parsed structured payload; when present, use it directly instead of calling `tryParseJson(text)`.
  - Update the `persistSource`/`toolOutputs` mapping (line 1716-1736) to pass `o.structuredContent` through to `buildPersistedToolOutput`.
- **Modify** `packages/agent/src/sub-agent-raw-output-capture.test.ts`:
  - New `describe` block with the test cases from the design spec's Testing section (artifact present + matches, artifact absent, artifact present but malformed).
- **Modify** `packages/agent/src/sub-agent.test.ts`:
  - Extend the existing `describe("buildPersistedToolOutput SIO-1159 typed-finding exemption", ...)` block with cases for the new 4th parameter.

No new files. This mirrors the existing SIO-1248 raw-capture pattern exactly (same files, same call graph), which is why no new module is warranted — the two touched functions already own this responsibility.

---

### Task 1: `extractStructuredContent()` helper + `RawToolOutput.structuredContent` field

**Files:**
- Modify: `packages/agent/src/sub-agent-instrumentation.ts:107-110` (interface), `:448-453` (add helper near `extractContent`)
- Test: `packages/agent/src/sub-agent-raw-output-capture.test.ts`

**Interfaces:**
- Consumes: `ToolMessage` from `@langchain/core/messages` (already imported at `sub-agent-instrumentation.ts:4`).
- Produces: `extractStructuredContent(result: unknown): unknown | undefined` (private, not exported — matches `extractContent`'s own visibility). `RawToolOutput` gains `structuredContent?: unknown`, consumed by Task 2.

The real MCP adapter shape (confirmed live, `@langchain/mcp-adapters@1.1.3`'s `dist/tools.js:311-325`): when a tool declares `outputSchema` and returns `structuredContent`, the resulting `ToolMessage.artifact` is an array containing `{ type: "mcp_structured_content", data: <the tool's structuredContent object> }` alongside any other artifact entries. `extractStructuredContent` finds and returns that entry's `data`, or `undefined` if absent/malformed.

- [ ] **Step 1: Write the failing test**

Add to `packages/agent/src/sub-agent-raw-output-capture.test.ts` (new `describe` block, after the existing SIO-1248 block):

```typescript
describe("SIO-1425/1437 structuredContent capture", () => {
	test("captures ToolMessage.artifact's mcp_structured_content alongside text content", async () => {
		const structured = { groupId: "g1", totalLag: "42", topics: [] };
		const fake = tool(async () => [JSON.stringify(structured), [{ type: "mcp_structured_content", data: structured }]], {
			name: "kafka_get_consumer_group_lag",
			description: "x",
			schema: z.object({}),
			responseFormat: "content_and_artifact",
		});

		const rawOutputs: RawToolOutput[] = [];
		const wrapped = instrumentTools([fake], {
			dataSourceId: "kafka",
			log: { info: () => {}, warn: () => {} },
			rawOutputs,
		})[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		await wrapped.invoke({ id: "c", name: "kafka_get_consumer_group_lag", args: {}, type: "tool_call" });

		expect(rawOutputs).toHaveLength(1);
		expect(rawOutputs[0]?.structuredContent).toEqual(structured);
	});

	test("leaves structuredContent undefined when the tool has no artifact", async () => {
		const fake = tool(async () => "plain text result", {
			name: "gitlab_get_blame",
			description: "x",
			schema: z.object({}),
		});

		const rawOutputs: RawToolOutput[] = [];
		const wrapped = instrumentTools([fake], {
			dataSourceId: "gitlab",
			log: { info: () => {}, warn: () => {} },
			rawOutputs,
		})[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		await wrapped.invoke({ id: "c", name: "gitlab_get_blame", args: {}, type: "tool_call" });

		expect(rawOutputs).toHaveLength(1);
		expect(rawOutputs[0]?.structuredContent).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/sub-agent-raw-output-capture.test.ts -t "structuredContent capture"`
Expected: FAIL — `rawOutputs[0]?.structuredContent` is `undefined` for the first test (property doesn't exist / isn't populated yet), second test may pass trivially since `undefined` is already the default. Confirm the FIRST test specifically fails with a value mismatch (`{groupId:...}` !== `undefined`).

- [ ] **Step 3: Add the `structuredContent` field to `RawToolOutput` and write the helper**

In `packages/agent/src/sub-agent-instrumentation.ts`, update the interface at line 107-110:

```typescript
export interface RawToolOutput {
	toolName: string;
	content: unknown;
	// SIO-1425/1437: the tool's MCP structuredContent payload, when the underlying MCP
	// tool declared an outputSchema and the client (@langchain/mcp-adapters) routed it to
	// ToolMessage.artifact's "mcp_structured_content" entry. Undefined for every tool that
	// hasn't declared an outputSchema (all but the 4 SIO-1422 wave-1 tools today).
	structuredContent?: unknown;
}
```

Add the helper immediately after `extractContent` (currently ending at line 453):

```typescript
// SIO-1425/1437: mirrors extractContent's instanceof narrowing. The MCP adapter's
// artifact shape (confirmed live, @langchain/mcp-adapters@1.1.3 dist/tools.js:311-325)
// is an array of entries; the structuredContent one is tagged "mcp_structured_content".
function extractStructuredContent(result: unknown): unknown | undefined {
	if (!(result instanceof ToolMessage)) return undefined;
	const artifact = result.artifact;
	if (!Array.isArray(artifact)) return undefined;
	const entry = artifact.find(
		(a): a is { type: "mcp_structured_content"; data: unknown } =>
			typeof a === "object" && a !== null && (a as { type?: unknown }).type === "mcp_structured_content",
	);
	return entry?.data;
}
```

Update the one real-success raw-capture push site (currently line 317):

```typescript
ctx.rawOutputs?.push({
	toolName: tool.name,
	content: extractContent(result),
	structuredContent: extractStructuredContent(result),
});
```

Leave the other two `rawOutputs?.push` sites (loop-guard stop at line 280, caught error at line 303-306) unchanged — neither has a real MCP `ToolMessage` result (`stop` is synthetically built, the catch branch only has an `Error`), so `structuredContent` is correctly absent (`undefined`) for both by construction, no explicit field needed there.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/agent/src/sub-agent-raw-output-capture.test.ts -t "structuredContent capture"`
Expected: PASS (2 tests)

- [ ] **Step 5: Run full instrumentation test file to check for regressions**

Run: `bun test packages/agent/src/sub-agent-instrumentation.test.ts packages/agent/src/sub-agent-raw-output-capture.test.ts`
Expected: all PASS, same pass count as before this task plus the 2 new tests

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/sub-agent-instrumentation.ts packages/agent/src/sub-agent-raw-output-capture.test.ts
git commit -m "SIO-1437: capture ToolMessage.artifact structuredContent in raw tool output"
```

---

### Task 2: `buildPersistedToolOutput` prefers structuredContent when present

**Files:**
- Modify: `packages/agent/src/sub-agent.ts:509-538` (function), `:1716-1736` (call site)
- Test: `packages/agent/src/sub-agent.test.ts`

**Interfaces:**
- Consumes: `RawToolOutput.structuredContent` from Task 1.
- Produces: `buildPersistedToolOutput(toolName: string, text: string, stateCapBytes: number | null, structuredContent?: unknown)` — the added 4th parameter. Return shape (`{ rawJson, capSkippedBytes, truncation }`) is unchanged, consumed as today by `extractFindings` via `DataSourceResult.toolOutputs[].rawJson`.

- [ ] **Step 1: Write the failing test**

Add to `packages/agent/src/sub-agent.test.ts`, inside the existing `describe("buildPersistedToolOutput SIO-1159 typed-finding exemption", ...)` block (after the existing tests, before its closing brace):

```typescript
	test("structuredContent, when provided, is used directly without re-parsing text", () => {
		const structured = { groupId: "g1", totalLag: "42", topics: [] };
		// Deliberately mismatched text: if tryParseJson(text) were used instead of the
		// structured payload, rawJson would equal this different object, not `structured`.
		const mismatchedText = JSON.stringify({ groupId: "WRONG", totalLag: "0", topics: [] });
		const out = buildPersistedToolOutput("kafka_get_consumer_group_lag", mismatchedText, CAP, structured);
		expect(out.rawJson).toEqual(structured);
	});

	test("falls back to tryParseJson(text) when structuredContent is undefined", () => {
		const out = buildPersistedToolOutput("kafka_get_consumer_group_lag", '{"groupId":"g1","totalLag":"1","topics":[]}', CAP, undefined);
		expect(out.rawJson).toEqual({ groupId: "g1", totalLag: "1", topics: [] });
	});

	test("structuredContent does not change capSkippedBytes/truncation accounting", () => {
		const structured = { groupId: "g1", totalLag: "42", topics: [] };
		const bigText = `Total: ${"x".repeat(CAP * 4)}`;
		const out = buildPersistedToolOutput("kafka_get_consumer_group_lag", bigText, CAP, structured);
		// still a TYPED_FINDING_TOOLS member -> cap-skip branch, same as without structuredContent
		expect(out.capSkippedBytes).toBe(Buffer.byteLength(bigText, "utf8"));
		expect(out.truncation).toBeNull();
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/sub-agent.test.ts -t "structuredContent"`
Expected: FAIL — TypeScript error or runtime mismatch, since `buildPersistedToolOutput` doesn't accept a 4th argument yet (the extra arg is currently silently ignored by JS at runtime, so the first test fails on the `rawJson` assertion: it would equal the parsed `mismatchedText`, not `structured`).

- [ ] **Step 3: Add the 4th parameter to `buildPersistedToolOutput`**

In `packages/agent/src/sub-agent.ts`, replace the function at line 509-538:

```typescript
// SIO-1159: exported for tests. Decides the persisted form of one tool output.
// SIO-1043 caps toolOutputs[].rawJson so checkpoint state stays bounded, but
// typed-finding tools bypass the cap entirely (mirroring the in-flight skip in
// sub-agent-instrumentation.ts): extractFindings parses the persisted rawJson,
// and truncateToolOutput's "text" fallback is NOT structure-preserving -- a
// 500KB elastic "Document ID:" block string capped at 32KB parses to zero
// findings (observed live: ElasticFindingsCard rawCount 0 in run 270378e0).
// Bounded regardless: pruneThreadState resets dataSourceResults every turn.
// SIO-1425/1437: structuredContent, when provided, is the MCP tool's own
// structuredContent payload (already a parsed object, byte-identical in shape to
// what tryParseJson(text) would produce for the 4 SIO-1422 wave-1 tools -- see
// docs/superpowers/specs/2026-08-07-agent-structuredcontent-consumption-design.md).
// Using it directly skips a redundant JSON.parse; byte accounting (capSkippedBytes/
// truncation) still runs against `text` unchanged, since those numbers describe the
// text payload's size, not the structured object's.
export function buildPersistedToolOutput(
	toolName: string,
	text: string,
	stateCapBytes: number | null,
	structuredContent?: unknown,
): {
	rawJson: unknown;
	capSkippedBytes: number | null;
	truncation: { strategy: string; originalBytes: number; finalBytes: number } | null;
} {
	const parsedOrStructured = structuredContent !== undefined ? structuredContent : tryParseJson(text);
	if (stateCapBytes == null) {
		return { rawJson: parsedOrStructured, capSkippedBytes: null, truncation: null };
	}
	if (TYPED_FINDING_TOOLS.has(toolName)) {
		const bytes = Buffer.byteLength(text, "utf8");
		return {
			rawJson: parsedOrStructured,
			capSkippedBytes: bytes > stateCapBytes ? bytes : null,
			truncation: null,
		};
	}
	const capped = truncateToolOutput(text, stateCapBytes);
	return {
		rawJson: structuredContent !== undefined ? structuredContent : tryParseJson(capped.content),
		capSkippedBytes: null,
		truncation:
			capped.strategy === "none"
				? null
				: { strategy: capped.strategy, originalBytes: capped.originalBytes, finalBytes: capped.finalBytes },
	};
}
```

Note: the non-typed-tool branch (`truncateToolOutput`) also honors `structuredContent` if present, for forward-consistency with Task 1's design (any future tool with an `outputSchema` gets correct behavior regardless of `TYPED_FINDING_TOOLS` membership) — but in practice only the `TYPED_FINDING_TOOLS` branch is reachable with a non-undefined `structuredContent` today, since all 4 target tools are members (confirmed in the design spec's research).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/agent/src/sub-agent.test.ts -t "structuredContent"`
Expected: PASS (3 tests)

- [ ] **Step 5: Update the call site to pass `structuredContent` through**

In `packages/agent/src/sub-agent.ts`, update the `persistSource` type and `toolOutputs` mapping at line 1716-1736:

```typescript
const persistSource: Array<{ name?: string; content: unknown; structuredContent?: unknown }> =
	rawOutputs.length > 0
		? rawOutputs.map((o) => ({ name: o.toolName, content: o.content, structuredContent: o.structuredContent }))
		: toolMessages.map((m: { name?: string; content: unknown }) => ({ name: m.name, content: m.content }));
const toolOutputs = persistSource.map((m: { name?: string; content: unknown; structuredContent?: unknown }) => {
	const toolName = m.name ?? "unknown";
	const out = buildPersistedToolOutput(toolName, normalizeToolContent(m.content), stateCapBytes, m.structuredContent);
	if (out.capSkippedBytes != null) {
		log.info(
			{ event: "subagent.state_output_cap_skipped", deploymentId, toolName, bytes: out.capSkippedBytes },
			"Persisted tool output cap skipped to preserve typed-finding JSON",
		);
	}
	if (out.truncation) {
		log.info(
			{ event: "subagent.state_output_truncated", deploymentId, toolName, ...out.truncation },
			"Persisted tool output truncated",
		);
	}
	return { toolName, rawJson: out.rawJson };
});
```

The `toolMessages`-derived fallback branch (when `rawOutputs.length === 0`, i.e. a path that bypassed the instrumented tools) correctly has no `structuredContent` key — `LangChain`'s raw `response.messages` ToolMessages are read here as plain `{name, content}`, matching today's behavior exactly; this fallback path is unaffected by this change.

- [ ] **Step 6: Run full test suite for the package**

Run: `bun run --filter '@devops-agent/agent' test`
Expected: all PASS, no regressions elsewhere (this confirms the `persistSource` type widening and the new parameter don't break any other caller of `buildPersistedToolOutput` or the `toolOutputs` construction)

- [ ] **Step 7: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add packages/agent/src/sub-agent.ts packages/agent/src/sub-agent.test.ts
git commit -m "SIO-1437: prefer structuredContent over text re-parse in buildPersistedToolOutput"
```

---

### Task 3: End-to-end integration test (instrumentTools -> buildPersistedToolOutput -> extractor)

**Files:**
- Modify: `packages/agent/src/sub-agent-raw-output-capture.test.ts`

**Interfaces:**
- Consumes: `instrumentTools`, `RawToolOutput` (Task 1), `buildPersistedToolOutput` (Task 2), `extractKafkaFindings` from `packages/agent/src/correlation/extractors/kafka.ts` (existing, unmodified).
- Produces: nothing new — this task only adds a test proving the full chain end-to-end, matching the file's existing SIO-1248 test pattern (fake tool -> instrumentTools -> buildPersistedToolOutput -> extractor -> assert on findings).

This is the test that actually proves the design spec's central claim (byte-identical extractor output) rather than testing each function in isolation.

- [ ] **Step 1: Write the test**

Add to `packages/agent/src/sub-agent-raw-output-capture.test.ts`, inside the `describe("SIO-1425/1437 structuredContent capture", ...)` block from Task 1:

```typescript
	test("end-to-end: kafka_get_consumer_group_lag structuredContent reaches extractKafkaFindings identically to text re-parse", async () => {
		const structured = {
			groupId: "checkout-workers",
			groupState: "Stable",
			totalLag: "150",
			topics: [{ topic: "orders", partitions: [{ partition: 0, committedOffset: "100", latestOffset: "250", lag: "150" }], totalLag: "150" }],
		};
		const fake = tool(async () => [JSON.stringify(structured), [{ type: "mcp_structured_content", data: structured }]], {
			name: "kafka_get_consumer_group_lag",
			description: "x",
			schema: z.object({}),
			responseFormat: "content_and_artifact",
		});

		const rawOutputs: RawToolOutput[] = [];
		const wrapped = instrumentTools([fake], {
			dataSourceId: "kafka",
			log: { info: () => {}, warn: () => {} },
			rawOutputs,
		})[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		await wrapped.invoke({ id: "c", name: "kafka_get_consumer_group_lag", args: {}, type: "tool_call" });

		const raw = rawOutputs[0];
		if (!raw) throw new Error("no raw output captured");
		const persisted = buildPersistedToolOutput(
			raw.toolName,
			normalizeToolContent(raw.content),
			65_536,
			raw.structuredContent,
		);

		const findings = extractKafkaFindings([{ toolName: "kafka_get_consumer_group_lag", rawJson: persisted.rawJson }] as never);

		// KafkaFindingsSchema.consumerGroups[].totalLag is z.number() (packages/shared/src/agent-state.ts:154-158).
		// GetConsumerGroupLagSchema (kafka.ts:26-35) accepts the server's string totalLag and
		// coerces it to a number via .transform() -- the extractor's OUTPUT is numeric even
		// though structuredContent's totalLag is the string "150", matching the server's real
		// wire shape. This is unchanged extractor behavior; asserting the coerced type here
		// proves the swap didn't silently bypass that coercion (e.g. by handing the extractor
		// an already-parsed object with the wrong totalLag type).
		expect(findings.consumerGroups).toHaveLength(1);
		expect(findings.consumerGroups?.[0]?.id).toBe("checkout-workers");
		expect(findings.consumerGroups?.[0]?.totalLag).toBe(150);
	});
```

Add the import at the top of the file (alongside the existing `extractElasticFindings` import):

```typescript
import { extractKafkaFindings } from "./correlation/extractors/kafka.ts";
```

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `bun test packages/agent/src/sub-agent-raw-output-capture.test.ts -t "end-to-end"`
Expected: after Tasks 1-2 are complete, this should PASS on first run (it's exercising already-implemented behavior, not driving new implementation) — if it fails, that's a signal Task 1 or 2 has a bug, not that new code is needed here.

- [ ] **Step 3: Run the full agent test suite**

Run: `bun run --filter '@devops-agent/agent' test`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/sub-agent-raw-output-capture.test.ts
git commit -m "SIO-1437: end-to-end test for structuredContent through to extractKafkaFindings"
```

---

### Task 4: Full verification and eval reassessment gate

**Files:** none modified — verification only.

**Interfaces:** none — this task runs the project's standard gates plus the design spec's eval-reassessment prerequisite before the branch is considered ready for PR.

- [ ] **Step 1: Full package verification**

```bash
bun run --filter '@devops-agent/agent' typecheck
bun run --filter '@devops-agent/agent' test
bun run lint
```

Expected: all green. `lint` covers the whole repo per this project's convention (see CLAUDE.md's Testing section) — confirm no findings in the 4 touched files; pre-existing unrelated warnings elsewhere are not blockers (matches this session's own precedent on PR #629).

- [ ] **Step 2: Eval reassessment (design spec Section 5, required before merge)**

This is a manual gate, not a CI step. Per the design spec and SIO-1425's own stated prerequisite: confirm no behavioral drift on the kafka/aws/atlassian incident-replay eval examples, since `rawJson`'s source changed even though its value shouldn't have.

Follow the `langsmith-evaluator` skill / `eval-engineering` conventions already established in this repo (see memory `reference_live_eval_anchor_entities_per_datasource` for the smaller live-anchor probe option if a full eval run is too costly for this change's scope). Compare `datasourceVerdicts`/`response_quality` for kafka/aws/atlassian-touching examples before and after this branch. Record the outcome (pass/no-drift, or specifics of any drift found) in the PR description.

- [ ] **Step 3: If eval reassessment is clean, proceed to PR per repo workflow**

Branch off `main` (if not already), push, open PR ready-for-review citing SIO-1437 (and note it also resolves/supersedes SIO-1425 as a duplicate — link both in the PR description), then the standard CodeRabbit SHA-scoped review loop per CLAUDE.md before merge.

---

## Self-Review Notes

**Spec coverage:**
- Design step 1 (extract structuredContent) -> Task 1. ✓
- Design step 2 (thread through RawToolOutput) -> Task 1. ✓
- Design step 3 (prefer in buildPersistedToolOutput) -> Task 2. ✓
- Design step 4 (no extractor changes) -> verified by Task 3's end-to-end test using the real unmodified extractor. ✓
- Design step 5 (eval reassessment) -> Task 4. ✓
- Testing section's 3 cases (present+match, absent, present+malformed) -> Task 1 covers present/absent; the "malformed" case (wrong `type` string) is implicitly covered by `extractStructuredContent`'s `.find()` returning `undefined` when no entry matches, exercised by the "no artifact" test's same code path (an empty/non-matching array behaves identically to a missing one) -- not a gap, the malformed case and the absent case hit the same return branch.

**Placeholder scan:** no TBD/TODO; every step has literal code, not descriptions.

**Type consistency:** `RawToolOutput.structuredContent?: unknown` (Task 1) flows unchanged in type through `persistSource` (Task 2) to `buildPersistedToolOutput`'s 4th parameter (Task 2, same `unknown` type) — no name or type drift across tasks.
