# AWS Datasource Phase 4 — Agent Pipeline Integration

**Status:** Approved
**Parent epic:** [SIO-756](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)
**Parent design:** [2026-05-15-aws-datasource-design.md](./2026-05-15-aws-datasource-design.md) (Phase 4 outline at lines 319–325)
**Phase 1:** SIO-757 — IAM scaffolding (merged)
**Phase 2:** SIO-758 — `packages/mcp-server-aws/` native TypeScript MCP server (merged)
**Phase 3:** SIO-759 — AgentCore deployment (merged, PR #93)
**Date:** 2026-05-15

## Goal

Wire the AWS datasource — deployed in Phase 3 and reachable via a local SigV4 proxy on `:3001` — into the LangGraph pipeline so the supervisor fans out to a new `aws-agent` alongside the existing five sub-agents (elastic, kafka, capella, konnect, gitlab). A complex incident produces six `DataSourceResult` entries instead of five.

## Non-goals

- Correlation rules referencing AWS findings (Phase 5).
- AWS-specific runbooks under `agents/incident-analyzer/knowledge/runbooks/` (Phase 5 or separate ticket).
- Wiring `atlassian-agent` into the pipeline (pre-existing gap; manifest exists but isn't dispatched).
- LangSmith eval dataset for AWS findings (separate ticket per parent design).
- Production multi-account expansion to `352896877281` (post-launch).
- Live integration test against the deployed AgentCore runtime (Phase 3 was that gate).

## Inputs from prior phases

- AgentCore runtime `aws_mcp_server-57wIOB35U1` exists in `eu-central-1`, account `356994971776`, status `READY`.
- `packages/mcp-server-aws/src/index.ts` reads `AWS_AGENTCORE_RUNTIME_ARN` (with fallback to generic `AGENTCORE_RUNTIME_ARN`); when set, starts the SigV4 proxy on `:3001` instead of a local MCP server.
- All 39 AWS tools are registered and reachable (Phase 3 Appendix A verified `tools/list` returns 39 entries across 17 service families).
- The agent already loads tools per-datasource via `MultiServerMCPClient` from `@langchain/mcp-adapters`; existing sub-agents (kafka, elastic, etc.) follow this pattern.

## Architecture

```
Today (5 sub-agents)              Phase 4 (6 sub-agents)
=========================         =========================
START -> classify                 START -> classify
  complex                           complex
   -> normalize                       -> normalize
   -> entityExtractor                 -> entityExtractor
   -> supervise (fan-out)             -> supervise (fan-out)
        ├── elastic-agent                  ├── elastic-agent
        ├── kafka-agent                    ├── kafka-agent
        ├── capella-agent                  ├── capella-agent
        ├── konnect-agent                  ├── konnect-agent
        └── gitlab-agent                   ├── gitlab-agent
                                           └── aws-agent             <-- NEW
   -> align                           -> align
   -> aggregate                       -> aggregate
   ...                                ...
```

No graph topology changes. The 13-node pipeline (including the SIO-681 `correlationFetch` + `enforceCorrelationsAggregate` nodes) stays as-is. The new agent slots into the existing fan-out the way `kafka-agent` does — gets its tool catalogue via `MultiServerMCPClient` against `http://localhost:3001/mcp`, runs in parallel with the other agents, returns a `DataSourceResult` to `aggregate`.

## Changes

### Change 1 — New sub-agent definition (3 files)

Match the existing kafka/elastic/capella/konnect/gitlab shape, not the aspirational "5 files (agent.yaml, SOUL.md, RULES.md, tools/, skills/)" from the parent design. The siblings have no `tools/` or `skills/` subdirectories; the parent design's count was aspirational.

#### `agents/incident-analyzer/agents/aws-agent/agent.yaml`

Mirrors `kafka-agent/agent.yaml`:

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

The `tools: [aws-introspect]` entry is a logical group label — actual tool registration is driven by the MCP server itself (39 tools via `AWS_MCP_URL`), not by listing tools here. This matches kafka-agent's pattern.

#### `agents/incident-analyzer/agents/aws-agent/SOUL.md`

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

#### `agents/incident-analyzer/agents/aws-agent/RULES.md`

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
contains `_error`, use the `kind` and `advice` fields verbatim in the report —
don't paraphrase. Common kinds:

- `iam-permission-missing`: the action is listed; the user/operator action is "Update DevOpsAgentReadOnlyPolicy to include <action>". Report this as a finding, not a failure.
- `assume-role-denied`: the trust-policy chain is broken; report the AssumeRole step that failed.
- `aws-throttled`: SDK already retried 3x; suggest narrowing scope before retry.
- `resource-not-found`: routine — the named resource doesn't exist in this account/region. Report as a finding ("resource not found" is real data).
- `aws-network-error`: surface the underlying network error.
- `aws-server-error`: AWS 5xx; surface the requestId.

## What I Don't Do

- I don't make any write API calls (no create-/update-/put-/delete-/start-/stop-/terminate-). The MCP server's policy only grants read actions, so write attempts will return AccessDenied — but I don't even try.
- I don't propose infrastructure changes. My job is to describe state, not modify it.
- I don't make claims about cost or billing — the read-only policy doesn't grant those actions and that's a separate datasource.
```

### Change 2 — Pipeline wiring (4 files)

#### `packages/shared/src/datasource.ts:46`

```diff
-export const DATA_SOURCE_IDS = ["elastic", "kafka", "couchbase", "konnect", "gitlab", "atlassian"] as const;
+export const DATA_SOURCE_IDS = ["elastic", "kafka", "couchbase", "konnect", "gitlab", "atlassian", "aws"] as const;
```

`atlassian` stays in the list even though the supervisor doesn't dispatch it yet — that's a pre-existing gap, not Phase 4's job.

#### `packages/agent/src/state.ts:18`

```diff
-export type AgentName = "elastic-agent" | "kafka-agent" | "capella-agent" | "konnect-agent" | "gitlab-agent";
+export type AgentName = "elastic-agent" | "kafka-agent" | "capella-agent" | "konnect-agent" | "gitlab-agent" | "aws-agent";
```

#### `packages/agent/src/supervisor.ts:13`

```diff
 const AGENT_NAMES: Record<string, string> = {
   elastic: "elastic-agent",
   kafka: "kafka-agent",
   couchbase: "capella-agent",
   konnect: "konnect-agent",
   gitlab: "gitlab-agent",
   atlassian: "atlassian-agent",
+  aws: "aws-agent",
 };
```

#### `packages/agent/src/sub-agent.ts:55`

Same `AGENT_NAMES` table needs the same entry. (The duplicate table is pre-existing; collapsing it is out of scope for Phase 4.)

```diff
 const AGENT_NAMES: Record<string, string> = {
   elastic: "elastic-agent",
   kafka: "kafka-agent",
   couchbase: "capella-agent",
   konnect: "konnect-agent",
   gitlab: "gitlab-agent",
   atlassian: "atlassian-agent",
+  aws: "aws-agent",
 };
```

### Change 3 — MCP bridge (1 file)

#### `packages/agent/src/mcp-bridge.ts`

Three additions, all in existing patterns:

**3a — `McpClientConfig` interface (around line 23):**

```diff
 export interface McpClientConfig {
   elasticUrl?: string;
   kafkaUrl?: string;
   capellaUrl?: string;
   konnectUrl?: string;
   gitlabUrl?: string;
   atlassianUrl?: string;
+  awsUrl?: string;
 }
```

**3b — `createMcpClient`'s server-entry assembly (around line 132):**

```diff
 if (config.atlassianUrl) {
   serverEntries.push({ name: "atlassian-mcp", url: `${config.atlassianUrl}/mcp` });
 }
+if (config.awsUrl) {
+  serverEntries.push({ name: "aws-mcp", url: `${config.awsUrl}/mcp` });
+}
```

**3c — `getToolsForDataSource`'s `serverMap` (around line 207):**

```diff
 const serverMap: Record<string, string> = {
   elastic: "elastic-mcp",
   kafka: "kafka-mcp",
   couchbase: "couchbase-mcp",
   konnect: "konnect-mcp",
   gitlab: "gitlab-mcp",
   atlassian: "atlassian-mcp",
+  aws: "aws-mcp",
 };
```

No changes to header injection, retry, health-poll, or timeout logic. The AWS MCP server is served via the local SigV4 proxy which already handles all transport-level concerns including SIO-737 retries.

### Change 4 — Per-server `<SERVER>_AGENTCORE_RUNTIME_ARN` for Kafka (1 file)

Only Kafka and AWS have proxy-mode branches today (verified during plan-writing: `grep -l AGENTCORE_RUNTIME_ARN packages/mcp-server-*/src/index.ts` returns only those two). The AWS package already reads `AWS_AGENTCORE_RUNTIME_ARN` with fallback to generic (Phase 3). This change aligns Kafka with the same shape so the two servers can run side-by-side without env-var collision.

The other four servers (`mcp-server-elastic`, `mcp-server-couchbase`, `mcp-server-konnect`, `mcp-server-gitlab`) have no proxy-mode branch at all and don't currently support AgentCore deployment. Adding per-server ARN env vars to them would be dead code (YAGNI). When any of them eventually gets an AgentCore deploy, that's the right time to add the branch — copying the pattern from Kafka/AWS.

#### `packages/mcp-server-kafka/src/index.ts` (around line 76–110)

```diff
 if (import.meta.main) {
   // If AGENTCORE_RUNTIME_ARN is set, the Kafka MCP server runs remotely on AWS.
   // Start only the local SigV4 proxy so the agent can reach it -- no local server needed.
-  if (process.env.AGENTCORE_RUNTIME_ARN) {
+  const runtimeArn = process.env.KAFKA_AGENTCORE_RUNTIME_ARN ?? process.env.AGENTCORE_RUNTIME_ARN;
+  if (runtimeArn) {
+    // startAgentCoreProxy reads AGENTCORE_RUNTIME_ARN; set it from the resolved
+    // value so a developer can scope per-server (KAFKA_AGENTCORE_RUNTIME_ARN) or
+    // use the generic var as a single-server override.
+    process.env.AGENTCORE_RUNTIME_ARN = runtimeArn;
     const { startAgentCoreProxy } = await import("@devops-agent/shared");
     logger.info(
       {
-        arn: process.env.AGENTCORE_RUNTIME_ARN,
+        arn: runtimeArn,
         transport: "agentcore-proxy",
       },
       "Starting Kafka MCP Server",
     );
     const proxy = await startAgentCoreProxy();
     ...
```

Kafka's existing proxy port (3000 — the default `AGENTCORE_PROXY_PORT` in `startAgentCoreProxy`) is unchanged. AWS's :3001 is set inside the AWS package's index.ts (Phase 3). No port collision.

This change is **backwards-compatible**: any developer with `AGENTCORE_RUNTIME_ARN` in `.env` keeps getting the same behavior. The generic var continues to work as a single-server override. When both vars are set, the per-server var wins.

### Change 5 — Web app integration (3 files)

#### `apps/web/src/lib/server/agent.ts:41`

```diff
 const config: McpClientConfig = {
   elasticUrl: process.env.ELASTIC_MCP_URL,
   kafkaUrl: process.env.KAFKA_MCP_URL,
   capellaUrl: process.env.COUCHBASE_MCP_URL,
   konnectUrl: process.env.KONNECT_MCP_URL,
   gitlabUrl: process.env.GITLAB_MCP_URL,
   atlassianUrl: process.env.ATLASSIAN_MCP_URL_LOCAL,
+  awsUrl: process.env.AWS_MCP_URL,
 };
```

#### `apps/web/src/routes/api/datasources/+server.ts`

Two changes: extend the server-name → datasource-id map, and add the env-presence check.

```diff
 const SERVER_TO_DATASOURCE: Record<string, string> = {
   "elastic-mcp": "elastic",
   "kafka-mcp": "kafka",
   "couchbase-mcp": "couchbase",
   "konnect-mcp": "konnect",
   "gitlab-mcp": "gitlab",
   "atlassian-mcp": "atlassian",
+  "aws-mcp": "aws",
 };

 ...

 if (process.env.ELASTIC_MCP_URL) dataSources.push("elastic");
 if (process.env.KAFKA_MCP_URL) dataSources.push("kafka");
 if (process.env.COUCHBASE_MCP_URL) dataSources.push("couchbase");
 if (process.env.KONNECT_MCP_URL) dataSources.push("konnect");
 if (process.env.GITLAB_MCP_URL) dataSources.push("gitlab");
 if (process.env.ATLASSIAN_MCP_URL_LOCAL) dataSources.push("atlassian");
+if (process.env.AWS_MCP_URL) dataSources.push("aws");
```

#### `apps/web/src/lib/components/DataSourceSelector.svelte:13`

```diff
 const labels: Record<string, string> = {
   elastic: "Elastic",
   kafka: "Kafka",
   couchbase: "Couchbase",
   konnect: "Konnect",
   gitlab: "GitLab",
   atlassian: "Atlassian",
+  aws: "AWS",
 };
```

### Change 6 — `.env`

Add one line:

```diff
+AWS_MCP_URL=http://localhost:3001
```

No per-server ARN values are written to `.env` — those are opt-in per developer. The user's existing generic `AGENTCORE_RUNTIME_ARN` stays as-is and continues to work for the Kafka path.

## Testing

Two new test files. No changes to existing tests beyond what the type-system propagates.

### `packages/agent/src/__tests__/wiring-aws.test.ts`

Five unit-level assertions:

```typescript
import { describe, expect, test } from "bun:test";
import { DATA_SOURCE_IDS } from "@devops-agent/shared";
import type { AgentName } from "../state.ts";
// imports for the two AGENT_NAMES tables

describe("AWS datasource wiring", () => {
  test("DATA_SOURCE_IDS includes 'aws'", () => {
    expect(DATA_SOURCE_IDS).toContain("aws");
  });

  test("AgentName union accepts 'aws-agent'", () => {
    const name: AgentName = "aws-agent";
    expect(name).toBe("aws-agent");
  });

  test("supervisor's AGENT_NAMES maps aws -> aws-agent", () => {
    // import the AGENT_NAMES table (may need an export for testability)
    expect(supervisorAgentNames.aws).toBe("aws-agent");
  });

  test("sub-agent's AGENT_NAMES maps aws -> aws-agent", () => {
    expect(subAgentNames.aws).toBe("aws-agent");
  });

  test("mcp-bridge serverMap routes aws -> aws-mcp", () => {
    // requires getToolsForDataSource's serverMap to be exported for test
    expect(serverMap.aws).toBe("aws-mcp");
  });
});
```

If the two `AGENT_NAMES` tables and the `serverMap` aren't currently exported, that's a small TDD-driven cleanup as part of Phase 4: add a named export so the test can reach them. Three named exports added, no production behavior change.

### `packages/agent/src/__tests__/supervisor.aws-fanout.test.ts`

One pipeline-level assertion using the existing mock-MCP harness pattern (see `mcp-integration.test.ts` for the existing mock shape):

```typescript
import { describe, expect, test } from "bun:test";
import { supervise } from "../supervisor.ts";
// mock infrastructure: copy from supervisor-router.test.ts

describe("supervisor fans out to aws-agent", () => {
  test("complex incident with all 6 sources connected dispatches 6 Sends", async () => {
    // mock state: complex incident, no UI-selected sources, entityExtractor
    // matched all six datasources
    const state = makeMockState({
      queryComplexity: "complex",
      extractedEntities: {
        dataSources: [
          { id: "elastic", mentionedAs: "explicit" },
          { id: "kafka",   mentionedAs: "explicit" },
          { id: "couchbase", mentionedAs: "explicit" },
          { id: "konnect", mentionedAs: "explicit" },
          { id: "gitlab",  mentionedAs: "explicit" },
          { id: "aws",     mentionedAs: "explicit" },
        ],
      },
    });

    // mock mcp-bridge so all 6 servers are "connected"
    mockConnectedServers(["elastic-mcp", "kafka-mcp", "couchbase-mcp", "konnect-mcp", "gitlab-mcp", "aws-mcp"]);

    const sends = supervise(state);

    expect(sends).toHaveLength(6);
    const targetAgents = sends.map(s => s.node).sort();
    expect(targetAgents).toContain("aws-agent");
  });
});
```

The existing `supervisor-router.test.ts` already establishes the mock shape — copy that pattern. No new mocking infrastructure required.

### Test coverage rationale

- **Wiring tests catch typos**: the 7 pre-existing bugs surfaced in Phase 3 included multiple typo-class errors (wrong jmespath key, wrong status enum, etc.). These tests catch the agent-side analogs (typo in `AGENT_NAMES`, missing entry in `serverMap`).
- **One fan-out test catches integration regressions**: if any future refactor breaks the dispatcher (e.g., wraps `Send[]` in a different shape), the gate fails immediately.
- **No live integration test**: Phase 3 Appendix A already verified end-to-end reachability against the deployed runtime. Repeating that test in CI would gate on AWS credentials and be flaky. The user-facing smoke is unchanged: `bun run dev` brings up the proxy + agent; an incident query at the SvelteKit UI exercises the full path.

## Gate

Phase 4 is complete when:

1. The three sub-agent files exist under `agents/incident-analyzer/agents/aws-agent/`.
2. `bun run typecheck` passes for `@devops-agent/agent`, `@devops-agent/shared`, and `@devops-agent/web`.
3. `bun run lint` passes.
4. `bun run --filter @devops-agent/agent test` passes including the two new test files (wiring + fan-out).
5. The Kafka `index.ts` refactor commit typechecks (`KAFKA_AGENTCORE_RUNTIME_ARN` reads its own var first, falls back to generic `AGENTCORE_RUNTIME_ARN`).
6. Manual: with `AWS_MCP_URL=http://localhost:3001` set, the SvelteKit UI shows "AWS" in the data-source selector dropdown, and a complex incident query produces `dataSourceResults.length === 6`.

## Error modes and recovery

| Failure | Symptom | Recovery |
|---|---|---|
| `AWS_MCP_URL` not set in `.env` | Agent boots without AWS tools; AWS not in selector dropdown | Set the env var; restart |
| Local SigV4 proxy not running on `:3001` | `MCP connect to 'aws-mcp' timed out` log line on boot; AWS shown as connected briefly but tool calls fail | `bun run --filter @devops-agent/mcp-server-aws dev` (with `AWS_AGENTCORE_RUNTIME_ARN` set); next health poll reconnects |
| AgentCore runtime stopped or removed | Tool calls return 5xx through the SigV4 proxy | Existing `_error` mapping captures it as `aws-server-error`; falls through to `DataSourceResult.failed = true`; pipeline continues |
| `<SERVER>_AGENTCORE_RUNTIME_ARN` refactor accidentally breaks Kafka | Kafka proxy doesn't start when `bun run dev` runs | Per-server var reads with `??` fallback to generic; existing `AGENTCORE_RUNTIME_ARN` in `.env` continues to work for Kafka |
| Duplicate `AGENT_NAMES` tables get out of sync over time | Future agent fans out to one but not the other | Wiring test catches the inconsistency; the duplicate is pre-existing tech debt for a separate ticket |

## Reversibility

Phase 4 is independently revertable: each commit is a focused diff. Reverting the per-server-ARN refactor commits returns each MCP package to reading the generic `AGENTCORE_RUNTIME_ARN`. Reverting the wiring commits removes the AWS fan-out entry; Phase 3's deployed runtime is unaffected.

## Out of scope (Phase 5+)

- Correlation rules involving AWS findings (`aws-ecs-degraded-needs-elastic-traces`, `aws-cloudwatch-anomaly-needs-kafka-lag`, `kafka-broker-timeout-needs-aws-metrics`) — Phase 5
- AWS-specific runbooks under `agents/incident-analyzer/knowledge/runbooks/` — Phase 5 or separate ticket
- Wiring `atlassian-agent` into the supervisor's fan-out — pre-existing gap, separate ticket
- Collapsing the duplicate `AGENT_NAMES` tables across `supervisor.ts` and `sub-agent.ts` — pre-existing tech debt
- LangSmith eval dataset for AWS findings — separate ticket per parent design
- Multi-account expansion to `352896877281` — post-launch follow-up

## References

- Parent design: `docs/superpowers/specs/2026-05-15-aws-datasource-design.md` (Phase 4 outline at lines 319–325)
- Phase 3 spec (gate context): `docs/superpowers/specs/2026-05-15-aws-datasource-phase-3-agentcore-deployment.md`
- `packages/mcp-server-kafka/src/index.ts:76–110` — the proxy-mode branch shape mirrored by Change 4
- `packages/mcp-server-aws/src/index.ts` — already has the per-server ARN pattern (Phase 3)
- `packages/agent/src/mcp-bridge.ts:112–200` — the wiring extended by Change 3
- `apps/web/src/lib/server/agent.ts`, `apps/web/src/routes/api/datasources/+server.ts`, `apps/web/src/lib/components/DataSourceSelector.svelte` — the three web touchpoints
- Memory notes: `feedback_plan_authority_over_pattern` (justifies the per-server-ARN scope), `reference_first_deploy_to_fresh_account_bugs` (recently-fixed deploy.sh bugs), `project_chat_platform_teams` (frontend infra context).
