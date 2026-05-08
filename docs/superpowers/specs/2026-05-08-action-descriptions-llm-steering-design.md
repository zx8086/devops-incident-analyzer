# Spec: per-action descriptions for LLM-driven action selection

**Date:** 2026-05-08
**Tickets:** SIO-680, SIO-682 (extension of the kafka-introspect.yaml v2.0.0 work; reuses originating tickets per memory rule).

## Context

The orchestrator's entity extractor (`packages/agent/src/entity-extractor.ts:38-56`) builds a per-LLM-call "action catalog" that lists which curated actions each datasource exposes. Today it emits a bare comma-separated list:

```
- kafka: consumer_lag, topic_throughput, dlq_messages, cluster_info, describe_topic, schema_registry, schema_management, ksql, connect_status, connect_management, restproxy, write_ops
```

The LLM has to infer each action's intent from the bare name. With the SIO-680/682 expansion to 12 actions, several names are now ambiguous:

- `restproxy` — opaque single word; reads or writes?
- `schema_management` vs `schema_registry` — which is the read path?
- `connect_status` vs `connect_management` — overlap unclear without context
- `cluster_info` vs `describe_topic` — both touch topic-adjacent metadata
- `write_ops` — whose writes? gated by what?
- `ksql` — query, list, or run?

When the entity extractor picks the wrong action, the kafka sub-agent's tier-1 selection (`packages/agent/src/sub-agent.ts:114`) returns the wrong tools, then falls through to tier-2 (full curated catalog, capped at 25 by `MAX_TOOLS_PER_AGENT`). The action-tool-map then carries no signal — exactly the regression that SIO-641's curated-set design was meant to prevent.

The fix is to give the LLM disambiguating prose at the point where it picks actions. The YAML schema does not currently carry per-action descriptions; this spec adds them as an optional field, teaches the entity extractor to use them when present, and populates kafka-introspect.yaml with descriptions for all 12 actions.

## Goal

Add per-action LLM-facing descriptions to the YAML schema and entity extractor so kafka-introspect.yaml can steer the entity extractor's action selection. Optional schema field, additive YAML change, additive prompt-format change, no impact on the 5 non-kafka YAMLs.

## Decisions (locked via brainstorming)

1. **Schema:** `action_descriptions: Record<string, string>` is **optional per action**, gated by a Zod cross-field check that rejects keys absent from `action_tool_map`.
2. **Format change in entity extractor:** indented multi-line format only when at least one action in that tool has a description; bare-name format unchanged otherwise.
3. **Scope of YAML population:** kafka-introspect.yaml only. The 5 sibling YAMLs (elastic-logs, couchbase-health, konnect-gateway, gitlab-api, atlassian-api) keep their existing format and are a separate follow-up.
4. **Other YAML prose surfaces left untouched:** top-level `description`, `input_schema.action.description`, `prompt_template`, `related_tools` are unchanged. The user's earlier multi-select picked all four, but only `action_descriptions` reaches the LLM via `buildActionCatalog()`. The other three would be human-only documentation and are out of scope here — flagged in §"Out of scope" so the user can request them as a follow-up.

## Detailed design

### Change 1: Schema — `packages/gitagent-bridge/src/types.ts`

Add `action_descriptions` to the `tool_mapping` shape inside `ToolDefinitionSchema`:

```typescript
tool_mapping: z
  .object({
    mcp_server: z.string().describe("MCP server this facade maps to"),
    mcp_patterns: z.array(z.string()).describe(
      "MCP tool name patterns: exact names or glob with * suffix"
    ),
    action_tool_map: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe("Maps action categories to specific MCP tool names"),
    action_descriptions: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Optional one-line LLM-facing hint per action key. " +
        "Each value is a single sentence completing 'pick this action when ...'. " +
        "Consumed by entity-extractor.buildActionCatalog() to steer action selection. " +
        "Keys, when present, must be a subset of action_tool_map keys."
      ),
  })
  .optional()
  .superRefine((tm, ctx) => {
    if (!tm?.action_descriptions || !tm?.action_tool_map) return;
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
  }),
```

`.superRefine()` is the Zod v4 idiom for cross-field validation; the codebase has no existing `.refine()` usage so this is a new pattern. Documented inline.

### Change 2: Entity extractor — `packages/agent/src/entity-extractor.ts`

Replace `buildActionCatalog()`:

```typescript
function buildActionCatalog(): string {
  try {
    const agent = getAgent();
    const lines: string[] = [];
    for (const tool of agent.tools) {
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
  } catch {
    return "";
  }
}
```

Behaviour matrix:

| YAML state | Output |
|---|---|
| `action_tool_map` absent | tool skipped (unchanged) |
| `action_tool_map` present, `action_descriptions` absent | `- kafka: a, b, c` (unchanged from today) |
| `action_tool_map` present, `action_descriptions` present and complete | `- kafka:\n  - a — desc\n  - b — desc\n  - c — desc` |
| `action_tool_map` present, `action_descriptions` partial | `- kafka:\n  - a — desc\n  - b\n  - c — desc` (bare lines for actions without descriptions) |

Indent uses two spaces (matches YAML block style; LLMs handle this format reliably).

### Change 3: YAML — `agents/incident-analyzer/tools/kafka-introspect.yaml`

Append `action_descriptions` block under `tool_mapping` (after `action_tool_map`):

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

All 12 keys covered. Each line:
- starts with "when" so it reads as a selection criterion;
- explicitly distinguishes overlapping pairs (`schema_registry` vs `schema_management`, `connect_status` vs `connect_management`, `cluster_info` vs `describe_topic`);
- flags gating wherever it applies, so the LLM doesn't pick a destructive action for a benign read intent.

### Change 4: Tests

#### Test A — schema cross-field check
**File:** `packages/gitagent-bridge/src/types.test.ts` (new, 1 file).

```typescript
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
      expect(result.error.issues.some((i) => i.path.includes("ghost"))).toBe(true);
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

#### Test B — entity-extractor format
**File:** `packages/agent/src/entity-extractor.test.ts` (new, 1 file).

Need to mock `getAgent()` from `./prompt-context.ts`. Bun's `mock.module()` (Bun-test idiom) handles this. The test asserts:
1. A tool with `action_descriptions` produces the multi-line indented format (`- kafka:\n  - consumer_lag — when ...`).
2. A tool without `action_descriptions` produces the original bare-name format (`- elastic: search_logs, count_documents`).
3. A mixed-state agent (kafka with descriptions, elastic without) produces the *correct* format per tool — the format choice is per-tool, not global.

Note: `buildActionCatalog` is NOT exported today (line 38, no `export` keyword). The test needs either:
- (Option B1) Export it from `entity-extractor.ts` so the test can call it directly.
- (Option B2) Test through the public `extractEntities()` and assert on the prompt sent to the LLM via the mocked `createLlm()`.

**Decision: B1.** Smaller diff, zero coupling to LLM mocking infrastructure. Add `export` keyword to `buildActionCatalog`.

#### Test C — coverage regression
**File:** `packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts` (existing, +1 assertion).

Add a 10th `test()` block:

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
    expect(descriptions[action]?.length).toBeGreaterThan(20);
  }
  expect(Object.keys(descriptions).length).toBe(12);
});
```

The `>20` length check is a minimal sanity bound — the spec's shortest description is "when querying ksqlDB streams, tables, persistent queries, or running ad-hoc KSQL statements" (~85 chars), so 20 is a safe floor that catches accidental empty strings or one-word entries without false-positives.

### Change 5: Type re-export

`packages/gitagent-bridge/src/index.ts` re-exports `ToolDefinition` and the inferred type already includes the new field via `z.infer<typeof ToolDefinitionSchema>`. No change needed here.

### Change 6: Documentation

`docs/development/action-tool-maps.md` — add a brief subsection under "Per-tool YAML schema" documenting the new `action_descriptions` field, the Zod cross-field check, and the entity-extractor format change. ~10-15 lines.

## Tool count math (sanity)

Unchanged from `4551d94`: 12 actions, 55 unique tools. This spec adds *prose* per action; tool counts and names are not touched.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `superRefine` is the only Zod cross-field check in the codebase; future contributors may not recognize the pattern | Inline JSDoc on the field describing the constraint; new test (`types.test.ts`) provides a runnable example; spec note in this section. |
| Multi-line format change leaks into LLM prompt for non-kafka tools by accident | Logic gates on `hasAnyDescription` per tool, not globally. Test B asserts the per-tool isolation. |
| Description text drifts from the underlying MCP tool prompts (`packages/mcp-server-kafka/src/tools/*/prompts.ts`) | Description targets *action selection* (what intent picks this); MCP tool prompts target *tool execution* (how to call this tool). Different audiences, no overlap to drift. Documented in `action-tool-maps.md` update. |
| Inflated entity-extractor system prompt | 12 lines × ~110 chars = ~1.3k chars added. Negligible against typical 4-8k system prompt; well under model context limits. |
| New optional schema field invalidates existing YAML loads | Field is `.optional()`; verified the existing 6 YAMLs load cleanly via `bun test packages/gitagent-bridge/src/index.test.ts`. |
| `action_descriptions` keys could fall out of sync with `action_tool_map` after future kafka-introspect.yaml edits | Schema cross-field check + new coverage assertion in `kafka-introspect-coverage.test.ts` catch drift at test time. |

## Out of scope

- Adding `action_descriptions` to `elastic-logs.yaml`, `couchbase-health.yaml`, `konnect-gateway.yaml`, `gitlab-api.yaml`, `atlassian-api.yaml` — separate follow-up. Each would benefit but each has its own per-action wording effort.
- Top-level `description`, `input_schema.action.description`, `prompt_template`, `related_tools` updates in kafka-introspect.yaml — none reach the entity extractor today; would be human-readability polish only.
- Action renames (e.g. `restproxy` → `restproxy_topic_metadata`) — explicitly declined during brainstorming.
- LLM behavioural eval / regression testing — there are no existing action-selection evals in this repo; building the harness is its own scope. Test C's structural pin and Test B's format pin guard the *infrastructure*, not the LLM's selection quality.
- Adjusting the entity-extractor system prompt itself (lines 86-90) beyond the `buildActionCatalog()` output format.

## Verification

```bash
# Schema + tests
bun run --filter '@devops-agent/gitagent-bridge' test
# Expect: kafka-introspect-coverage.test.ts at 10/10, types.test.ts new (3/3), no regressions

# Entity extractor test
bun run --filter '@devops-agent/agent' test
# Expect: entity-extractor.test.ts new (3/3), no regressions

# Format checks
bun run typecheck && bun run lint && bun run yaml:check
# Expect: all pass

# Manual sanity — print buildActionCatalog output and visually confirm format
bun -e "
  import { buildActionCatalog } from './packages/agent/src/entity-extractor.ts';
  console.log(buildActionCatalog());
"
# Expect: kafka block uses indented multi-line; elastic/couchbase/konnect/gitlab/atlassian use comma-separated
```

## Commit shape

Single commit (or split if scope warrants — leave to the writing-plans phase). Suggested files:

- `packages/gitagent-bridge/src/types.ts` — schema extension
- `packages/gitagent-bridge/src/types.test.ts` — new (3 tests)
- `packages/gitagent-bridge/src/kafka-introspect-coverage.test.ts` — +1 assertion
- `packages/agent/src/entity-extractor.ts` — buildActionCatalog format + export
- `packages/agent/src/entity-extractor.test.ts` — new (3 tests)
- `agents/incident-analyzer/tools/kafka-introspect.yaml` — +13 lines (`action_descriptions` block)
- `docs/development/action-tool-maps.md` — +10-15 lines documenting the new field

Commit message prefix: `SIO-680,SIO-682:` (extension of the originating tickets, no new Linear issue per memory rule).
