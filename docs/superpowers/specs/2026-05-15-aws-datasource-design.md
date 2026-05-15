# AWS Datasource Design (aws-agent + AWS MCP Server on AgentCore)

Date: 2026-05-15
Status: Approved (pending implementation)
Linear: (issue to be created before implementation begins)

## Goal

Add a 6th datasource so the DevOps Incident Analyzer can correlate AWS infrastructure state (compute, observability, networking, datastores, deployment context) with the existing 5 datasources (elastic, kafka, capella, konnect, gitlab) during incident analysis. The new datasource matches the existing infrastructure pattern end-to-end: gitagent sub-agent definition, dedicated MCP server package, AgentCore deployment, SigV4 proxy, supervisor fan-out, and SIO-681 correlation rules.

## Non-Goals

- Multi-account expansion beyond the single AgentCore account (`352896877281`). The trust policy is shaped for cross-account today; expansion to additional target accounts is a follow-up.
- Decomposition into service-specific MCP servers (`awslabs.cloudwatch-mcp-server`, etc.). The MVP uses the single `agent-toolkit-for-aws` server.
- LangSmith eval dataset for aws-agent findings. Follow-up ticket once the agent is producing real findings.
- Policy tightening based on observed access patterns. Per the design-doc rollout step 7, this comes after a few weeks of real usage.
- Cold-start warming. Only revisit if it becomes a real annoyance.

## Architecture

### Topology (end-to-end)

```
LangGraph supervisor
  |
  | (fan-out, alongside elastic/kafka/capella/konnect/gitlab)
  v
aws-agent (sub-agent)
  | MultiServerMCPClient -> http://localhost:3001/mcp  (plain HTTP, JSON-RPC)
  v
SigV4 Proxy (localhost:3001)
  | Resolves AWS creds, signs request, service=bedrock-agentcore
  v
AgentCore Runtime (eu-central-1, account 352896877281)
  | microVM hosting AWS MCP container :8000
  | Container assumes DevOpsAgentReadOnly via STS
  v
AWS APIs (EC2, ECS, Lambda, CloudWatch, Logs, X-Ray, Health,
          CloudFormation, RDS/DynamoDB/S3, SNS/SQS/EventBridge, Config)
```

### Three auth hops (same shape as the Kafka pattern)

1. **Local -> AgentCore**: SigV4 signed by local AWS creds, service `bedrock-agentcore`.
2. **AgentCore execution role -> DevOpsAgentReadOnly**: `sts:AssumeRole` with `ExternalId=aws-mcp-readonly-2026`. Intra-account today; same shape works cross-account when expanded.
3. **DevOpsAgentReadOnly -> AWS APIs**: standard IAM-authed `Describe*` / `Get*` / `List*` calls.

### Why this works

Every layer mirrors something that already exists in the codebase:

- The Kafka pattern proves the SigV4 + AgentCore + MCP triangle.
- The 5 existing sub-agents prove the gitagent + supervisor + correlation pattern.
- `scripts/agentcore/deploy.sh` is already parameterized by `MCP_SERVER`.
- `packages/shared/src/agentcore-proxy.ts` is runtime-agnostic — a second proxy instance on a different port is all that's needed locally.

This is composition, not invention.

## Components (file-by-file)

### 1. New gitagent definition: `agents/incident-analyzer/agents/aws-agent/`

Mirrors `agents/incident-analyzer/agents/kafka-agent/`:

- `agent.yaml` — declares `name: aws-agent`, model `claude-haiku-4-5`, `risk_tier: low`, references `aws-introspect` tool bundle.
- `SOUL.md` — agent persona and analytical voice.
- `RULES.md` — guardrails (read-only, no destructive calls, mention IAM scope when reporting).
- `tools/aws-introspect.yaml` — action-driven tool filter declaring which AWS MCP tools to expose per action (e.g. action `inventory` exposes `call_aws` + `recommend`; action `logs` exposes `call_aws` scoped to Logs Insights commands).
- `skills/` — incident-specific skill prompts (`ecs-task-failure.md`, `cloudwatch-correlation.md`, etc.).

### 2. New MCP server package: `packages/mcp-server-aws/`

Mirrors `packages/mcp-server-kafka/` structurally. The package's job is intentionally thin: it wraps the upstream `agent-toolkit-for-aws` AWS MCP server with the project's unified bootstrap shim.

- Vendors the upstream AWS MCP server inside the container image.
- Uses `createMcpApplication` from `@devops-agent/shared` for stdio/http/agentcore transports, logging, and `/ping` + `/health` endpoints — matching the other 5 servers.
- Implements a **truncation shim** that caps tool responses at `SUBAGENT_TOOL_RESULT_CAP_BYTES` with an explicit `[truncated at N bytes, M more items]` marker. Enforced at the shim layer, not the model layer.
- Implements **AssumeRole + ExternalId** in the container's startup path: container uses its execution-role credentials to assume `DevOpsAgentReadOnly`, then uses the returned temporary credentials for every AWS API call.

### 3. AgentCore deployment: extend existing script

Modify `scripts/agentcore/deploy.sh`:

- Add `aws` to the `MCP_SERVER=kafka|elastic|couchbase|konnect` switch.
- Add an `aws` block to the IAM policy switch (Step 3): execution role needs `sts:AssumeRole` for `arn:aws:iam::352896877281:role/DevOpsAgentReadOnly`, plus the standard CloudWatch Logs + ECR pull statements.
- Add an `aws` block to the env-vars switch (Step 4): pass `AWS_REGION`, `AGENT_READONLY_ROLE_ARN`, `AGENT_READONLY_EXTERNAL_ID`, `AWS_MCP_LOG_LEVEL`.

New file: `scripts/agentcore/setup-aws-readonly-role.sh` — one-shot, idempotent script that creates `DevOpsAgentReadOnly` with the full 11-statement read-only policy and the trust policy allowing the AWS MCP execution role to assume it.

### 4. Local SigV4 proxy port allocation

A second proxy instance on `localhost:3001`:

| Server | Local MCP / Proxy Port |
|---|---|
| Elastic MCP | 9080 |
| Kafka MCP (local) | 9081 |
| Capella MCP | 9082 |
| Konnect MCP | 9083 |
| GitLab MCP | 9084 |
| AWS MCP (new local entry) | 9085 |
| Kafka AgentCore SigV4 proxy | 3000 |
| **AWS AgentCore SigV4 proxy (new)** | **3001** |

The existing `packages/shared/src/agentcore-proxy.ts` is runtime-agnostic. The dev-runner script that spawns proxies for `bun run dev` is extended to start both proxies side-by-side. Per-proxy env vars (`KAFKA_AGENTCORE_RUNTIME_ARN`, `AWS_AGENTCORE_RUNTIME_ARN`) are required to prevent collision on a shared `AGENTCORE_RUNTIME_ARN`.

### 5. Agent pipeline integration (`packages/agent/src/`)

Touch points:

- `state.ts:18` — extend `AgentName` union: `"elastic-agent" | "kafka-agent" | "capella-agent" | "konnect-agent" | "gitlab-agent" | "aws-agent"`.
- `supervisor.ts:14` — add `aws: "aws-agent"` to the agent mapping.
- `sub-agent.ts:56` — add `aws: "aws-agent"` to the parallel mapping.
- Fan-out node — 5-way fan-out becomes 6-way (one additional `Send`).
- `correlation/rules.ts` — add starter rules referencing `requiredAgent: "aws-agent"`.

### Files at a glance

| New | Modified |
|---|---|
| `agents/incident-analyzer/agents/aws-agent/` (5 files) | `scripts/agentcore/deploy.sh` |
| `packages/mcp-server-aws/` (full package) | `packages/agent/src/state.ts` |
| `scripts/agentcore/setup-aws-readonly-role.sh` | `packages/agent/src/supervisor.ts` |
| | `packages/agent/src/sub-agent.ts` |
| | `packages/agent/src/correlation/rules.ts` |
| | dev-runner script (start second SigV4 proxy) |

`Dockerfile.agentcore` is already parameterized via `MCP_SERVER_PACKAGE`; no change needed beyond ensuring the new `packages/mcp-server-aws` builds cleanly under it.

## IAM Design

### The `DevOpsAgentReadOnly` role

- **Account**: `352896877281` (same account as AgentCore today).
- **Permissions policy**: full 11-statement read-only policy from the original AWS MCP design doc (`AWS MCP Design.md` and `AWS MCP Policy.md`):
  1. `IdentityAndAccountDiscovery` (sts, organizations, account)
  2. `RegionalAndNetworkTopology` (ec2 network describes, elb describes)
  3. `ComputeContainersAndServerlessRead` (ec2 instances, autoscaling, ecs, eks, lambda, apigateway)
  4. `DatastoresAndStorageRead` (rds, dynamodb, elasticache, s3)
  5. `MessagingAndIntegrationRead` (sns, sqs, eventbridge, step functions)
  6. `MetricsAlarmsAndDashboardsRead` (cloudwatch)
  7. `LogsReadLimitedByName` (CloudWatch Logs Insights, prefix-scoped to `/aws/*`, `/ecs/*`, `/app/*`, `/platform/*`, `/prod/*`)
  8. `TracingAndServiceMapRead` (X-Ray)
  9. `AwsHealthRead` (Health)
  10. `ConfigInventoryReadOptional` (Config)
  11. `CloudFormationAndDeploymentContextRead` (CloudFormation, Tags)

- **Trust policy**: only the AWS MCP execution role created by `deploy.sh` can assume it, with `ExternalId=aws-mcp-readonly-2026`.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::352896877281:role/aws-mcp-server-agentcore-role" },
    "Action": "sts:AssumeRole",
    "Condition": { "StringEquals": { "sts:ExternalId": "aws-mcp-readonly-2026" } }
  }]
}
```

### Why this shape (vs. attaching the policy to the execution role directly)

- Clean separation: execution role only does what AgentCore needs (ECR pull, CloudWatch logs); `DevOpsAgentReadOnly` only does inventory reads. Easier to audit.
- Same wire-shape as future multi-account: when an additional target account is added, the container code doesn't change — only the role ARN list grows.
- Policy can be tightened or expanded without touching AgentCore's IAM at all.

## Data Flow (worked example)

User input: *"Our checkout service is throwing 5xx errors — what's going on?"*

1. **Classify + extract** (existing). Classifier marks `complex`. Entities: service `checkout`, error `5xx`, implicit "now" time window.
2. **Runbook + fan-out** (existing). Runbook selector matches a "service errors" runbook. Fan-out sends `Send` to all 6 specialists in parallel including the new `aws-agent` branch.
3. **aws-agent invocation**. Gitagent action-driven filter picks action `service-health-check`, exposing ~10 AWS MCP tools out of 200+. Agent issues:
   - `call_aws ecs list-services --cluster <inferred>`
   - `call_aws ecs describe-services --services checkout`
   - `call_aws cloudwatch get-metric-data` for CPU/memory/5xx
   - `call_aws logs start-query` (Logs Insights) on `/ecs/checkout`
4. **SigV4 path**. Each tool call goes: aws-agent -> `http://localhost:3001/mcp` -> SigV4 proxy (service `bedrock-agentcore`) -> AgentCore microVM -> container assumes `DevOpsAgentReadOnly` -> AWS API.
5. **Findings**. Agent assembles a `DataSourceResult` matching the existing shape used by the other 5 sub-agents (source, findings, confidence, toolCalls).
6. **Aggregate + correlate** (existing SIO-681). `align` and `aggregate` merge findings from all 6 agents. New correlation rules:
   - `aws-ecs-degraded-needs-elastic-traces`: aws-agent reports `ecs-service-degraded` AND no elastic-agent finding for the same service -> dispatch `correlationFetch` to elastic-agent for APM traces.
   - `aws-cloudwatch-anomaly-needs-kafka-lag`: aws-agent reports CloudWatch 5xx spike AND service consumes from MSK -> dispatch to kafka-agent for consumer lag.
   - `kafka-broker-timeout-needs-aws-metrics`: existing rule extended; if kafka-agent reports broker timeouts AND no aws-agent finding for MSK -> dispatch to aws-agent for CloudWatch MSK broker metrics.
7. **`enforceCorrelationsAggregate` re-evaluates**. If any rule is still degraded, `confidenceCap` drops to 0.6 (existing logic).
8. **checkConfidence -> validate -> proposeMitigation -> followUp** (existing). No changes.

### Tool result size budget

aws-agent respects `SUBAGENT_TOOL_RESULT_CAP_BYTES`. CloudWatch Logs Insights can return huge result sets. Truncation is enforced **at the shim layer** with the explicit marker `[truncated at N bytes, M more items]` regardless of model behavior. Matches the `SUBAGENT_TOOL_RESULT_CAP_BYTES` + `SUBAGENT_*_RECURSION_LIMIT` pattern already documented.

## Error Handling

Every layer fails partially, not fatally. The other 5 sources continue and the pipeline produces a partial answer with degraded confidence.

| Where | Failure | Detection | Response |
|---|---|---|---|
| SigV4 proxy | Not running / port not bound | Connection refused on first tool call | `DataSourceResult` marked `failed: true, reason: "sigv4_proxy_unreachable"`; aggregate continues with the other 5 sources |
| SigV4 proxy | Local AWS creds expired/missing | Proxy returns 401/403 with credential-chain error | Same as above; proxy logs the priority chain (AGENTCORE_AWS_* -> AWS_* -> CLI) so user knows which to refresh |
| AgentCore Runtime | Not ACTIVE / cold-start timeout | Proxy gets 5xx from `bedrock-agentcore` API | Single retry with backoff; on second failure mark aws-agent failed |
| AgentCore Runtime | Container OOM / crashed | Runtime-error response | Mark aws-agent failed; CloudWatch logs at `/aws/bedrock-agentcore/runtimes/aws-mcp-server/*` capture container side |
| Container -> STS | DevOpsAgentReadOnly doesn't exist / trust policy wrong | STS returns `AccessDenied` | Surface as MCP tool error with `reason: "assume_role_denied"`; treat as hard failure (no retry) |
| Container -> STS | ExternalId mismatch | STS returns `AccessDenied` with `InvalidExternalId` | Distinct reason code so users see actual cause, not generic auth error |
| DevOpsAgentReadOnly -> AWS | IAM policy missing an action | `AccessDeniedException` | Return AWS error verbatim; aws-agent reports it as a finding (`kind: "iam-permission-missing", action: "<action>"`) — signal, not failure |
| AWS API | Throttling | `Throttling` / `ThrottlingException` | Single SDK-level retry with backoff; if still throttled, surface as finding |
| AWS API | Result too large | Response exceeds `SUBAGENT_TOOL_RESULT_CAP_BYTES` | Truncation shim caps with explicit marker; agent acknowledges incomplete data |
| aws-agent | Hit `SUBAGENT_AWS_RECURSION_LIMIT` | LangGraph aborts sub-agent loop | Partial `DataSourceResult` with findings so far + `failed: true, reason: "recursion_limit"` |

### Patterns reused (not re-invented)

- Partial-data flow handled by existing pipeline.
- Correlation rules degrade gracefully via the SIO-681 `confidenceCap = 0.6` mechanism.
- Container logging to `/aws/bedrock-agentcore/runtimes/aws-mcp-server/*` via existing CloudWatch Logs statement in execution-role policy.
- SigV4 proxy logs to stdout via Pino, matching Kafka.
- OpenTelemetry spans + LangSmith traces emitted through `@devops-agent/observability` like every other sub-agent.

### Cold-start latency

AgentCore Runtimes can take 10–30s to warm up after idle. First call may time out before the runtime is ready. **Decision: accept the cold-start window**; partial-data path handles it cleanly. Retrofit a `/ping` warmer only if it becomes a real annoyance.

## Testing

### Layer 1: unit tests (Bun test, no network)

- `packages/mcp-server-aws/`:
  - Bootstrap shim wires up `createMcpApplication` for all 3 transports.
  - Truncation shim caps at `SUBAGENT_TOOL_RESULT_CAP_BYTES` with marker.
  - STS error surfacing — given mocked STS errors, shim returns correct reason codes.
  - Env-var resolution priority (AGENTCORE_AWS_* > AWS_* > CLI) for the local proxy.
- `packages/agent/`:
  - `AgentName` union includes `"aws-agent"`.
  - `supervisor.ts` + `sub-agent.ts` mappings.
  - New correlation rules fire on correct trigger conditions; degraded-rule state is produced when aws-agent is absent.
- `packages/gitagent-bridge/`:
  - aws-agent YAML loads, parses, builds valid prompts; action-driven tool filtering returns expected tool subsets.

### Layer 2: integration tests (MCP tool execution, mocked AWS)

Per CLAUDE.md: "Always validate MCP tool changes by running the tool, not just typechecking."

- Run AWS MCP server locally (stdio) with mocked AWS SDK.
- Invoke `call_aws ec2 describe-vpcs`, `call_aws cloudwatch get-metric-data`, `call_aws logs start-query` end-to-end.
- Verify truncation marker.
- Verify `IAM permission missing` surfaces as a structured finding when mock returns `AccessDeniedException`.

### Layer 3: pipeline tests (LangGraph + aws-agent)

- Mock `MultiServerMCPClient` at its boundary so LangGraph fan-out exercises aws-agent without a live container.
- Verify 6-way fan-out produces 6 `DataSourceResult` entries reaching `aggregate`.
- Verify each new correlation rule fires its `Send` to the right `requiredAgent`; verify `enforceCorrelationsAggregate` caps confidence when degraded.
- Verify partial-data path: simulate aws-agent failure; pipeline produces final response with the other 5 sources + degraded confidence.

### Layer 4: live AWS verification (manual, one-time per environment)

Prove the IAM chain works **outside MCP** before exposing it through MCP. Per the design-doc rollout step 5:

```bash
aws sts assume-role \
  --role-arn arn:aws:iam::352896877281:role/DevOpsAgentReadOnly \
  --role-session-name aws-mcp-test \
  --external-id aws-mcp-readonly-2026

export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_SESSION_TOKEN=...
aws sts get-caller-identity        # should show DevOpsAgentReadOnly session
aws ec2 describe-vpcs              # should return VPCs
aws cloudwatch describe-alarms     # should return alarms
aws logs describe-log-groups       # should return log groups
```

If any of these fail, the MCP path is guaranteed to fail with confusing errors.

### Layer 5: AgentCore-deployed end-to-end (manual, validating the deploy)

After `MCP_SERVER=aws ./scripts/agentcore/deploy.sh` runs successfully:

- Probe via SigV4 proxy — `POST http://localhost:3001/mcp` (the "probe AgentCore via SigV4 proxy" pattern).
- `tools/list` returns AWS MCP tools.
- `call_aws sts get-caller-identity` returns the `DevOpsAgentReadOnly` session ARN (proves AssumeRole hop happened inside the container).
- `call_aws logs start-query` against a known-good log group with short time window — confirms permissions + truncation marker behavior.

### Explicitly NOT tested

- AWS API surface itself (upstream SDK).
- Correlation rule "value" (feedback-loop question, not unit-testable).
- Cold-start latency (acceptance behavior, not a gating test).

### LangSmith evals — follow-up

Eval dataset for aws-agent findings is a separate ticket. Adding aws-agent to existing eval datasets covering real incidents is the cleaner path.

## Rollout Sequence

Five phases. Each is independently verifiable and revertable.

### Phase 1: IAM scaffolding (no MCP, no container)

- Write `scripts/agentcore/setup-aws-readonly-role.sh`.
- Create `DevOpsAgentReadOnly` in account `352896877281` with the 11-statement policy.
- Create trust policy allowing the (yet-to-exist) AWS MCP execution role to assume it with `ExternalId=aws-mcp-readonly-2026`.
- For Phase 1 verification only, temporarily allow your local IAM Identity Center / dev profile in the trust policy so you can run Layer 4 manual checks.
- **Gate**: Layer 4 manual checks pass. Remove the temporary local-principal trust entry before moving on.

### Phase 2: MCP server package (local-only, no AgentCore)

- Scaffold `packages/mcp-server-aws/`.
- Vendor the upstream AWS MCP server.
- Wire `createMcpApplication` for stdio/http/agentcore transports.
- Implement truncation shim.
- Implement AssumeRole + ExternalId logic in container startup.
- **Gate**: Layer 1 + Layer 2 tests pass. Manual `bun run packages/mcp-server-aws stdio` returns the AWS tool catalogue.

### Phase 3: AgentCore deployment (no agent integration yet)

- Extend `scripts/agentcore/deploy.sh` to handle `MCP_SERVER=aws`.
- Run `MCP_SERVER=aws ./scripts/agentcore/deploy.sh`; wait for `ACTIVE`.
- Start local SigV4 proxy on `:3001` with `AWS_AGENTCORE_RUNTIME_ARN`.
- **Gate**: Layer 5 manual probes pass — `tools/list`, `call_aws sts get-caller-identity` shows `DevOpsAgentReadOnly` session, `call_aws logs start-query` works.

### Phase 4: Agent pipeline integration (no new correlation rules yet)

- Create `agents/incident-analyzer/agents/aws-agent/` (5 files).
- Update `state.ts`, `supervisor.ts`, `sub-agent.ts`.
- Add `MultiServerMCPClient` entry pointing at `http://localhost:3001/mcp`.
- Update dev-runner so `bun run dev` starts the second SigV4 proxy.
- **Gate**: Layer 3 pipeline test passes. A test incident routed through `complex` produces 6 `DataSourceResult` entries.

### Phase 5: Correlation rules

- Add `aws-ecs-degraded-needs-elastic-traces`, `aws-cloudwatch-anomaly-needs-kafka-lag`, `kafka-broker-timeout-needs-aws-metrics`.
- **Gate**: Layer 3 pipeline tests for each rule pass. One manual end-to-end probe with a real-shaped synthetic incident confirms `enforceCorrelationsAggregate` behaves correctly.

### Reversibility

Each phase is independently revertable: a problem found at Phase N doesn't force rolling back Phases 1..N-1.

- Phase 1 alone: orphan IAM role doing nothing.
- Phase 2 alone: package builds but nothing imports it.
- Phase 3 alone: AgentCore runtime running but agent never calls it.
- Phase 4 alone: aws-agent in pipeline but no correlation pressure.
- Phase 5: rules active.

## Open Questions

None at design time. Items deliberately deferred to follow-up tickets:

- Multi-account expansion (additional `DevOpsAgentReadOnly` roles in other accounts).
- LangSmith eval dataset.
- Policy tightening based on observed access patterns.
- Service-specific MCP server decomposition.
- Cold-start warming.

## References

- `AWS MCP Design.md` (user notes, original)
- `AWS MCP Policy.md` (user notes, full 11-statement policy)
- `Kafka MCP AgentCore.md` (existing runtime ARNs)
- `Kafka MCP to AgentCore - SigV4 Connection Guide.md` (auth pattern template)
- AWS docs: agent-toolkit-for-aws, mcp-proxy-for-aws, AgentCore Runtime
- Existing repo references:
  - `packages/shared/src/agentcore-proxy.ts` (reused for second proxy instance)
  - `scripts/agentcore/deploy.sh` (extended)
  - `packages/agent/src/state.ts:18` (`AgentName` union)
  - `packages/agent/src/supervisor.ts:14` (agent mapping)
  - `packages/agent/src/sub-agent.ts:56` (parallel mapping)
  - `packages/agent/src/correlation/rules.ts` (correlation framework, SIO-681)
- Memory: `reference_kafka_mcp_agentcore_ksql_disabled`, `reference_confluent_prd_ecs_topology`, `feedback_probe_agentcore_via_sigv4_proxy`, `reference_subagent_env_tunables`.
