# AWS Datasource Phase 5 — Correlation Rules

**Status:** Approved
**Parent epic:** [SIO-756](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)
**Parent design:** [2026-05-15-aws-datasource-design.md](./2026-05-15-aws-datasource-design.md) (Phase 5 outline at lines 327–330)
**Phase 1:** SIO-757 — IAM scaffolding (merged)
**Phase 2:** SIO-758 — `packages/mcp-server-aws/` native MCP server (merged)
**Phase 3:** SIO-759 — AgentCore deployment (merged, PR #93)
**Phase 4:** SIO-760 — Agent pipeline integration (merged, PR #94)
**Date:** 2026-05-16

## Goal

Add three correlation rules to the SIO-681 enforcement framework so the aggregator can detect cross-source dependencies involving the AWS datasource. All three rules use the production-live prose-matching pattern (SIO-717/742 style) and ship correlated re-fan-out from day one.

## Non-goals

- Sub-agent structured-data emission (would unblock the existing dormant `kafka-empty-or-dead-groups`-style rules; see `getKafkaData`'s comment in `rules.ts`) — pre-existing tech debt, separate epic.
- AWS-specific runbooks under `agents/incident-analyzer/knowledge/runbooks/` — separate ticket; the parent design lists them but they're a distinct deliverable.
- LangSmith eval dataset for AWS correlation findings — separate ticket per parent design.
- A live AgentCore probe — Phase 3 was that gate; Phase 5's new behavior is code-testable.
- Fixing the pre-existing `capella-agent → capella` (instead of `couchbase`) bug in `engine.agentToDataSourceId` — out of scope; doesn't affect aws-agent because we chose its name to match `DATA_SOURCE_IDS`.
- Migrating the existing dormant structured-data rules to prose-matching — out of scope; they have their own tickets.

## Inputs from prior phases

- `aws-agent` is wired into the supervisor's fan-out (Phase 4, SIO-760).
- `AgentName` union accepts `"aws-agent"`; `AGENT_NAMES` tables in both `supervisor.ts` and `sub-agent.ts` map `aws → aws-agent`.
- `DATA_SOURCE_IDS` includes `"aws"`; `mcp-bridge.ts` exports `DATASOURCE_TO_MCP_SERVER` with `aws → aws-mcp`.
- A complex incident already produces a `DataSourceResult` with `dataSourceId: "aws"` and `result.data` as the LLM's prose summary (matching what the other sub-agents emit).
- The correlation engine (`packages/agent/src/correlation/engine.ts`) already does prose-driven rule evaluation via the existing `correlationRules` array and `agentToDataSourceId` derives the datasource from the agent name via `agent.replace(/-agent$/, "")` — so `aws-agent → aws` works without any engine change.
- The SIO-681 confidence cap (`CONFIDENCE_CAP_ON_DEGRADATION = 0.59` in `enforce-node.ts`) automatically applies when any rule remains degraded after re-fan-out.

## Architecture

```
                    aggregate
                        |
                        v
            enforceCorrelationsRouter
                        |
            +-----------+-----------+
            |                       |
   no rules fired              one or more rules fired
            |                       |
            v                       v
  enforceCorrelations         Send[] (re-fan-out to)
       Aggregate              each rule's requiredAgent
            |                       |
            |                       v
            +-----------+    aggregator + cap (0.59 if still degraded)
                        |
                        v
                  checkConfidence
```

Phase 5 only adds rules to the `correlationRules` array. The 13-node pipeline, the router, the engine, the cap logic — all unchanged. The three new rules just give the router more triggers to evaluate.

## Changes

### Change 1 — Add the AWS prose extraction helper to `rules.ts`

Mirror `getKafkaResultSignals`. Place it near that function so future maintainers see them paired:

```typescript
// SIO-756 Phase 5 (mirrors getKafkaResultSignals for aws-agent).
// The aws sub-agent emits its findings as a prose string in result.data
// and structured tool errors in result.toolErrors. Both are read by the
// new aws-* correlation rules.
function getAwsResultSignals(state: AgentStateType): { toolErrors: ToolError[]; prose: string } {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "aws");
	if (!result || result.status !== "success") return { toolErrors: [], prose: "" };
	const toolErrors = Array.isArray(result.toolErrors) ? result.toolErrors : [];
	const prose = typeof result.data === "string" ? result.data : "";
	return { toolErrors, prose };
}
```

No structural change to `result.data` typing required — the function reads the existing shape produced by `sub-agent.ts:301` (string prose) and existing `result.toolErrors` (already populated by Phase 2 SDK error mapping).

### Change 2 — Three new rule definitions in `rules.ts`

Append all three to the existing `correlationRules` array, between the Kafka rules and the SIO-712 `gitlab-deploy-vs-datastore-runtime` rule (which itself is appended after the array literal via `correlationRules.push(...)`). Order them by source-of-signal so future readers can scan by triggering datasource.

#### Rule 1: `aws-ecs-degraded-needs-elastic-traces`

```typescript
{
	// Phase 5 (SIO-7XX): aws-agent reported one or more ECS services in a
	// degraded state (runningCount < desiredCount, or "0 of N tasks running",
	// or explicit "service degraded" phrasing). Application logs/traces in
	// Elasticsearch typically explain WHY the tasks aren't running (OOM,
	// startup crash, image pull failure, etc.), so dispatch elastic-agent
	// to cross-check before the report concludes.
	name: "aws-ecs-degraded-needs-elastic-traces",
	description:
		"AWS sub-agent reported ECS service with runningCount < desiredCount; correlate with application traces in Elasticsearch.",
	trigger: (state) => {
		const { prose } = getAwsResultSignals(state);
		if (!prose) return null;
		// Three independent ECS-degraded shapes, any one suffices:
		//   a) "<N> of <M> tasks running" with N < M (numeric pair)
		//   b) "<service-name> is degraded" / "service degraded"
		//   c) "desiredCount" + "runningCount" both named in the same prose
		const taskMatch = prose.match(/\b(\d+)\s*of\s*(\d+)\s+tasks?\s+running\b/i);
		const taskMismatch = taskMatch && Number(taskMatch[1]) < Number(taskMatch[2]);
		const degradedPhrasing = /\bservice(?:\s+[a-zA-Z0-9_-]+)?\s+(?:is\s+)?degraded\b/i.test(prose);
		const structuredEnvelope = /\bdesiredCount\b/.test(prose) && /\brunningCount\b/.test(prose);
		if (!taskMismatch && !degradedPhrasing && !structuredEnvelope) return null;
		return { context: { signal: "aws-ecs-degraded" } };
	},
	requiredAgent: "elastic-agent",
	retry: { attempts: 2, timeoutMs: 30_000 },
},
```

Why this shape: aws-agent's SOUL.md (added in Phase 4) prescribes drilling into ECS via `aws_ecs_describe_services`. The response field names are exactly `desiredCount` / `runningCount`, so when the prose paraphrases the tool output, those names tend to appear. The "0 of N tasks" phrasing is the LLM's natural rendering for incident reports. The "degraded" keyword catches the explicit-statement case.

#### Rule 2: `aws-cloudwatch-anomaly-needs-kafka-lag`

```typescript
{
	// Phase 5 (SIO-7XX): aws-agent reported a CloudWatch alarm in ALARM state
	// whose name or metric references Kafka/MSK. Consumer-lag spikes on the
	// MSK side often anchor the alarm; fan out to kafka-agent for a lag
	// snapshot before the report concludes.
	name: "aws-cloudwatch-anomaly-needs-kafka-lag",
	description:
		"AWS sub-agent reported a CloudWatch alarm in ALARM state referencing Kafka/MSK; correlate with kafka-agent consumer-group lag.",
	trigger: (state) => {
		const { prose } = getAwsResultSignals(state);
		if (!prose) return null;
		// Both signals must coexist in the same prose blob: ALARM state AND a
		// Kafka-related keyword. Either alone is too noisy (alarms exist for
		// every service; Kafka is named in lots of contexts).
		const alarmStated = /\bStateValue\b.*\bALARM\b/i.test(prose) || /\balarm.*\bin\s+ALARM\b/i.test(prose);
		const kafkaContext = /\b(MSK|Kafka|kafka|consumer\s+lag|broker)\b/.test(prose);
		if (!alarmStated || !kafkaContext) return null;
		return { context: { signal: "aws-cloudwatch-alarm-kafka" } };
	},
	requiredAgent: "kafka-agent",
	retry: { attempts: 2, timeoutMs: 30_000 },
},
```

Why this shape: `aws_cloudwatch_describe_alarms` returns each alarm with a `StateValue` field; aws-agent's RULES.md says "When CloudWatch alarms are in ALARM state, surface them with state, threshold, and metric in the report" — so `StateValue: ALARM` reliably appears in the prose. The Kafka-related keyword filter prevents false fan-outs every time any AWS alarm fires (most have nothing to do with Kafka).

#### Rule 3: `kafka-broker-timeout-needs-aws-metrics`

```typescript
{
	// Phase 5 (SIO-7XX): kafka-agent reported broker-side timeout / unreachable
	// MSK cluster / connection failure. AWS-side networking, EC2 instance
	// health, or security-group changes are common root causes; fan out to
	// aws-agent for an MSK cluster + EC2 cross-check.
	name: "kafka-broker-timeout-needs-aws-metrics",
	description:
		"kafka-agent reported broker timeout / connection failure against MSK; correlate with AWS-side MSK cluster metrics, EC2 instance health, and security groups.",
	trigger: (state) => {
		const { toolErrors, prose } = getKafkaResultSignals(state);
		// Two paths: structured tool errors (preferred, set by SIO-725 errors
		// from the kafka MCP server) or prose-mention fallback.
		const networkErrorKind = toolErrors.some(
			(e) => e.kind === "aws-network-error" || e.kind === "aws-server-error",
		);
		const proseBrokerTimeout =
			/\bbroker\b.*(timeout|unreachable|unavailable|connection\s+refused)/i.test(prose) ||
			/\bMSK\b.*(timeout|unreachable|unavailable)/i.test(prose) ||
			/\bkafka\b.*\bconnection\b.*\btimeout\b/i.test(prose);
		if (!networkErrorKind && !proseBrokerTimeout) return null;
		return { context: { signal: "kafka-broker-timeout-needs-aws" } };
	},
	requiredAgent: "aws-agent",
	retry: { attempts: 2, timeoutMs: 30_000 },
},
```

Why this shape: kafka-agent uses the structured `ToolError.kind` values from `mapAwsError` (defined in `packages/mcp-server-aws/src/tools/wrap.ts`). When the kafka MCP server hits an AWS-side networking error (e.g., MSK cluster unreachable), `kind` is `"aws-network-error"`. The prose fallback catches the case where the LLM has summarized the error in natural language but the structured field hasn't been preserved.

This is the only **bidirectional** rule — kafka-agent's findings cause an aws-agent fan-out, the inverse of rules 1 and 2. The framework already supports this; no new wiring needed.

### Change 3 — New `rules.test.ts` file

Place at `packages/agent/src/correlation/rules.test.ts`. Tests live alongside source, following the existing convention.

Test layout (7 tests total):

```typescript
// packages/agent/src/correlation/rules.test.ts
// Unit tests for the Phase 5 AWS correlation rules.
import { describe, expect, test } from "bun:test";
import { correlationRules } from "./rules.ts";

function findRule(name: string) {
	const rule = correlationRules.find((r) => r.name === name);
	if (!rule) throw new Error(`Rule ${name} not found`);
	return rule;
}

function makeStateWithAwsProse(prose: string) {
	return {
		dataSourceResults: [
			{ dataSourceId: "aws", status: "success", data: prose, toolErrors: [] },
		],
	} as never; // partial AgentStateType, sufficient for trigger
}

function makeStateWithKafkaProse(prose: string, toolErrors: Array<{ kind: string }> = []) {
	return {
		dataSourceResults: [
			{ dataSourceId: "kafka", status: "success", data: prose, toolErrors },
		],
	} as never;
}

describe("aws-ecs-degraded-needs-elastic-traces", () => {
	const rule = findRule("aws-ecs-degraded-needs-elastic-traces");

	test("fires on '0 of 3 tasks running' phrasing", () => {
		const state = makeStateWithAwsProse("ECS service my-svc: 0 of 3 tasks running. Last event at 2026-05-16T...");
		expect(rule.trigger(state)).not.toBeNull();
	});

	test("does not fire when desired == running", () => {
		const state = makeStateWithAwsProse("ECS service my-svc: 3 of 3 tasks running. Healthy.");
		expect(rule.trigger(state)).toBeNull();
	});

	test("fires on explicit 'service degraded' phrasing", () => {
		const state = makeStateWithAwsProse("service backend is degraded; investigating.");
		expect(rule.trigger(state)).not.toBeNull();
	});
});

describe("aws-cloudwatch-anomaly-needs-kafka-lag", () => {
	const rule = findRule("aws-cloudwatch-anomaly-needs-kafka-lag");

	test("fires when ALARM state coexists with Kafka context", () => {
		const state = makeStateWithAwsProse(
			"Alarm 'MSK-ConsumerLag-High' StateValue: ALARM. Threshold: 10000 messages.",
		);
		expect(rule.trigger(state)).not.toBeNull();
	});

	test("does not fire for non-Kafka alarms", () => {
		const state = makeStateWithAwsProse(
			"Alarm 'RDS-CPU-High' StateValue: ALARM. Database under heavy load.",
		);
		expect(rule.trigger(state)).toBeNull();
	});
});

describe("kafka-broker-timeout-needs-aws-metrics", () => {
	const rule = findRule("kafka-broker-timeout-needs-aws-metrics");

	test("fires on prose mentioning broker timeout", () => {
		const state = makeStateWithKafkaProse("broker b-1.msk.amazonaws.com unreachable: connection timeout");
		expect(rule.trigger(state)).not.toBeNull();
	});

	test("fires on structured aws-network-error tool error", () => {
		const state = makeStateWithKafkaProse(
			"successful query",
			[{ kind: "aws-network-error", message: "ENOTFOUND" } as never],
		);
		expect(rule.trigger(state)).not.toBeNull();
	});
});
```

Total: 7 tests across the 3 rules. Each rule has at least one positive (trigger fires) and one negative (trigger does not fire) assertion. The `as never` casts replace the full `AgentStateType` (50+ fields, most unused by these triggers).

### Change 4 — One pipeline integration test

Place at `packages/agent/src/correlation/integration.test.ts` (new file). One test exercising the engine + enforce-node end-to-end:

```typescript
// packages/agent/src/correlation/integration.test.ts
// Pipeline integration test: aws-agent reports an ECS service degraded ->
// the engine triggers aws-ecs-degraded-needs-elastic-traces ->
// enforceCorrelationsRouter dispatches an elastic-agent Send.
import { describe, expect, mock, test } from "bun:test";

// Mock the mcp-bridge so the router thinks all servers are connected.
mock.module("../mcp-bridge.ts", () => ({
	getToolsForDataSource: () => [{ name: "fake_tool" }],
	getAllTools: () => [],
	getConnectedServers: () => ["elastic-mcp", "kafka-mcp", "couchbase-mcp", "konnect-mcp", "gitlab-mcp", "aws-mcp"],
	DATASOURCE_TO_MCP_SERVER: {
		elastic: "elastic-mcp",
		kafka: "kafka-mcp",
		couchbase: "couchbase-mcp",
		konnect: "konnect-mcp",
		gitlab: "gitlab-mcp",
		aws: "aws-mcp",
	},
}));

mock.module("../prompt-context.ts", () => ({
	getAgent: () => ({ manifest: { delegation: { mode: "auto" } }, tools: [], subAgents: new Map() }),
	buildOrchestratorPrompt: () => "",
	buildSubAgentPrompt: () => "",
	getToolDefinitionForDataSource: () => undefined,
}));

import { enforceCorrelationsRouter } from "./enforce-node.ts";

describe("ECS-degraded triggers elastic re-fan-out", () => {
	test("aws-agent prose with task mismatch dispatches elastic-agent Send", () => {
		const state = {
			messages: [],
			dataSourceResults: [
				{
					dataSourceId: "aws",
					status: "success" as const,
					data: "ECS service backend: 0 of 5 tasks running. Last event 'CannotPullContainerError'.",
					toolErrors: [],
				},
			],
			extractedEntities: { dataSources: [{ id: "aws", mentionedAs: "explicit" as const }] },
			confidenceCap: undefined,
			degradedRules: [],
			pendingCorrelations: [],
			// Other AgentStateType fields are read but defaults are fine
		} as never;

		const result = enforceCorrelationsRouter(state);

		// Router returns Send[] when one or more rules need invocation.
		expect(Array.isArray(result)).toBe(true);
		if (!Array.isArray(result)) throw new Error("expected Send[]");

		// At least one Send must target the elastic datasource (the rule's requiredAgent).
		const targets = result.map((s) => s.args.currentDataSource);
		expect(targets).toContain("elastic");
	});
});
```

Single integration test; the unit tests in `rules.test.ts` cover the rest. This proves the rule connects through the engine to the router to the actual Send dispatch — closing the gap between unit-test trigger logic and pipeline behavior.

## Gate

Phase 5 is complete when:

1. The three new rules exist in `correlationRules`.
2. The `getAwsResultSignals` helper exists and is used by rules 1 and 2.
3. `rules.test.ts` exists with 7 passing tests.
4. `integration.test.ts` exists with 1 passing test.
5. `bun run --filter @devops-agent/agent test` shows pass count up by 8+ from `main`.
6. No regressions: existing test count unchanged, all green.
7. `bun run --filter @devops-agent/agent typecheck` exits 0.
8. `bunx biome check packages/agent/src/correlation/` exits 0.

## Error modes and recovery

| Failure | Symptom | Recovery |
|---|---|---|
| A new rule's regex throws on a malformed prose input | Engine's existing `try/catch` catches it; rule returns `satisfied` with `predicate error (fail-open)` reason | No code change — the engine already isolates rule failures from the pipeline |
| AWS-related keyword in rule 2 is too aggressive (any mention of "Kafka" fires the rule) | False positive: unnecessary kafka-agent re-fan-out, capped confidence on incidents that didn't need it | Add a calibration commit narrowing the regex; the cap is only `0.59` so it gates HITL, not pipeline progress |
| Sub-agent prose changes phrasing between LLM runs (e.g., model upgrade) | Trigger silently misses the new phrasing; rule effectively dormant on that incident shape | Monitor LangSmith traces; widen the regex when patterns change. Engine fail-open behavior means a missed trigger is a missed correlation, not a crash |
| The integration test mock is incomplete and the router crashes loading state | Test fails locally before merge | Fix in TDD loop; doesn't reach production |

## Reversibility

Phase 5 is independently revertable. The three rules and the helper sit in two new code blocks in `rules.ts` plus two new test files. Reverting all of them restores Phase 4's pipeline behavior exactly. Phase 3's AgentCore runtime and Phase 4's wiring are unaffected.

## Out of scope (later)

- Sub-agent structured-data emission (would unblock existing dormant rules; needs a dedicated epic — see comments in `rules.ts` lines ~37 and ~389).
- AWS-specific runbooks under `agents/incident-analyzer/knowledge/runbooks/`.
- Fixing `engine.agentToDataSourceId`'s incorrect `capella-agent → capella` mapping (should be `capella-agent → couchbase`).
- LangSmith eval dataset for AWS correlation findings.
- Adding bidirectional rules beyond rule 3 (e.g., aws-elasticache-evictions-needs-elastic-cache-misses).
- A `tools/`-and-`skills/` subdirectory under `agents/incident-analyzer/agents/aws-agent/` (parent design suggested this; not adopted in Phase 4, not needed for Phase 5).

## References

- Parent design: `docs/superpowers/specs/2026-05-15-aws-datasource-design.md` (Phase 5 outline at lines 327–330).
- Phase 4 spec: `docs/superpowers/specs/2026-05-15-aws-datasource-phase-4-agent-pipeline-integration.md` (wired aws-agent into the supervisor).
- `packages/agent/src/correlation/rules.ts` — the file extended by Change 1 and Change 2.
- `packages/agent/src/correlation/engine.ts:54` — `agentToDataSourceId` regex that maps `aws-agent → aws`.
- `packages/agent/src/correlation/enforce-node.ts:12` — `CONFIDENCE_CAP_ON_DEGRADATION = 0.59` (the cap that lands when a rule remains degraded).
- `packages/mcp-server-aws/src/tools/wrap.ts` — `mapAwsError` and the `ToolError.kind` values consumed by rule 3.
- Existing prose-matching rules referenced for pattern: `ksqldb-unresponsive-task` (SIO-717), `confluent-component-not-probed` (SIO-742), `ksql-cluster-status-degraded` (SIO-742).
- Memory notes: `reference_supervisor_send_shape` (test assertions read `args.currentDataSource`), `reference_first_deploy_to_fresh_account_bugs` (cautions on bug-discovery during pipeline integration).
