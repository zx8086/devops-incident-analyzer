# AWS Datasource Phase 5 — Correlation Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three prose-matching correlation rules to the SIO-681 enforcement framework so the aggregator detects cross-source dependencies involving the AWS datasource (aws-agent's findings cause elastic/kafka re-fan-out, and kafka findings cause aws-agent re-fan-out).

**Architecture:** All changes are additive: a helper function and three rules appended to `packages/agent/src/correlation/rules.ts`, plus two new test files. No graph topology changes; no existing rules modified; no behavior change to pipeline routing other than the new triggers becoming available.

**Tech Stack:** Bun, TypeScript strict, Zod (for ToolError shape), LangGraph, the existing SIO-681 correlation engine.

**Spec:** [docs/superpowers/specs/2026-05-16-aws-datasource-phase-5-correlation-rules.md](../specs/2026-05-16-aws-datasource-phase-5-correlation-rules.md)

**Parent design:** [docs/superpowers/specs/2026-05-15-aws-datasource-design.md](../specs/2026-05-15-aws-datasource-design.md) (Phase 5 outline at lines 327–330)

**Linear:** Create a sub-issue under [SIO-756](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a) before starting Task 1. Commits use the new sub-issue ID (assume `SIO-761` below — replace with the real ID after creation).

---

## File Map

**New (2 files)**

| File | Responsibility |
|---|---|
| `packages/agent/src/correlation/rules.test.ts` | Unit tests for the three new rules. Asserts trigger() returns null vs TriggerMatch correctly for each prose/error pattern. 7 tests. |
| `packages/agent/src/correlation/integration.test.ts` | One pipeline test: an aws-agent prose claiming an ECS service is degraded must dispatch an elastic-agent Send via `enforceCorrelationsRouter`. |

**Modified (1 file)**

| File | What changes |
|---|---|
| `packages/agent/src/correlation/rules.ts` | Adds `getAwsResultSignals` helper near `getKafkaResultSignals` (~line 45); appends three new rule objects to the end of the `correlationRules` array literal (before the closing `];` at line 330). |

No deletions. No graph topology changes. No new dependencies.

---

## Pre-Task: Create Linear sub-issue and worktree

- [ ] **Step 1: Create Linear sub-issue under SIO-756**

Use the Linear MCP. Title: `Phase 5 — Correlation rules for AWS datasource`. State: `In Progress` (NOT `Done`). Parent: `SIO-756`. Description: link the spec at `docs/superpowers/specs/2026-05-16-aws-datasource-phase-5-correlation-rules.md`.

Capture the issue ID (expected to be the next free number after SIO-760). All commit subjects below use placeholder `SIO-761`; **replace with the real ID** before committing.

- [ ] **Step 2: Create a worktree for this phase**

Per `superpowers:using-git-worktrees`. From the repo root:

```bash
# Replace 761 if Linear assigned a different number
git worktree add ../devops-incident-analyzer-sio-761 -b sio-761-phase-5-correlation-rules main
cd ../devops-incident-analyzer-sio-761
```

All subsequent tasks run inside this worktree.

- [ ] **Step 3: Install dependencies**

```bash
bun install
```

Expected: completes without errors, prints `<N> packages installed`.

- [ ] **Step 4: Confirm pre-conditions**

```bash
# Phase 4 must be on main
git log --oneline | head -3
# Expected: commit a0685f2 SIO-760 (Phase 4) visible

# Existing tests are green
bun run --filter @devops-agent/agent test 2>&1 | tail -5
# Expected: pass count > 0, fail count = 0

# Spec is present (we'll reference it)
ls docs/superpowers/specs/2026-05-16-aws-datasource-phase-5-correlation-rules.md
# Expected: file exists
```

If any check fails, stop and investigate.

---

## Task 1: Add `getAwsResultSignals` helper to rules.ts

**Files:**
- Modify: `packages/agent/src/correlation/rules.ts` (insert helper near line 45, immediately after `getKafkaResultSignals`)

The helper is the foundation rules 1 and 2 read from. Land it standalone so each subsequent task can test its rule against a working helper.

- [ ] **Step 1: Inspect the existing helper for reference**

```bash
sed -n '35,46p' packages/agent/src/correlation/rules.ts
```

Expected:
```typescript
// SIO-717: read the result-level toolErrors (populated by sub-agent.ts) and
// the LLM's prose summary (result.data when string). This is the production
// signal -- unlike getKafkaData which expects structured fields that today's
// sub-agents do not emit (see comment on line ~154).
function getKafkaResultSignals(state: AgentStateType): { toolErrors: ToolError[]; prose: string } {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "kafka");
	if (!result || result.status !== "success") return { toolErrors: [], prose: "" };
	const toolErrors = Array.isArray(result.toolErrors) ? result.toolErrors : [];
	const prose = typeof result.data === "string" ? result.data : "";
	return { toolErrors, prose };
}
```

The new helper mirrors this exactly, swapping `kafka` for `aws`.

- [ ] **Step 2: Add `getAwsResultSignals` after `getKafkaResultSignals`**

Use the Edit tool. Find:

```typescript
function getKafkaResultSignals(state: AgentStateType): { toolErrors: ToolError[]; prose: string } {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "kafka");
	if (!result || result.status !== "success") return { toolErrors: [], prose: "" };
	const toolErrors = Array.isArray(result.toolErrors) ? result.toolErrors : [];
	const prose = typeof result.data === "string" ? result.data : "";
	return { toolErrors, prose };
}
```

Replace with:

```typescript
function getKafkaResultSignals(state: AgentStateType): { toolErrors: ToolError[]; prose: string } {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "kafka");
	if (!result || result.status !== "success") return { toolErrors: [], prose: "" };
	const toolErrors = Array.isArray(result.toolErrors) ? result.toolErrors : [];
	const prose = typeof result.data === "string" ? result.data : "";
	return { toolErrors, prose };
}

// SIO-761 Phase 5: mirror of getKafkaResultSignals for aws-agent. The aws
// sub-agent emits its findings as a prose string in result.data and structured
// tool errors in result.toolErrors. Both are read by the new aws-* correlation
// rules added in Phase 5.
function getAwsResultSignals(state: AgentStateType): { toolErrors: ToolError[]; prose: string } {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "aws");
	if (!result || result.status !== "success") return { toolErrors: [], prose: "" };
	const toolErrors = Array.isArray(result.toolErrors) ? result.toolErrors : [];
	const prose = typeof result.data === "string" ? result.data : "";
	return { toolErrors, prose };
}
```

- [ ] **Step 3: Verify typecheck**

```bash
bun run --filter @devops-agent/agent typecheck
# Expected: Exited with code 0
```

The helper isn't called yet (rules 1 and 2 land in later tasks), so typecheck just confirms the function is well-formed.

- [ ] **Step 4: Verify Biome formatting**

```bash
bunx biome check packages/agent/src/correlation/rules.ts 2>&1 | tail -3
# Expected: Checked 1 file ... No fixes applied
```

If Biome reformats, run `bunx biome check --write packages/agent/src/correlation/rules.ts` and re-verify.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/correlation/rules.ts
git commit -m "SIO-761: add getAwsResultSignals helper for Phase 5 rules

Mirrors getKafkaResultSignals. The aws sub-agent emits prose in
result.data and structured tool errors in result.toolErrors; this
helper unifies extraction so the three new aws-* correlation rules
can read from a single shape.

No callers yet; rules added in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add rule 1 — `aws-ecs-degraded-needs-elastic-traces`

**Files:**
- Modify: `packages/agent/src/correlation/rules.ts` (append to the `correlationRules` array, before the closing `];` at line 330)
- Create: `packages/agent/src/correlation/rules.test.ts` (initial test file with rule 1 coverage; rules 2 and 3 add to it in later tasks)

Follows TDD: write the test first, then add the rule.

- [ ] **Step 1: Write the failing test file**

Use the Write tool to create `packages/agent/src/correlation/rules.test.ts`:

```typescript
// packages/agent/src/correlation/rules.test.ts
// Unit tests for the Phase 5 AWS correlation rules.
import { describe, expect, test } from "bun:test";
import type { ToolError } from "@devops-agent/shared";
import { correlationRules } from "./rules.ts";

function findRule(name: string) {
	const rule = correlationRules.find((r) => r.name === name);
	if (!rule) throw new Error(`Rule ${name} not found`);
	return rule;
}

function makeStateWithAwsProse(prose: string, toolErrors: ToolError[] = []) {
	return {
		dataSourceResults: [
			{ dataSourceId: "aws", status: "success" as const, data: prose, toolErrors },
		],
	} as never; // partial AgentStateType, sufficient for trigger logic
}

describe("aws-ecs-degraded-needs-elastic-traces", () => {
	const rule = findRule("aws-ecs-degraded-needs-elastic-traces");

	test("fires on '0 of 3 tasks running' phrasing", () => {
		const state = makeStateWithAwsProse(
			"ECS service my-svc: 0 of 3 tasks running. Last event at 2026-05-16T...",
		);
		expect(rule.trigger(state)).not.toBeNull();
	});

	test("does not fire when desired == running", () => {
		const state = makeStateWithAwsProse(
			"ECS service my-svc: 3 of 3 tasks running. Healthy.",
		);
		expect(rule.trigger(state)).toBeNull();
	});

	test("fires on explicit 'service degraded' phrasing", () => {
		const state = makeStateWithAwsProse("service backend is degraded; investigating.");
		expect(rule.trigger(state)).not.toBeNull();
	});
});
```

- [ ] **Step 2: Run the test to confirm it fails as expected**

```bash
bun test packages/agent/src/correlation/rules.test.ts 2>&1 | tail -10
# Expected: 0 pass, 3 fail (rule not yet defined; `findRule` throws "Rule aws-ecs-degraded-needs-elastic-traces not found")
```

The failure mode is what the test was designed to catch — the rule doesn't exist yet. Don't fix the test; add the rule.

- [ ] **Step 3: Append rule 1 to the `correlationRules` array**

Use the Edit tool. Find the end of the array (the `ksql-cluster-status-degraded` rule):

```typescript
		},
		requiredAgent: "elastic-agent",
		retry: { attempts: 2, timeoutMs: 30_000 },
	},
];
```

Replace with:

```typescript
		},
		requiredAgent: "elastic-agent",
		retry: { attempts: 2, timeoutMs: 30_000 },
	},
	{
		// SIO-761 Phase 5: aws-agent reported one or more ECS services in a
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
			const taskMismatch = !!(taskMatch && Number(taskMatch[1]) < Number(taskMatch[2]));
			const degradedPhrasing = /\bservice(?:\s+[a-zA-Z0-9_-]+)?\s+(?:is\s+)?degraded\b/i.test(prose);
			const structuredEnvelope = /\bdesiredCount\b/.test(prose) && /\brunningCount\b/.test(prose);
			if (!taskMismatch && !degradedPhrasing && !structuredEnvelope) return null;
			return { context: { signal: "aws-ecs-degraded" } };
		},
		requiredAgent: "elastic-agent",
		retry: { attempts: 2, timeoutMs: 30_000 },
	},
];
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
bun test packages/agent/src/correlation/rules.test.ts 2>&1 | tail -8
# Expected: 3 pass, 0 fail
```

- [ ] **Step 5: Verify typecheck + biome**

```bash
bun run --filter @devops-agent/agent typecheck 2>&1 | tail -2
# Expected: Exited with code 0

bunx biome check packages/agent/src/correlation/rules.ts packages/agent/src/correlation/rules.test.ts 2>&1 | tail -3
# Expected: No fixes applied
```

If Biome reformats either file, run with `--write` and re-verify.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/correlation/rules.ts packages/agent/src/correlation/rules.test.ts
git commit -m "SIO-761: add aws-ecs-degraded-needs-elastic-traces correlation rule

When aws-agent's prose names an ECS service with runningCount <
desiredCount (three independent regex shapes), fan out to elastic-agent
to cross-check application traces.

Tested via 3 unit tests in the new rules.test.ts (rules 2 and 3 follow).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add rule 2 — `aws-cloudwatch-anomaly-needs-kafka-lag`

**Files:**
- Modify: `packages/agent/src/correlation/rules.ts` (append to the array)
- Modify: `packages/agent/src/correlation/rules.test.ts` (add 2 tests)

Same TDD pattern.

- [ ] **Step 1: Add the failing tests**

Use the Edit tool. Find the closing `});` of the `describe("aws-ecs-degraded-needs-elastic-traces"...)` block in `rules.test.ts`:

```typescript
	test("fires on explicit 'service degraded' phrasing", () => {
		const state = makeStateWithAwsProse("service backend is degraded; investigating.");
		expect(rule.trigger(state)).not.toBeNull();
	});
});
```

Replace with:

```typescript
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
```

- [ ] **Step 2: Run the tests to confirm the new ones fail**

```bash
bun test packages/agent/src/correlation/rules.test.ts 2>&1 | tail -10
# Expected: 3 pass (rule 1), 2 fail (rule 2 not yet defined)
```

- [ ] **Step 3: Append rule 2 to the `correlationRules` array**

Use the Edit tool. Find the rule 1 closing block (the one ending the `aws-ecs-degraded-needs-elastic-traces` rule and the array):

```typescript
		requiredAgent: "elastic-agent",
		retry: { attempts: 2, timeoutMs: 30_000 },
	},
];
```

Replace with:

```typescript
		requiredAgent: "elastic-agent",
		retry: { attempts: 2, timeoutMs: 30_000 },
	},
	{
		// SIO-761 Phase 5: aws-agent reported a CloudWatch alarm in ALARM state
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
			const alarmStated =
				/\bStateValue\b.*\bALARM\b/i.test(prose) || /\balarm.*\bin\s+ALARM\b/i.test(prose);
			const kafkaContext = /\b(MSK|Kafka|kafka|consumer\s+lag|broker)\b/.test(prose);
			if (!alarmStated || !kafkaContext) return null;
			return { context: { signal: "aws-cloudwatch-alarm-kafka" } };
		},
		requiredAgent: "kafka-agent",
		retry: { attempts: 2, timeoutMs: 30_000 },
	},
];
```

- [ ] **Step 4: Run all tests in rules.test.ts**

```bash
bun test packages/agent/src/correlation/rules.test.ts 2>&1 | tail -8
# Expected: 5 pass, 0 fail
```

- [ ] **Step 5: Verify typecheck + biome**

```bash
bun run --filter @devops-agent/agent typecheck 2>&1 | tail -2
# Expected: Exited with code 0

bunx biome check packages/agent/src/correlation/rules.ts packages/agent/src/correlation/rules.test.ts 2>&1 | tail -3
# Expected: No fixes applied
```

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/correlation/rules.ts packages/agent/src/correlation/rules.test.ts
git commit -m "SIO-761: add aws-cloudwatch-anomaly-needs-kafka-lag correlation rule

When aws-agent's prose names a CloudWatch alarm in ALARM state AND
contains a Kafka/MSK keyword, fan out to kafka-agent for a consumer-lag
snapshot. Both signals must coexist to filter alarm noise on unrelated
services.

Tested via 2 new unit tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add rule 3 — `kafka-broker-timeout-needs-aws-metrics`

**Files:**
- Modify: `packages/agent/src/correlation/rules.ts` (append to the array)
- Modify: `packages/agent/src/correlation/rules.test.ts` (add 2 tests + a kafka-prose helper)

This rule is bidirectional — kafka findings cause aws-agent fan-out. The test needs a helper for kafka-shape states.

- [ ] **Step 1: Add the helper + failing tests**

Use the Edit tool. Find:

```typescript
function makeStateWithAwsProse(prose: string, toolErrors: ToolError[] = []) {
	return {
		dataSourceResults: [
			{ dataSourceId: "aws", status: "success" as const, data: prose, toolErrors },
		],
	} as never; // partial AgentStateType, sufficient for trigger logic
}
```

Replace with:

```typescript
function makeStateWithAwsProse(prose: string, toolErrors: ToolError[] = []) {
	return {
		dataSourceResults: [
			{ dataSourceId: "aws", status: "success" as const, data: prose, toolErrors },
		],
	} as never; // partial AgentStateType, sufficient for trigger logic
}

function makeStateWithKafkaProse(prose: string, toolErrors: ToolError[] = []) {
	return {
		dataSourceResults: [
			{ dataSourceId: "kafka", status: "success" as const, data: prose, toolErrors },
		],
	} as never;
}
```

Then find the rule 2 closing `});`:

```typescript
	test("does not fire for non-Kafka alarms", () => {
		const state = makeStateWithAwsProse(
			"Alarm 'RDS-CPU-High' StateValue: ALARM. Database under heavy load.",
		);
		expect(rule.trigger(state)).toBeNull();
	});
});
```

Replace with:

```typescript
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
		const state = makeStateWithKafkaProse(
			"broker b-1.msk.amazonaws.com unreachable: connection timeout after 30s",
		);
		expect(rule.trigger(state)).not.toBeNull();
	});

	test("fires on transient ToolError with network-shape message", () => {
		const state = makeStateWithKafkaProse(
			"successful query",
			[
				{
					toolName: "kafka_list_topics",
					category: "transient",
					message: "ENOTFOUND b-1.msk.amazonaws.com",
					retryable: true,
				} as never,
			],
		);
		expect(rule.trigger(state)).not.toBeNull();
	});
});
```

- [ ] **Step 2: Run the tests to confirm new ones fail**

```bash
bun test packages/agent/src/correlation/rules.test.ts 2>&1 | tail -10
# Expected: 5 pass (rules 1+2), 2 fail (rule 3 not yet defined)
```

- [ ] **Step 3: Append rule 3 to the `correlationRules` array**

Use the Edit tool. Find the rule 2 closing block (the one ending the `aws-cloudwatch-anomaly-needs-kafka-lag` rule and the array):

```typescript
		requiredAgent: "kafka-agent",
		retry: { attempts: 2, timeoutMs: 30_000 },
	},
];
```

Replace with:

```typescript
		requiredAgent: "kafka-agent",
		retry: { attempts: 2, timeoutMs: 30_000 },
	},
	{
		// SIO-761 Phase 5: kafka-agent reported broker-side timeout / unreachable
		// MSK cluster / connection failure. AWS-side networking, EC2 instance
		// health, or security-group changes are common root causes; fan out to
		// aws-agent for an MSK cluster + EC2 cross-check.
		name: "kafka-broker-timeout-needs-aws-metrics",
		description:
			"kafka-agent reported broker timeout / connection failure against MSK; correlate with AWS-side MSK cluster metrics, EC2 instance health, and security groups.",
		trigger: (state) => {
			const { toolErrors, prose } = getKafkaResultSignals(state);
			// Two paths: structured tool errors (preferred -- ToolError.category
			// is "transient" + the message has a network-shape pattern from
			// mapAwsError) or prose-mention fallback. Same dual-path approach
			// as SIO-717's findConfluent5xxToolErrors.
			const networkErrorTransient = toolErrors.some(
				(e) =>
					e.category === "transient" &&
					/(timeout|unreachable|unavailable|connection\s+refused|ENOTFOUND|ECONNREFUSED|ETIMEDOUT)/i.test(e.message),
			);
			const proseBrokerTimeout =
				/\bbroker\b.*(timeout|unreachable|unavailable|connection\s+refused)/i.test(prose) ||
				/\bMSK\b.*(timeout|unreachable|unavailable)/i.test(prose) ||
				/\bkafka\b.*\bconnection\b.*\btimeout\b/i.test(prose);
			if (!networkErrorTransient && !proseBrokerTimeout) return null;
			return { context: { signal: "kafka-broker-timeout-needs-aws" } };
		},
		requiredAgent: "aws-agent",
		retry: { attempts: 2, timeoutMs: 30_000 },
	},
];
```

- [ ] **Step 4: Run all unit tests**

```bash
bun test packages/agent/src/correlation/rules.test.ts 2>&1 | tail -8
# Expected: 7 pass, 0 fail
```

- [ ] **Step 5: Verify typecheck + biome**

```bash
bun run --filter @devops-agent/agent typecheck 2>&1 | tail -2
# Expected: Exited with code 0

bunx biome check packages/agent/src/correlation/rules.ts packages/agent/src/correlation/rules.test.ts 2>&1 | tail -3
# Expected: No fixes applied
```

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/correlation/rules.ts packages/agent/src/correlation/rules.test.ts
git commit -m "SIO-761: add kafka-broker-timeout-needs-aws-metrics correlation rule

When kafka-agent's structured ToolError shows category=transient with a
network-shape message (ENOTFOUND, ETIMEDOUT, etc.) OR the prose mentions
broker timeout / MSK unreachable, fan out to aws-agent for MSK cluster
+ EC2 cross-check.

First bidirectional rule for the aws datasource (kafka findings cause
aws fan-out, inverse of rules 1 and 2).

Tested via 2 new unit tests (prose path + structured ToolError path).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Add the pipeline integration test

**Files:**
- Create: `packages/agent/src/correlation/integration.test.ts`

Proves the engine + enforce-node flow end-to-end: an aws-agent prose with task-mismatch must produce an elastic-agent Send.

- [ ] **Step 1: Inspect an existing mock-harness pattern**

```bash
head -40 packages/agent/src/supervisor-router.test.ts
```

You should see `mock.module("./mcp-bridge.ts", ...)` and `mock.module("./prompt-context.ts", ...)` declarations. The new integration test uses the same shape but imports from `../mcp-bridge.ts` (one level up because we're in `correlation/`).

- [ ] **Step 2: Write the integration test file**

Use the Write tool to create `packages/agent/src/correlation/integration.test.ts`:

```typescript
// packages/agent/src/correlation/integration.test.ts
// Pipeline integration test: an aws-agent prose claiming an ECS service is
// degraded must drive enforceCorrelationsRouter to dispatch an elastic-agent
// Send via the aws-ecs-degraded-needs-elastic-traces rule.
import { describe, expect, mock, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";

// Mock the mcp-bridge so the router thinks all servers are connected.
mock.module("../mcp-bridge.ts", () => ({
	getToolsForDataSource: () => [{ name: "fake_tool" }],
	getAllTools: () => [],
	getConnectedServers: () => [
		"elastic-mcp",
		"kafka-mcp",
		"couchbase-mcp",
		"konnect-mcp",
		"gitlab-mcp",
		"aws-mcp",
	],
	DATASOURCE_TO_MCP_SERVER: {
		elastic: "elastic-mcp",
		kafka: "kafka-mcp",
		couchbase: "couchbase-mcp",
		konnect: "konnect-mcp",
		gitlab: "gitlab-mcp",
		atlassian: "atlassian-mcp",
		aws: "aws-mcp",
	},
}));

mock.module("../prompt-context.ts", () => ({
	getAgent: () => ({
		manifest: { delegation: { mode: "auto" } },
		tools: [],
		subAgents: new Map(),
	}),
	buildOrchestratorPrompt: () => "",
	buildSubAgentPrompt: () => "",
	getToolDefinitionForDataSource: () => undefined,
}));

import { enforceCorrelationsRouter } from "./enforce-node.ts";

describe("Phase 5 correlation rules — pipeline integration", () => {
	test("aws-agent ECS-degraded prose dispatches elastic-agent Send", () => {
		const awsResult: DataSourceResult = {
			dataSourceId: "aws",
			status: "success",
			data: "ECS service backend: 0 of 5 tasks running. Last event 'CannotPullContainerError'.",
			toolErrors: [],
		};

		const state = {
			messages: [],
			dataSourceResults: [awsResult],
			extractedEntities: { dataSources: [{ id: "aws", mentionedAs: "explicit" as const }] },
			confidenceCap: undefined,
			degradedRules: [],
			pendingCorrelations: [],
			targetDataSources: [] as string[],
			retryCount: 0,
			alignmentRetries: 0,
			skippedDataSources: [] as string[],
			isFollowUp: false,
			finalAnswer: "",
			requestId: "test-phase5",
			attachmentMeta: [],
			suggestions: [],
			normalizedIncident: {},
			mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
			mitigationFragments: [],
			confidenceScore: 0,
			lowConfidence: false,
			pendingActions: [],
			actionResults: [],
			selectedRunbooks: null,
			partialFailures: [],
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

- [ ] **Step 3: Run the integration test**

```bash
bun test packages/agent/src/correlation/integration.test.ts 2>&1 | tail -8
# Expected: 1 pass, 0 fail
```

If the test fails with "expected Send[]" or `targets` doesn't include "elastic", check that the rule from Task 2 actually fires on the prose. The most likely cause is a regex miss; run the rule's trigger manually in the bun REPL or temporarily add a `console.log(rule.trigger(state))` to debug.

- [ ] **Step 4: Run the full agent test suite to confirm no regressions**

```bash
bun run --filter @devops-agent/agent test 2>&1 | tail -5
# Expected: total pass count up by 8 (7 from rules.test.ts + 1 here); 0 fail
```

- [ ] **Step 5: Verify typecheck + biome**

```bash
bun run --filter @devops-agent/agent typecheck 2>&1 | tail -2
# Expected: Exited with code 0

bunx biome check packages/agent/src/correlation/integration.test.ts 2>&1 | tail -3
# Expected: No fixes applied
```

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/correlation/integration.test.ts
git commit -m "SIO-761: pipeline integration test for aws-ecs-degraded rule

Constructs an AgentStateType with aws-agent prose containing the
'0 of 5 tasks running' phrasing, runs it through
enforceCorrelationsRouter, and asserts the returned Send[] dispatches
to the elastic datasource (the rule's requiredAgent).

Single end-to-end test; unit tests in rules.test.ts cover the rest.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full project lint, typecheck, and test

**Files:** none

- [ ] **Step 1: Typecheck everything**

```bash
bun run typecheck 2>&1 | tail -15
# Expected: every package "Exited with code 0".
# Known pre-existing failures (NOT introduced by Phase 5):
# - @devops-agent/mcp-server-elastic langsmith/traceable import
# These do not block Phase 5; document in PR body if they surface.
```

- [ ] **Step 2: Lint everything**

```bash
bun run lint 2>&1 | tail -5
# Expected: any lint errors are pre-existing nits unrelated to Phase 5
# (e.g., scripts/agentcore/policies/*.json format, couchbase mcp.d.ts import order)
```

If Biome reorders the new files' imports, run `bun run lint:fix` and amend the most recent commit:

```bash
bun run lint:fix
git add -u
git commit --amend --no-edit
```

- [ ] **Step 3: Run agent tests**

```bash
bun run --filter @devops-agent/agent test 2>&1 | tail -5
# Expected: pass count up by 8 vs main; 0 fail
```

- [ ] **Step 4: Sanity-check other packages didn't regress**

```bash
bun run --filter @devops-agent/mcp-server-kafka test 2>&1 | tail -3
# Expected: 307 pass, 0 fail

bun run --filter @devops-agent/mcp-server-aws test 2>&1 | tail -3
# Expected: 130 pass, 0 fail
```

Neither package is touched by Phase 5; this is just confirming no surprise transitive impact.

---

## Task 7: Push branch, open PR, move Linear to In Review

- [ ] **Step 1: Push the branch**

```bash
git push -u origin sio-761-phase-5-correlation-rules
```

- [ ] **Step 2: Open the PR**

Use `gh pr create`. Title: `SIO-761: Phase 5 — AWS datasource correlation rules`. Body:

```markdown
## Summary

Three prose-matching correlation rules using the SIO-717/742 pattern:

1. **`aws-ecs-degraded-needs-elastic-traces`** (aws → elastic) — when aws-agent's prose names an ECS service with runningCount < desiredCount, fan out to elastic-agent for app traces.
2. **`aws-cloudwatch-anomaly-needs-kafka-lag`** (aws → kafka) — when aws-agent's prose names a CloudWatch ALARM with Kafka/MSK context, fan out to kafka-agent for consumer lag.
3. **`kafka-broker-timeout-needs-aws-metrics`** (kafka → aws) — when kafka-agent reports broker timeouts (structured ToolError or prose), fan out to aws-agent for MSK cluster + EC2 metrics. **First bidirectional rule for the aws datasource.**

All three rules live in production from day one (no dependency on structured-data emission, which remains pre-existing tech debt).

## Files touched

| Layer | Files |
|---|---|
| Helper | `packages/agent/src/correlation/rules.ts` — adds `getAwsResultSignals` mirroring `getKafkaResultSignals` |
| Rules | `packages/agent/src/correlation/rules.ts` — appends 3 new rule objects to `correlationRules` |
| Unit tests | `packages/agent/src/correlation/rules.test.ts` (new) — 7 tests across the 3 rules |
| Pipeline test | `packages/agent/src/correlation/integration.test.ts` (new) — 1 end-to-end test exercising `enforceCorrelationsRouter` |

## Test plan

- [x] `bun run --filter @devops-agent/agent test`: pass count +8 vs main; 0 fail
- [x] `bun run --filter @devops-agent/mcp-server-kafka test`: 307 pass, 0 fail (no regression)
- [x] `bun run --filter @devops-agent/mcp-server-aws test`: 130 pass, 0 fail (no regression)

## Pre-existing issues NOT touched (acknowledged in plan)

- `mcp-server-elastic` typecheck failure on `langsmith/traceable` import — pre-existing Phase 2 escape, separate ticket
- `scripts/agentcore/policies/*.json` format nits — pre-existing, separate ticket
- `mcp-server-couchbase/src/types/mcp.d.ts` import order — pre-existing, separate ticket
- `engine.agentToDataSourceId`'s `capella-agent → capella` (should be `couchbase`) — pre-existing bug, doesn't affect Phase 5

## Out of scope

- Sub-agent structured-data emission (unblocks dormant kafka rules; separate epic)
- AWS-specific runbooks under `agents/incident-analyzer/knowledge/runbooks/`
- LangSmith eval dataset for AWS correlation findings
- Migrating dormant structured-data rules to prose-matching

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 3: Move Linear sub-issue to In Review**

Use Linear MCP to set SIO-761 state to `In Review` (NOT `Done`). Comment on the issue with the PR URL.

- [ ] **Step 4: Wait for review**

Per `superpowers:finishing-a-development-branch`. Do **not** merge. Do **not** set the Linear issue to `Done`. Wait for user approval.

---

## Out of scope (later)

For clarity to anyone reading this plan:

- **Sub-agent structured-data emission** — would unblock the existing dormant `kafka-empty-or-dead-groups`-style rules. Pre-existing tech debt, separate epic. Comments in `rules.ts` explicitly call this out.
- **AWS-specific runbooks** under `agents/incident-analyzer/knowledge/runbooks/` — the parent design lists them for Phase 5 but they're a distinct deliverable.
- **LangSmith eval dataset** for AWS correlation findings — separate ticket per parent design.
- **Live AgentCore probe** — Phase 3 was that gate; Phase 5's behavior is code-testable.
- **Fixing `engine.agentToDataSourceId`'s `capella-agent → capella` bug** (should be `couchbase`) — pre-existing, doesn't affect Phase 5 because `aws-agent → aws` works correctly.
- **More bidirectional rules** (e.g., `aws-elasticache-evictions-needs-elastic-cache-misses`) — could follow the same pattern but YAGNI for Phase 5.

If a reviewer asks "why didn't you also do X", check whether X is listed above before adding scope.
