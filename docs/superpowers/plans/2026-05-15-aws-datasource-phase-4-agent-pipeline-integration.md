# AWS Datasource Phase 4 — Agent Pipeline Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the deployed AWS datasource into the LangGraph pipeline so the supervisor fans out to a new `aws-agent` alongside the existing five sub-agents — a complex incident produces six `DataSourceResult` entries.

**Architecture:** Add a new sub-agent definition (3 markdown/yaml files), thread `"aws"` through the type/data tables in `shared`/`agent`, plumb `awsUrl` through `mcp-bridge.ts` and the SvelteKit web app, refactor Kafka's index.ts to read its own ARN env var (AWS already does), and add two test files. No graph topology changes.

**Tech Stack:** Bun, TypeScript strict, Zod, LangGraph, `@langchain/mcp-adapters`, SvelteKit (Svelte 5 runes), Biome.

**Spec:** [docs/superpowers/specs/2026-05-15-aws-datasource-phase-4-agent-pipeline-integration.md](../specs/2026-05-15-aws-datasource-phase-4-agent-pipeline-integration.md)

**Parent design:** [docs/superpowers/specs/2026-05-15-aws-datasource-design.md](../specs/2026-05-15-aws-datasource-design.md)

**Linear:** Create a sub-issue under [SIO-756](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a) before starting Task 1. Commits use the new sub-issue ID (assume `SIO-760` below — replace with the real ID after creation).

---

## File Map

**New (5 files)**

| File | Responsibility |
|---|---|
| `agents/incident-analyzer/agents/aws-agent/agent.yaml` | Manifest: model preferences, tool family label, risk_tier |
| `agents/incident-analyzer/agents/aws-agent/SOUL.md` | Sub-agent identity, expertise, output standards |
| `agents/incident-analyzer/agents/aws-agent/RULES.md` | Probe discipline, service drill-down ordering, error handling |
| `packages/agent/src/wiring-aws.test.ts` | Unit tests asserting `aws` is plumbed through DATA_SOURCE_IDS, AgentName, both AGENT_NAMES tables, and mcp-bridge serverMap |
| `packages/agent/src/supervisor-aws-fanout.test.ts` | Pipeline test asserting `supervise()` dispatches 6 Sends when all 6 servers are connected |

**Modified (10 files)**

| File | What changes |
|---|---|
| `packages/shared/src/datasource.ts:46` | Add `"aws"` to `DATA_SOURCE_IDS` |
| `packages/agent/src/state.ts:18` | Add `"aws-agent"` to `AgentName` union |
| `packages/agent/src/supervisor.ts:12-19` | Add `aws: "aws-agent"` to AGENT_NAMES; **export** the table for tests |
| `packages/agent/src/sub-agent.ts:54-61` | Add `aws: "aws-agent"` to AGENT_NAMES; **export** the table for tests |
| `packages/agent/src/mcp-bridge.ts` | Add `awsUrl?: string` to McpClientConfig; add `aws-mcp` server entry; add `aws` to serverMap; **export** serverMap for tests |
| `packages/mcp-server-kafka/src/index.ts:76-110` | Refactor to read `KAFKA_AGENTCORE_RUNTIME_ARN ?? AGENTCORE_RUNTIME_ARN` |
| `apps/web/src/lib/server/agent.ts:41` | Add `awsUrl: process.env.AWS_MCP_URL` |
| `apps/web/src/routes/api/datasources/+server.ts` | Add `"aws-mcp": "aws"` mapping and `AWS_MCP_URL` presence check |
| `apps/web/src/lib/components/DataSourceSelector.svelte:13` | Add `aws: "AWS"` label |
| `.env` | Add `AWS_MCP_URL=http://localhost:3001` |

No deletions. No graph topology changes. No new dependencies.

---

## Pre-Task: Create Linear sub-issue and worktree

- [ ] **Step 1: Create Linear sub-issue under SIO-756**

Use the Linear MCP. Title: `Phase 4 — Agent pipeline integration for AWS datasource`. State: `In Progress` (NOT `Done`). Parent: `SIO-756`. Description: link the spec at `docs/superpowers/specs/2026-05-15-aws-datasource-phase-4-agent-pipeline-integration.md`.

Capture the issue ID (expected to be the next free number after SIO-759). All commit subjects below use placeholder `SIO-760`; **replace with the real ID** before committing.

- [ ] **Step 2: Create a worktree for this phase**

Per `superpowers:using-git-worktrees`. From the repo root:

```bash
# Replace 760 if Linear assigned a different number
git worktree add ../devops-incident-analyzer-sio-760 -b sio-760-phase-4-agent-pipeline main
cd ../devops-incident-analyzer-sio-760
```

All subsequent tasks run inside this worktree.

- [ ] **Step 3: Bun install in the worktree**

The worktree starts with no `node_modules`. Bun's workspace install is fast (~2s for cached, ~20s cold).

```bash
bun install
```

Expected: completes without errors, prints `<N> packages installed`.

- [ ] **Step 4: Confirm pre-conditions**

```bash
# Phase 3 must be on main
git log --oneline | head -3
# Expected: commit 6860009 SIO-759 (Phase 3) visible

# AWS MCP package builds clean
bun run --filter @devops-agent/mcp-server-aws typecheck
# Expected: Exited with code 0

# Phase 3 deployment artifact is unrelated (it's a local artifact, not in git)
ls .agentcore-deployment.json 2>&1
# Expected: "No such file or directory" (correct — was in Phase 3 worktree only)
```

If any of these fail, stop and investigate before continuing.

---

## Task 1: Add `aws` to `DATA_SOURCE_IDS`

**Files:**
- Modify: `packages/shared/src/datasource.ts:46`

- [ ] **Step 1: Inspect current state**

```bash
grep -n "DATA_SOURCE_IDS" packages/shared/src/datasource.ts
```

Expected output:
```
46:export const DATA_SOURCE_IDS = ["elastic", "kafka", "couchbase", "konnect", "gitlab", "atlassian"] as const;
47:export type DataSourceId = (typeof DATA_SOURCE_IDS)[number];
```

- [ ] **Step 2: Add `aws` to the array**

Use the Edit tool. Find:

```typescript
export const DATA_SOURCE_IDS = ["elastic", "kafka", "couchbase", "konnect", "gitlab", "atlassian"] as const;
```

Replace with:

```typescript
export const DATA_SOURCE_IDS = ["elastic", "kafka", "couchbase", "konnect", "gitlab", "atlassian", "aws"] as const;
```

- [ ] **Step 3: Verify**

```bash
bun run --filter @devops-agent/shared typecheck
# Expected: Exited with code 0
```

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/datasource.ts
git commit -m "SIO-760: add 'aws' to DATA_SOURCE_IDS

First step of wiring the AWS datasource into the supervisor fan-out.
Other Phase 4 tasks build on this constant.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `aws-agent` to `AgentName` union

**Files:**
- Modify: `packages/agent/src/state.ts:18`

- [ ] **Step 1: Inspect**

```bash
sed -n '17,18p' packages/agent/src/state.ts
```

Expected:
```typescript
// SIO-681: Union of all specialist sub-agent identifiers
export type AgentName = "elastic-agent" | "kafka-agent" | "capella-agent" | "konnect-agent" | "gitlab-agent";
```

- [ ] **Step 2: Add `"aws-agent"` to the union**

Use the Edit tool. Find:

```typescript
export type AgentName = "elastic-agent" | "kafka-agent" | "capella-agent" | "konnect-agent" | "gitlab-agent";
```

Replace with:

```typescript
export type AgentName = "elastic-agent" | "kafka-agent" | "capella-agent" | "konnect-agent" | "gitlab-agent" | "aws-agent";
```

Note that the AgentName union doesn't include `atlassian-agent` today (atlassian isn't dispatched yet — pre-existing gap, not Phase 4's job).

- [ ] **Step 3: Verify**

```bash
bun run --filter @devops-agent/agent typecheck
# Expected: Exited with code 0
```

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/state.ts
git commit -m "SIO-760: add 'aws-agent' to AgentName union

Required so DegradedRule/PendingCorrelation can name aws-agent as the
requiredAgent in future correlation rules (Phase 5).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Update supervisor.ts — add `aws` to AGENT_NAMES + export the table

**Files:**
- Modify: `packages/agent/src/supervisor.ts:12-19`

- [ ] **Step 1: Inspect**

```bash
sed -n '12,20p' packages/agent/src/supervisor.ts
```

Expected:
```typescript
const AGENT_NAMES: Record<string, string> = {
	elastic: "elastic-agent",
	kafka: "kafka-agent",
	couchbase: "capella-agent",
	konnect: "konnect-agent",
	gitlab: "gitlab-agent",
	atlassian: "atlassian-agent",
};
```

- [ ] **Step 2: Add `aws` entry and export the constant**

Use the Edit tool. Find:

```typescript
const AGENT_NAMES: Record<string, string> = {
	elastic: "elastic-agent",
	kafka: "kafka-agent",
	couchbase: "capella-agent",
	konnect: "konnect-agent",
	gitlab: "gitlab-agent",
	atlassian: "atlassian-agent",
};
```

Replace with:

```typescript
// Exported for wiring tests (packages/agent/src/wiring-aws.test.ts).
export const AGENT_NAMES: Record<string, string> = {
	elastic: "elastic-agent",
	kafka: "kafka-agent",
	couchbase: "capella-agent",
	konnect: "konnect-agent",
	gitlab: "gitlab-agent",
	atlassian: "atlassian-agent",
	aws: "aws-agent",
};
```

- [ ] **Step 3: Verify**

```bash
bun run --filter @devops-agent/agent typecheck
# Expected: Exited with code 0
```

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/supervisor.ts
git commit -m "SIO-760: supervisor.ts adds aws->aws-agent and exports AGENT_NAMES

The export is for the wiring test added in a later Phase 4 task;
no behavior change for production callers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Update sub-agent.ts — add `aws` to AGENT_NAMES + export

**Files:**
- Modify: `packages/agent/src/sub-agent.ts:54-61`

- [ ] **Step 1: Inspect**

```bash
sed -n '54,62p' packages/agent/src/sub-agent.ts
```

Expected:
```typescript
const AGENT_NAMES: Record<string, string> = {
	elastic: "elastic-agent",
	kafka: "kafka-agent",
	couchbase: "capella-agent",
	konnect: "konnect-agent",
	gitlab: "gitlab-agent",
	atlassian: "atlassian-agent",
};
```

- [ ] **Step 2: Add `aws` entry and export**

Use the Edit tool. Find:

```typescript
const AGENT_NAMES: Record<string, string> = {
	elastic: "elastic-agent",
	kafka: "kafka-agent",
	couchbase: "capella-agent",
	konnect: "konnect-agent",
	gitlab: "gitlab-agent",
	atlassian: "atlassian-agent",
};
```

Replace with:

```typescript
// Exported for wiring tests (packages/agent/src/wiring-aws.test.ts).
// SIO-756 follow-up: this table duplicates supervisor.ts AGENT_NAMES;
// collapsing them is pre-existing tech debt for a separate ticket.
export const AGENT_NAMES: Record<string, string> = {
	elastic: "elastic-agent",
	kafka: "kafka-agent",
	couchbase: "capella-agent",
	konnect: "konnect-agent",
	gitlab: "gitlab-agent",
	atlassian: "atlassian-agent",
	aws: "aws-agent",
};
```

- [ ] **Step 3: Verify**

```bash
bun run --filter @devops-agent/agent typecheck
# Expected: Exited with code 0
```

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/sub-agent.ts
git commit -m "SIO-760: sub-agent.ts adds aws->aws-agent and exports AGENT_NAMES

Mirrors the supervisor.ts change. The duplicate table is pre-existing
tech debt; collapsing is out of scope for Phase 4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Update mcp-bridge.ts — add awsUrl, server entry, serverMap export

**Files:**
- Modify: `packages/agent/src/mcp-bridge.ts` (interface around line 23, server-entry block around line 132, getToolsForDataSource around line 206)

Three sub-edits inside one file. Bundled as one commit.

- [ ] **Step 1: Inspect McpClientConfig**

```bash
sed -n '23,30p' packages/agent/src/mcp-bridge.ts
```

Expected:
```typescript
export interface McpClientConfig {
	elasticUrl?: string;
	kafkaUrl?: string;
	capellaUrl?: string;
	konnectUrl?: string;
	gitlabUrl?: string;
	atlassianUrl?: string;
}
```

- [ ] **Step 2: Add `awsUrl` to the interface**

Use the Edit tool. Find:

```typescript
export interface McpClientConfig {
	elasticUrl?: string;
	kafkaUrl?: string;
	capellaUrl?: string;
	konnectUrl?: string;
	gitlabUrl?: string;
	atlassianUrl?: string;
}
```

Replace with:

```typescript
export interface McpClientConfig {
	elasticUrl?: string;
	kafkaUrl?: string;
	capellaUrl?: string;
	konnectUrl?: string;
	gitlabUrl?: string;
	atlassianUrl?: string;
	awsUrl?: string;
}
```

- [ ] **Step 3: Inspect server-entry block**

```bash
sed -n '117,135p' packages/agent/src/mcp-bridge.ts
```

Expected:
```typescript
	if (config.elasticUrl) {
		serverEntries.push({ name: "elastic-mcp", url: `${config.elasticUrl}/mcp` });
	}
	if (config.kafkaUrl) {
		serverEntries.push({ name: "kafka-mcp", url: `${config.kafkaUrl}/mcp` });
	}
	if (config.capellaUrl) {
		serverEntries.push({ name: "couchbase-mcp", url: `${config.capellaUrl}/mcp` });
	}
	if (config.konnectUrl) {
		serverEntries.push({ name: "konnect-mcp", url: `${config.konnectUrl}/mcp` });
	}
	if (config.gitlabUrl) {
		serverEntries.push({ name: "gitlab-mcp", url: `${config.gitlabUrl}/mcp` });
	}
	if (config.atlassianUrl) {
		serverEntries.push({ name: "atlassian-mcp", url: `${config.atlassianUrl}/mcp` });
	}
```

- [ ] **Step 4: Add `aws-mcp` server entry after atlassian**

Use the Edit tool. Find:

```typescript
	if (config.atlassianUrl) {
		serverEntries.push({ name: "atlassian-mcp", url: `${config.atlassianUrl}/mcp` });
	}
```

Replace with:

```typescript
	if (config.atlassianUrl) {
		serverEntries.push({ name: "atlassian-mcp", url: `${config.atlassianUrl}/mcp` });
	}
	if (config.awsUrl) {
		serverEntries.push({ name: "aws-mcp", url: `${config.awsUrl}/mcp` });
	}
```

- [ ] **Step 5: Inspect serverMap in getToolsForDataSource**

```bash
sed -n '206,220p' packages/agent/src/mcp-bridge.ts
```

Expected:
```typescript
export function getToolsForDataSource(dataSourceId: string): StructuredToolInterface[] {
	const serverMap: Record<string, string> = {
		elastic: "elastic-mcp",
		kafka: "kafka-mcp",
		couchbase: "couchbase-mcp",
		konnect: "konnect-mcp",
		gitlab: "gitlab-mcp",
		atlassian: "atlassian-mcp",
	};
	const serverName = serverMap[dataSourceId];
	if (!serverName) return [];
	return toolsByServer.get(serverName) ?? [];
}
```

- [ ] **Step 6: Refactor serverMap to module scope, export it, and add `aws`**

The serverMap is currently a function-local constant. Hoist it to module scope (exported) so the wiring test can assert against it, and add the `aws` entry.

Use the Edit tool. Find:

```typescript
export function getToolsForDataSource(dataSourceId: string): StructuredToolInterface[] {
	const serverMap: Record<string, string> = {
		elastic: "elastic-mcp",
		kafka: "kafka-mcp",
		couchbase: "couchbase-mcp",
		konnect: "konnect-mcp",
		gitlab: "gitlab-mcp",
		atlassian: "atlassian-mcp",
	};
	const serverName = serverMap[dataSourceId];
	if (!serverName) return [];
	return toolsByServer.get(serverName) ?? [];
}
```

Replace with:

```typescript
// Exported for wiring tests (packages/agent/src/wiring-aws.test.ts).
export const DATASOURCE_TO_MCP_SERVER: Record<string, string> = {
	elastic: "elastic-mcp",
	kafka: "kafka-mcp",
	couchbase: "couchbase-mcp",
	konnect: "konnect-mcp",
	gitlab: "gitlab-mcp",
	atlassian: "atlassian-mcp",
	aws: "aws-mcp",
};

export function getToolsForDataSource(dataSourceId: string): StructuredToolInterface[] {
	const serverName = DATASOURCE_TO_MCP_SERVER[dataSourceId];
	if (!serverName) return [];
	return toolsByServer.get(serverName) ?? [];
}
```

- [ ] **Step 7: Verify typecheck + lint**

```bash
bun run --filter @devops-agent/agent typecheck
# Expected: Exited with code 0

bunx biome check packages/agent/src/mcp-bridge.ts
# Expected: Checked 1 file ... No fixes applied
```

If Biome flags formatting, run `bunx biome check --write packages/agent/src/mcp-bridge.ts` and re-check.

- [ ] **Step 8: Commit**

```bash
git add packages/agent/src/mcp-bridge.ts
git commit -m "SIO-760: mcp-bridge.ts wires awsUrl + aws-mcp + exports DATASOURCE_TO_MCP_SERVER

- McpClientConfig gets optional awsUrl field
- createMcpClient adds aws-mcp server entry when awsUrl is set
- getToolsForDataSource's serverMap is hoisted to module scope as
  DATASOURCE_TO_MCP_SERVER and exported for wiring tests

The hoist is a TDD-driven cleanup, not a behavior change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Create the aws-agent sub-agent definition (3 files)

**Files:**
- Create: `agents/incident-analyzer/agents/aws-agent/agent.yaml`
- Create: `agents/incident-analyzer/agents/aws-agent/SOUL.md`
- Create: `agents/incident-analyzer/agents/aws-agent/RULES.md`

- [ ] **Step 1: Create the agent directory**

```bash
mkdir -p agents/incident-analyzer/agents/aws-agent
```

- [ ] **Step 2: Write agent.yaml**

Use the Write tool to create `agents/incident-analyzer/agents/aws-agent/agent.yaml` with this exact content:

```yaml
spec_version: "0.1.0"
name: aws-agent
version: 0.1.0
description: Read-only AWS infrastructure-state analysis specialist.

model:
  preferred: claude-haiku-4-5
  constraints:
    temperature: 0.1
    max_tokens: 2048

tools:
  - aws-introspect

compliance:
  risk_tier: low
  data_governance:
    pii_handling: redact
```

- [ ] **Step 3: Write SOUL.md**

Use the Write tool to create `agents/incident-analyzer/agents/aws-agent/SOUL.md` with this exact content:

```markdown
# Soul

## Core Identity
I am an AWS infrastructure specialist sub-agent. I query the AWS API to analyze
compute, observability, data, networking, and deployment state across an
account for incident analysis.

## Expertise
- Compute state: EC2 instances, ECS services and tasks, Lambda functions
- Observability: CloudWatch metrics and alarms, CloudWatch Logs and Logs Insights, X-Ray traces and service graph
- Data stores: DynamoDB tables, RDS instances and clusters, S3 buckets, ElastiCache clusters
- Messaging: SNS topics, SQS queues, EventBridge rules, Step Functions state machines
- Networking: VPCs, security groups, ALB/NLB topology (via tags + ResourceGroupsTagging)
- Deployment context: CloudFormation stacks and recent events, Config rules and compliance, AWS Health events
- Account-wide tag discovery via ResourceGroupsTagging

## Approach
I focus on the state that matters for incident triage: what's red right now,
what changed recently, what's the error rate. I prefer CloudWatch alarms and
AWS Health events as my first-pass status snapshot. When the user names a
specific service (RDS, Lambda, ECS), I drill into that service's describe
APIs. I never make write API calls.

## Output Standards
- Every claim must reference specific tool output (no fabrication)
- Include ISO 8601 timestamps and metric values in all findings
- Report tool failures transparently with the error message
- Read-only analysis only; never propose write API calls or infrastructure changes
- When CloudWatch alarms are in ALARM state, surface them with state, threshold, and metric in the report
- When AWS Health events are open, surface them with eventTypeCode and affectedEntities
- When a service describe call returns AccessDenied, link the error to the IAM action that failed (the MCP server's error mapper already surfaces this in error.advice)
```

- [ ] **Step 4: Write RULES.md**

Use the Write tool to create `agents/incident-analyzer/agents/aws-agent/RULES.md` with this exact content:

```markdown
# Rules

## Iteration 1 Probe Discipline

When the user query references infrastructure health, account-wide status, or
asks "what's going on in AWS" or "is X broken" or "are there any alarms",
issue these probes IN PARALLEL in the first iteration BEFORE any
list/describe/enumerate tool:

- `aws_cloudwatch_describe_alarms` — current alarm states (filter StateValue=ALARM)
- `aws_health_describe_events` — open Health events (account-level)

Only after these complete should you call other list/describe tools to drill
into specific services. This guarantees a status snapshot is established
before downstream calls produce noise.

If `aws_cloudwatch_describe_alarms` returns one or more ALARM-state alarms,
include them in the report with state, threshold, metric, and last-state-change
timestamp. The presence of ALARM-state alarms typically anchors the rest of
the investigation (find the alarmed metric, then drill into the service that
produces it).

If `aws_health_describe_events` returns open events with status `open` or
`upcoming`, surface them as a separate "Account-level events" section in
the report, listing eventTypeCategory, eventTypeCode, region, and
affectedEntities count.

## Service-Specific Drill-Downs

When the user names a specific service or resource:

- EC2/VPC: `aws_ec2_describe_instances` (filter by tag or by instanceIds) -> `aws_ec2_describe_vpcs` if network context is needed
- ECS: `aws_ecs_list_clusters` -> `aws_ecs_describe_services` -> `aws_ecs_describe_tasks` (in that order; never describe-tasks without first knowing the cluster)
- Lambda: `aws_lambda_list_functions` (paginated) for inventory; `aws_lambda_get_function_configuration` for a single function's runtime/env/timeout
- RDS: `aws_rds_describe_db_instances` (instances) or `aws_rds_describe_db_clusters` (Aurora clusters)
- DynamoDB: `aws_dynamodb_list_tables` -> `aws_dynamodb_describe_table` for a specific table
- S3: `aws_s3_list_buckets` -> `aws_s3_get_bucket_location` (region check) -> `aws_s3_get_bucket_policy_status` (public-access check)
- Messaging: `aws_sns_list_topics`, `aws_sqs_list_queues`, `aws_eventbridge_list_rules`, `aws_stepfunctions_list_state_machines`
- Tracing: `aws_xray_get_service_graph` (topology) -> `aws_xray_get_trace_summaries` (specific traces)
- Logs: `aws_logs_describe_log_groups` (find the group) -> `aws_logs_start_query` -> `aws_logs_get_query_results` (Insights polling pattern)
- Deployment context: `aws_cloudformation_list_stacks` -> `aws_cloudformation_describe_stacks` (status, outputs) -> `aws_cloudformation_describe_stack_events` (failure diagnosis)
- Tag discovery: `aws_resourcegroupstagging_get_resources` to find all resources matching a team/env tag across services

## Error Handling

The MCP server's error mapper already classifies AWS errors. When a tool result
contains `_error`, use the `kind` and `advice` fields verbatim in the report --
don't paraphrase. Common kinds:

- `iam-permission-missing`: the action is listed; the user/operator action is "Update DevOpsAgentReadOnlyPolicy to include <action>". Report this as a finding, not a failure.
- `assume-role-denied`: the trust-policy chain is broken; report the AssumeRole step that failed.
- `aws-throttled`: SDK already retried 3x; suggest narrowing scope before retry.
- `resource-not-found`: routine -- the named resource doesn't exist in this account/region. Report as a finding ("resource not found" is real data).
- `aws-network-error`: surface the underlying network error.
- `aws-server-error`: AWS 5xx; surface the requestId.

## What I Don't Do

- I don't make any write API calls (no create-/update-/put-/delete-/start-/stop-/terminate-). The MCP server's policy only grants read actions, so write attempts will return AccessDenied -- but I don't even try.
- I don't propose infrastructure changes. My job is to describe state, not modify it.
- I don't make claims about cost or billing -- the read-only policy doesn't grant those actions and that's a separate datasource.
```

- [ ] **Step 5: Validate YAML**

```bash
bun run yaml:check
# Expected: agents/incident-analyzer/agents/aws-agent/agent.yaml passes
```

If yamllint errors, fix indentation/quotes and re-run. The `agent.yaml` content above mirrors `kafka-agent/agent.yaml` line-for-line in structure, so this should pass first time.

- [ ] **Step 6: Commit**

```bash
git add agents/incident-analyzer/agents/aws-agent/
git commit -m "SIO-760: add aws-agent sub-agent definition

Three files mirroring the kafka-agent layout:
- agent.yaml: manifest with claude-haiku-4-5, low risk_tier
- SOUL.md: broad infrastructure-state specialist identity
- RULES.md: iteration-1 probe discipline (CloudWatch alarms + Health
  events in parallel before drill-downs), service drill-down ordering,
  error handling guidance

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Refactor mcp-server-kafka to read KAFKA_AGENTCORE_RUNTIME_ARN

**Files:**
- Modify: `packages/mcp-server-kafka/src/index.ts:76-110`

- [ ] **Step 1: Inspect the proxy-mode branch**

```bash
sed -n '76,98p' packages/mcp-server-kafka/src/index.ts
```

Expected:
```typescript
if (import.meta.main) {
	// If AGENTCORE_RUNTIME_ARN is set, the Kafka MCP server runs remotely on AWS.
	// Start only the local SigV4 proxy so the agent can reach it -- no local server needed.
	if (process.env.AGENTCORE_RUNTIME_ARN) {
		const { startAgentCoreProxy } = await import("@devops-agent/shared");
		logger.info(
			{
				arn: process.env.AGENTCORE_RUNTIME_ARN,
				transport: "agentcore-proxy",
			},
			"Starting Kafka MCP Server",
		);
		const proxy = await startAgentCoreProxy();
```

- [ ] **Step 2: Refactor to read `KAFKA_AGENTCORE_RUNTIME_ARN ?? AGENTCORE_RUNTIME_ARN`**

Use the Edit tool. Find:

```typescript
	// If AGENTCORE_RUNTIME_ARN is set, the Kafka MCP server runs remotely on AWS.
	// Start only the local SigV4 proxy so the agent can reach it -- no local server needed.
	if (process.env.AGENTCORE_RUNTIME_ARN) {
		const { startAgentCoreProxy } = await import("@devops-agent/shared");
		logger.info(
			{
				arn: process.env.AGENTCORE_RUNTIME_ARN,
				transport: "agentcore-proxy",
			},
			"Starting Kafka MCP Server",
		);
```

Replace with:

```typescript
	// Proxy-only mode: when an AgentCore runtime ARN is set, the Kafka MCP
	// server runs remotely on AWS. Start only the local SigV4 proxy so the
	// agent can reach it. KAFKA_AGENTCORE_RUNTIME_ARN takes precedence over
	// the generic AGENTCORE_RUNTIME_ARN to support running Kafka + AWS
	// proxies side-by-side without env-var collision (Phase 4: SIO-760).
	const runtimeArn = process.env.KAFKA_AGENTCORE_RUNTIME_ARN ?? process.env.AGENTCORE_RUNTIME_ARN;
	if (runtimeArn) {
		// startAgentCoreProxy reads AGENTCORE_RUNTIME_ARN; set it from the
		// resolved value so a developer can scope per-server or use the
		// generic var as a single-server override.
		process.env.AGENTCORE_RUNTIME_ARN = runtimeArn;
		const { startAgentCoreProxy } = await import("@devops-agent/shared");
		logger.info(
			{
				arn: runtimeArn,
				transport: "agentcore-proxy",
			},
			"Starting Kafka MCP Server",
		);
```

The rest of the function (proxy startup, logging, shutdown handlers) stays unchanged.

- [ ] **Step 3: Verify typecheck + Kafka tests**

```bash
bun run --filter @devops-agent/mcp-server-kafka typecheck
# Expected: Exited with code 0

bun run --filter @devops-agent/mcp-server-kafka test
# Expected: all existing tests pass (the new code path isn't exercised in unit tests; it's a runtime-only branch)
```

- [ ] **Step 4: Smoke-test that legacy AGENTCORE_RUNTIME_ARN still works**

```bash
# Stub the proxy with a fake ARN; expect "Starting Kafka MCP Server" with the ARN echoed.
# The proxy will try to connect to a fake runtime and fail, but the boot path
# under test runs to the log line first.
AGENTCORE_RUNTIME_ARN="arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/fake_kafka-XXXXX" \
  timeout 3 bun packages/mcp-server-kafka/src/index.ts 2>&1 | head -3 || true
# Expected: log line "Starting Kafka MCP Server" containing the ARN above
```

- [ ] **Step 5: Smoke-test that the new KAFKA_AGENTCORE_RUNTIME_ARN takes precedence**

```bash
KAFKA_AGENTCORE_RUNTIME_ARN="arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/kafka_specific-XXXXX" \
AGENTCORE_RUNTIME_ARN="arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/generic-XXXXX" \
  timeout 3 bun packages/mcp-server-kafka/src/index.ts 2>&1 | head -3 || true
# Expected: log line shows the kafka_specific ARN, not the generic one
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server-kafka/src/index.ts
git commit -m "SIO-760: kafka MCP reads KAFKA_AGENTCORE_RUNTIME_ARN with fallback

When both Kafka and AWS proxies run side-by-side (Phase 4), each needs
its own ARN env var. Pattern mirrors what mcp-server-aws got in Phase 3:
read <SERVER>_AGENTCORE_RUNTIME_ARN first, fall back to generic
AGENTCORE_RUNTIME_ARN so existing setups keep working.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Wire awsUrl into the web app (3 files)

**Files:**
- Modify: `apps/web/src/lib/server/agent.ts:41`
- Modify: `apps/web/src/routes/api/datasources/+server.ts`
- Modify: `apps/web/src/lib/components/DataSourceSelector.svelte:13`

Three small edits in three files; bundle into one commit.

- [ ] **Step 1: Add awsUrl to the McpClientConfig instantiation**

```bash
grep -n "awsUrl\|atlassianUrl: process.env.ATLASSIAN" apps/web/src/lib/server/agent.ts
```

Expected: one match for `atlassianUrl: process.env.ATLASSIAN_MCP_URL_LOCAL`. No `awsUrl` yet.

Use the Edit tool. Find:

```typescript
		atlassianUrl: process.env.ATLASSIAN_MCP_URL_LOCAL,
```

Replace with:

```typescript
		atlassianUrl: process.env.ATLASSIAN_MCP_URL_LOCAL,
		awsUrl: process.env.AWS_MCP_URL,
```

- [ ] **Step 2: Add aws-mcp mapping + env-presence check to the datasources endpoint**

```bash
cat apps/web/src/routes/api/datasources/+server.ts
```

Expected: a small file that maps connected MCP server names to datasource IDs, plus a list of `if (process.env.<X>_MCP_URL) dataSources.push("<id>")` lines.

Use the Edit tool. Find:

```typescript
	"atlassian-mcp": "atlassian",
};
```

Replace with:

```typescript
	"atlassian-mcp": "atlassian",
	"aws-mcp": "aws",
};
```

Then find:

```typescript
	if (process.env.ATLASSIAN_MCP_URL_LOCAL) dataSources.push("atlassian");
```

Replace with:

```typescript
	if (process.env.ATLASSIAN_MCP_URL_LOCAL) dataSources.push("atlassian");
	if (process.env.AWS_MCP_URL) dataSources.push("aws");
```

- [ ] **Step 3: Add AWS label to the DataSourceSelector component**

```bash
grep -n "atlassian:" apps/web/src/lib/components/DataSourceSelector.svelte
```

Expected: one match for `atlassian: "Atlassian",`.

Use the Edit tool. Find:

```typescript
	atlassian: "Atlassian",
```

Replace with:

```typescript
	atlassian: "Atlassian",
	aws: "AWS",
```

- [ ] **Step 4: Verify typecheck + lint for the web package**

```bash
bun run --filter @devops-agent/web typecheck
# Expected: Exited with code 0

bunx biome check apps/web/src/lib/server/agent.ts apps/web/src/routes/api/datasources/+server.ts apps/web/src/lib/components/DataSourceSelector.svelte
# Expected: No fixes applied
```

If Biome reformats anything, run with `--write` and recheck.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/agent.ts apps/web/src/routes/api/datasources/+server.ts apps/web/src/lib/components/DataSourceSelector.svelte
git commit -m "SIO-760: web app wires AWS_MCP_URL through the three touchpoints

- agent.ts: passes process.env.AWS_MCP_URL to createMcpClient
- datasources/+server.ts: aws-mcp -> aws mapping, AWS_MCP_URL presence check
- DataSourceSelector.svelte: aws -> 'AWS' label

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Add AWS_MCP_URL to .env

**Files:**
- Modify: `.env`

- [ ] **Step 1: Inspect existing MCP URL block**

```bash
grep -n "^[A-Z_]*_MCP_URL=" .env | head -10
```

Expected:
```
62:ELASTIC_MCP_URL=http://localhost:9080
64:KAFKA_MCP_URL=http://localhost:3000
65:COUCHBASE_MCP_URL=http://localhost:9082
66:KONNECT_MCP_URL=http://localhost:9083
67:GITLAB_MCP_URL=http://localhost:9084
...
```

- [ ] **Step 2: Add the AWS line after GITLAB**

Use the Edit tool. Find:

```
GITLAB_MCP_URL=http://localhost:9084
```

Replace with:

```
GITLAB_MCP_URL=http://localhost:9084
AWS_MCP_URL=http://localhost:3001
```

The :3001 port matches Phase 3's deployment (the local SigV4 proxy listens there when `AWS_AGENTCORE_RUNTIME_ARN` is set).

- [ ] **Step 3: Verify**

```bash
grep "AWS_MCP_URL" .env
# Expected: AWS_MCP_URL=http://localhost:3001
```

- [ ] **Step 4: Commit**

```bash
git add .env
git commit -m "SIO-760: add AWS_MCP_URL=http://localhost:3001 to .env

The local SigV4 proxy for the AWS AgentCore runtime listens on :3001
when AWS_AGENTCORE_RUNTIME_ARN is set (Phase 3).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Write wiring-aws.test.ts (5 unit assertions)

**Files:**
- Create: `packages/agent/src/wiring-aws.test.ts`

Tests live alongside source, not in a `__tests__/` subdir — matches existing convention (`supervisor-router.test.ts` etc.).

- [ ] **Step 1: Write the test file**

Use the Write tool to create `packages/agent/src/wiring-aws.test.ts`:

```typescript
// packages/agent/src/wiring-aws.test.ts
// SIO-760: assert the aws datasource is plumbed through every wiring table.
import { describe, expect, test } from "bun:test";
import { DATA_SOURCE_IDS } from "@devops-agent/shared";
import { DATASOURCE_TO_MCP_SERVER } from "./mcp-bridge.ts";
import type { AgentName } from "./state.ts";
import { AGENT_NAMES as SUB_AGENT_AGENT_NAMES } from "./sub-agent.ts";
import { AGENT_NAMES as SUPERVISOR_AGENT_NAMES } from "./supervisor.ts";

describe("AWS datasource wiring", () => {
	test("DATA_SOURCE_IDS includes 'aws'", () => {
		expect(DATA_SOURCE_IDS).toContain("aws");
	});

	test("AgentName union accepts 'aws-agent'", () => {
		// Type-level assertion: this assignment compiles only if 'aws-agent' is in the union.
		const name: AgentName = "aws-agent";
		expect(name).toBe("aws-agent");
	});

	test("supervisor's AGENT_NAMES maps aws -> aws-agent", () => {
		expect(SUPERVISOR_AGENT_NAMES.aws).toBe("aws-agent");
	});

	test("sub-agent's AGENT_NAMES maps aws -> aws-agent", () => {
		expect(SUB_AGENT_AGENT_NAMES.aws).toBe("aws-agent");
	});

	test("mcp-bridge DATASOURCE_TO_MCP_SERVER routes aws -> aws-mcp", () => {
		expect(DATASOURCE_TO_MCP_SERVER.aws).toBe("aws-mcp");
	});
});
```

- [ ] **Step 2: Run the new test file**

```bash
bun test packages/agent/src/wiring-aws.test.ts
# Expected: 5 pass, 0 fail
```

If any test fails, it indicates a missing wiring in Tasks 1–5 — go back and fix.

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/wiring-aws.test.ts
git commit -m "SIO-760: unit tests asserting aws datasource is plumbed through all tables

Five assertions:
- DATA_SOURCE_IDS contains 'aws'
- AgentName union accepts 'aws-agent' (type-level assertion)
- supervisor's AGENT_NAMES maps aws -> aws-agent
- sub-agent's AGENT_NAMES maps aws -> aws-agent
- mcp-bridge DATASOURCE_TO_MCP_SERVER routes aws -> aws-mcp

Catches typo-class regressions if any future refactor breaks the wiring.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Write supervisor-aws-fanout.test.ts (1 pipeline test)

**Files:**
- Create: `packages/agent/src/supervisor-aws-fanout.test.ts`

Mirrors the existing `supervisor-router.test.ts` pattern: mocks `mcp-bridge.ts` and `prompt-context.ts`, then exercises `supervise()` with a state that names all 6 datasources.

- [ ] **Step 1: Inspect the existing supervisor test for the mock pattern**

```bash
head -60 packages/agent/src/supervisor-router.test.ts
```

You should see `mock.module("./mcp-bridge.ts", ...)` and `mock.module("./prompt-context.ts", ...)` blocks followed by `makeState()`. The new test reuses this exact harness shape.

- [ ] **Step 2: Write the test file**

Use the Write tool to create `packages/agent/src/supervisor-aws-fanout.test.ts`:

```typescript
// packages/agent/src/supervisor-aws-fanout.test.ts
// SIO-760: assert supervise() dispatches 6 Sends when all 6 datasources are
// connected and named in extractedEntities. This is the Phase 4 gate.
import { describe, expect, mock, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";

const ALL_SIX = new Set(["elastic", "kafka", "couchbase", "konnect", "gitlab", "aws"]);

mock.module("./mcp-bridge.ts", () => ({
	getToolsForDataSource: (id: string) => (ALL_SIX.has(id) ? [{ name: `${id}_tool` }] : []),
	getAllTools: () => [],
	getConnectedServers: () => [...ALL_SIX].map((id) => `${id === "couchbase" ? "couchbase" : id}-mcp`),
	// DATASOURCE_TO_MCP_SERVER is needed at module load by some agent code paths.
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

mock.module("./prompt-context.ts", () => ({
	getAgent: () => ({
		manifest: { delegation: { mode: "auto" } },
		tools: [],
		subAgents: new Map(),
	}),
	buildOrchestratorPrompt: () => "",
	buildSubAgentPrompt: () => "",
	getToolDefinitionForDataSource: () => undefined,
}));

import { supervise } from "./supervisor.ts";

function makeState(overrides: Record<string, unknown> = {}) {
	return {
		messages: [],
		queryComplexity: "complex" as const,
		targetDataSources: [] as string[],
		targetDeployments: [] as string[],
		retryDeployments: [] as string[],
		dataSourceResults: [] as DataSourceResult[],
		currentDataSource: "",
		extractedEntities: {
			dataSources: [
				{ id: "elastic", mentionedAs: "explicit" },
				{ id: "kafka", mentionedAs: "explicit" },
				{ id: "couchbase", mentionedAs: "explicit" },
				{ id: "konnect", mentionedAs: "explicit" },
				{ id: "gitlab", mentionedAs: "explicit" },
				{ id: "aws", mentionedAs: "explicit" },
			],
		},
		previousEntities: { dataSources: [] },
		toolPlanMode: "autonomous" as const,
		toolPlan: [],
		validationResult: "pass" as const,
		retryCount: 0,
		alignmentRetries: 0,
		alignmentHints: [] as string[],
		skippedDataSources: [] as string[],
		isFollowUp: false,
		finalAnswer: "",
		dataSourceContext: undefined,
		investigationFocus: undefined,
		pendingTopicShiftPrompt: undefined,
		requestId: "test-fanout",
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
		degradedRules: [],
		confidenceCap: undefined,
		pendingCorrelations: [],
		partialFailures: [],
		...overrides,
	};
}

describe("supervisor AWS fan-out", () => {
	test("complex incident with all 6 sources connected dispatches 6 Sends including aws-agent", () => {
		// biome-ignore lint/suspicious/noExplicitAny: test harness state shape matches AgentStateType at runtime
		const sends = supervise(makeState() as any);

		expect(sends).toHaveLength(6);

		// Each Send.node is the sub-agent name. Collect them.
		const targetAgents = sends.map((s) => s.node).sort();
		expect(targetAgents).toContain("aws-agent");

		// Verify all 6 expected sub-agents are present.
		expect(targetAgents).toEqual([
			"aws-agent",
			"capella-agent",
			"elastic-agent",
			"gitlab-agent",
			"kafka-agent",
			"konnect-agent",
		]);
	});

	test("when aws is the only requested source, supervisor dispatches a single aws-agent Send", () => {
		const state = makeState({
			extractedEntities: {
				dataSources: [{ id: "aws", mentionedAs: "explicit" }],
			},
		});
		// biome-ignore lint/suspicious/noExplicitAny: same as above
		const sends = supervise(state as any);

		expect(sends).toHaveLength(1);
		expect(sends[0]?.node).toBe("aws-agent");
	});
});
```

- [ ] **Step 3: Run the new test file**

```bash
bun test packages/agent/src/supervisor-aws-fanout.test.ts
# Expected: 2 pass, 0 fail
```

If `supervise()` dispatches fewer than 6 Sends (or omits aws-agent), the wiring in Tasks 3–5 is incomplete — investigate.

- [ ] **Step 4: Run the full agent test suite to confirm no regressions**

```bash
bun run --filter @devops-agent/agent test 2>&1 | tail -10
# Expected: total pass count up by 7 (5 from Task 10 + 2 from Task 11); 0 fail
```

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/supervisor-aws-fanout.test.ts
git commit -m "SIO-760: pipeline test asserting 6-way fan-out includes aws-agent

Two assertions:
- All 6 sources connected and named -> 6 Sends, list includes aws-agent
- Only aws named -> 1 Send to aws-agent

This is the Phase 4 gate: supervise() must dispatch aws-agent whenever
the aws datasource is connected and matched by entity extraction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Full project lint, typecheck, and test

**Files:** none

- [ ] **Step 1: Typecheck everything**

```bash
bun run typecheck 2>&1 | tail -20
# Expected: every package "Exited with code 0".
# If @devops-agent/mcp-server-elastic shows langsmith/traceable missing, that's
# a pre-existing dep-declaration gap noted in Phase 3 — file a follow-up but
# do not block Phase 4 on it.
```

If the elastic typecheck failure surfaces, document it in the PR body as a known pre-existing issue. Don't fix it in this PR (out of scope).

- [ ] **Step 2: Lint everything**

```bash
bun run lint 2>&1 | tail -5
# Expected: no errors
```

If Biome reorders type imports in any new file (common on first import of a new symbol), run `bun run lint:fix` and amend the relevant commit:

```bash
bun run lint:fix
git add -u
git commit --amend --no-edit
```

- [ ] **Step 3: Run all agent tests**

```bash
bun run --filter @devops-agent/agent test 2>&1 | tail -5
# Expected: all pass; the diff vs main shows +7 passing tests (Tasks 10+11)
```

- [ ] **Step 4: Run mcp-server-aws tests as a sanity check**

```bash
bun run --filter @devops-agent/mcp-server-aws test 2>&1 | tail -5
# Expected: 130 pass, 0 fail (unchanged from Phase 3)
```

---

## Task 13: Push branch, open PR, move Linear to In Review

- [ ] **Step 1: Push the branch**

```bash
git push -u origin sio-760-phase-4-agent-pipeline
```

- [ ] **Step 2: Open the PR**

Use `gh pr create`. Title: `SIO-760: Phase 4 — AWS datasource agent pipeline integration`. Body:

```markdown
## Summary

- Wires the AWS datasource (deployed in Phase 3, SIO-759) into the LangGraph pipeline
- Supervisor now fans out to 6 sub-agents on complex incidents (was 5)
- Adds aws-agent sub-agent definition (agent.yaml, SOUL.md, RULES.md)
- Refactors mcp-server-kafka to read KAFKA_AGENTCORE_RUNTIME_ARN with fallback (mirrors AWS pattern from Phase 3)
- Adds 7 new tests (5 wiring + 2 fan-out)

Builds on Phase 3 (#93, SIO-759).

## Wiring touched

| Layer | Files |
|---|---|
| Shared types | `packages/shared/src/datasource.ts` |
| Agent state + dispatch | `packages/agent/src/{state,supervisor,sub-agent,mcp-bridge}.ts` |
| MCP server | `packages/mcp-server-kafka/src/index.ts` |
| Web app | `apps/web/src/{lib/server/agent.ts,routes/api/datasources/+server.ts,lib/components/DataSourceSelector.svelte}` |
| Config | `.env` |
| Sub-agent definition | `agents/incident-analyzer/agents/aws-agent/{agent.yaml,SOUL.md,RULES.md}` |
| Tests | `packages/agent/src/{wiring-aws,supervisor-aws-fanout}.test.ts` |

## Test plan

- [ ] CI: `bun run typecheck` (all packages green; if mcp-server-elastic shows langsmith/traceable missing, that's a pre-existing dep gap unrelated to Phase 4 — separate ticket)
- [ ] CI: `bun run lint` passes
- [ ] CI: `bun run --filter @devops-agent/agent test` passes (+7 tests vs main)
- [ ] CI: `bun run --filter @devops-agent/mcp-server-kafka test` passes (no regressions from KAFKA_AGENTCORE_RUNTIME_ARN refactor)
- [ ] Manual: with `AWS_MCP_URL=http://localhost:3001` set in `.env`, the SvelteKit UI shows "AWS" in the data-source selector dropdown
- [ ] Manual: a complex incident query routes through `supervise()` and produces `dataSourceResults.length === 6` (one entry per sub-agent)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 3: Move Linear sub-issue to In Review**

Use Linear MCP to set SIO-760 state to `In Review` (NOT `Done`). Comment on the issue with the PR URL.

- [ ] **Step 4: Wait for review**

Per `superpowers:finishing-a-development-branch`. Do **not** merge. Do **not** set the Linear issue to `Done`. Wait for user approval.

---

## Out of scope (Phase 5 / later)

For clarity to anyone reading this plan:

- **Correlation rules involving AWS** (e.g., `aws-ecs-degraded-needs-elastic-traces`) — Phase 5
- **AWS-specific runbooks** in `agents/incident-analyzer/knowledge/runbooks/` — Phase 5 or separate ticket
- **Wiring `atlassian-agent`** into the supervisor's fan-out — pre-existing gap, separate ticket
- **Collapsing the duplicate `AGENT_NAMES` tables** across `supervisor.ts` and `sub-agent.ts` — pre-existing tech debt
- **Per-server ARN env vars for elastic/couchbase/konnect/gitlab** — those servers don't have AgentCore deploys today; YAGNI
- **Fixing the `langsmith/traceable` dep declaration** in `mcp-server-elastic` — pre-existing Phase 2 escape, separate ticket
- **LangSmith eval dataset** for AWS findings — separate ticket per parent design
- **Multi-account expansion** to `352896877281` — post-launch follow-up

If a reviewer asks "why didn't you also do X", check whether X is listed above before adding scope.
