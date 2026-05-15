# AWS MCP Server Package Design (Phase 2 of the AWS datasource rollout)

Date: 2026-05-15
Status: Approved (pending implementation)
Linear epic: [SIO-756](https://linear.app/siobytes/issue/SIO-756)
Linear sub-issue: (created before Phase 2 implementation begins)
Parent spec: `docs/superpowers/specs/2026-05-15-aws-datasource-design.md` (Phase 1 merged in PR #91)

## Goal

Ship a native-TypeScript MCP server at `packages/mcp-server-aws/` that exposes 39 read-only AWS tools across 14 tool folders (covering ~18 AWS service families — the `messaging/` folder bundles SNS, SQS, EventBridge, and Step Functions for code organization). The server matches the existing 5-server pattern exactly (`createMcpApplication` bootstrap, Pino logging, OpenTelemetry tracing, stdio/http/agentcore transports). All AWS API calls go through `@aws-sdk/client-*` clients wrapped with the SDK's built-in `fromTemporaryCredentials` provider, which assumes the `DevOpsAgentReadOnly` role created in Phase 1.

## Non-Goals (Phase 2 deliberately defers)

- **AgentCore deployment.** `scripts/agentcore/deploy.sh` is not modified in this phase. Phase 3 extends the deploy script to handle `MCP_SERVER=aws`.
- **The SigV4 proxy on `:3001`.** Same reason — Phase 3.
- **The aws-agent gitagent definition.** Phase 4.
- **Correlation rules referencing `requiredAgent: "aws-agent"`.** Phase 5.
- **LangSmith eval coverage for aws-agent findings.** Follow-up issue.
- **Trimming the tool surface.** Phase 2 ships the full 39-tool coverage (per Q2 decision: "C, we can trim down later after testing exploration").

## Architecture

### End-to-end (Phase 2 deliverable)

```
aws-agent (later — Phase 4)
  | MultiServerMCPClient -> http://localhost:9085/mcp (Phase 2 local dev path)
  |                     -> http://localhost:3001/mcp (Phase 3 AgentCore path)
  v
mcp-server-aws (bun process locally, AgentCore container later)
  | createMcpApplication bootstrap (stdio | http | agentcore transport)
  | ~39 tools, each: validate params -> SDK call -> wrap (truncate + error map) -> return
  v
AWS SDK clients (lazy singletons, one per service — up to 18 distinct @aws-sdk/client-* packages)
  | each constructed with credentials: fromTemporaryCredentials({ RoleArn, ExternalId })
  | SDK handles assume-role on first call, caches creds, refreshes ~5min before expiry
  v
AWS APIs (EC2, ECS, Lambda, CloudWatch, Logs, X-Ray, Health,
          CloudFormation, RDS, DynamoDB, S3, ElastiCache,
          SNS, SQS, EventBridge, Step Functions, Config, Tags)
```

### Three design principles

1. **Same shape as the other 5 MCP servers.** `packages/mcp-server-aws/` mirrors `packages/mcp-server-kafka/` structurally: `index.ts` is thin (~80 LOC bootstrap), tools are split into folder-per-service, transport is the standard `factory.ts`, logging/tracing flow through `@devops-agent/observability`.

2. **Credentials are the SDK's problem.** No custom STS refresh code. Every SDK client gets `credentials: fromTemporaryCredentials({ RoleArn, ExternalId, RoleSessionName })`. SDK manages caching, refresh-before-expiry, clock skew, throttle-retry. The MVP wires this once in `services/credentials.ts`.

3. **Truncation is a wrapper concern, not a tool concern.** Tools call SDK methods and return raw responses. `wrap.ts` helpers (`wrapListTool`, `wrapBlobTool`) apply truncation + error mapping transparently. Tool files stay focused on one SDK call each (~30-50 LOC).

## Components

### Package layout

```
packages/mcp-server-aws/
  package.json                   # @devops-agent/mcp-server-aws
  tsconfig.json                  # extends root
  src/
    index.ts                     # bootstrap entry (createMcpApplication, ~80 LOC)
    config/
      schemas.ts                 # Zod schemas for env
      index.ts                   # getConfig() + types (~60 LOC)
    services/
      credentials.ts             # buildAssumedCredsProvider()
      client-factory.ts          # lazy SDK client singletons (~80 LOC)
    tools/
      wrap.ts                    # wrapListTool / wrapBlobTool / error mapping (~120 LOC)
      register.ts                # registerAllTools(server)
      ec2/                       # describe-instances, describe-vpcs, describe-security-groups
      ecs/                       # list-clusters, describe-services, describe-tasks, list-tasks
      lambda/                    # list-functions, get-function-configuration
      cloudwatch/                # get-metric-data, describe-alarms
      logs/                      # describe-log-groups, start-query, get-query-results
      xray/                      # get-service-graph, get-trace-summaries
      health/                    # describe-events
      cloudformation/            # list-stacks, describe-stacks, describe-stack-events
      rds/                       # describe-db-instances, describe-db-clusters
      dynamodb/                  # list-tables, describe-table
      s3/                        # list-buckets, get-bucket-location, get-bucket-policy-status
      elasticache/               # describe-cache-clusters, describe-replication-groups
      messaging/                 # 7 tools across sns/sqs/eventbridge/stepfunctions
      config/                    # describe-config-rules, list-discovered-resources
      tags/                      # get-resources
    transport/
      factory.ts                 # creates stdio | http | agentcore transport
    telemetry/
      tracing.ts                 # bridge to @devops-agent/observability
    utils/
      logger.ts                  # Pino via @devops-agent/observability
      env.ts                     # getRuntimeInfo()
  __tests__/
    wrap.test.ts                 # truncation + error mapping (~12 tests)
    config.test.ts               # Zod schemas (~6 tests)
    client-factory.test.ts       # singleton behavior, credential provider wiring (~4 tests)
    tools-smoke.test.ts          # each tool's param schema parses (~39 tests minimum, one per tool)
    tools-integration.test.ts    # SDK-mocked end-to-end per service family (~15 tests)
    bootstrap.test.ts            # transport startup + /ping + /health (~4 tests)
```

### Tool coverage (39 tools across 14 folders)

The 35 tools map directly onto the IAM policy verified in Phase 1. Each tool exposes one AWS SDK command:

| Family | Tools | SDK package |
|---|---|---|
| EC2 / VPC | `aws_ec2_describe_instances`, `aws_ec2_describe_vpcs`, `aws_ec2_describe_security_groups` | `@aws-sdk/client-ec2` |
| ECS | `aws_ecs_list_clusters`, `aws_ecs_describe_services`, `aws_ecs_describe_tasks`, `aws_ecs_list_tasks` | `@aws-sdk/client-ecs` |
| Lambda | `aws_lambda_list_functions`, `aws_lambda_get_function_configuration` | `@aws-sdk/client-lambda` |
| CloudWatch | `aws_cloudwatch_get_metric_data`, `aws_cloudwatch_describe_alarms` | `@aws-sdk/client-cloudwatch` |
| CloudWatch Logs | `aws_logs_describe_log_groups`, `aws_logs_start_query`, `aws_logs_get_query_results` | `@aws-sdk/client-cloudwatch-logs` |
| X-Ray | `aws_xray_get_service_graph`, `aws_xray_get_trace_summaries` | `@aws-sdk/client-xray` |
| Health | `aws_health_describe_events` | `@aws-sdk/client-health` |
| CloudFormation | `aws_cloudformation_list_stacks`, `aws_cloudformation_describe_stacks`, `aws_cloudformation_describe_stack_events` | `@aws-sdk/client-cloudformation` |
| RDS | `aws_rds_describe_db_instances`, `aws_rds_describe_db_clusters` | `@aws-sdk/client-rds` |
| DynamoDB | `aws_dynamodb_list_tables`, `aws_dynamodb_describe_table` | `@aws-sdk/client-dynamodb` |
| S3 | `aws_s3_list_buckets`, `aws_s3_get_bucket_location`, `aws_s3_get_bucket_policy_status` | `@aws-sdk/client-s3` |
| ElastiCache | `aws_elasticache_describe_cache_clusters`, `aws_elasticache_describe_replication_groups` | `@aws-sdk/client-elasticache` |
| Messaging | `aws_sns_list_topics`, `aws_sns_get_topic_attributes`, `aws_sqs_list_queues`, `aws_sqs_get_queue_attributes`, `aws_eventbridge_list_rules`, `aws_eventbridge_describe_rule`, `aws_stepfunctions_list_state_machines` | `@aws-sdk/client-sns`, `@aws-sdk/client-sqs`, `@aws-sdk/client-eventbridge`, `@aws-sdk/client-sfn` |
| Config | `aws_config_describe_config_rules`, `aws_config_list_discovered_resources` | `@aws-sdk/client-config-service` |
| Tags | `aws_resourcegroupstagging_get_resources` | `@aws-sdk/client-resource-groups-tagging-api` |

Each tool file is the same shape (~30-50 LOC): Zod `paramsSchema`, wrapped handler via `wrapListTool` or `wrapBlobTool`. The action-driven filtering at the gitagent layer (Phase 4) controls which subset of these tools is exposed to the LLM per invocation.

### Credentials wiring (one file, one decision)

`src/services/credentials.ts`:

```typescript
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";

export function buildAssumedCredsProvider(config: AwsConfig): AwsCredentialIdentityProvider {
  return fromTemporaryCredentials({
    params: {
      RoleArn: config.assumedRoleArn,        // arn:aws:iam::ACCOUNT:role/DevOpsAgentReadOnly
      ExternalId: config.externalId,         // aws-mcp-readonly-2026
      RoleSessionName: "aws-mcp-server",
      DurationSeconds: 3600,
    },
    // Base creds default to the SDK's standard chain (env vars / shared config / instance metadata).
    // AgentCore: execution role creds resolve here; locally: dev profile.
  });
}
```

Every SDK client (EC2, ECS, Lambda, ...) is constructed with `credentials: buildAssumedCredsProvider(config)`. The SDK handles caching and refresh internally.

### Wrappers (two truncation strategies + one error mapper)

`src/tools/wrap.ts`:

```typescript
export function wrapListTool<TResponse, TParams>(args: {
  name: string;
  listField: keyof TResponse;
  fn: (params: TParams) => Promise<TResponse>;
  capBytes?: number;
}): (params: TParams) => Promise<TResponse & { _truncated?: { shown: number; total: number; advice: string } } | { _error: ToolError }>;

export function wrapBlobTool<TResponse, TParams>(args: {
  name: string;
  fn: (params: TParams) => Promise<TResponse>;
  capBytes?: number;
}): (params: TParams) => Promise<TResponse | { _raw: string; _truncated: { atBytes: number; advice: string } } | { _error: ToolError }>;
```

**`wrapListTool` behavior** (for responses with a known list field like `Vpcs`, `Tasks`, `results`):
- Cap response at `SUBAGENT_TOOL_RESULT_CAP_BYTES` worth of items
- Truncate the array (not the bytes mid-item) and emit `_truncated: { shown, total, advice }`
- All non-list fields preserved unchanged

**`wrapBlobTool` behavior** (for shape-less responses like `get_service_graph`, `get_template`):
- Serialize, cap at byte limit
- Walk back to the last valid `,` or `]` to keep JSON parseable
- Emit `_truncated: { atBytes, advice }` marker

**Shared error mapping**:

| AWS SDK error | `_error.kind` | aws-agent behavior |
|---|---|---|
| `AccessDeniedException` (from STS) | `assume-role-denied` | Hard fail; surfaces as actionable signal (IAM setup wrong) |
| `AccessDeniedException` (from API) | `iam-permission-missing` | Structured finding; surfaces as actionable signal (policy needs widening) |
| `ThrottlingException` | `aws-throttled` | Soft failure; SDK already retried (maxAttempts=3) |
| `ValidationException`, `InvalidParameterValue` | `bad-input` | aws-agent retries with corrected params |
| `ResourceNotFoundException` | (not an error — pass through empty response) | Empty result is a valid finding |
| `ServiceUnavailable`, `InternalServerError` | `aws-server-error` | Soft failure |
| Network timeout / DNS | `aws-network-error` | Same as `aws-server-error` |
| Unrecognized | `aws-unknown` | Failed call; full message included |

Tool calls never throw to the MCP layer. Bootstrap errors (config invalid, etc.) do throw — that's caught by `createMcpApplication` and the process exits non-zero.

## Data flow (worked example)

aws-agent invokes `aws_logs_start_query` to find `DBConnectionTimeout` in `/ecs/checkout`:

1. **MCP request** lands at `http://localhost:9085/mcp` with body containing tool name + arguments
2. **`createMcpApplication`** routes to the registered handler for `aws_logs_start_query`
3. **Zod `paramsSchema.parse(arguments)`** validates shape; structured error if invalid
4. **`wrapBlobTool`'s inner fn** calls `getLogsClient(config)` — lazy singleton
   - First call this process: SDK constructs `CloudWatchLogsClient` with `credentials = fromTemporaryCredentials({...})`
   - SDK's credential provider, on first use, calls `sts:AssumeRole` via the default credential chain (locally: dev profile; AgentCore: execution role)
   - SDK caches assumed creds; refreshes ~5min before 1h expiry
5. **`client.send(new StartQueryCommand({...}))`** signs and sends to `logs.{region}.amazonaws.com:443`
6. **AWS returns** `{ queryId: "abc-123" }`
7. **`wrapBlobTool`** serializes (response is small, no truncation), returns the raw response
8. **MCP layer** returns the JSON-RPC response

aws-agent chains a follow-up `aws_logs_get_query_results` call after a brief delay (standard Logs Insights pattern). That call returns a list response with `results: LogInsightsRow[]` — `wrapListTool` truncates to fit cap, emits `_truncated: { shown: 111, total: 487, advice: "Narrow query or filter" }`.

### Truncation contract (the structured marker)

For `aws_logs_get_query_results` with `capBytes=32000`:

```json
{
  "results": [/* 111 complete rows */],
  "status": "Complete",
  "statistics": { /* unchanged */ },
  "_truncated": {
    "shown": 111,
    "total": 487,
    "advice": "Narrow the query window or add a filter to fit more rows in a single call."
  }
}
```

aws-agent's tool description (in `tools/logs/get-query-results.ts`) instructs the model to issue a follow-up with tighter scope when `_truncated` appears.

### Error contract (the structured `_error`)

For `aws_rds_describe_db_instances` if RDS were denied:

```json
{
  "_error": {
    "kind": "iam-permission-missing",
    "action": "rds:DescribeDBInstances",
    "advice": "Update DevOpsAgentReadOnlyPolicy to include this action, then re-run setup-aws-readonly-role.sh."
  }
}
```

aws-agent treats `iam-permission-missing` as a structured finding (`kind: "iam-permission-missing"`), not a thrown exception. The aggregate step (Phase 4) surfaces this to the human as actionable signal.

### Cold-start latency

Per aws-agent invocation:
- First SDK client construction: ~50ms (one-time per service per process)
- First STS assume-role: ~150-300ms (one-time per credential lifetime — ~1 hour)
- Each AWS API call: ~50-500ms depending on service

For an aws-agent invocation issuing 4-10 tool calls, the total auth overhead is ~200-300ms (mostly the first call), not per call.

## Error handling

Three principles:

1. **Tool calls don't throw — they return.** Every tool wrapper catches AWS SDK exceptions and returns a structured `{_error: ...}` shape. The MCP layer never propagates AWS exceptions to the agent.
2. **Bootstrap errors do throw.** Config validation, missing env vars, region misconfig — these happen at process start; `createMcpApplication` handles the non-zero exit.
3. **Credential failures get their own error class.** STS denial is reported as `_error.kind = "assume-role-denied"` with the actual STS message. Highest-actionability error type.

### Logging policy

Every `_error` return logs at Pino `error` level:

```typescript
logger.error(
  {
    tool: "aws_logs_describe_log_groups",
    region: "eu-central-1",
    awsErrorName: error.name,
    awsErrorMessage: error.message,
    awsRequestId: error.$metadata?.requestId,
    httpStatusCode: error.$metadata?.httpStatusCode,
    duration_ms: 123,
    errorKind: "iam-permission-missing",
  },
  `AWS tool call failed: ${error.name}`,
);
```

LangSmith traces capture the structured `_error` automatically because the tool's return value flows into the agent's tool-result message.

### Out of scope for Phase 2

- **Circuit breakers.** No breaker at the wrapper layer. The LangGraph fan-out only invokes aws-agent once per incident; `SUBAGENT_AWS_RECURSION_LIMIT` caps tool calls per invocation. Blast radius is bounded structurally. Retrofit if practice shows otherwise.
- **Custom retry logic.** SDK's built-in retry (default: 3 attempts with exponential backoff) is enough. We set `maxAttempts: 3` explicitly so future maintainers see the choice.

## Testing

### Layer 1: Unit tests (Bun test, no network, ~58 tests)

| File | Tests |
|---|---|
| `wrap.test.ts` | 12 (truncation in both wrappers, error mapping for each `_error.kind`, valid-JSON walkback) |
| `config.test.ts` | 6 (Zod schema accepts/rejects, defaults, idempotency) |
| `client-factory.test.ts` | 4 (singleton behavior, credential-provider wiring, region override, 18 distinct clients) |
| `tools-smoke.test.ts` | 39 (one per tool: paramsSchema parses valid + rejects invalid) |

### Layer 2: Integration tests (SDK-mocked, ~15 tests)

`tools-integration.test.ts` — one representative test per service family. Uses `aws-sdk-client-mock` to mock SDK command responses; invokes the tool handler; asserts on the wrapped response shape (truncation for list shapes, blob walkback for `xray.get_service_graph` etc., error mapping for an injected `AccessDeniedException`).

### Layer 3: Bootstrap tests (~4 tests)

`bootstrap.test.ts` — `MCP_TRANSPORT=stdio` starts on stdin/stdout, `MCP_TRANSPORT=http` binds and responds to `/ping` and `/health`, missing env causes `createMcpApplication` to throw before transport binds.

### Layer 4: Live AWS verification (manual, one-time per developer)

```bash
# Setup dev trust (one-time)
TRUST_POLICY_FILE=scripts/agentcore/policies/devops-agent-readonly-trust-policy-phase1.json \
  ./scripts/agentcore/setup-aws-readonly-role.sh

# Start the server
AWS_REGION=eu-central-1 \
AWS_ASSUMED_ROLE_ARN=arn:aws:iam::356994971776:role/DevOpsAgentReadOnly \
AWS_EXTERNAL_ID=aws-mcp-readonly-2026 \
MCP_TRANSPORT=http \
TRANSPORT_PORT=9085 \
bun run packages/mcp-server-aws/src/index.ts

# Probe
MCP_SERVER=aws BASE_URL=http://localhost:9085 ./scripts/agentcore/test-local.sh

# tools/list — expect 39
curl -sX POST http://localhost:9085/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'

# One call per tool folder (14 total) — see plan for the full set
```

Catches: SDK contract drift not visible in mocks, AssumeRole end-to-end, truncation under real response volumes, policy gaps Phase 1 didn't catch.

### Layer 5 (deferred to Phase 3)

AgentCore-deployed end-to-end (SigV4 proxy → AgentCore → container). Phase 3 extends `deploy.sh`; Layer 4 probes get re-run via `http://localhost:3001/mcp`.

### Not tested

- AWS API surface itself (upstream SDK).
- LangGraph fan-out with aws-agent (Phase 4).
- Correlation rules (Phase 5).
- Cold-start performance (acceptance, not gating).

## Rollout

Phase 2 is one PR, end-to-end. No phased rollout within this phase — the deliverables are tightly coupled.

| Order | What lands | Verification |
|---|---|---|
| 1 | Package skeleton, config, credentials, client-factory | `bun typecheck` passes for `@devops-agent/mcp-server-aws` |
| 2 | `wrap.ts` and its unit tests | Layer 1 wrap tests pass |
| 3 | First family of tools (EC2) end-to-end (4 tools), with the bootstrap | `bun run packages/mcp-server-aws/src/index.ts` returns `tools/list` |
| 4 | Remaining 10 families of tools | Layer 1 smoke + Layer 2 integration tests pass |
| 5 | Layer 4 manual probes | Verification appendix added to this spec |
| 6 | PR opened, reviewed, merged | Linear sub-issue moved to Done after explicit user approval |

Each step is committable on its own, but they land in one PR — the unit isn't releasable until step 5.

## References

- Parent spec: `docs/superpowers/specs/2026-05-15-aws-datasource-design.md`
- Phase 1 IAM verification record: same spec, Appendix A
- AWS SDK credential providers docs (`@aws-sdk/credential-providers`)
- `@aws-sdk/client-*` SDK references
- Existing patterns:
  - `packages/mcp-server-kafka/` — closest structural analog
  - `packages/mcp-server-kafka/src/tools/wrap.ts` — wrapper pattern template
  - `packages/shared/src/agentcore-proxy.ts` — SigV4 proxy (used in Phase 3, not Phase 2)
  - `packages/mcp-server-konnect/src/index.ts` — minimal-bootstrap template
- Memory:
  - `reference_aws_iam_role_and_externalid` — `DevOpsAgentReadOnly` + ExternalId facts
  - `reference_aws_iam_gotchas` — Phase 1 findings (12-statement policy, principal-must-exist, EC2 denial-message shape)
  - `reference_subagent_env_tunables` — `SUBAGENT_TOOL_RESULT_CAP_BYTES` pattern
