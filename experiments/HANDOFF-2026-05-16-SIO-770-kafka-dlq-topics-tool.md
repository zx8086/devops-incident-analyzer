# Handover — SIO-770: expose `kafka_list_dlq_topics` MCP tool + dlqTopics extractor

**Date:** 2026-05-16
**Linear:** [SIO-770](https://linear.app/siobytes/issue/SIO-770) (Todo · Medium)
**Parent epic:** [SIO-764](https://linear.app/siobytes/issue/SIO-764) (Done — Phase A merged as PR #101 / commit `3268a1a`)
**Repo state:** `main` at `3268a1a` — SIO-764 Phase A merged; the `kafkaFindings.dlqTopics` schema slot exists but is empty
**Branch suggestion:** `sio-770-kafka-list-dlq-topics-tool`

This document is self-contained — you can pick up SIO-770 without re-reading the SIO-764 epic history.

---

## TL;DR

The `kafka-dlq-growth` correlation rule reads `kafkaFindings.dlqTopics[]`. The schema slot was added by SIO-764 Phase A. The data isn't there because:

1. The service method `listDlqTopics()` exists at `packages/mcp-server-kafka/src/services/kafka.ts:308`, computes `recentDelta` via dual sampling, and returns the exact shape the rule expects.
2. **The service method is never exposed as an MCP tool.** No registration in `tools/read/tools.ts` or `tools-extended.ts`. The sub-agent therefore cannot call it.
3. Since no `toolOutputs[]` entry has `toolName === "kafka_list_dlq_topics"`, the Phase A extractor (`packages/agent/src/correlation/extractors/kafka.ts`) has nothing to read.

This ticket: **register the tool, extend the extractor, verify the rule fires.**

---

## Context: how this ticket came to be

SIO-764 Phase A introduced the structured-findings pattern: capture tool outputs → derive typed findings in a graph node → rules read typed siblings. Phase A wired:

- ✅ `kafka_list_consumer_groups` → `consumerGroups[].state`
- ✅ `kafka_get_consumer_group_lag` → `consumerGroups[].totalLag`
- ❌ `kafka_list_dlq_topics` → `dlqTopics[]` — **MCP tool didn't exist**, so deferred to this ticket.

During Phase A planning we verified that of the 5 originally-dormant rules, `kafka-dlq-growth` was the only one where the source data isn't even computed by an exposed MCP tool. The service-layer logic for DLQ-delta computation exists and is tested in the kafka package, but the tool registration step was never done.

---

## Where the bodies are buried

### What exists today (post-PR #101)

**1. The schema field is defined** in `packages/shared/src/agent-state.ts`:

```typescript
export const KafkaFindingsSchema = z.object({
	consumerGroups: z.array(z.object({
		id: z.string(),
		state: z.string().optional(),
		totalLag: z.number().optional(),
	})).optional(),
	dlqTopics: z.array(z.object({
		name: z.string(),
		totalMessages: z.number(),
		recentDelta: z.number().nullable(),  // null when only one sample taken
	})).optional(),
});
```

**2. The rule already reads it** at `packages/agent/src/correlation/rules.ts:161-173`:

```typescript
{
	name: "kafka-dlq-growth",
	description: "Significant DLQ growth requires cross-checking elastic logs.",
	trigger: (state) => {
		const k = getKafkaData(state);
		const grown = (k.dlqTopics ?? []).filter((t) => (t.recentDelta ?? 0) > 0);
		if (grown.length === 0) return null;
		return { context: { dlqTopicNames: grown.map((t) => t.name) } };
	},
	requiredAgent: "elastic-agent",
	retry: { attempts: 1, timeoutMs: 60_000 },
},
```

`getKafkaData()` (lines 23-33) now reads `result.kafkaFindings` — but with no extractor branch for DLQ tools, `dlqTopics` is always `undefined`.

**3. The service method does the actual work** at `packages/mcp-server-kafka/src/services/kafka.ts:308`:

```typescript
// Read this file directly — the method computes recentDelta via dual sampling.
async listDlqTopics(args: { sampleIntervalMs?: number; topicPrefixes?: string[] } = {}): Promise<DlqTopic[]>
```

Its Zod schema is at `services/kafka.ts:257-269` (verify exact lines):

```typescript
export const DlqTopicSchema = z.object({
	name: z.string(),
	totalMessages: z.number(),
	recentDelta: z.number().nullable(),
});
```

**This is the same shape as `KafkaFindings.dlqTopics[]`.** Zero schema mapping work needed.

**4. The extractor is ready to accept a new tool branch** at `packages/agent/src/correlation/extractors/kafka.ts`. The current implementation (post-Phase A) handles consumer groups via two `if/else if` branches. Adding a third branch for `kafka_list_dlq_topics` is the bulk of the agent-side work.

### What's missing

**1. Tool registration in `packages/mcp-server-kafka/src/tools/`.**

Reference pattern at `packages/mcp-server-kafka/src/tools/read/tools.ts:52-69`:

```typescript
server.tool(
	"kafka_list_consumer_groups",
	prompts.LIST_CONSUMER_GROUPS_DESCRIPTION,
	params.ListConsumerGroupsParams.shape,
	wrapHandler("kafka_list_consumer_groups", config, async (args) => {
		const result = await ops.listConsumerGroups(service, args);
		return ResponseBuilder.success(result);
	}),
);
```

You'll need:
- A Zod param schema in `parameters.ts` or `parameters-extended.ts` (mirror `ListConsumerGroupsParams`).
- A prompt description in `prompts.ts`.
- An operation wrapper in `operations.ts` or `operations-extended.ts` that delegates to `service.listDlqTopics(args)`.
- The `server.tool("kafka_list_dlq_topics", ...)` registration.

**2. Action-tool-map entry.** Sub-agents use action-driven tool selection (the YAML files under `agents/incident-analyzer/agents/kafka-agent/tools/`). For the new tool to be reachable, add an entry that maps a relevant kafka-agent action (likely "investigate-dlq" or similar — check existing actions) to `kafka_list_dlq_topics`.

**3. Integration test.** Mirror the pattern in `packages/mcp-server-kafka/test/` for an existing tool registration. The dual-sampling makes integration testing trickier — set a small `sampleIntervalMs` (e.g. 100ms) and assert that the tool returns at least the structured shape.

**4. Agent-side extractor branch.** Extend `packages/agent/src/correlation/extractors/kafka.ts`. The current shape (verify the exact lines on main — Phase A's PR #101 landed it as one of the new files):

```typescript
// agent/src/correlation/extractors/kafka.ts
import type { KafkaFindings, ToolOutput } from "@devops-agent/shared";

// ... isRecord, extractListConsumerGroupsEntries, extractGetConsumerGroupLagEntry ...

export function extractKafkaFindings(outputs: ToolOutput[]): KafkaFindings {
	const byId = new Map<string, { id: string; state?: string; totalLag?: number }>();
	const dlqTopics: Array<{ name: string; totalMessages: number; recentDelta: number | null }> = [];

	for (const o of outputs) {
		if (o.toolName === "kafka_list_consumer_groups") { /* ... */ }
		else if (o.toolName === "kafka_get_consumer_group_lag") { /* ... */ }
		else if (o.toolName === "kafka_list_dlq_topics") {
			// SIO-770: parse the DLQ-topic list. Each output is one tool call;
			// the response is an array of {name, totalMessages, recentDelta}.
			if (!isRecord(o.rawJson) || !Array.isArray(o.rawJson.topics)) continue;
			for (const t of o.rawJson.topics) {
				if (!isRecord(t)) continue;
				if (typeof t.name !== "string" || typeof t.totalMessages !== "number") continue;
				const recentDelta = typeof t.recentDelta === "number" ? t.recentDelta : null;
				dlqTopics.push({ name: t.name, totalMessages: t.totalMessages, recentDelta });
			}
		}
	}

	const findings: KafkaFindings = {};
	if (byId.size > 0) findings.consumerGroups = Array.from(byId.values());
	if (dlqTopics.length > 0) findings.dlqTopics = dlqTopics;
	return findings;
}
```

**Note on response shape:** the snippet above assumes `service.listDlqTopics()` returns `{topics: [...]}` to match the `kafka_list_consumer_groups` `{groups: [...]}` wrapping pattern. Verify by reading the service method and adjusting the parse path — it might be a bare array, in which case the extractor reads `o.rawJson` directly.

**5. Extractor unit tests.** Append to `packages/agent/src/correlation/extractors/kafka.test.ts`:

```typescript
test("maps kafka_list_dlq_topics response to dlqTopics[]", () => {
	const outputs: ToolOutput[] = [
		{
			toolName: "kafka_list_dlq_topics",
			rawJson: {
				topics: [
					{ name: "orders.DLQ", totalMessages: 1247, recentDelta: 12 },
					{ name: "shipments.DLQ", totalMessages: 88, recentDelta: 0 },
				],
			},
		},
	];
	const findings = extractKafkaFindings(outputs);
	expect(findings.dlqTopics).toEqual([
		{ name: "orders.DLQ", totalMessages: 1247, recentDelta: 12 },
		{ name: "shipments.DLQ", totalMessages: 88, recentDelta: 0 },
	]);
});

test("preserves null recentDelta when only one sample was taken", () => {
	const outputs: ToolOutput[] = [
		{
			toolName: "kafka_list_dlq_topics",
			rawJson: { topics: [{ name: "orders.DLQ", totalMessages: 1247, recentDelta: null }] },
		},
	];
	const findings = extractKafkaFindings(outputs);
	expect(findings.dlqTopics?.[0]?.recentDelta).toBeNull();
});
```

---

## The fix, ordered

The work splits into two PR-sized chunks. Either ship as one PR (small enough) or split if the Kafka MCP test machinery needs significant setup.

### Chunk 1: Expose the tool

1. Add `ListDlqTopicsParams` to `packages/mcp-server-kafka/src/tools/parameters.ts` (or `parameters-extended.ts` depending on where it semantically fits):
   ```typescript
   export const ListDlqTopicsParams = z.object({
     sampleIntervalMs: z.number().int().min(100).max(60_000).default(30_000)
       .describe("Milliseconds between the two samples used to compute recentDelta. Default 30s."),
     topicPrefixes: z.array(z.string()).optional()
       .describe("Optional prefix filter; e.g. ['orders.', 'shipments.']. Default: all DLQ topics."),
   });
   ```

2. Add a prompt description in `packages/mcp-server-kafka/src/tools/prompts.ts`:
   ```typescript
   export const LIST_DLQ_TOPICS_DESCRIPTION =
     "Lists Kafka topics matching DLQ naming conventions, returning totalMessages and recentDelta (computed via two snapshots ~sampleIntervalMs apart). Use this to detect DLQ growth that may indicate stalled consumers or repeated processing failures.";
   ```

3. Add an operation wrapper if the file uses that pattern (e.g. `packages/mcp-server-kafka/src/tools/operations.ts`):
   ```typescript
   export async function listDlqTopics(service: KafkaService, params: { sampleIntervalMs?: number; topicPrefixes?: string[] }) {
     return service.listDlqTopics(params);
   }
   ```

4. Register the tool in `tools/read/tools.ts` (mirror `kafka_list_consumer_groups`):
   ```typescript
   server.tool(
     "kafka_list_dlq_topics",
     prompts.LIST_DLQ_TOPICS_DESCRIPTION,
     params.ListDlqTopicsParams.shape,
     wrapHandler("kafka_list_dlq_topics", config, async (args) => {
       const result = await ops.listDlqTopics(service, args);
       return ResponseBuilder.success(result);
     }),
   );
   ```

5. Add integration test under `packages/mcp-server-kafka/test/`:
   - Use the existing test container or mock pattern. If the existing tests for `kafka_list_consumer_groups` mock the service rather than spin up a broker, mirror that — the value here is shape verification, not e2e correctness (the service method already has unit tests in the kafka package).

6. Add an action-tool-map entry under `agents/incident-analyzer/agents/kafka-agent/tools/`:
   - Find the YAML file that groups read-side investigation tools (likely `tools/read.yaml` or similar).
   - Add `kafka_list_dlq_topics` under an appropriate action key. If no DLQ-related action exists, add one — and make sure the kafka-agent's SOUL.md or RULES.md references it so the supervisor picks it.

### Chunk 2: Wire the extractor

7. Edit `packages/agent/src/correlation/extractors/kafka.ts` — add the third `else if` branch shown above, plus a defensive parser helper.

8. Append the two unit tests above to `packages/agent/src/correlation/extractors/kafka.test.ts`.

9. Migrate the `kafka-dlq-growth` test in `packages/agent/tests/correlation/engine.test.ts` (around lines 51-74 — verify) from `withKafkaResult(state, {dlqTopics: [...]})` to `withKafkaFindings(state, {dlqTopics: [...]})` (the helper was added in PR #101). Phase A may have already migrated this — check first; if so, skip.

---

## Verification

### Tool-level

```bash
# After chunk 1:
bun run --filter @devops-agent/mcp-server-kafka typecheck
bun run --filter @devops-agent/mcp-server-kafka test
```

Manual MCP probe (per the `feedback_probe_agentcore_via_sigv4_proxy` pattern):

```bash
# Start kafka MCP locally (uses port 9081)
KAFKA_PROVIDER=local bun run --filter @devops-agent/mcp-server-kafka dev

# In another terminal, list tools and confirm kafka_list_dlq_topics is present
curl -s http://localhost:9081/mcp -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[] | select(.name=="kafka_list_dlq_topics")'

# Then call it (with a fast sample interval for local testing)
curl -s http://localhost:9081/mcp -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"kafka_list_dlq_topics","arguments":{"sampleIntervalMs":200}}}'
```

### Agent-level

```bash
bun run --filter @devops-agent/agent test
# Expect: extractor unit tests pass; engine.test.ts kafka-dlq-growth test passes.

bun run typecheck && bun run lint && bun run test
# Expect: all clean. (SIO-769 may still leave a failing kafka-tool-failures test if its sidecar hasn't merged yet — that's not this ticket's concern.)
```

### Integration replay (production-shape verification)

1. `bun run dev` (full stack).
2. Fire a query that should trigger DLQ investigation, e.g.:
   > "Is the orders DLQ growing? Cross-check with elastic for stalled consumer logs."
3. In the LangSmith trace:
   - The kafka-agent should call `kafka_list_dlq_topics` at least once.
   - In the `extractFindings` node, the kafka `DataSourceResult.kafkaFindings.dlqTopics[]` should be populated with the response.
   - In `enforceCorrelationsAggregate`, the `kafka-dlq-growth` rule should evaluate. If any topic has `recentDelta > 0`, the rule fires with `context.dlqTopicNames: [...]` and `correlationFetch` dispatches a Send to elastic-agent.

---

## Files to modify

### MCP server side
| File | Change |
|---|---|
| `packages/mcp-server-kafka/src/tools/parameters.ts` (or `-extended.ts`) | Add `ListDlqTopicsParams` Zod schema. |
| `packages/mcp-server-kafka/src/tools/prompts.ts` | Add `LIST_DLQ_TOPICS_DESCRIPTION` constant. |
| `packages/mcp-server-kafka/src/tools/operations.ts` (or `-extended.ts`) | Add `listDlqTopics(service, params)` wrapper. |
| `packages/mcp-server-kafka/src/tools/read/tools.ts` | Register `kafka_list_dlq_topics`. |
| `packages/mcp-server-kafka/test/<existing-pattern>.test.ts` | Add registration + shape test. |
| `agents/incident-analyzer/agents/kafka-agent/tools/<action-yaml>.yaml` | Add `kafka_list_dlq_topics` under an appropriate action. |

### Agent side
| File | Change |
|---|---|
| `packages/agent/src/correlation/extractors/kafka.ts` | Add `kafka_list_dlq_topics` branch in `extractKafkaFindings`. |
| `packages/agent/src/correlation/extractors/kafka.test.ts` | Append 2 fixture tests. |
| `packages/agent/tests/correlation/engine.test.ts` | If the `kafka-dlq-growth` test still uses `withKafkaResult`, migrate to `withKafkaFindings` (Phase A may have already done this — verify first). |

---

## Workflow

1. Move SIO-770 to **In Progress** in Linear.
2. Branch off main:
   ```bash
   git checkout main && git pull
   git checkout -b sio-770-kafka-list-dlq-topics-tool
   ```
3. Work through Chunks 1 and 2. Recommend two commits per chunk:
   - "SIO-770: expose kafka_list_dlq_topics MCP tool"
   - "SIO-770: extend extractor + migrate engine test for dlqTopics"
4. Run the full verification block.
5. Push, open PR, move SIO-770 to **In Review**.
6. After merge: Done with user approval.

---

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| `service.listDlqTopics()` response shape doesn't match the `{topics: [...]}` wrapper assumed in the extractor | Medium | Read the service method first (`services/kafka.ts:308`) to confirm exact return shape. Adjust the extractor parser. Add a fixture test for whatever the real shape is. |
| Dual-sampling makes the tool slow (~30s default sampleIntervalMs) and the sub-agent's overall timeout fires | Low | The sub-agent already has long retry timeouts (`retry: { timeoutMs: 60_000 }` is typical). The `sampleIntervalMs` arg is configurable — defaults can be lowered to 10s if 30s proves too slow. |
| `recentDelta: null` (single sample, no delta) is misinterpreted as zero by the rule | Already handled | The rule code at `rules.ts:165` does `(t.recentDelta ?? 0) > 0`, which correctly treats null as zero (rule doesn't fire). |
| Action-tool-map plumbing isn't obvious | Medium | Read `agents/incident-analyzer/agents/kafka-agent/SOUL.md` + the existing tool YAML files. The sub-agent picks tools via "actions" declared in YAML. Mirror an adjacent action that uses `kafka_list_consumer_groups`. |
| Tests need a real Kafka broker for integration | Probably low | The kafka MCP package already has unit tests for `listDlqTopics()` at the service layer. The tool-registration test only needs to verify the tool appears in the registry and the handler delegates correctly — a service mock is enough. |

---

## Out of scope

- **A batch state-aggregator tool** (mentioned in Linear as optional): defer unless measurement during integration testing shows that N per-group `kafka_get_consumer_group_lag` calls is a real bottleneck.
- **Other dormant rules**: `gitlab-deploy-vs-datastore-runtime` needs SIO-771 + SIO-772; `kafka-tool-failures` is SIO-769. Don't conflate.
- **Modifying `service.listDlqTopics()`**: the service-layer logic is correct and tested. Only the tool registration layer needs changes.

---

## Related code references

- `packages/mcp-server-kafka/src/services/kafka.ts:308` — `listDlqTopics()` service method (the work is already done).
- `packages/mcp-server-kafka/src/services/kafka.ts:257-269` — `DlqTopicSchema` (canonical shape).
- `packages/mcp-server-kafka/src/tools/read/tools.ts:52-69` — `kafka_list_consumer_groups` registration (reference pattern).
- `packages/shared/src/agent-state.ts` — `KafkaFindingsSchema.dlqTopics[]` (target schema slot).
- `packages/agent/src/correlation/extractors/kafka.ts` — extractor to extend (Phase A artifact).
- `packages/agent/src/correlation/rules.ts:161-173` — the `kafka-dlq-growth` rule (consumer of the new data).
- `packages/agent/tests/correlation/test-helpers.ts` — `withKafkaFindings` helper (Phase A artifact, no changes needed).

---

## Memory references

- `reference_first_deploy_to_fresh_account_bugs` — pattern: when adding new tools, register them everywhere they need to appear (services, tool YAMLs, action maps, agent SOULs). First-deploy uncovers missed registrations.
- `feedback_handoff_docs_main_branch` — this handover doc stays local in `experiments/`.
- `reference_kafka_mcp_agentcore_ksql_disabled` — for context on Kafka MCP feature gates; DLQ topic listing is local/MSK/Confluent-agnostic at the service layer, but verify it works for whichever provider you're testing against.

End of handover.
