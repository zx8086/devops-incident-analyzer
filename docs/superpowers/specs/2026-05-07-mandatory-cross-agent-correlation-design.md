# Mandatory Cross-Agent Correlation — Design

## Context

The original c72-shared-services-msk Kafka health report shipped with a "Confidence: 0.62" verdict and an explicit gap line: *"Elasticsearch not queried."* The kafka-agent had observed 55 EMPTY consumer groups for named services like `notification-service`, but the supervisor pipeline finalized the report without ever invoking elastic-agent to check whether the underlying applications had errors. The kafka-consumer-lag runbook *did* tell the agent to query Elastic in this case (Step 7), but the runbook is markdown — guidance the supervisor can ignore, and historically did.

SIO-679 closed the gap at the runbook layer (made Step 7 mandatory by wording, added an inference subsection for service names, forbade "Elasticsearch not queried" in the kafka-agent SOUL). The runbook strengthening is real, but it's still markdown — fragile by design. The c72 incident itself was triggered by exactly this fragility, and the SIO-679 description acknowledges that promoting the rule into supervisor-pipeline code is the durable fix if the runbook proves insufficient.

This spec promotes the rule into supervisor-pipeline code: a generic, config-driven correlation rule engine that forces required cross-agent hand-offs based on specialist findings, with bounded retry and graceful degradation when the required correlation is genuinely unreachable.

## Goals

1. **No future report finalizes with skipped correlations** when specialist findings imply correlation is needed. The supervisor pipeline enforces this at code level, not runbook level.
2. **Distinguish "we didn't try" (forbidden) from "we tried, infra failed" (acceptable, surfaced).** Reports that hit infrastructure failures during enforced correlation should still finalize, but with downgraded confidence and an explicit reason line.
3. **Rule engine is generic across all specialists.** Adding a new rule (e.g., capella-agent for downstream sink failures) is a one-place config change, not a code change.
4. **Stays within YAGNI guardrails.** No rule priorities, no multi-agent triggers, no rule-fired-too-often suppression. Stateless evaluation per run.

## Non-goals

- Replacing or refactoring the existing 12-node LangGraph supervisor — the new node inserts cleanly between aggregate and validate.
- Chasing newly-fired rules whose triggers depend on the *result* of an invoked specialist (one rule pass per run, surfaced as `degradedRules` for follow-up).
- Persisting state across runs (no "this rule fired N times in the last hour, suppress" logic).
- Modifying the existing `validate` node beyond honoring `confidenceCap` set by the rule engine.

## Architecture

One new pipeline node `enforceCorrelations` is inserted into the supervisor `StateGraph` between `aggregate` and `validate`. The node consults a static array of `CorrelationRule` definitions, evaluates each against the current `IncidentState`, and either invokes the required specialist (with bounded retry) or marks the rule satisfied.

The node makes a single pass. It is idempotent within a run: if a specialist already produced findings for the service-name(s) implied by a rule's trigger context, the rule counts as satisfied without re-invocation.

Pipeline flow (changes in **bold**):

```
START -> classify -> {simple: responder -> followUp -> END, complex: normalize}
  -> [selectRunbooks] -> entityExtractor -> fan-out [elastic, kafka, capella, konnect, gitlab]
  -> align -> aggregate -> **enforceCorrelations** -> validate -> proposeMitigation -> followUp -> END
```

## Components

Three new files in `packages/agent/src/correlation/`, plus a small edit to the existing graph builder and an additive change to the `IncidentState` type. Tests live in `packages/agent/tests/correlation/`. A separate small change is needed in `packages/mcp-server-kafka/` to support the DLQ-growth rule (see Initial Rule Set below).

```
packages/agent/src/
├── correlation/
│   ├── rules.ts               # Rule definitions (config-as-code)
│   ├── engine.ts              # Pure evaluation: (state, rules) -> decisions
│   └── enforce-node.ts        # Pipeline node: invokes specialists with bounded retry
└── graph/builder.ts           # EDITED: insert enforceCorrelations between aggregate and validate

packages/agent/tests/correlation/
├── engine.test.ts             # Pure-function tests for rule evaluation
└── enforce-node.test.ts       # Integration tests with mocked specialist invocation

packages/mcp-server-kafka/src/services/kafka-service.ts
  # EDITED: dlqTopics[] entries gain a recentDelta field, computed from two offset samples
```

**Why the split:**
- `rules.ts` is config — adding a fifth rule later is a one-place change with no logic touched.
- `engine.ts` is pure: takes `(state, rules) => decisions`, no I/O, no side effects. Trivial to unit-test.
- `enforce-node.ts` is the impure shell — calls the engine, then performs side effects (specialist invocation, retries, state mutation). Standard "functional core, imperative shell" pattern.

Tests mirror the split. Engine tests are fast and exhaustive; node tests cover pipeline integration.

Each file has a single clear purpose, well under 200 lines.

## Data shapes

```ts
// packages/agent/src/correlation/rules.ts
export type AgentName = "elastic-agent" | "kafka-agent" | "capella-agent" | "konnect-agent" | "gitlab-agent";

export interface CorrelationRule {
  name: string;                                          // stable id, e.g. "kafka-empty-or-dead-groups"
  description: string;                                   // human-readable, surfaces in degradedRule output
  trigger: (state: IncidentState) => TriggerMatch | null; // null = no match
  requiredAgent: AgentName;
  retry: { attempts: number; timeoutMs: number };
}

export interface TriggerMatch {
  // What about the state caused this rule to fire — flows into the specialist invocation prompt
  // and into degradedRules output. e.g. { groupIds: ["notification-service", "customer-assignments"] }
  context: Record<string, unknown>;
}
```

```ts
// packages/agent/src/correlation/engine.ts
export interface CorrelationDecision {
  rule: CorrelationRule;
  status: "satisfied" | "needs-invocation";
  match: TriggerMatch | null;        // only set when status = "needs-invocation"
  reason: string;                    // why satisfied/needs-invocation, for logging
}

export function evaluate(state: IncidentState, rules: CorrelationRule[]): CorrelationDecision[];
```

```ts
// packages/agent/src/state.ts (additive)
export interface IncidentState {
  // ... existing fields
  degradedRules?: Array<{
    ruleName: string;
    requiredAgent: AgentName;
    reason: string;                  // e.g. "elastic-agent unreachable: ECONNREFUSED after 3 attempts"
    triggerContext: Record<string, unknown>;
  }>;
  confidenceCap?: number;            // e.g. 0.6; the validate node respects this as an upper bound
}
```

**Subtle points:**

1. `trigger` returns `TriggerMatch | null`, not `boolean`. When the rule fires, we know *why* and *which entities*. That context flows into the specialist invocation, so `elastic-agent` queries the specific service names that triggered the rule, not all of them from scratch.
2. `confidenceCap` is an upper bound applied by the existing validate node. The engine doesn't compute confidence — it records "no rule should let this report exceed 0.6". Validate honors it. Engine stays pure; existing validate logic remains the source of truth for confidence calculation.

## Initial rule set

Four rules, all targeting `elastic-agent`:

```ts
// packages/agent/src/correlation/rules.ts
export const correlationRules: CorrelationRule[] = [
  {
    name: "kafka-empty-or-dead-groups",
    description: "Kafka consumer groups in Empty/Dead state imply the consuming app may have exceptions; correlate with app logs.",
    trigger: (state) => {
      const groups = state.kafkaFindings?.consumerGroups ?? [];
      const matched = groups.filter((g) => g.state === "Empty" || g.state === "Dead");
      return matched.length === 0 ? null : { context: { groupIds: matched.map((g) => g.id) } };
    },
    requiredAgent: "elastic-agent",
    retry: { attempts: 3, timeoutMs: 30_000 },
  },
  {
    name: "kafka-significant-lag",
    description: "Stable consumer group with lag > 10K messages; app-level slowness or downstream errors are likely.",
    trigger: (state) => {
      const groups = state.kafkaFindings?.consumerGroups ?? [];
      const matched = groups.filter((g) => g.state === "Stable" && (g.totalLag ?? 0) > 10_000);
      return matched.length === 0 ? null : { context: { groupIds: matched.map((g) => g.id), lags: matched.map((g) => g.totalLag) } };
    },
    requiredAgent: "elastic-agent",
    retry: { attempts: 3, timeoutMs: 30_000 },
  },
  {
    name: "kafka-dlq-growth",
    description: "DLQ topic with messages added since baseline (live failure, not historical noise).",
    trigger: (state) => {
      const dlqs = state.kafkaFindings?.dlqTopics ?? [];
      const matched = dlqs.filter((d) => (d.recentDelta ?? 0) > 0);
      return matched.length === 0 ? null : { context: { topics: matched.map((d) => ({ name: d.name, delta: d.recentDelta })) } };
    },
    requiredAgent: "elastic-agent",
    retry: { attempts: 3, timeoutMs: 30_000 },
  },
  {
    name: "kafka-tool-failures",
    description: "kafka-agent tool calls failed; check whether broker logs in Elastic show cluster-side issues.",
    trigger: (state) => {
      const failures = state.kafkaFindings?.toolErrors ?? [];
      return failures.length === 0 ? null : { context: { errors: failures.map((e) => ({ tool: e.tool, code: e.code })) } };
    },
    requiredAgent: "elastic-agent",
    retry: { attempts: 3, timeoutMs: 30_000 },
  },
];
```

**Notes on the rules:**

- **`kafka-dlq-growth` checks `recentDelta`, not `totalMessages`.** The c72 incident proved that historical DLQ counts can be misleading — `sap-car-prices-dlt` had 177,700 messages from past failures while the live incident was unrelated. The rule fires only when DLQ messages accumulate during the incident window. This requires kafka-agent to populate `recentDelta` on `dlqTopics[]` entries — see "Upstream change" below.

- **All four rules target `elastic-agent`.** Same target by design — the link between "Kafka shows symptoms" and "app logs explain why" is universal. Future rules pointing at other agents (capella-agent, gitlab-agent) are cleanly additive: same shape, different `requiredAgent`.

## Upstream change in kafka-agent (`packages/mcp-server-kafka/src/services/kafka-service.ts`)

To support `kafka-dlq-growth`, `dlqTopics[]` entries gain a `recentDelta: number | null` field, computed inside the existing DLQ-listing code path:

1. Identify DLQ topics as today (suffix-based: `*-dlq`, `dlt-*`, `dead-letter-*`, etc.).
2. For each, take an immediate `kafka_get_topic_offsets` snapshot (`sample1.totalMessages`).
3. Wait `~30s` (configurable, default 30s; capped to avoid blowing the agent's budget for clusters with many DLQs).
4. Take a second snapshot (`sample2.totalMessages`).
5. Emit `recentDelta = sample2.totalMessages - sample1.totalMessages`.

If `dlqTopics.length === 0` after step 1, skip steps 2-5 entirely — no second sampling, no 30s wait. The optimization matters because most healthy clusters have empty DLQ inventories, and a 30s no-op penalty on every kafka-agent invocation is unacceptable.

For DLQ inventories larger than `N=20` topics, the second sampling is parallelized in batches to keep the total wall-time bounded at `~30s` regardless of DLQ count. If the second sample fails (e.g., topic deleted between samples), `recentDelta = null` and the rule treats it as no-fire (conservative — avoids fabricating signal).

This is a self-contained change inside `kafka-service.ts` and a small Zod schema addition for the output shape. No new tools.

## Idempotency: how engine.ts decides "already satisfied"

For each rule, the engine inspects `state.elasticFindings` (or the relevant agent's findings array). If findings exist that reference the same service-name(s) implied by the trigger context, the rule is `satisfied` without re-invocation. This depends on `elasticFindings` entries carrying their `service.name` query value, which they do today.

De-duplication is per-(agent, service) tuple within a run. If multiple rules require `elastic-agent` for the same set of services, the specialist is invoked once at most.

## Error handling

| Failure mode | Behavior |
|---|---|
| Specialist invocation throws (network, MCP error) | Catch, retry up to `rule.retry.attempts` times. Each attempt has `rule.retry.timeoutMs` ceiling. |
| All retries exhausted | Append `{ ruleName, requiredAgent, reason: "<last error>", triggerContext }` to `state.degradedRules`. Set `state.confidenceCap = min(0.6, current)`. Continue to validate. |
| Specialist returns empty findings | Treat as success (specialist ran, produced nothing — that's a valid answer). Rule satisfied. |
| Trigger predicate itself throws (bug in rule) | Catch in `engine.ts`, log error, treat rule as `satisfied` (fail-open — a buggy rule shouldn't block the report). Add `degradedRules` entry noting the rule was skipped due to predicate error. |
| Multiple rules trigger same agent for same service | Idempotency check de-dups: specialist invoked at most once per (agent, service) tuple. |
| New rule triggered by the *result* of a specialist invocation | Not chased — design states one pass only. Logged as `degradedRules` with reason `"triggered after correlation already complete; not chased to avoid loops"`. Surfaced for follow-up investigation. |

## Testing

**Unit (`engine.test.ts` — pure-function tests):**
- Each of the 4 rules fires correctly on the right inputs (4 happy-path tests).
- Each rule does NOT fire when conditions absent.
- Idempotency: rule with prior `elasticFindings` covering the relevant service returns `satisfied`.
- Trigger predicate that throws is caught; engine continues evaluating other rules.
- Multiple rules with overlapping required-agent + service de-dup correctly.
- No mocks needed beyond input state.

**Integration (`enforce-node.test.ts` — with mocked specialist invocation):**
- Happy path: Empty groups in kafka findings → node invokes mocked elastic-agent → state has elastic findings appended → no degraded rules.
- Specialist invocation fails 3× → node retries → exhausts → adds `degradedRules` entry → sets `confidenceCap` to 0.6 → run continues to validate.
- No rules fire (kafka findings all Stable, no errors) → node is a no-op pass-through.
- Specialist already satisfied (state pre-populated with elastic findings) → node skips invocation, marks rule satisfied.

**Upstream change in kafka-agent (kafka-service.ts):**
- Existing kafka-service tests must continue to pass.
- New tests for the two-sample `recentDelta` computation: positive delta, zero delta, second-sample failure (returns `null`), parallelization for large DLQ inventories.

## Verification (end-to-end)

After implementation:

1. `bun run --filter @devops-agent/agent typecheck` and `bun run --filter @devops-agent/mcp-server-kafka typecheck` pass.
2. `bun run --filter @devops-agent/agent test` and `bun run --filter @devops-agent/mcp-server-kafka test` pass, including new test files.
3. `bun run lint` clean.
4. Re-run a c72-style incident through the supervisor with elastic-agent mocked-out: report MUST contain either elastic findings OR a `degradedRules` entry with explicit `reason`. The literal string `"Elasticsearch not queried"` must NOT appear in any report containing Empty/Dead consumer groups.
5. Re-run a c72-style incident with elastic-agent reachable: report contains real elastic findings; `confidenceCap` is unset.

## Out of scope

- Promoting other runbook MUSTs into pipeline rules beyond the four listed. Future rules are additive; design supports them without code changes.
- Modifying the validate node's confidence calculation logic beyond honoring `confidenceCap`.
- Modifying the existing 12-node LangGraph topology beyond inserting `enforceCorrelations`.
- Persisting rule-firing history across runs.
- Cross-agent triggers (a single rule that requires multiple agents).
- Rule priorities or partial ordering.

## Risks

- **Pipeline latency increase.** The new node adds at minimum the time for one elastic-agent invocation when triggered. Acceptable: the alternative is a wrong report. Bounded retry (90s worst case for 3× 30s) limits the worst case.
- **Idempotency-by-service-name relies on elasticFindings carrying `service.name`.** True today, but if the elasticFindings shape changes, the de-dup logic breaks silently (re-invokes specialist). Mitigated by an integration test that verifies de-dup behavior.
- **Two-sample DLQ delta adds ~30s to every kafka-agent invocation, even when no DLQs are present.** Mitigation: skip the second sample entirely if `dlqTopics.length === 0`.
- **The "one pass" decision means a rule fired by elastic-agent's output isn't chased.** Acceptable per design (avoid loops). Surfaced as `degradedRules` so it doesn't go silently unaddressed.
