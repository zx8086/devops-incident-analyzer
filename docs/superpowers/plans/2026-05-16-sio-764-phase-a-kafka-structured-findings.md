# SIO-764 Phase A — Kafka structured findings (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `DataSourceResult.toolOutputs[]` with raw MCP tool JSON, add a pure-function `extractFindings` graph node that derives typed `kafkaFindings` from those outputs, and migrate the two unblockable Kafka dormant rules (`kafka-empty-or-dead-groups`, `kafka-significant-lag`) to read the typed sibling field — so they fire in production traffic.

**Architecture:** New optional `KafkaFindingsSchema` + `kafkaFindings` field on `DataSourceResult`. New module `packages/agent/src/extract-findings.ts` (pure function, soft-fail per agent). New module `packages/agent/src/correlation/extractors/kafka.ts` (pure function, fixture-tested). Graph wires `extractFindings` between `aggregate` and `enforceCorrelationsRouter`. Rule helper `getKafkaData()` reads `r.kafkaFindings` instead of casting `r.data` through `unknown`.

**Tech Stack:** TypeScript strict mode, Bun runtime, Zod v4, `@langchain/langgraph` StateGraph, `bun:test`.

**Scope boundaries (out of this plan):**
- GitLab and Couchbase extractors — deferred because the source MCP tools don't exist yet (separate sub-tickets to expose them, then add their extractors).
- `kafka_list_dlq_topics` exposure — Phase B sub-ticket against `mcp-server-kafka`.
- `kafka-tool-failures` field-name bug fix — independent sidecar sub-ticket.
- LLM prompt changes — none. Sub-agent SOUL.md files unchanged.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/agent-state.ts` | Add `KafkaFindingsSchema` + optional `kafkaFindings` field on `DataSourceResult`. |
| `packages/shared/src/index.ts` | Re-export `KafkaFindingsSchema` and `KafkaFindings` type. |
| `packages/agent/src/correlation/extractors/kafka.ts` | NEW — pure `extractKafkaFindings(outputs: ToolOutput[]): KafkaFindings`. |
| `packages/agent/src/correlation/extractors/kafka.test.ts` | NEW — fixture tests for the extractor. |
| `packages/agent/src/extract-findings.ts` | NEW — graph node dispatching per-agent extractors with soft-fail. |
| `packages/agent/src/extract-findings.test.ts` | NEW — integration test for the node. |
| `packages/agent/src/sub-agent.ts` | Modify line 417 — populate `toolOutputs[]` from tool messages instead of `[]`. |
| `packages/agent/src/correlation/rules.ts` | Modify `getKafkaData` (lines 23-33) — read `r.kafkaFindings` instead of `r.data`. |
| `packages/agent/src/graph.ts` | Modify lines 85-132 — add `extractFindings` node and edge. |
| `packages/agent/tests/correlation/engine.test.ts` | Migrate dormant Kafka rule tests to populate `kafkaFindings` instead of `data`. |
| `packages/agent/tests/correlation/test-helpers.ts` | Add `withKafkaFindings` helper alongside existing `withKafkaResult`. |
| `CLAUDE.md` | Update the pipeline-stage description (13 → 14 nodes). |
| `docs/architecture/agent-pipeline.md` | Update full diagram + add "Findings extraction" subsection. |

---

## Task 1: Add `KafkaFindingsSchema` and `kafkaFindings` field

**Files:**
- Modify: `packages/shared/src/agent-state.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add the schema and field**

Append `KafkaFindingsSchema` near the existing schemas in `packages/shared/src/agent-state.ts` (after `ToolOutputSchema` block, before `DataSourceResultSchema`):

```ts
// SIO-764: Per-domain structured findings derived from toolOutputs[] by the
// extractFindings graph node. Optional; absence = no extraction ran or
// extractor soft-failed. Each agent gets its own *Findings field; rules
// read the typed sibling instead of casting result.data through unknown.
export const KafkaFindingsSchema = z.object({
	consumerGroups: z
		.array(
			z.object({
				id: z.string(),
				state: z.string().optional(),
				totalLag: z.number().optional(),
			}),
		)
		.optional(),
	dlqTopics: z
		.array(
			z.object({
				name: z.string(),
				totalMessages: z.number(),
				recentDelta: z.number().nullable(),
			}),
		)
		.optional(),
});
export type KafkaFindings = z.infer<typeof KafkaFindingsSchema>;
```

Then add `kafkaFindings: KafkaFindingsSchema.optional(),` to `DataSourceResultSchema`, right after the `toolErrors` field:

```ts
export const DataSourceResultSchema = z.object({
	// ...existing fields up through toolErrors...
	toolErrors: z.array(ToolErrorSchema).optional(),
	// SIO-764: structured findings derived from toolOutputs[] in extractFindings node.
	kafkaFindings: KafkaFindingsSchema.optional(),
	messageCount: z.number().optional(),
});
```

(Keep `messageCount` last — only insert `kafkaFindings` between `toolErrors` and `messageCount`.)

- [ ] **Step 2: Re-export from package root**

In `packages/shared/src/index.ts`, find the `export ... from "./agent-state.ts"` block and add `KafkaFindingsSchema` + the `KafkaFindings` type to it. If the existing exports are individual:

```ts
export {
	// ...existing exports...
	KafkaFindingsSchema,
} from "./agent-state.ts";
export type {
	// ...existing type exports...
	KafkaFindings,
} from "./agent-state.ts";
```

- [ ] **Step 3: Typecheck the shared package**

Run: `bun run --filter @devops-agent/shared typecheck`
Expected: `Exited with code 0`

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/agent-state.ts packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
SIO-764: add KafkaFindingsSchema and kafkaFindings field

Per-domain structured findings derived from toolOutputs[] by the
upcoming extractFindings graph node. Schema mirrors the field paths
the dormant kafka-empty-or-dead-groups and kafka-significant-lag
rules already expect (id/state/totalLag, dlqTopics).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Write `extractKafkaFindings` failing tests

**Files:**
- Create: `packages/agent/src/correlation/extractors/kafka.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/agent/src/correlation/extractors/kafka.test.ts
import { describe, expect, test } from "bun:test";
import type { ToolOutput } from "@devops-agent/shared";
import { extractKafkaFindings } from "./kafka.ts";

describe("extractKafkaFindings", () => {
	test("returns empty findings when no relevant tool outputs are present", () => {
		const outputs: ToolOutput[] = [
			{ toolName: "kafka_list_topics", rawJson: { topics: [] } },
		];
		expect(extractKafkaFindings(outputs)).toEqual({});
	});

	test("maps kafka_list_consumer_groups response to consumerGroups[] with state", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "kafka_list_consumer_groups",
				rawJson: {
					groups: [
						{ id: "notification-service", state: "Stable" },
						{ id: "payments-service", state: "Empty" },
					],
				},
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.consumerGroups).toEqual([
			{ id: "notification-service", state: "Stable" },
			{ id: "payments-service", state: "Empty" },
		]);
	});

	test("maps each kafka_get_consumer_group_lag call to a consumerGroups[] entry with totalLag", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "kafka_get_consumer_group_lag",
				rawJson: { groupId: "notification-service", totalLag: 1234 },
			},
			{
				toolName: "kafka_get_consumer_group_lag",
				rawJson: { groupId: "payments-service", totalLag: 0 },
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.consumerGroups).toEqual([
			{ id: "notification-service", totalLag: 1234 },
			{ id: "payments-service", totalLag: 0 },
		]);
	});

	test("merges state + totalLag by group id when both tools were called", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "kafka_list_consumer_groups",
				rawJson: { groups: [{ id: "notification-service", state: "Empty" }] },
			},
			{
				toolName: "kafka_get_consumer_group_lag",
				rawJson: { groupId: "notification-service", totalLag: 9999 },
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.consumerGroups).toEqual([
			{ id: "notification-service", state: "Empty", totalLag: 9999 },
		]);
	});

	test("ignores tool outputs whose rawJson is a string (non-JSON tool result)", () => {
		const outputs: ToolOutput[] = [
			{ toolName: "kafka_list_consumer_groups", rawJson: "upstream returned 503" },
		];
		expect(extractKafkaFindings(outputs)).toEqual({});
	});

	test("ignores malformed tool outputs (missing expected fields)", () => {
		const outputs: ToolOutput[] = [
			{ toolName: "kafka_list_consumer_groups", rawJson: { unexpected: true } },
			{ toolName: "kafka_get_consumer_group_lag", rawJson: { totalLag: 5 } },
		];
		expect(extractKafkaFindings(outputs)).toEqual({});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/correlation/extractors/kafka.test.ts`
Expected: FAIL — `Cannot find module './kafka.ts'` or similar.

---

## Task 3: Implement `extractKafkaFindings`

**Files:**
- Create: `packages/agent/src/correlation/extractors/kafka.ts`

- [ ] **Step 1: Write the extractor**

```ts
// packages/agent/src/correlation/extractors/kafka.ts
import type { KafkaFindings, ToolOutput } from "@devops-agent/shared";

interface ListConsumerGroupsRawGroup {
	id: unknown;
	state?: unknown;
}

function isRecord(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null && !Array.isArray(x);
}

function extractListConsumerGroupsEntries(rawJson: unknown): Array<{ id: string; state: string }> {
	if (!isRecord(rawJson) || !Array.isArray(rawJson.groups)) return [];
	const out: Array<{ id: string; state: string }> = [];
	for (const g of rawJson.groups as ListConsumerGroupsRawGroup[]) {
		if (!isRecord(g)) continue;
		if (typeof g.id !== "string" || typeof g.state !== "string") continue;
		out.push({ id: g.id, state: g.state });
	}
	return out;
}

function extractGetConsumerGroupLagEntry(rawJson: unknown): { id: string; totalLag: number } | null {
	if (!isRecord(rawJson)) return null;
	const id = rawJson.groupId;
	const totalLag = rawJson.totalLag;
	if (typeof id !== "string" || typeof totalLag !== "number") return null;
	return { id, totalLag };
}

export function extractKafkaFindings(outputs: ToolOutput[]): KafkaFindings {
	const byId = new Map<string, { id: string; state?: string; totalLag?: number }>();

	for (const o of outputs) {
		if (o.toolName === "kafka_list_consumer_groups") {
			for (const entry of extractListConsumerGroupsEntries(o.rawJson)) {
				const existing = byId.get(entry.id) ?? { id: entry.id };
				existing.state = entry.state;
				byId.set(entry.id, existing);
			}
		} else if (o.toolName === "kafka_get_consumer_group_lag") {
			const entry = extractGetConsumerGroupLagEntry(o.rawJson);
			if (!entry) continue;
			const existing = byId.get(entry.id) ?? { id: entry.id };
			existing.totalLag = entry.totalLag;
			byId.set(entry.id, existing);
		}
	}

	const findings: KafkaFindings = {};
	if (byId.size > 0) findings.consumerGroups = Array.from(byId.values());
	return findings;
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test packages/agent/src/correlation/extractors/kafka.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 3: Typecheck**

Run: `bun run --filter @devops-agent/agent typecheck`
Expected: `Exited with code 0`

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/correlation/extractors/kafka.ts packages/agent/src/correlation/extractors/kafka.test.ts
git commit -m "$(cat <<'EOF'
SIO-764: extractKafkaFindings pure function

Maps kafka_list_consumer_groups (state) and kafka_get_consumer_group_lag
(totalLag) tool outputs into the KafkaFindings.consumerGroups[] shape
the dormant correlation rules expect. Merges by group id when both
tools were called. Defensive parsing — malformed/non-JSON tool outputs
are skipped, not thrown.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Write `extractFindings` graph-node failing test

**Files:**
- Create: `packages/agent/src/extract-findings.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent/src/extract-findings.test.ts
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { extractFindings } from "./extract-findings.ts";
import type { AgentStateType } from "./state.ts";

function baseState(): AgentStateType {
	return { dataSourceResults: [] } as unknown as AgentStateType;
}

function kafkaResult(toolOutputs: DataSourceResult["toolOutputs"]): DataSourceResult {
	return {
		dataSourceId: "kafka",
		data: "prose summary",
		status: "success",
		duration: 100,
		toolOutputs,
	};
}

describe("extractFindings node", () => {
	test("populates kafkaFindings on the kafka DataSourceResult", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				kafkaResult([
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: { groups: [{ id: "notification-service", state: "Empty" }] },
					},
				]),
			],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings?.consumerGroups).toEqual([
			{ id: "notification-service", state: "Empty" },
		]);
	});

	test("leaves non-kafka results untouched (no extractor registered)", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				{
					dataSourceId: "elastic",
					data: "prose",
					status: "success",
					duration: 50,
					toolOutputs: [{ toolName: "es_search", rawJson: { hits: [] } }],
				},
			],
		};
		const out = await extractFindings(state);
		const elastic = out.dataSourceResults?.find((r) => r.dataSourceId === "elastic");
		expect(elastic).toBeDefined();
		expect((elastic as unknown as { kafkaFindings?: unknown }).kafkaFindings).toBeUndefined();
	});

	test("soft-fails (returns the result unchanged) when the extractor throws", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				kafkaResult(null as unknown as DataSourceResult["toolOutputs"]),
			],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings).toBeUndefined();
	});

	test("preserves prose result.data unchanged", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [kafkaResult([])],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.data).toBe("prose summary");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/extract-findings.test.ts`
Expected: FAIL — `Cannot find module './extract-findings.ts'`.

---

## Task 5: Implement the `extractFindings` graph node

**Files:**
- Create: `packages/agent/src/extract-findings.ts`

- [ ] **Step 1: Write the node**

```ts
// packages/agent/src/extract-findings.ts
import type { DataSourceResult } from "@devops-agent/shared";
import { logger } from "@devops-agent/observability";
import { extractKafkaFindings } from "./correlation/extractors/kafka.ts";
import type { AgentStateType } from "./state.ts";

const EXTRACTORS: Record<string, (r: DataSourceResult) => Partial<DataSourceResult>> = {
	kafka: (r) => ({ kafkaFindings: extractKafkaFindings(r.toolOutputs ?? []) }),
};

export async function extractFindings(state: AgentStateType): Promise<Partial<AgentStateType>> {
	const dataSourceResults = state.dataSourceResults.map((r) => {
		const extractor = EXTRACTORS[r.dataSourceId];
		if (!extractor) return r;
		try {
			return { ...r, ...extractor(r) };
		} catch (err) {
			logger.warn(
				{ dataSourceId: r.dataSourceId, error: err instanceof Error ? err.message : String(err) },
				"extractFindings failed",
			);
			return r;
		}
	});
	return { dataSourceResults };
}
```

**If `@devops-agent/observability` does not export `logger`:** check what the rest of `packages/agent/src/` imports for logging (likely `import { createLogger } from "@devops-agent/observability"` then `const log = createLogger("extract-findings")`). Mirror the closest sibling pattern in `packages/agent/src/aggregator.ts` or `packages/agent/src/sub-agent.ts`.

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test packages/agent/src/extract-findings.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 3: Typecheck**

Run: `bun run --filter @devops-agent/agent typecheck`
Expected: `Exited with code 0`

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/extract-findings.ts packages/agent/src/extract-findings.test.ts
git commit -m "$(cat <<'EOF'
SIO-764: extractFindings graph node with per-agent dispatch

Pure-function node that runs registered extractors against each
DataSourceResult and writes derived structured findings to typed
sibling fields. Soft-fails per agent so a buggy extractor leaves
its findings undefined rather than crashing the graph.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire `extractFindings` into the graph

**Files:**
- Modify: `packages/agent/src/graph.ts` (lines 85-132)

- [ ] **Step 1: Add the import**

Near the top of `packages/agent/src/graph.ts`, alongside the existing node imports (look for `aggregate`, `enforceCorrelationsRouter`, `correlationFetch`, `enforceCorrelationsAggregate` imports), add:

```ts
import { extractFindings } from "./extract-findings.ts";
```

- [ ] **Step 2: Register the node**

In the `StateGraph` builder chain (currently lines 78-99 of graph.ts), add a `.addNode("extractFindings", ...)` call **immediately after** the `aggregate` node registration (line 85) and **before** the `correlationFetch` registration (line 86):

```ts
.addNode("aggregate", traceNode("aggregate", aggregate))
.addNode("extractFindings", traceNode("extractFindings", extractFindings))
.addNode("correlationFetch", traceNode("correlationFetch", correlationFetch))
```

- [ ] **Step 3: Rewire the aggregate-out edge**

In the same file at line 132, replace:

```ts
.addConditionalEdges("aggregate", enforceCorrelationsRouter, ["correlationFetch", "enforceCorrelationsAggregate"])
```

with:

```ts
.addEdge("aggregate", "extractFindings")
.addConditionalEdges("extractFindings", enforceCorrelationsRouter, ["correlationFetch", "enforceCorrelationsAggregate"])
```

Leave lines 133-134 (correlationFetch → enforceCorrelationsAggregate → checkConfidence) unchanged.

- [ ] **Step 4: Typecheck**

Run: `bun run --filter @devops-agent/agent typecheck`
Expected: `Exited with code 0`

- [ ] **Step 5: Run the agent package's existing tests**

Run: `bun run --filter @devops-agent/agent test`
Expected: All existing tests still pass. Pipeline-shape tests (if any test the node count or edge graph) may need updating in Task 11 — note any failures and continue if they're confined to graph-shape assertions.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/graph.ts
git commit -m "$(cat <<'EOF'
SIO-764: insert extractFindings node between aggregate and router

Pipeline becomes 14 nodes (was 13). extractFindings is a pure
transformation node — same pattern as align and
enforceCorrelationsAggregate. It runs unconditionally so structured
findings are available to enforceCorrelationsRouter, correlationFetch
re-fan-out, and downstream nodes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Populate `toolOutputs[]` in `sub-agent.ts`

**Files:**
- Modify: `packages/agent/src/sub-agent.ts` (around lines 387, 417)

- [ ] **Step 1: Inspect the existing tool-message filter**

The file already has at line 387 (verified during plan-step exploration):

```ts
const toolMessages = response.messages.filter((m: { _getType(): string }) => m._getType() === "tool");
```

We'll reuse that filter (or its result) to build the `toolOutputs[]` array.

- [ ] **Step 2: Add the `tryParseJson` helper near the top of the file**

After the existing imports in `packages/agent/src/sub-agent.ts`, add:

```ts
// SIO-764: tool message contents are sometimes JSON strings (kafka MCP responses),
// sometimes plain text (upstream nginx 503 pages). Parse when possible; keep raw
// otherwise. The extractFindings node handles either case.
function tryParseJson(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
}
```

- [ ] **Step 3: Build `toolOutputs[]` from tool messages**

Just before the `return { dataSourceId, ... toolOutputs: [], ... }` block (currently around line 412), insert:

```ts
const toolOutputs = toolMessages.map((m: { name?: string; content: unknown }) => ({
	toolName: m.name ?? "unknown",
	rawJson: tryParseJson(String(m.content)),
}));
```

If `toolMessages` is not in scope at that point in the function, walk up to where it's defined (line 387 region) and either widen its scope (move the `const toolMessages = ...` to an outer block before the return) or recompute it inline at the return site.

- [ ] **Step 4: Replace `toolOutputs: []` with `toolOutputs`**

Find the return at line 417:

```ts
toolOutputs: [],
```

Replace with:

```ts
toolOutputs,
```

- [ ] **Step 5: Typecheck**

Run: `bun run --filter @devops-agent/agent typecheck`
Expected: `Exited with code 0`

- [ ] **Step 6: Add a unit-level sanity test**

Append to `packages/agent/src/extract-findings.test.ts`:

```ts
test("end-to-end: a kafka_list_consumer_groups toolOutput parsed from a JSON string flows through", async () => {
	const state: AgentStateType = {
		...baseState(),
		dataSourceResults: [
			{
				dataSourceId: "kafka",
				data: "summary",
				status: "success",
				duration: 100,
				toolOutputs: [
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: { groups: [{ id: "payments-service", state: "Stable" }] },
					},
				],
			},
		],
	};
	const out = await extractFindings(state);
	expect(out.dataSourceResults?.[0]?.kafkaFindings?.consumerGroups?.[0]?.id).toBe("payments-service");
});
```

Run: `bun test packages/agent/src/extract-findings.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/sub-agent.ts packages/agent/src/extract-findings.test.ts
git commit -m "$(cat <<'EOF'
SIO-764: populate DataSourceResult.toolOutputs[] from ReAct tool messages

Replaces the long-standing toolOutputs: [] in sub-agent.ts with an
actual capture of each ToolMessage's content. tryParseJson keeps
non-JSON tool results (e.g. upstream 503 pages) as raw strings — the
extractor downstream is defensive about either shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Migrate `getKafkaData()` to read `kafkaFindings`

**Files:**
- Modify: `packages/agent/src/correlation/rules.ts` (lines 23-33)

- [ ] **Step 1: Replace the helper body**

Find `getKafkaData` at line 23 of `packages/agent/src/correlation/rules.ts`. Current body:

```ts
function getKafkaData(state: AgentStateType): {
	consumerGroups?: Array<{ id: string; state: string; totalLag?: number }>;
	dlqTopics?: Array<{ name: string; totalMessages: number; recentDelta: number | null }>;
	toolErrors?: Array<{ tool: string; code: string }>;
} {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "kafka");
	if (!result || result.status !== "success" || !result.data || typeof result.data !== "object") {
		return {};
	}
	return result.data as never;
}
```

Replace with:

```ts
function getKafkaData(state: AgentStateType): {
	consumerGroups?: Array<{ id: string; state?: string; totalLag?: number }>;
	dlqTopics?: Array<{ name: string; totalMessages: number; recentDelta: number | null }>;
	toolErrors?: Array<{ tool: string; code: string }>;
} {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "kafka");
	if (!result || result.status !== "success") return {};
	// SIO-764: read the structured sibling populated by extractFindings; result.data
	// stays as the prose summary for aggregator/UI.
	return result.kafkaFindings ?? {};
}
```

Note: the return type's `state` becomes optional (`state?: string`) to match `KafkaFindingsSchema` — extraction can produce a group entry that has `totalLag` but no `state` (when only `kafka_get_consumer_group_lag` was called). Rules that read `.state` already handle the optional case via `=== "Empty"` checks.

- [ ] **Step 2: Typecheck**

Run: `bun run --filter @devops-agent/agent typecheck`
Expected: `Exited with code 0`

**If there are type errors** in `rules.ts` because consuming rules assumed `state: string` (non-optional), audit each usage (`grep -n '\.state' packages/agent/src/correlation/rules.ts`). The two unblocked rules (`kafka-empty-or-dead-groups`, `kafka-significant-lag`) use the field via equality checks (`g.state === "Empty"`) which already handle `undefined` gracefully (comparison returns false). No code change should be needed in the rules themselves.

- [ ] **Step 3: Run rule-engine tests (will fail — they still use old data shape)**

Run: `bun test packages/agent/tests/correlation/engine.test.ts`
Expected: FAIL — dormant rule tests still hand-build `data: {consumerGroups: ...}` which is now ignored. Task 9 migrates them.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/correlation/rules.ts
git commit -m "$(cat <<'EOF'
SIO-764: getKafkaData reads result.kafkaFindings, not result.data

Closes the contract gap left by SIO-681: the rules expected typed
fields but the channel was never populated. Now reading the typed
sibling set by extractFindings. Prose result.data is untouched and
still consumed by the aggregator. Some engine tests fail until they
migrate to the new field — fixed in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Add `withKafkaFindings` helper and migrate dormant-rule tests

**Files:**
- Modify: `packages/agent/tests/correlation/test-helpers.ts`
- Modify: `packages/agent/tests/correlation/engine.test.ts`

- [ ] **Step 1: Add the helper**

In `packages/agent/tests/correlation/test-helpers.ts`, alongside the existing `withKafkaResult` (around line 41), add:

```ts
import type { KafkaFindings } from "@devops-agent/shared";

export function withKafkaFindings(state: AgentStateType, kafkaFindings: KafkaFindings): AgentStateType {
	return {
		...state,
		dataSourceResults: [
			...state.dataSourceResults,
			{
				dataSourceId: "kafka",
				status: "success",
				data: "prose summary placeholder",
				duration: 100,
				kafkaFindings,
			} as never,
		],
	};
}
```

(`KafkaFindings` import — adjust depending on whether `test-helpers.ts` already imports from `@devops-agent/shared`. Add the import if missing.)

- [ ] **Step 2: Migrate the kafka-empty-or-dead-groups test**

Find the test in `packages/agent/tests/correlation/engine.test.ts` (around line 8):

```ts
test("fires when at least one Empty or Dead group exists", () => {
	const state = withKafkaResult(baseState(), {
		consumerGroups: [
			{ id: "notification-service", state: "Empty" },
			{ id: "payments-service", state: "Stable", totalLag: 0 },
		],
	});
	const decisions = evaluate(state, correlationRules);
	const rule = decisions.find((d) => d.rule.name === "kafka-empty-or-dead-groups");
	expect(rule?.status).toBe("needs-invocation");
	expect(rule?.match?.context).toEqual({ groupIds: ["notification-service"] });
});
```

Replace the `withKafkaResult(baseState(), {...})` call with `withKafkaFindings(baseState(), {...})`. Keep the rest of the test body identical:

```ts
test("fires when at least one Empty or Dead group exists", () => {
	const state = withKafkaFindings(baseState(), {
		consumerGroups: [
			{ id: "notification-service", state: "Empty" },
			{ id: "payments-service", state: "Stable", totalLag: 0 },
		],
	});
	const decisions = evaluate(state, correlationRules);
	const rule = decisions.find((d) => d.rule.name === "kafka-empty-or-dead-groups");
	expect(rule?.status).toBe("needs-invocation");
	expect(rule?.match?.context).toEqual({ groupIds: ["notification-service"] });
});
```

- [ ] **Step 3: Migrate the kafka-significant-lag tests**

Find each test in `engine.test.ts` whose `describe()` block names `kafka-significant-lag` (verified existing at lines 31-48 during exploration; there may be 1-3 tests in that block). For each, replace `withKafkaResult` with `withKafkaFindings`. The structured payload shape stays identical — both helpers accept `{consumerGroups: [...]}` style data.

- [ ] **Step 4: Migrate the kafka-dlq-growth tests**

These rely on `dlqTopics[]` which is still in `KafkaFindingsSchema` (Phase A includes the schema; extraction lands in Phase B). Replace `withKafkaResult(state, {dlqTopics: [...]})` with `withKafkaFindings(state, {dlqTopics: [...]})`. The rule remains dormant in production until Phase B, but the test confirms the rule code is correct.

- [ ] **Step 5: Leave the kafka-tool-failures tests alone**

That rule is the sidecar bug-fix scope, not this plan. The test (around line 77-85) reads `result.data.toolErrors[]` which corresponds to a non-existent field — it's already broken, and the sidecar ticket fixes it. Don't touch in this PR.

- [ ] **Step 6: Run the engine tests**

Run: `bun test packages/agent/tests/correlation/engine.test.ts`
Expected: All migrated tests PASS. The `kafka-tool-failures` tests may continue to fail/skip — that's expected pre-sidecar.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/tests/correlation/test-helpers.ts packages/agent/tests/correlation/engine.test.ts
git commit -m "$(cat <<'EOF'
SIO-764: migrate dormant-rule tests to populate kafkaFindings

withKafkaFindings helper mirrors withKafkaResult but populates the
new typed sibling field instead of result.data. Tests for
kafka-empty-or-dead-groups, kafka-significant-lag, and kafka-dlq-growth
switch over. kafka-tool-failures test is left as-is (separate sidecar
sub-ticket for its nested-field bug).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Run the full package test + lint + typecheck

**Files:** none (validation)

- [ ] **Step 1: Typecheck across all packages**

Run: `bun run typecheck`
Expected: `Exited with code 0` (no errors in any workspace package).

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: `Exited with code 0`. If Biome flags the new files for import order, run `bun run lint:fix` and inspect the diff before continuing.

- [ ] **Step 3: Full test suite**

Run: `bun run test`
Expected: All tests pass. Note any agent-package tests asserting on graph shape — if they hard-code 13 nodes, they need updating to 14. Update the assertion to `14` and re-run.

- [ ] **Step 4: Commit any lint/test fixups**

```bash
git status
# If there are pending fixups:
git add <files>
git commit -m "$(cat <<'EOF'
SIO-764: test + lint fixups for the 14-node pipeline

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Update CLAUDE.md and the architecture doc

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/architecture/agent-pipeline.md`

- [ ] **Step 1: Update CLAUDE.md pipeline summary**

In `CLAUDE.md`, find the "Agent Pipeline (13-node LangGraph StateGraph)" heading. Update to "Agent Pipeline (14-node LangGraph StateGraph)". In the diagram block underneath:

```
... -> aggregate -> {enforceCorrelationsRouter}
  -> [correlationFetch ->] enforceCorrelationsAggregate
```

Change to:

```
... -> aggregate -> extractFindings -> {enforceCorrelationsRouter}
  -> [correlationFetch ->] enforceCorrelationsAggregate
```

Below the diagram, find the SIO-681 paragraph and append a sentence:

> SIO-764 added the `extractFindings` node immediately after `aggregate`; it reads each sub-agent's `toolOutputs[]` and derives per-domain typed findings (`kafkaFindings`) onto the `DataSourceResult` for the rule engine to consume.

- [ ] **Step 2: Update the architecture doc**

In `docs/architecture/agent-pipeline.md`, update the full diagram (find any ASCII art or mermaid block listing the node order) to insert `extractFindings` between `aggregate` and `enforceCorrelationsRouter`. Add a new subsection at the end of the rule-engine section:

```markdown
## Findings extraction (SIO-764)

The `extractFindings` node runs immediately after `aggregate` and before `enforceCorrelationsRouter`. It is a pure-function node — no I/O, no LLM call — that reads each `DataSourceResult.toolOutputs[]` (populated by `sub-agent.ts` from ReAct tool messages) and writes derived typed findings onto sibling fields like `DataSourceResult.kafkaFindings`. Rule helpers consume the typed sibling instead of casting `result.data` (which remains the LLM prose summary used by the aggregator and UI).

The node soft-fails per result: a broken extractor leaves its agent's findings undefined, the affected rules stay dormant for that turn, and the rest of the run proceeds normally. Phase A wires Kafka only; gitlab/couchbase extractors are deferred until their MCP servers expose the source tools.
```

- [ ] **Step 3: Typecheck once more (docs shouldn't break anything, but cheap to confirm)**

Run: `bun run typecheck`
Expected: `Exited with code 0`

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/architecture/agent-pipeline.md
git commit -m "$(cat <<'EOF'
SIO-764: docs — 14-node pipeline and findings extraction subsection

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Open the PR

**Files:** none (git operation)

- [ ] **Step 1: Push the branch**

```bash
# If you're on main, create a feature branch first:
git checkout -b sio-764-phase-a-kafka-structured-findings
git push -u origin sio-764-phase-a-kafka-structured-findings
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "SIO-764: Phase A — kafka structured findings + extractFindings node" --body "$(cat <<'EOF'
## Summary
- Populate `DataSourceResult.toolOutputs[]` from ReAct tool messages (was always `[]`)
- New `extractFindings` graph node (pure function, soft-fail per agent) derives typed `kafkaFindings` on each result
- Migrate `getKafkaData()` rule helper to read the typed sibling instead of `result.data`
- Two previously-dormant rules now fire in production: `kafka-empty-or-dead-groups`, `kafka-significant-lag`
- Pipeline grows from 13 to 14 nodes

## Out of scope
- gitlab + couchbase extractors (source MCP tools don't exist yet — separate sub-tickets)
- `kafka_list_dlq_topics` MCP tool exposure (Phase B sub-ticket)
- `kafka-tool-failures` field-name bug fix (independent sidecar sub-ticket)

## Test plan
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` clean
- [ ] `bun run test` passes; extractor + node unit tests cover the merge and soft-fail paths
- [ ] Manual integration: `bun run dev`, fire a Kafka query that calls `kafka_list_consumer_groups` + `kafka_get_consumer_group_lag`, inspect the LangSmith trace for the `extractFindings` node and confirm `kafkaFindings.consumerGroups[]` is populated
- [ ] Regression check: rerun the SIO-767 manual-validation query ("How is my AWS landscape?") and confirm answer shape unchanged

Refs: spec `docs/superpowers/specs/2026-05-16-sio-764-structured-findings-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: After CI passes and review approves, merge.** Per CLAUDE.md, never set the Linear ticket to "Done" without user approval — set to "In Review" on PR open, leave for user to close after merge.

---

## Verification end-to-end (post-PR)

1. **Unit:** All tests in `packages/agent/` and `packages/shared/` pass.
2. **Type/lint:** `bun run typecheck && bun run lint` clean across the workspace.
3. **Integration replay:** start `bun run dev`, fire a Kafka-related query (e.g. "what's the state of consumer group notification-service?") that triggers `kafka_list_consumer_groups` and/or `kafka_get_consumer_group_lag`. In the LangSmith trace:
   - The `extractFindings` node appears between `aggregate` and `enforceCorrelationsRouter`.
   - The kafka `DataSourceResult` in `extractFindings`'s output has `kafkaFindings.consumerGroups` populated with `{id, state, totalLag}` entries.
   - If conditions met, `enforceCorrelationsAggregate` shows `kafka-empty-or-dead-groups` or `kafka-significant-lag` evaluating as fired.
   - The final aggregator output and validator output are unchanged in shape (prose `result.data` was untouched).
4. **No-regression:** rerun the SIO-767 canonical query ("How is my AWS landscape?") — touches no kafka rules — confirm answer shape, confidence, and the 12 live rules' behaviour are identical to pre-merge.

---

## Follow-up sub-tickets to file after this lands

(Created in Linear after the implementation PR is merged. None are "Done" without user approval per CLAUDE.md.)

1. **Sidecar — kafka-tool-failures field-name fix.** `result.data.toolErrors[]` is nested at a path that has never existed; the helper should read top-level `result.toolErrors`. ~30 min.
2. **Phase B — Expose `kafka_list_dlq_topics` MCP tool.** Service method exists at `packages/mcp-server-kafka/src/services/kafka.ts:308`; needs MCP tool registration + Zod arg schema + integration test. Extend `extractors/kafka.ts` to populate `dlqTopics[]` once the tool is available. Unblocks `kafka-dlq-growth` rule.
3. **GitLab merge-request listing tool.** Add a native tool to `packages/mcp-server-gitlab/` returning merged MRs with `{title, mergedAt, projectId}`. Then add `extractors/gitlab.ts` + `gitlabFindings` field. Unblocks the gitlab side of `gitlab-deploy-vs-datastore-runtime`.
4. **Couchbase slow-queries tool clarification.** Either confirm `capella_get_longest_running_queries` is the slow-queries equivalent and adapt the rule to its response shape, or add a dedicated slow-queries tool. Then add `extractors/couchbase.ts` + `couchbaseFindings` field. Unblocks the couchbase side of `gitlab-deploy-vs-datastore-runtime`.
5. **Phase C parent — Findings extractors for remaining datasources, on demand.** When a future correlation rule needs structured signals from AWS, Elastic, Konnect, or Atlassian, add the matching `*FindingsSchema` + extractor following the Kafka pattern in this PR.
