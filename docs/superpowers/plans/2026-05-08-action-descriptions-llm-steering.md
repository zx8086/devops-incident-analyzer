# Per-Action Descriptions for LLM Steering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Steer the entity extractor's LLM toward picking the right kafka-introspect action by adding optional per-action prose descriptions to the YAML schema, populating them in `kafka-introspect.yaml`, and threading them into the entity extractor's `buildActionCatalog()` output.

**Architecture:** Three-layer additive change. (1) Optional `action_descriptions` field on `tool_mapping` Zod schema with a `superRefine` cross-field check (keys must subset `action_tool_map`). (2) `buildActionCatalog()` refactored into a pure formatter that emits indented multi-line per-tool when descriptions are present, comma-separated otherwise. (3) `kafka-introspect.yaml` gets descriptions for all 12 actions; the 5 sibling YAMLs are intentionally untouched and continue to work via the fallback format.

**Tech Stack:** Zod v4.3.6 (schema), TypeScript strict, Bun test runner, YAML.

**Spec:** `docs/superpowers/specs/2026-05-08-action-descriptions-llm-steering-design.md` (commit `c2da6a8`).

---

## Task 1: Schema extension + cross-field validation

The schema lands first. With the `superRefine` check in place, every subsequent task can rely on the constraint at parse time.

**Files:**
- Modify: `packages/gitagent-bridge/src/types.ts` (the `ToolDefinitionSchema.tool_mapping` block, currently lines 76-93)
- Create: `packages/gitagent-bridge/src/types.test.ts` (new, 3 tests)

- [ ] **Step 1: Write the failing tests**

Create `packages/gitagent-bridge/src/types.test.ts`:

```typescript
// packages/gitagent-bridge/src/types.test.ts
import { describe, expect, test } from "bun:test";
import { ToolDefinitionSchema } from "./types.ts";

describe("ToolDefinitionSchema action_descriptions", () => {
	test("accepts descriptions whose keys are a subset of action_tool_map keys", () => {
		const result = ToolDefinitionSchema.safeParse({
			name: "x",
			description: "x",
			input_schema: {},
			tool_mapping: {
				mcp_server: "x",
				mcp_patterns: ["x_*"],
				action_tool_map: { a: ["x_a"], b: ["x_b"] },
				action_descriptions: { a: "alpha" },
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects descriptions referencing keys absent from action_tool_map", () => {
		const result = ToolDefinitionSchema.safeParse({
			name: "x",
			description: "x",
			input_schema: {},
			tool_mapping: {
				mcp_server: "x",
				mcp_patterns: ["x_*"],
				action_tool_map: { a: ["x_a"] },
				action_descriptions: { a: "alpha", ghost: "boo" },
			},
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const offendingPaths = result.error.issues.flatMap((i) => i.path);
			expect(offendingPaths.includes("ghost")).toBe(true);
		}
	});

	test("accepts tool_mapping with no action_descriptions at all", () => {
		const result = ToolDefinitionSchema.safeParse({
			name: "x",
			description: "x",
			input_schema: {},
			tool_mapping: {
				mcp_server: "x",
				mcp_patterns: ["x_*"],
				action_tool_map: { a: ["x_a"] },
			},
		});
		expect(result.success).toBe(true);
	});
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test packages/gitagent-bridge/src/types.test.ts
```

Expected: 1 pass / 2 fail. The "accepts descriptions whose keys are a subset" test passes today because Zod's default `z.record(z.string(), z.unknown())` permissively accepts the unknown `action_descriptions` field — wait, actually `ToolDefinitionSchema` uses an explicit object schema, not passthrough, so unknown keys are stripped. Re-check: `z.object()` defaults to stripping unknown keys, so `action_descriptions` is silently dropped today, which means the first test passes (no error) but with `action_descriptions` stripped from the parsed result. The second test fails because there's no validation rejecting `ghost` yet. The third test passes today (legitimately).

If both Test 1 and Test 3 pass while Test 2 fails (1 pass / 2 fail or 2 pass / 1 fail depending on Zod's strip behaviour), the failing baseline is correctly established. Proceed.

- [ ] **Step 3: Implement schema change**

Open `packages/gitagent-bridge/src/types.ts` and locate the `ToolDefinitionSchema` block (currently lines 70-93). Replace the `tool_mapping` field definition with:

```typescript
	tool_mapping: z
		.object({
			mcp_server: z.string().describe("MCP server this facade maps to"),
			mcp_patterns: z.array(z.string()).describe("MCP tool name patterns: exact names or glob with * suffix"),
			action_tool_map: z
				.record(z.string(), z.array(z.string()))
				.optional()
				.describe("Maps action categories to specific MCP tool names"),
			// SIO-680/682: Optional one-line LLM-facing hint per action key.
			// Each value is a single sentence completing "pick this action when ...".
			// Consumed by entity-extractor.buildActionCatalog() to steer action selection.
			// Keys, when present, must be a subset of action_tool_map keys; enforced via superRefine below.
			action_descriptions: z
				.record(z.string(), z.string())
				.optional()
				.describe(
					"Optional one-line LLM-facing hint per action key. Each value is a single sentence completing \"pick this action when ...\". Consumed by entity-extractor.buildActionCatalog() to steer action selection. Keys, when present, must be a subset of action_tool_map keys.",
				),
		})
		.superRefine((tm, ctx) => {
			if (!tm.action_descriptions || !tm.action_tool_map) return;
			const validKeys = new Set(Object.keys(tm.action_tool_map));
			for (const key of Object.keys(tm.action_descriptions)) {
				if (!validKeys.has(key)) {
					ctx.addIssue({
						code: "custom",
						message: `action_descriptions key "${key}" is not in action_tool_map`,
						path: ["action_descriptions", key],
					});
				}
			}
		})
		.optional(),
```

Two non-obvious details:

1. The `.superRefine()` is chained *before* `.optional()`. In Zod v4, `.optional()` wraps the inner schema; placing `.superRefine` first ensures the refinement runs on the resolved object value, not on `undefined`.
2. Inside `superRefine`, both nullish guards (`!tm.action_descriptions`, `!tm.action_tool_map`) are necessary — Zod v4 still calls superRefine with the parsed object even when fields are absent (they show as `undefined`).

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test packages/gitagent-bridge/src/types.test.ts
```

Expected: 3 pass / 0 fail.

- [ ] **Step 5: Run the existing gitagent-bridge suite to confirm no regression**

```bash
bun run --filter '@devops-agent/gitagent-bridge' test
```

Expected: 141 pass / 0 fail (138 existing + 3 new in `types.test.ts`). The existing 6 YAMLs load without `action_descriptions`, which is now valid per the optional schema.

- [ ] **Step 6: Run typecheck and lint**

```bash
bun run typecheck && bun run lint
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/gitagent-bridge/src/types.ts packages/gitagent-bridge/src/types.test.ts
git commit -m "$(cat <<'EOF'
SIO-680,SIO-682: add optional action_descriptions to ToolMappingSchema

Optional Record<string, string> field on tool_mapping for LLM-facing
hints per action. Gated by a Zod superRefine cross-field check that
rejects keys absent from action_tool_map. First .superRefine() in the
codebase -- placement is .object().superRefine().optional() so the
refinement runs on the resolved object, not on undefined.

Test suite: 3 new tests in packages/gitagent-bridge/src/types.test.ts
covering accepts-subset, rejects-missing-key, and absent-block paths.

The 6 existing tool YAMLs load unchanged because the field is
optional. Entity extractor consumption lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Refactor `buildActionCatalog` into a pure helper + tests

The current `buildActionCatalog()` calls `getAgent()` directly, which is module-level cached and can't be cleanly mocked (see SIO-635 comment in `aggregator.test.ts:6-12`). Refactoring into a pure helper that takes the tools array as input avoids any module-level mocking and makes the formatting logic directly unit-testable.

**Files:**
- Modify: `packages/agent/src/entity-extractor.ts` (lines 38-56, the `buildActionCatalog` function)
- Create: `packages/agent/src/entity-extractor.test.ts` (new, 3 tests)

- [ ] **Step 1: Write the failing tests**

Create `packages/agent/src/entity-extractor.test.ts`:

```typescript
// packages/agent/src/entity-extractor.test.ts
import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@devops-agent/gitagent-bridge";
import { formatActionCatalog } from "./entity-extractor.ts";

function makeTool(server: string, actionMap: Record<string, string[]>, descriptions?: Record<string, string>): ToolDefinition {
	return {
		name: `${server}-facade`,
		description: "fixture",
		input_schema: {},
		tool_mapping: {
			mcp_server: server,
			mcp_patterns: [`${server}_*`],
			action_tool_map: actionMap,
			...(descriptions ? { action_descriptions: descriptions } : {}),
		},
	};
}

describe("formatActionCatalog", () => {
	test("emits indented multi-line format when descriptions are present", () => {
		const tools = [
			makeTool(
				"kafka",
				{ consumer_lag: ["k_a"], topic_throughput: ["k_b"] },
				{ consumer_lag: "when groups have rising lag", topic_throughput: "when investigating topic rates" },
			),
		];
		const out = formatActionCatalog(tools);
		expect(out).toContain("- kafka:\n");
		expect(out).toContain("  - consumer_lag — when groups have rising lag");
		expect(out).toContain("  - topic_throughput — when investigating topic rates");
		expect(out).not.toContain("- kafka: consumer_lag");
	});

	test("emits comma-separated format when descriptions are absent", () => {
		const tools = [makeTool("elastic", { search_logs: ["e_a"], count_documents: ["e_b"] })];
		const out = formatActionCatalog(tools);
		expect(out).toContain("- elastic: search_logs, count_documents");
		expect(out).not.toContain("  - search_logs");
	});

	test("decides format per-tool: kafka indented, elastic flat in same agent", () => {
		const tools = [
			makeTool("kafka", { a: ["k_a"] }, { a: "kafka description" }),
			makeTool("elastic", { b: ["e_b"] }),
		];
		const out = formatActionCatalog(tools);
		expect(out).toContain("- kafka:\n  - a — kafka description");
		expect(out).toContain("- elastic: b");
	});

	test("returns empty string when no tools have action_tool_map", () => {
		const tools: ToolDefinition[] = [
			{ name: "x", description: "x", input_schema: {}, tool_mapping: { mcp_server: "x", mcp_patterns: ["x_*"] } },
		];
		expect(formatActionCatalog(tools)).toBe("");
	});

	test("falls back to bare name for actions missing description in a partially-described tool", () => {
		const tools = [
			makeTool("kafka", { a: ["k_a"], b: ["k_b"] }, { a: "alpha only" }),
		];
		const out = formatActionCatalog(tools);
		expect(out).toContain("- kafka:\n");
		expect(out).toContain("  - a — alpha only");
		expect(out).toContain("  - b\n");
		expect(out).not.toContain("  - b — ");
	});
});
```

5 tests total — the original 3 from the spec plus 2 edge cases (empty catalog, partial descriptions) caught during plan review.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test packages/agent/src/entity-extractor.test.ts
```

Expected: 5 fail with "formatActionCatalog is not exported" or "is not a function". This is the failing baseline.

- [ ] **Step 3: Refactor `buildActionCatalog` and export `formatActionCatalog`**

Open `packages/agent/src/entity-extractor.ts`. The current function (lines 38-56) is:

```typescript
function buildActionCatalog(): string {
	try {
		const agent = getAgent();
		const lines: string[] = [];
		for (const tool of agent.tools) {
			if (tool.tool_mapping?.action_tool_map) {
				const actions = Object.keys(tool.tool_mapping.action_tool_map);
				lines.push(`- ${tool.tool_mapping.mcp_server}: ${actions.join(", ")}`);
			}
		}
		if (lines.length === 0) return "";
		return `\nFor each datasource, also identify which tool actions are most relevant to the query.
Available actions per datasource:
${lines.join("\n")}
Return toolActions as { "datasource_id": ["action1", "action2"] }.`;
	} catch {
		return "";
	}
}
```

Replace it with:

```typescript
// SIO-680/682: Pure formatter for the action catalog. Extracted from buildActionCatalog
// so unit tests can supply synthetic ToolDefinition[] without mocking getAgent()
// (see SIO-635: mocking ./prompt-context.ts causes cross-file test pollution).
//
// Per-tool format choice: emits indented multi-line ("- server:\n  - action — desc")
// when at least one action has a description; falls back to the original
// comma-separated single-line ("- server: a, b, c") otherwise. The decision is
// per-tool, not global, so non-kafka YAMLs without descriptions are unaffected.
export function formatActionCatalog(tools: ToolDefinition[]): string {
	const lines: string[] = [];
	for (const tool of tools) {
		const map = tool.tool_mapping?.action_tool_map;
		if (!map) continue;
		const server = tool.tool_mapping?.mcp_server ?? "?";
		const descriptions = tool.tool_mapping?.action_descriptions ?? {};
		const actions = Object.keys(map);
		const hasAnyDescription = actions.some((a) => descriptions[a]);
		if (hasAnyDescription) {
			lines.push(`- ${server}:`);
			for (const a of actions) {
				const desc = descriptions[a];
				lines.push(desc ? `  - ${a} — ${desc}` : `  - ${a}`);
			}
		} else {
			lines.push(`- ${server}: ${actions.join(", ")}`);
		}
	}
	if (lines.length === 0) return "";
	return `\nFor each datasource, also identify which tool actions are most relevant to the query.
Available actions per datasource:
${lines.join("\n")}
Return toolActions as { "datasource_id": ["action1", "action2"] }.`;
}

function buildActionCatalog(): string {
	try {
		const agent = getAgent();
		return formatActionCatalog(agent.tools);
	} catch {
		return "";
	}
}
```

Also add the `ToolDefinition` import at the top of the file. Find the existing import block (lines 1-12) and add the import after the existing `@devops-agent/shared` line:

```typescript
import type { ToolDefinition } from "@devops-agent/gitagent-bridge";
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test packages/agent/src/entity-extractor.test.ts
```

Expected: 5 pass / 0 fail.

- [ ] **Step 5: Run the agent test suite to confirm no regression**

```bash
bun run --filter '@devops-agent/agent' test
```

Expected: PASS — including the existing entity-extractor consumers (`extractEntities`) which still call `buildActionCatalog()` internally with unchanged behaviour for the current YAMLs (none have `action_descriptions` yet, so the comma-separated fallback fires).

- [ ] **Step 6: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/entity-extractor.ts packages/agent/src/entity-extractor.test.ts
git commit -m "$(cat <<'EOF'
SIO-680,SIO-682: extract formatActionCatalog as pure helper for testing

buildActionCatalog() called getAgent() directly, which is module-cached
and can't be mocked without the cross-file test pollution flagged in
SIO-635 (see aggregator.test.ts:6-12). Extracted the formatting logic
into a pure formatActionCatalog(tools: ToolDefinition[]) helper so
unit tests can pass synthetic fixtures.

Format change: when at least one action in a tool has a description,
emits indented multi-line ("- kafka:\n  - consumer_lag — when ...")
instead of comma-separated. Decision is per-tool, so the 5 sibling
YAMLs without descriptions stay on the original format.

5 new tests covering all four format branches plus the empty-catalog
edge case.

YAML population for kafka-introspect.yaml lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Populate `kafka-introspect.yaml` with descriptions for all 12 actions

**Files:**
- Modify: `agents/incident-analyzer/tools/kafka-introspect.yaml` (append `action_descriptions` block under `tool_mapping`)
- Modify: `packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts` (add a 10th `test()` block)

- [ ] **Step 1: Add the failing coverage assertion**

Open `packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts`. The file currently ends with the `preserves the existing action enum entries (no regression)` test. Append a new test inside the same `describe()` block, immediately before the closing `});`:

```typescript
	test("declares action_descriptions for all 12 actions, each non-empty", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka).toBeDefined();
		if (!kafka) return;
		const descriptions = kafka.tool_mapping?.action_descriptions;
		expect(descriptions).toBeDefined();
		if (!descriptions) return;
		const actionKeys = Object.keys(kafka.tool_mapping?.action_tool_map ?? {});
		for (const action of actionKeys) {
			expect(descriptions[action]).toBeDefined();
			expect((descriptions[action] ?? "").length).toBeGreaterThan(20);
		}
		expect(Object.keys(descriptions).length).toBe(12);
	});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
bun test packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts
```

Expected: 9 pass / 1 fail. The new test fails because `kafka-introspect.yaml` has no `action_descriptions` block yet.

- [ ] **Step 3: Append `action_descriptions` to `kafka-introspect.yaml`**

Open `agents/incident-analyzer/tools/kafka-introspect.yaml`. Find the end of `tool_mapping.action_tool_map` (the last entry is `write_ops`, ending around line 120 with `kafka_reset_consumer_group_offsets`). Add the following block immediately after the closing of the action_tool_map (still inside `tool_mapping`, same indentation as `action_tool_map:`):

```yaml
  action_descriptions:
    consumer_lag: when a consumer group shows rising or sustained message lag (e.g. >10k messages, processing latency growing, or stalled partitions)
    topic_throughput: when investigating producer rate, consumer rate, or partition offsets on a specific topic
    dlq_messages: when inspecting dead-letter queue contents (topics suffixed with -dlq, .DLQ, dead-letter-, or similar)
    cluster_info: when checking cluster-wide health (broker count, controller, version) -- not topic- or group-specific
    describe_topic: when needing partition count, replication factor, retention config, or per-partition offsets for a known topic
    schema_registry: when reading Avro/Protobuf/JSON schemas, subject versions, or compatibility config (read-only)
    schema_management: when registering, evolving, or deleting schemas in the Schema Registry (gated by KAFKA_ALLOW_WRITES / KAFKA_ALLOW_DESTRUCTIVE)
    ksql: when querying ksqlDB streams, tables, persistent queries, or running ad-hoc KSQL statements
    connect_status: when Kafka Connect connectors or tasks are failing, paused, or in unknown state -- read-only inspection
    connect_management: when pausing, resuming, restarting, or deleting Kafka Connect connectors (gated by KAFKA_ALLOW_WRITES / KAFKA_ALLOW_DESTRUCTIVE)
    restproxy: when producing to or consuming from Kafka via the Confluent REST Proxy v2 API (writes gated by KAFKA_ALLOW_WRITES)
    write_ops: when producing test messages, creating/altering topics, deleting topics, or resetting consumer group offsets (gated by KAFKA_ALLOW_WRITES / KAFKA_ALLOW_DESTRUCTIVE)
```

Indentation must match `action_tool_map:` (2-space block style). Each description value is on a single line — yamllint will reject continuation that breaks the schema's `Record<string, string>` shape.

- [ ] **Step 4: Run yamllint**

```bash
bun run yaml:check
```

Expected: PASS.

- [ ] **Step 5: Run the coverage test to confirm it passes**

```bash
bun test packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts
```

Expected: 10 pass / 0 fail.

- [ ] **Step 6: Run the full gitagent-bridge suite**

```bash
bun run --filter '@devops-agent/gitagent-bridge' test
```

Expected: 142 pass / 0 fail (141 from Task 1's baseline + 1 new in `kafka-introspect-coverage.test.ts`).

- [ ] **Step 7: Manual sanity — verify the catalog format**

```bash
bun -e "
import { loadAgent } from './packages/gitagent-bridge/src/index.ts';
import { formatActionCatalog } from './packages/agent/src/entity-extractor.ts';
import { getAgentsDir } from './packages/agent/src/paths.ts';
const agent = loadAgent(getAgentsDir());
console.log(formatActionCatalog(agent.tools));
"
```

Expected output: kafka block uses indented multi-line format with the 12 descriptions; elastic / couchbase / konnect / gitlab / atlassian use the original comma-separated format. Visually confirm both branches fire.

If the snippet errors with "getAgentsDir is not exported" or similar path issue, replace with the literal directory:

```bash
bun -e "
import { loadAgent } from './packages/gitagent-bridge/src/index.ts';
import { formatActionCatalog } from './packages/agent/src/entity-extractor.ts';
const agent = loadAgent('agents/incident-analyzer');
console.log(formatActionCatalog(agent.tools));
"
```

- [ ] **Step 8: Run typecheck and lint**

```bash
bun run typecheck && bun run lint
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add agents/incident-analyzer/tools/kafka-introspect.yaml packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts
git commit -m "$(cat <<'EOF'
SIO-680,SIO-682: action_descriptions for all 12 kafka-introspect actions

Each description starts with "when" so it reads as a selection
criterion in the entity extractor's action catalog. Explicitly
distinguishes overlapping pairs (schema_registry vs schema_management,
connect_status vs connect_management, cluster_info vs describe_topic)
and flags KAFKA_ALLOW_WRITES / KAFKA_ALLOW_DESTRUCTIVE gating wherever
it applies, so the LLM doesn't pick a destructive action for a benign
read intent.

Coverage test extended to assert all 12 keys present, each value
non-empty (>20 chars). Total kafka-introspect-coverage assertions: 10.

The 5 sibling YAMLs (elastic-logs, couchbase-health, konnect-gateway,
gitlab-api, atlassian-api) intentionally remain without descriptions
and continue to use the comma-separated catalog format -- per-YAML
adoption is a separate follow-up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Document the new field in `action-tool-maps.md`

**Files:**
- Modify: `docs/development/action-tool-maps.md` (append a subsection)

- [ ] **Step 1: Locate the right section**

Open `docs/development/action-tool-maps.md`. Find the section that documents the YAML schema for `tool_mapping`. If there's no dedicated subsection, the new content should go immediately after the table that documents `action_tool_map` shape. If unsure where, search for the string `action_tool_map` and place the new subsection after the first prose explanation of that field.

```bash
grep -n "action_tool_map" docs/development/action-tool-maps.md | head -5
```

This locates the candidate insertion points. Pick the one that appears in a "schema" or "structure" subsection rather than the example-walkthrough section.

- [ ] **Step 2: Add the new subsection**

Append the following block at the chosen location:

```markdown
### `action_descriptions` (optional, SIO-680/682)

Each `tool_mapping.action_descriptions` entry is a one-line, LLM-facing hint that completes the sentence "pick this action when ...". The entity extractor (`packages/agent/src/entity-extractor.ts`, `formatActionCatalog`) emits these descriptions in its action catalog so the LLM has explicit selection criteria instead of inferring from bare action names.

| Constraint | Enforcement |
|---|---|
| Optional per action | Absent keys are silently allowed; LLM gets a bare name for those actions |
| Optional per YAML | Whole field can be absent; the YAML's catalog block uses the legacy comma-separated format |
| Keys must be a subset of `action_tool_map` keys | Zod `superRefine` cross-field check in `packages/gitagent-bridge/src/types.ts` |
| Each value is a single non-empty string | Type `Record<string, string>` |

Format change in the catalog when descriptions are present (per-tool decision):

```
- kafka:
  - consumer_lag — when a consumer group shows rising or sustained message lag (...)
  - topic_throughput — when investigating producer rate, consumer rate (...)
- elastic: search_logs, count_documents, ...   (unchanged: no descriptions today)
```

Currently populated for `kafka-introspect.yaml` only. Adding descriptions to the 5 sibling YAMLs is a follow-up; each requires per-action wording.
```

- [ ] **Step 3: Verify the doc renders cleanly**

```bash
grep -A 30 "action_descriptions" docs/development/action-tool-maps.md | head -40
```

Visually inspect the table alignment and code-fence balance. No automated check exists for markdown rendering in this repo.

- [ ] **Step 4: Commit**

```bash
git add docs/development/action-tool-maps.md
git commit -m "$(cat <<'EOF'
SIO-680,SIO-682: document action_descriptions in action-tool-maps.md

New subsection covering the optional Record<string, string> field,
the Zod superRefine cross-field constraint, the per-tool format
change in formatActionCatalog, and the deliberate non-population of
the 5 sibling YAMLs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Final cross-check before push

- [ ] **Step 1: Re-run the full validation sweep**

```bash
bun run typecheck && bun run lint && bun run yaml:check && bun test packages/gitagent-bridge/ && bun test packages/agent/src/entity-extractor.test.ts
```

Expected: PASS on all five. If any step fails, stop — diagnose and fix in place rather than pushing a broken state.

- [ ] **Step 2: Inspect the four commits**

```bash
git log origin/main..HEAD --stat
```

Expected: 4 commits in this order (schema → entity-extractor → YAML+coverage → docs), totaling ~280 lines added across:
- `packages/gitagent-bridge/src/types.ts` (~25 lines added)
- `packages/gitagent-bridge/src/types.test.ts` (~50 lines new)
- `packages/agent/src/entity-extractor.ts` (~30 lines added/modified)
- `packages/agent/src/entity-extractor.test.ts` (~70 lines new)
- `agents/incident-analyzer/tools/kafka-introspect.yaml` (~14 lines added)
- `packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts` (~15 lines added)
- `docs/development/action-tool-maps.md` (~25 lines added)

- [ ] **Step 3: End-to-end smoke against the real loaded agent**

```bash
bun -e "
import { loadAgent } from './packages/gitagent-bridge/src/index.ts';
import { formatActionCatalog } from './packages/agent/src/entity-extractor.ts';
const agent = loadAgent('agents/incident-analyzer');
const out = formatActionCatalog(agent.tools);
const hasIndentedKafka = out.includes('- kafka:\n  - consumer_lag — when');
const hasFlatElastic = /- elastic: [a-z_, ]+\n/.test(out);
console.log('kafka indented:', hasIndentedKafka);
console.log('elastic flat:', hasFlatElastic);
console.log('kafka block length:', out.split('- kafka:')[1].split('\n- ')[0].length);
if (!hasIndentedKafka || !hasFlatElastic) {
  console.error('FAIL: format branches did not both fire');
  process.exit(1);
}
console.log('OK');
"
```

Expected output: `kafka indented: true`, `elastic flat: true`, `OK`.

- [ ] **Step 4: Push (await user authorization)**

The user must explicitly authorize `git push`. Do not push autonomously. When authorized:

```bash
git push origin main
```

---

## Verification (manual smoke after merge)

Not automated, documented for the human reviewer:

1. **Live entity-extractor system prompt**: enable LangSmith tracing locally (`LANGSMITH_API_KEY=...`), submit a kafka-related incident query through the agent, fetch the resulting trace, and verify the `extractEntities` system prompt now contains the indented kafka action catalog with all 12 descriptions. The trace's `toolActions` field should reference the action keys without descriptions (the LLM picks keys, not descriptions).

2. **Action selection drift check**: pick 3-5 deliberately-ambiguous queries (e.g. "schema config is broken", "rest proxy producer issue", "connector failed") and confirm the entity extractor returns the *intended* action (`schema_registry`, `restproxy`, `connect_status`) rather than the previous miss. No automated harness exists for this — this is a manual qualitative check.

3. **Sibling YAML regression**: confirm the elastic / couchbase / konnect / gitlab / atlassian datasource queries still work end-to-end. The format change is per-tool; their bare-name catalog should remain unchanged.

## Out of scope

- `action_descriptions` for the 5 non-kafka YAMLs.
- Action renames (declined during brainstorming).
- Other YAML prose surfaces (`description`, `prompt_template`, `related_tools`, `input_schema.action.description`) — none reach the entity extractor today.
- Building an automated LLM-action-selection eval harness.
- Adjusting the entity-extractor system prompt itself beyond the catalog block.
- Pushing to remote — last step requires explicit user authorization per repo guardrails.
