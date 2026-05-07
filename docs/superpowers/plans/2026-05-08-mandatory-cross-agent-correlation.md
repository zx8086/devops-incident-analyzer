# Mandatory Cross-Agent Correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Linear:** [SIO-681](https://linear.app/siobytes/issue/SIO-681/mandatory-cross-agent-correlation-rule-engine)
**Spec:** `docs/superpowers/specs/2026-05-07-mandatory-cross-agent-correlation-design.md`

**Goal:** Add a supervisor-pipeline rule engine that forces required cross-agent correlations (e.g., Empty/Dead Kafka groups → must query Elastic) with bounded retry and graceful degradation, plus the DLQ inventory needed by one of the four initial rules.

**Architecture:** Three new files in `packages/agent/src/correlation/` (rules, engine, node), wired into `packages/agent/src/graph.ts` between `aggregate` and `checkConfidence`. The node is a **router**: returns `Send` objects to re-fan-out to specialists when rules need invocation, plus a follow-up aggregator that applies `confidenceCap` and writes `degradedRules` after the re-fan-out completes. Idempotent within a run, stateless across runs. Includes a self-contained DLQ inventory + two-sample `recentDelta` addition to kafka-service.ts.

**Tech Stack:** TypeScript strict, Zod, LangGraph (`@langchain/langgraph`), Bun test, Pino logger via `@devops-agent/observability`.

---

## Critical deviations from the spec (intentional, baked into the plan)

The spec was written before the codebase was probed at the file level. These deviations don't change the design intent.

1. **Findings shape**: spec says `state.kafkaFindings`/`state.elasticFindings`. Reality: findings live in `state.dataSourceResults: DataSourceResult[]` keyed by `dataSourceId`. Trigger predicates read from `dataSourceResults`. Only `degradedRules` + `confidenceCap` + `pendingCorrelations` are added to state.
2. **Node invocation pattern**: spec says "node invokes specialist". Reality: regular nodes can't dispatch sub-agents — only routing functions returning `Send(...)` can. `enforceCorrelations` is implemented as a **router** that returns `Send("correlationFetch", { ...state, currentDataSource: "elastic", correlationContext })` for each rule needing invocation, plus a follow-up `enforceCorrelationsAggregate` node that runs after the re-fan-out and applies cap/degradedRules. When no rules need invocation, it routes straight to `enforceCorrelationsAggregate` (which becomes a no-op).
3. **Confidence cap honoring**: spec says "validate honors confidenceCap". Reality: `validate` doesn't touch confidence; `aggregate` sets it and `checkConfidence` reads it. Plan applies the cap in `enforceCorrelationsAggregate` itself by writing `confidenceScore = min(currentScore, cap)` and storing the cap value on state for downstream display. No edits to `validate`.
4. **DLQ inventory does not exist** in kafka-service.ts today. Plan adds full DLQ inventory (suffix-based detection, two-sample delta, parallel batching) — not just a `recentDelta` field on existing entries.

---

## Task A0: Probe queryDataSource to confirm router-with-Send approach

**Files:**
- Read: `packages/agent/src/supervisor.ts` (lines 31–102)
- Read: `packages/agent/src/graph.ts` (locate the `queryDataSource` node registration)
- Read: whichever file `queryDataSource` is implemented in

- [ ] **Step 1: Verify queryDataSource accepts `currentDataSource` from state**

Read the implementation. Confirm it reads `state.currentDataSource` and dispatches to the matching MCP server (elastic at :9080, etc.). Confirm the return shape appends to `state.dataSourceResults`.

- [ ] **Step 2: Verify Send routing is the only sub-agent entry point**

Confirm there is no exported function that synchronously runs a sub-agent outside the graph. If there IS such an exported function, note it — that becomes a simpler alternative for `enforceCorrelations`. If there isn't (expected), the router-with-Send pattern is the path.

- [ ] **Step 3: Note any retry/timeout machinery already in queryDataSource**

The spec specifies `{ attempts: 3, timeoutMs: 30_000 }` per rule. If queryDataSource already implements retry/timeout, the rule engine just sets `currentDataSource` and the existing machinery handles retry. If not, the rule engine layer must wrap. Note which.

This task produces no commit. It's a 5-minute read that informs Tasks A4–A5.

---

## Task A1: Add DLQ inventory with two-sample recentDelta to kafka-service.ts

**Files:**
- Modify: `packages/mcp-server-kafka/src/services/kafka-service.ts`
- Modify: `packages/mcp-server-kafka/src/config/schemas.ts` (add output type for DLQ entries)
- Test: `packages/mcp-server-kafka/tests/services/kafka-service-dlq.test.ts` (new)

- [ ] **Step 1: Write the failing test for DLQ topic detection**

Create `packages/mcp-server-kafka/tests/services/kafka-service-dlq.test.ts`:

```ts
// packages/mcp-server-kafka/tests/services/kafka-service-dlq.test.ts
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { KafkaService } from "../../src/services/kafka-service";

describe("KafkaService.listDlqTopics — detection", () => {
  test("identifies DLQ topics by suffix patterns", async () => {
    const service = makeServiceWithTopics([
      "orders",
      "orders-dlq",
      "payments",
      "dlt-payments",
      "users",
      "users-dead-letter",
      "raw-events",
    ]);
    const dlqs = await service.listDlqTopics({ skipDelta: true });
    const names = dlqs.map((d) => d.name).sort();
    expect(names).toEqual(["dlt-payments", "orders-dlq", "users-dead-letter"]);
  });

  test("returns empty array when no DLQ topics present", async () => {
    const service = makeServiceWithTopics(["orders", "payments"]);
    const dlqs = await service.listDlqTopics({ skipDelta: true });
    expect(dlqs).toEqual([]);
  });
});

function makeServiceWithTopics(topics: string[]): KafkaService {
  // Helper builds a KafkaService with mocked admin client returning these topics.
  // Implementation below in step 5 alongside the production code.
  throw new Error("not implemented");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @devops-agent/mcp-server-kafka test tests/services/kafka-service-dlq.test.ts`
Expected: FAIL with `listDlqTopics is not a function` or similar.

- [ ] **Step 3: Add the DlqTopic Zod schema in config/schemas.ts**

In `packages/mcp-server-kafka/src/config/schemas.ts` add a new exported schema (alongside the existing exports):

```ts
export const dlqTopicSchema = z
  .object({
    name: z.string().describe("DLQ topic name"),
    totalMessages: z.number().int().nonnegative().describe("Total messages across all partitions at sample time"),
    recentDelta: z
      .number()
      .int()
      .nullable()
      .describe(
        "Messages added between the two samples (~30s apart). Null if the second sample failed (e.g., topic deleted between samples). Zero means no live ingestion during the window.",
      ),
  })
  .strict();

export type DlqTopic = z.infer<typeof dlqTopicSchema>;
```

- [ ] **Step 4: Implement `listDlqTopics` in kafka-service.ts**

In `packages/mcp-server-kafka/src/services/kafka-service.ts`, add (placement: alongside other inventory-style methods, e.g., after `listTopics`):

```ts
import type { DlqTopic } from "../config/schemas";

const DLQ_PATTERNS: RegExp[] = [/-dlq$/, /^dlt-/, /-dead-letter$/, /^dead-letter-/, /\.DLQ$/];
const DEFAULT_DLQ_DELTA_WINDOW_MS = 30_000;
const DLQ_PARALLEL_BATCH_SIZE = 20;

export interface ListDlqTopicsOptions {
  skipDelta?: boolean; // when true, only sample once (used in tests to avoid the wait)
  windowMs?: number; // override the 30s default for tests
}

export class KafkaService {
  // ... existing methods ...

  async listDlqTopics(options: ListDlqTopicsOptions = {}): Promise<DlqTopic[]> {
    const allTopics = await this.listTopics();
    const dlqNames = allTopics.filter((name) => DLQ_PATTERNS.some((re) => re.test(name)));
    if (dlqNames.length === 0) return [];

    const sample1 = await this.sampleTotals(dlqNames);

    if (options.skipDelta) {
      return Array.from(sample1.entries()).map(([name, totalMessages]) => ({
        name,
        totalMessages,
        recentDelta: null,
      }));
    }

    const windowMs = options.windowMs ?? DEFAULT_DLQ_DELTA_WINDOW_MS;
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    const sample2 = await this.sampleTotals(dlqNames);

    return Array.from(sample1.entries()).map(([name, totalMessages]) => {
      const second = sample2.get(name);
      return {
        name,
        totalMessages,
        recentDelta: second === undefined ? null : second - totalMessages,
      };
    });
  }

  // Two-sample helper — batched to keep wall-time bounded for clusters with many DLQs.
  private async sampleTotals(names: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (let i = 0; i < names.length; i += DLQ_PARALLEL_BATCH_SIZE) {
      const batch = names.slice(i, i + DLQ_PARALLEL_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (name) => ({ name, total: await this.getTopicTotalMessages(name) })),
      );
      for (const r of results) {
        if (r.status === "fulfilled") out.set(r.value.name, r.value.total);
        // rejected sample: omit from map; consumer treats absence as "second sample failed" -> null delta
      }
    }
    return out;
  }

  // Sum of (latestOffset - earliestOffset) across all partitions of `topic`.
  // Reuses the existing offsets-fetching code path used by listTopics/getTopicOffsets.
  private async getTopicTotalMessages(topic: string): Promise<number> {
    const offsets = await this.admin.fetchTopicOffsets(topic);
    return offsets.reduce((sum, p) => sum + (Number(p.high) - Number(p.low)), 0);
  }
}
```

If `this.admin` is not the property name in this file, the implementer reads the existing `listTopics` method and reuses whatever client property/method it uses. Do not introduce a new client connection.

- [ ] **Step 5: Wire up the test helper `makeServiceWithTopics`**

In `kafka-service-dlq.test.ts`, replace the `throw new Error("not implemented")` body:

```ts
function makeServiceWithTopics(topics: string[]): KafkaService {
  const fakeAdmin = {
    listTopics: () => Promise.resolve(topics),
    fetchTopicOffsets: (topic: string) =>
      Promise.resolve([{ partition: 0, high: "100", low: "0" }]),
  };
  // Construct KafkaService with the fake admin. Mirror the existing
  // tests/services/kafka-service-get-message.test.ts construction pattern.
  const service = new KafkaService(/* config */ {} as never);
  // @ts-expect-error -- injecting fake admin for test
  service.admin = fakeAdmin;
  return service;
}
```

If `KafkaService` constructor pattern in existing tests differs (e.g., constructor takes the admin directly), follow that pattern instead.

- [ ] **Step 6: Run the detection tests, verify pass**

Run: `bun run --filter @devops-agent/mcp-server-kafka test tests/services/kafka-service-dlq.test.ts`
Expected: both detection tests PASS.

- [ ] **Step 7: Add the recentDelta tests**

Append to `kafka-service-dlq.test.ts`:

```ts
describe("KafkaService.listDlqTopics — recentDelta", () => {
  test("computes positive delta when second sample is higher", async () => {
    const sequenced = sequencedTotals([
      { "orders-dlq": 100 },
      { "orders-dlq": 105 },
    ]);
    const service = makeServiceWithSequencedTotals(["orders-dlq", "raw"], sequenced);
    const dlqs = await service.listDlqTopics({ windowMs: 1 });
    expect(dlqs).toEqual([{ name: "orders-dlq", totalMessages: 100, recentDelta: 5 }]);
  });

  test("zero delta when second sample matches first", async () => {
    const sequenced = sequencedTotals([
      { "orders-dlq": 100 },
      { "orders-dlq": 100 },
    ]);
    const service = makeServiceWithSequencedTotals(["orders-dlq"], sequenced);
    const dlqs = await service.listDlqTopics({ windowMs: 1 });
    expect(dlqs[0].recentDelta).toBe(0);
  });

  test("recentDelta is null when second sample fails", async () => {
    const sequenced = sequencedTotals([{ "orders-dlq": 100 }, { /* second sample throws */ }]);
    const service = makeServiceWithSequencedTotalsAndFailure(["orders-dlq"], sequenced);
    const dlqs = await service.listDlqTopics({ windowMs: 1 });
    expect(dlqs[0].recentDelta).toBeNull();
  });

  test("parallelizes large DLQ inventories without exceeding window", async () => {
    const names = Array.from({ length: 50 }, (_, i) => `t${i}-dlq`);
    const totals = Object.fromEntries(names.map((n) => [n, 10]));
    const sequenced = sequencedTotals([totals, totals]);
    const service = makeServiceWithSequencedTotals(names, sequenced);
    const start = Date.now();
    const dlqs = await service.listDlqTopics({ windowMs: 50 });
    const elapsed = Date.now() - start;
    expect(dlqs).toHaveLength(50);
    expect(elapsed).toBeLessThan(500);
  });
});

function sequencedTotals(samples: Array<Record<string, number>>) {
  let i = 0;
  return (topic: string) => {
    const sample = samples[Math.min(i, samples.length - 1)];
    if (!(topic in sample)) throw new Error("topic missing in sample");
    const v = sample[topic];
    if (i + 1 < samples.length) i = Math.min(i + 1, samples.length - 1);
    return v;
  };
}

function makeServiceWithSequencedTotals(
  topics: string[],
  totalsForTopic: (t: string) => number,
): KafkaService {
  const fakeAdmin = {
    listTopics: () => Promise.resolve(topics),
    fetchTopicOffsets: (topic: string) =>
      Promise.resolve([{ partition: 0, high: String(totalsForTopic(topic)), low: "0" }]),
  };
  const service = new KafkaService({} as never);
  // @ts-expect-error
  service.admin = fakeAdmin;
  return service;
}

function makeServiceWithSequencedTotalsAndFailure(
  topics: string[],
  totalsForTopic: (t: string) => number,
): KafkaService {
  let call = 0;
  const fakeAdmin = {
    listTopics: () => Promise.resolve(topics),
    fetchTopicOffsets: (topic: string) => {
      call++;
      if (call > topics.length) throw new Error("simulated second-sample failure");
      return Promise.resolve([{ partition: 0, high: String(totalsForTopic(topic)), low: "0" }]);
    },
  };
  const service = new KafkaService({} as never);
  // @ts-expect-error
  service.admin = fakeAdmin;
  return service;
}
```

- [ ] **Step 8: Run the recentDelta tests, verify pass**

Run: `bun run --filter @devops-agent/mcp-server-kafka test tests/services/kafka-service-dlq.test.ts`
Expected: all tests in this file PASS.

- [ ] **Step 9: Run full kafka-mcp test suite, lint, typecheck**

Run in parallel:
- `bun run --filter @devops-agent/mcp-server-kafka test`
- `bun run --filter @devops-agent/mcp-server-kafka typecheck`
- `bun run lint`

Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add packages/mcp-server-kafka/src/services/kafka-service.ts \
        packages/mcp-server-kafka/src/config/schemas.ts \
        packages/mcp-server-kafka/tests/services/kafka-service-dlq.test.ts
git commit -m "SIO-681: add DLQ topic inventory with two-sample recentDelta"
```

---

## Task A2: Add `degradedRules` and `confidenceCap` fields to AgentState

**Files:**
- Modify: `packages/agent/src/state.ts`
- Test: `packages/agent/tests/state-correlation.test.ts` (new — type-shape smoke test)

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent/tests/state-correlation.test.ts
import { describe, expect, test } from "bun:test";
import type { AgentStateType } from "../src/state";

describe("AgentState — correlation fields", () => {
  test("degradedRules and confidenceCap are present on the state type", () => {
    const s: Pick<AgentStateType, "degradedRules" | "confidenceCap"> = {
      degradedRules: [
        {
          ruleName: "kafka-empty-or-dead-groups",
          requiredAgent: "elastic-agent",
          reason: "elastic-agent unreachable: ECONNREFUSED after 3 attempts",
          triggerContext: { groupIds: ["notification-service"] },
        },
      ],
      confidenceCap: 0.6,
    };
    expect(s.degradedRules).toHaveLength(1);
    expect(s.confidenceCap).toBe(0.6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @devops-agent/agent test tests/state-correlation.test.ts`
Expected: FAIL with TypeScript error.

- [ ] **Step 3: Add the fields to AgentState**

In `packages/agent/src/state.ts`, locate the `Annotation.Root({...})` block. Above the annotation block, define the supporting types:

```ts
export type AgentName =
  | "elastic-agent"
  | "kafka-agent"
  | "capella-agent"
  | "konnect-agent"
  | "gitlab-agent";

export interface DegradedRule {
  ruleName: string;
  requiredAgent: AgentName;
  reason: string;
  triggerContext: Record<string, unknown>;
}
```

In the annotation block, add (placement: alongside `confidenceScore`):

```ts
degradedRules: Annotation<DegradedRule[]>({
  reducer: (_, next) => next,
  default: () => [],
}),
confidenceCap: Annotation<number | undefined>({
  reducer: (_, next) => next,
  default: () => undefined,
}),
```

- [ ] **Step 4: Run test to verify pass + typecheck**

Run in parallel:
- `bun run --filter @devops-agent/agent test tests/state-correlation.test.ts`
- `bun run --filter @devops-agent/agent typecheck`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/state.ts packages/agent/tests/state-correlation.test.ts
git commit -m "SIO-681: add degradedRules and confidenceCap to AgentState"
```

---

## Task A3: Pure rule engine (`engine.ts`) + initial 4 rules

**Files:**
- Create: `packages/agent/src/correlation/rules.ts`
- Create: `packages/agent/src/correlation/engine.ts`
- Test: `packages/agent/tests/correlation/engine.test.ts`

- [ ] **Step 1: Write failing tests for the engine**

```ts
// packages/agent/tests/correlation/engine.test.ts
import { describe, expect, test } from "bun:test";
import { evaluate } from "../../src/correlation/engine";
import { correlationRules } from "../../src/correlation/rules";
import type { AgentStateType } from "../../src/state";

function baseState(): AgentStateType {
  return {
    messages: [],
    attachmentMeta: [],
    queryComplexity: "complex",
    targetDataSources: [],
    targetDeployments: [],
    dataSourceResults: [],
    currentDataSource: "",
    extractedEntities: { dataSources: [] },
    previousEntities: { dataSources: [] },
    toolPlanMode: "autonomous",
    toolPlan: [],
    validationResult: "pass",
    retryCount: 0,
    alignmentRetries: 0,
    alignmentHints: [],
    skippedDataSources: [],
    isFollowUp: false,
    finalAnswer: "",
    dataSourceContext: undefined,
    requestId: "test",
    suggestions: [],
    normalizedIncident: {},
    mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
    confidenceScore: 0,
    lowConfidence: false,
    pendingActions: [],
    actionResults: [],
    selectedRunbooks: null,
    degradedRules: [],
    confidenceCap: undefined,
  } as AgentStateType;
}

function withKafkaResult(state: AgentStateType, data: unknown): AgentStateType {
  return {
    ...state,
    dataSourceResults: [
      ...state.dataSourceResults,
      { dataSourceId: "kafka", status: "success", data, duration: 100 } as never,
    ],
  };
}

function withElasticResult(state: AgentStateType, data: unknown): AgentStateType {
  return {
    ...state,
    dataSourceResults: [
      ...state.dataSourceResults,
      { dataSourceId: "elastic", status: "success", data, duration: 100 } as never,
    ],
  };
}

describe("correlation engine — kafka-empty-or-dead-groups", () => {
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

  test("does not fire when all groups are Stable", () => {
    const state = withKafkaResult(baseState(), {
      consumerGroups: [{ id: "payments-service", state: "Stable", totalLag: 0 }],
    });
    const decisions = evaluate(state, correlationRules);
    const rule = decisions.find((d) => d.rule.name === "kafka-empty-or-dead-groups");
    expect(rule?.status).toBe("satisfied");
  });
});

describe("correlation engine — kafka-significant-lag", () => {
  test("fires when a Stable group has lag > 10K", () => {
    const state = withKafkaResult(baseState(), {
      consumerGroups: [{ id: "payments-service", state: "Stable", totalLag: 50_000 }],
    });
    const decisions = evaluate(state, correlationRules);
    const rule = decisions.find((d) => d.rule.name === "kafka-significant-lag");
    expect(rule?.status).toBe("needs-invocation");
  });

  test("does not fire below threshold", () => {
    const state = withKafkaResult(baseState(), {
      consumerGroups: [{ id: "payments-service", state: "Stable", totalLag: 100 }],
    });
    const decisions = evaluate(state, correlationRules);
    const rule = decisions.find((d) => d.rule.name === "kafka-significant-lag");
    expect(rule?.status).toBe("satisfied");
  });
});

describe("correlation engine — kafka-dlq-growth", () => {
  test("fires when any DLQ has positive recentDelta", () => {
    const state = withKafkaResult(baseState(), {
      dlqTopics: [
        { name: "orders-dlq", totalMessages: 100, recentDelta: 5 },
        { name: "payments-dlq", totalMessages: 999, recentDelta: 0 },
      ],
    });
    const decisions = evaluate(state, correlationRules);
    const rule = decisions.find((d) => d.rule.name === "kafka-dlq-growth");
    expect(rule?.status).toBe("needs-invocation");
  });

  test("does not fire when all deltas are zero or null", () => {
    const state = withKafkaResult(baseState(), {
      dlqTopics: [
        { name: "orders-dlq", totalMessages: 100, recentDelta: 0 },
        { name: "sap-car-prices-dlt", totalMessages: 177_700, recentDelta: null },
      ],
    });
    const decisions = evaluate(state, correlationRules);
    const rule = decisions.find((d) => d.rule.name === "kafka-dlq-growth");
    expect(rule?.status).toBe("satisfied");
  });
});

describe("correlation engine — kafka-tool-failures", () => {
  test("fires when toolErrors array is non-empty", () => {
    const state = withKafkaResult(baseState(), {
      toolErrors: [{ tool: "kafka_get_consumer_groups", code: "ECONNREFUSED" }],
    });
    const decisions = evaluate(state, correlationRules);
    const rule = decisions.find((d) => d.rule.name === "kafka-tool-failures");
    expect(rule?.status).toBe("needs-invocation");
  });
});

describe("correlation engine — idempotency", () => {
  test("rule already covered by elastic findings is satisfied", () => {
    const s1 = withKafkaResult(baseState(), {
      consumerGroups: [{ id: "notification-service", state: "Empty" }],
    });
    const s2 = withElasticResult(s1, {
      services: [{ name: "notification-service", errorRate: 0.02 }],
    });
    const decisions = evaluate(s2, correlationRules);
    const rule = decisions.find((d) => d.rule.name === "kafka-empty-or-dead-groups");
    expect(rule?.status).toBe("satisfied");
  });
});

describe("correlation engine — predicate errors are caught", () => {
  test("buggy predicate marks rule satisfied with reason", () => {
    const buggy = [
      {
        name: "buggy",
        description: "throws on purpose",
        trigger: () => {
          throw new Error("kaboom");
        },
        requiredAgent: "elastic-agent" as const,
        retry: { attempts: 1, timeoutMs: 1000 },
      },
    ];
    const decisions = evaluate(baseState(), buggy);
    expect(decisions[0].status).toBe("satisfied");
    expect(decisions[0].reason).toContain("predicate error");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --filter @devops-agent/agent test tests/correlation/engine.test.ts`
Expected: FAIL with module-not-found errors.

- [ ] **Step 3: Implement `rules.ts`**

```ts
// packages/agent/src/correlation/rules.ts
import type { AgentName, AgentStateType } from "../state";

export interface CorrelationRule {
  name: string;
  description: string;
  trigger: (state: AgentStateType) => TriggerMatch | null;
  requiredAgent: AgentName;
  retry: { attempts: number; timeoutMs: number };
}

export interface TriggerMatch {
  context: Record<string, unknown>;
}

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

export const correlationRules: CorrelationRule[] = [
  {
    name: "kafka-empty-or-dead-groups",
    description:
      "Kafka consumer groups in Empty/Dead state imply the consuming app may have exceptions; correlate with app logs.",
    trigger: (state) => {
      const groups = getKafkaData(state).consumerGroups ?? [];
      const matched = groups.filter((g) => g.state === "Empty" || g.state === "Dead");
      return matched.length === 0 ? null : { context: { groupIds: matched.map((g) => g.id) } };
    },
    requiredAgent: "elastic-agent",
    retry: { attempts: 3, timeoutMs: 30_000 },
  },
  {
    name: "kafka-significant-lag",
    description:
      "Stable consumer group with lag > 10K messages; app-level slowness or downstream errors are likely.",
    trigger: (state) => {
      const groups = getKafkaData(state).consumerGroups ?? [];
      const matched = groups.filter((g) => g.state === "Stable" && (g.totalLag ?? 0) > 10_000);
      return matched.length === 0
        ? null
        : {
            context: {
              groupIds: matched.map((g) => g.id),
              lags: matched.map((g) => g.totalLag),
            },
          };
    },
    requiredAgent: "elastic-agent",
    retry: { attempts: 3, timeoutMs: 30_000 },
  },
  {
    name: "kafka-dlq-growth",
    description:
      "DLQ topic with messages added since baseline (live failure, not historical noise).",
    trigger: (state) => {
      const dlqs = getKafkaData(state).dlqTopics ?? [];
      const matched = dlqs.filter((d) => (d.recentDelta ?? 0) > 0);
      return matched.length === 0
        ? null
        : { context: { topics: matched.map((d) => ({ name: d.name, delta: d.recentDelta })) } };
    },
    requiredAgent: "elastic-agent",
    retry: { attempts: 3, timeoutMs: 30_000 },
  },
  {
    name: "kafka-tool-failures",
    description:
      "kafka-agent tool calls failed; check whether broker logs in Elastic show cluster-side issues.",
    trigger: (state) => {
      const failures = getKafkaData(state).toolErrors ?? [];
      return failures.length === 0
        ? null
        : { context: { errors: failures.map((e) => ({ tool: e.tool, code: e.code })) } };
    },
    requiredAgent: "elastic-agent",
    retry: { attempts: 3, timeoutMs: 30_000 },
  },
];
```

- [ ] **Step 4: Implement `engine.ts`**

```ts
// packages/agent/src/correlation/engine.ts
import type { AgentStateType } from "../state";
import type { CorrelationRule, TriggerMatch } from "./rules";

export interface CorrelationDecision {
  rule: CorrelationRule;
  status: "satisfied" | "needs-invocation";
  match: TriggerMatch | null;
  reason: string;
}

export function evaluate(state: AgentStateType, rules: CorrelationRule[]): CorrelationDecision[] {
  return rules.map((rule) => evaluateOne(state, rule));
}

function evaluateOne(state: AgentStateType, rule: CorrelationRule): CorrelationDecision {
  let match: TriggerMatch | null;
  try {
    match = rule.trigger(state);
  } catch (err) {
    return {
      rule,
      status: "satisfied",
      match: null,
      reason: `predicate error (fail-open): ${(err as Error).message}`,
    };
  }
  if (match === null) {
    return { rule, status: "satisfied", match: null, reason: "trigger conditions absent" };
  }
  if (alreadyCovered(state, rule, match)) {
    return { rule, status: "satisfied", match, reason: "already covered by prior agent findings" };
  }
  return { rule, status: "needs-invocation", match, reason: "trigger fired; specialist required" };
}

// Idempotency: a rule is already covered if findings exist from the requiredAgent's data source
// referencing at least one of the entities in the trigger context.
function alreadyCovered(
  state: AgentStateType,
  rule: CorrelationRule,
  match: TriggerMatch,
): boolean {
  const dataSourceId = agentToDataSourceId(rule.requiredAgent);
  const result = state.dataSourceResults.find((r) => r.dataSourceId === dataSourceId);
  if (!result || result.status !== "success" || !result.data) return false;

  const triggeredEntities = extractEntityNames(match.context);
  if (triggeredEntities.length === 0) {
    return true; // no entity granularity available; presence of findings counts as covered
  }
  const data = result.data as { services?: Array<{ name: string }> };
  const knownServices = new Set((data.services ?? []).map((s) => s.name));
  return triggeredEntities.some((name) => knownServices.has(name));
}

function agentToDataSourceId(agent: string): string {
  return agent.replace(/-agent$/, "");
}

function extractEntityNames(context: Record<string, unknown>): string[] {
  const names: string[] = [];
  if (Array.isArray(context.groupIds)) {
    for (const x of context.groupIds) if (typeof x === "string") names.push(x);
  }
  if (Array.isArray(context.topics)) {
    for (const x of context.topics) {
      if (x && typeof x === "object" && "name" in x && typeof (x as { name: unknown }).name === "string") {
        names.push((x as { name: string }).name);
      }
    }
  }
  return names;
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `bun run --filter @devops-agent/agent test tests/correlation/engine.test.ts`
Expected: PASS.

- [ ] **Step 6: Run lint + typecheck**

Run in parallel:
- `bun run --filter @devops-agent/agent typecheck`
- `bun run lint`

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/correlation/rules.ts \
        packages/agent/src/correlation/engine.ts \
        packages/agent/tests/correlation/engine.test.ts
git commit -m "SIO-681: add correlation rule engine and 4 initial rules"
```

---

## Task A4: `enforceCorrelations` router + `enforceCorrelationsAggregate` follow-up node

**Files:**
- Create: `packages/agent/src/correlation/enforce-node.ts`
- Test: `packages/agent/tests/correlation/enforce-node.test.ts`

The router decides whether any rule needs invocation. If yes, it returns an array of `Send("correlationFetch", ...)` objects (one per unique required-agent + entity bundle), plus a flag in state recording which rules are pending. After re-fan-out, `enforceCorrelationsAggregate` re-evaluates with the new findings, computes `degradedRules` for any rule that still failed, applies the cap.

- [ ] **Step 1: Add a `pendingCorrelations` field to AgentState**

In `packages/agent/src/state.ts`, alongside `degradedRules`, add:

```ts
export interface PendingCorrelation {
  ruleName: string;
  requiredAgent: AgentName;
  triggerContext: Record<string, unknown>;
  attemptsRemaining: number;
  timeoutMs: number;
}
```

In the annotation block:

```ts
pendingCorrelations: Annotation<PendingCorrelation[]>({
  reducer: (_, next) => next,
  default: () => [],
}),
```

- [ ] **Step 2: Write failing tests for the router**

```ts
// packages/agent/tests/correlation/enforce-node.test.ts
import { describe, expect, test } from "bun:test";
import { Send } from "@langchain/langgraph";
import { enforceCorrelationsRouter, enforceCorrelationsAggregate } from "../../src/correlation/enforce-node";
import { baseState, withKafkaResult } from "./test-helpers";
import type { AgentStateType } from "../../src/state";

describe("enforceCorrelationsRouter", () => {
  test("returns Send objects when rules need invocation", () => {
    const state = withKafkaResult(baseState(), {
      consumerGroups: [{ id: "notification-service", state: "Empty" }],
    });
    const result = enforceCorrelationsRouter(state);
    expect(Array.isArray(result)).toBe(true);
    const sends = result as Send[];
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(sends[0]).toBeInstanceOf(Send);
  });

  test("returns the next node name when no rules fire", () => {
    const state = withKafkaResult(baseState(), {
      consumerGroups: [{ id: "payments", state: "Stable", totalLag: 0 }],
    });
    const result = enforceCorrelationsRouter(state);
    expect(result).toBe("enforceCorrelationsAggregate");
  });

  test("dedups same agent across multiple rules", () => {
    const state = withKafkaResult(baseState(), {
      consumerGroups: [{ id: "notification-service", state: "Empty", totalLag: 50_000 }],
    });
    const result = enforceCorrelationsRouter(state);
    const sends = result as Send[];
    expect(sends.filter((s) => s.node === "correlationFetch")).toHaveLength(1);
  });
});

describe("enforceCorrelationsAggregate", () => {
  test("no pending correlations => no-op pass-through", async () => {
    const state = withKafkaResult(baseState(), { consumerGroups: [] });
    const result = await enforceCorrelationsAggregate(state);
    expect(result.degradedRules).toEqual([]);
    expect(result.confidenceCap).toBeUndefined();
  });

  test("pending rule satisfied by new findings => no degradedRules", async () => {
    const state: AgentStateType = {
      ...withKafkaResult(baseState(), {
        consumerGroups: [{ id: "notification-service", state: "Empty" }],
      }),
      dataSourceResults: [
        {
          dataSourceId: "kafka",
          status: "success",
          data: { consumerGroups: [{ id: "notification-service", state: "Empty" }] },
          duration: 10,
        } as never,
        {
          dataSourceId: "elastic",
          status: "success",
          data: { services: [{ name: "notification-service", errorRate: 0.02 }] },
          duration: 200,
        } as never,
      ],
      pendingCorrelations: [
        {
          ruleName: "kafka-empty-or-dead-groups",
          requiredAgent: "elastic-agent",
          triggerContext: { groupIds: ["notification-service"] },
          attemptsRemaining: 0,
          timeoutMs: 30_000,
        },
      ],
    };
    const result = await enforceCorrelationsAggregate(state);
    expect(result.degradedRules).toEqual([]);
    expect(result.confidenceCap).toBeUndefined();
  });

  test("pending rule NOT satisfied => degradedRules entry, confidence capped at 0.6", async () => {
    const state: AgentStateType = {
      ...withKafkaResult(baseState(), {
        consumerGroups: [{ id: "notification-service", state: "Empty" }],
      }),
      confidenceScore: 0.85,
      pendingCorrelations: [
        {
          ruleName: "kafka-empty-or-dead-groups",
          requiredAgent: "elastic-agent",
          triggerContext: { groupIds: ["notification-service"] },
          attemptsRemaining: 0,
          timeoutMs: 30_000,
        },
      ],
    };
    const result = await enforceCorrelationsAggregate(state);
    expect(result.degradedRules?.length).toBe(1);
    expect(result.degradedRules?.[0].ruleName).toBe("kafka-empty-or-dead-groups");
    expect(result.confidenceCap).toBe(0.6);
    expect(result.confidenceScore).toBe(0.6);
  });

  test("currentScore already below cap => leaves it alone but still records cap value", async () => {
    const state: AgentStateType = {
      ...withKafkaResult(baseState(), {
        consumerGroups: [{ id: "notification-service", state: "Empty" }],
      }),
      confidenceScore: 0.4,
      pendingCorrelations: [
        {
          ruleName: "kafka-empty-or-dead-groups",
          requiredAgent: "elastic-agent",
          triggerContext: { groupIds: ["notification-service"] },
          attemptsRemaining: 0,
          timeoutMs: 30_000,
        },
      ],
    };
    const result = await enforceCorrelationsAggregate(state);
    expect(result.confidenceCap).toBe(0.6);
    expect(result.confidenceScore).toBe(0.4);
  });
});
```

Extract `baseState`/`withKafkaResult`/`withElasticResult` from `engine.test.ts` into a shared `tests/correlation/test-helpers.ts` file at this point (both test files import from it).

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun run --filter @devops-agent/agent test tests/correlation/enforce-node.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `enforce-node.ts`**

```ts
// packages/agent/src/correlation/enforce-node.ts
import { Send } from "@langchain/langgraph";
import { getLogger } from "@devops-agent/observability";
import type { AgentStateType, DegradedRule, PendingCorrelation } from "../state";
import { correlationRules } from "./rules";
import { evaluate } from "./engine";

const logger = getLogger("agent:enforceCorrelations");
const CONFIDENCE_CAP_ON_DEGRADATION = 0.6;

// Router: runs immediately after `aggregate`. Returns either:
//  - an array of Send objects (re-fan-out via correlationFetch), OR
//  - the string "enforceCorrelationsAggregate" (skip re-fan-out, go straight to aggregator)
export function enforceCorrelationsRouter(
  state: AgentStateType,
): Send[] | "enforceCorrelationsAggregate" {
  const decisions = evaluate(state, correlationRules);
  const needsInvocation = decisions.filter((d) => d.status === "needs-invocation");

  if (needsInvocation.length === 0) {
    logger.info({ rulesEvaluated: decisions.length }, "No correlation rules require invocation");
    return "enforceCorrelationsAggregate";
  }

  // Dedupe: collapse multiple rules requiring same agent into one Send.
  const dedupedByAgent = new Map<string, PendingCorrelation[]>();
  for (const d of needsInvocation) {
    const key = d.rule.requiredAgent;
    const existing = dedupedByAgent.get(key) ?? [];
    existing.push({
      ruleName: d.rule.name,
      requiredAgent: d.rule.requiredAgent,
      triggerContext: d.match?.context ?? {},
      attemptsRemaining: d.rule.retry.attempts,
      timeoutMs: d.rule.retry.timeoutMs,
    });
    dedupedByAgent.set(key, existing);
  }

  const sends: Send[] = [];
  for (const [agent, pendings] of dedupedByAgent.entries()) {
    const dataSourceId = agent.replace(/-agent$/, "");
    sends.push(
      new Send("correlationFetch", {
        ...state,
        currentDataSource: dataSourceId,
        pendingCorrelations: pendings,
      }),
    );
  }

  logger.info(
    { ruleCount: needsInvocation.length, sendCount: sends.length },
    "Correlation rules require specialist invocation; dispatching",
  );
  return sends;
}

// Follow-up node: receives state after the re-fan-out completes.
export async function enforceCorrelationsAggregate(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  if (state.pendingCorrelations.length === 0) {
    return { degradedRules: [], confidenceCap: undefined };
  }

  const decisions = evaluate(state, correlationRules);
  const degraded: DegradedRule[] = [];

  for (const pending of state.pendingCorrelations) {
    const decision = decisions.find((d) => d.rule.name === pending.ruleName);
    if (!decision || decision.status === "satisfied") continue;
    degraded.push({
      ruleName: pending.ruleName,
      requiredAgent: pending.requiredAgent,
      reason:
        "specialist invoked but findings did not cover the triggered entities (or invocation failed upstream)",
      triggerContext: pending.triggerContext,
    });
  }

  if (degraded.length === 0) {
    logger.info("All pending correlations satisfied after re-fan-out");
    return { degradedRules: [], confidenceCap: undefined, pendingCorrelations: [] };
  }

  const cap = CONFIDENCE_CAP_ON_DEGRADATION;
  const cappedScore = Math.min(state.confidenceScore, cap);
  logger.warn(
    { degradedCount: degraded.length, cap, originalScore: state.confidenceScore, cappedScore },
    "One or more correlation rules degraded; capping confidence",
  );
  return {
    degradedRules: degraded,
    confidenceCap: cap,
    confidenceScore: cappedScore,
    pendingCorrelations: [],
  };
}

// correlationFetch: a thin wrapper around the existing queryDataSource that routes its output
// to enforceCorrelationsAggregate instead of back to align/aggregate.
// Implementation: import queryDataSource from its current home (verify in Task A0) and call
// it directly here.
export async function correlationFetch(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // Import determined in Task A0. If queryDataSource is not exported as a callable function,
  // promote it as part of Task A5 Step 3b.
  const { queryDataSource } = await import("../<wherever-queryDataSource-lives>");
  return queryDataSource(state);
}
```

**How findings flow:** `dataSourceResults` has an "append (empty resets)" reducer in `state.ts`. When `enforceCorrelationsRouter` returns Send objects, each forks a parallel branch invoking `correlationFetch` (which calls the same datasource-querying logic as `queryDataSource`). LangGraph merges parallel branches at the join (`enforceCorrelationsAggregate`). The aggregate node sees the merged state with the NEW elastic finding appended, runs `evaluate` again, and idempotency in the engine sees the now-covered services and marks the rule satisfied. If invocation failed upstream, the rule still shows as `needs-invocation` and we mark it degraded.

- [ ] **Step 5: Run tests, verify pass**

Run: `bun run --filter @devops-agent/agent test tests/correlation/`
Expected: all tests in both files pass.

- [ ] **Step 6: Run lint + typecheck**

Run in parallel:
- `bun run --filter @devops-agent/agent typecheck`
- `bun run lint`

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/state.ts \
        packages/agent/src/correlation/enforce-node.ts \
        packages/agent/tests/correlation/test-helpers.ts \
        packages/agent/tests/correlation/enforce-node.test.ts \
        packages/agent/tests/correlation/engine.test.ts
git commit -m "SIO-681: add enforceCorrelations router + aggregate node"
```

---

## Task A5: Wire `enforceCorrelations` into the graph

**Files:**
- Modify: `packages/agent/src/graph.ts`
- Test: `packages/agent/tests/graph-correlation.test.ts` (new — integration smoke)

- [ ] **Step 1: Write the failing integration test**

```ts
// packages/agent/tests/graph-correlation.test.ts
import { describe, expect, test } from "bun:test";
import { buildGraph } from "../src/graph"; // adjust import to whatever the existing test uses

describe("graph wiring — enforceCorrelations", () => {
  test("graph builds without error", () => {
    expect(() => buildGraph()).not.toThrow();
  });

  test("graph contains enforceCorrelationsAggregate node", () => {
    const graph = buildGraph();
    const nodeNames = Object.keys((graph as unknown as { nodes: object }).nodes);
    expect(nodeNames).toContain("enforceCorrelationsAggregate");
    expect(nodeNames).toContain("correlationFetch");
  });
});
```

If `buildGraph` is not the export name, the implementer reads `packages/agent/src/graph.ts` and uses the actual export.

- [ ] **Step 2: Run test, verify it fails**

- [ ] **Step 3: Edit graph.ts**

Locate the existing chain (probe found at lines 71 + 103–105 of `packages/agent/src/graph.ts`):

```ts
.addNode("aggregate", traceNode("aggregate", aggregate))
// ... other addNode calls ...
.addEdge("aggregate", "checkConfidence")
.addEdge("checkConfidence", "validate")
```

Change to:

```ts
.addNode("aggregate", traceNode("aggregate", aggregate))
.addNode("correlationFetch", traceNode("correlationFetch", correlationFetch))
.addNode(
  "enforceCorrelationsAggregate",
  traceNode("enforceCorrelationsAggregate", enforceCorrelationsAggregate),
)
.addConditionalEdges("aggregate", enforceCorrelationsRouter, {
  correlationFetch: "correlationFetch",
  enforceCorrelationsAggregate: "enforceCorrelationsAggregate",
})
.addEdge("correlationFetch", "enforceCorrelationsAggregate")
.addEdge("enforceCorrelationsAggregate", "checkConfidence")
.addEdge("checkConfidence", "validate")
```

- [ ] **Step 3b: Promote queryDataSource if not already exported**

If `queryDataSource` is implemented inline in `graph.ts` (not a named export from another module), extract it to a callable function and re-import. `correlationFetch` reuses the same function.

- [ ] **Step 4: Run test, verify pass**

- [ ] **Step 5: Run full agent test suite + typecheck + lint**

Run in parallel:
- `bun run --filter @devops-agent/agent test`
- `bun run --filter @devops-agent/agent typecheck`
- `bun run lint`

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/graph.ts \
        packages/agent/src/correlation/enforce-node.ts \
        packages/agent/tests/graph-correlation.test.ts
git commit -m "SIO-681: wire enforceCorrelations router + aggregate into graph"
```

---

## Task A6: End-to-end verification

- [ ] **Step 1: Run a c72-style replay**

With elastic-agent **mocked unreachable**, run a c72-style incident through the supervisor. The report MUST contain a `degradedRules` entry with `reason` populated. The literal string `"Elasticsearch not queried"` must NOT appear in the final answer.

If no harness exists, write a small `tests/integration/c72-replay.test.ts` that constructs a state with Empty consumer groups and runs the full graph with stubbed agents.

- [ ] **Step 2: Run the same replay with elastic-agent reachable**

Verify: report contains real elastic findings, `confidenceCap` is `undefined`, `degradedRules` is empty.

- [ ] **Step 3: Final commit if anything changed during verification**

```bash
git commit -m "SIO-681: end-to-end verification fixtures"
```

- [ ] **Step 4: Open PR**

Title: `SIO-681: mandatory cross-agent correlation rule engine`
Body: link the spec; summarize the four rules; note the DLQ inventory addition; reference the c72 incident as the motivating case.
