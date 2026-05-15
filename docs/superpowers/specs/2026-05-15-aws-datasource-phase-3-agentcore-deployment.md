# AWS Datasource Phase 3 — AgentCore Deployment

**Status:** Approved
**Parent epic:** [SIO-756](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)
**Parent design:** [2026-05-15-aws-datasource-design.md](./2026-05-15-aws-datasource-design.md) (Phase 3 outline at lines 312–317)
**Phase 1:** SIO-757 — IAM scaffolding (merged)
**Phase 2:** SIO-758 — `packages/mcp-server-aws/` native TypeScript MCP server (merged)
**Target account:** `356994971776` (test account; matches Phase 1 verification)
**Date:** 2026-05-15

## Goal

Deploy `packages/mcp-server-aws/` to AWS Bedrock AgentCore Runtime so a future `aws-agent` (Phase 4) can reach it through a local SigV4 proxy on `:3001`. **No agent integration in this phase** — the gate is end-to-end reachability of the deployed runtime via manual probes.

## Non-goals

- `aws-agent` gitagent definition and tool/skill files (Phase 4).
- Supervisor fan-out, `state.ts` and `sub-agent.ts` edits (Phase 4).
- Correlation rules involving AWS findings (Phase 5).
- Multi-account expansion to production account `352896877281` (deferred per parent design open questions).
- Dev-runner script that auto-spawns both Kafka and AWS proxies side-by-side (Phase 4 work).
- Hard-switching Kafka MCP from generic `AGENTCORE_RUNTIME_ARN` to a per-server var (kept compatible this phase).

## Inputs from prior phases

- `DevOpsAgentReadOnly` role exists in `356994971776` with the 12-statement managed policy attached.
- Trust policy on `DevOpsAgentReadOnly` names `arn:aws:iam::356994971776:role/aws-mcp-server-agentcore-role` as the only IAM-role principal that can assume it, gated by `sts:ExternalId=aws-mcp-readonly-2026`.
- Placeholder `aws-mcp-server-agentcore-role` exists in `356994971776` with a bare `bedrock-agentcore.amazonaws.com` service trust and no permissions attached.
- `packages/mcp-server-aws/` builds, typechecks, and serves the AWS tool catalogue via `bun --hot src/index.ts` in stdio/http modes. Config (`src/config/schemas.ts`) requires `AWS_REGION`, `AWS_ASSUMED_ROLE_ARN`, `AWS_EXTERNAL_ID` at startup; transport defaults are stdio with `MCP_PORT=9085`.
- `Dockerfile.agentcore` at the repo root is parameterized by `MCP_SERVER_PACKAGE` and currently lists every workspace package.json **except** `mcp-server-aws`.

## Architecture

```
local dev shell
  |
  | bun run --filter @devops-agent/mcp-server-aws dev
  |   AWS_AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:eu-central-1:356994971776:runtime/aws-mcp-server-XXXXX
  v
SigV4 Proxy (localhost:3001)
  |
  | SigV4-signed POST, service=bedrock-agentcore
  v
AgentCore Runtime (eu-central-1, account 356994971776)
  |  execution role: aws-mcp-server-agentcore-role (now with real permissions)
  |  container: ${ACCOUNT_ID}.dkr.ecr.eu-west-1.amazonaws.com/aws-mcp-agentcore:latest
  v
mcp-server-aws (AssumeRole -> DevOpsAgentReadOnly with ExternalId aws-mcp-readonly-2026)
  |
  v
AWS APIs (CloudWatch, EC2, ECS, Lambda, S3, ...)
```

Two ports differ from the Kafka pattern only by destination: Kafka uses `:3000` -> `kafka-mcp-server` runtime, AWS uses `:3001` -> `aws-mcp-server` runtime. The Phase 4 dev-runner will start both side-by-side.

## Changes

### Change 1 — `Dockerfile.agentcore`

Add one line to the deps stage (after the existing `mcp-server-konnect` line, alphabetical):

```dockerfile
COPY packages/mcp-server-aws/package.json packages/mcp-server-aws/
```

Rationale: `bun install --frozen-lockfile` walks the workspace manifests; an omitted package.json fails the lockfile check at build time. No other Dockerfile changes — the runtime stage already copies `packages/${MCP_SERVER_PACKAGE}/` generically.

### Change 2 — `scripts/agentcore/deploy.sh`

Three bounded additions, all inside existing `case` switches. No new functions, no refactoring.

**2a. Header comment block.** Add to the "Environment variables" section near the top:

```bash
# AWS-specific:
#   AWS_ASSUMED_ROLE_ARN    - DevOpsAgentReadOnly role to assume in the runtime
#                             (default: arn:aws:iam::${ACCOUNT_ID}:role/DevOpsAgentReadOnly)
#   AWS_EXTERNAL_ID         - STS ExternalId required by the assumed role's trust policy
#                             (default: aws-mcp-readonly-2026)
```

**2b. Print-config case** (around line 127):

```bash
aws)      echo "  AWS:          role=${AWS_ASSUMED_ROLE_ARN:-DevOpsAgentReadOnly (default)}, externalId=set" ;;
```

**2c. IAM policy switch** (after the kafka block ending around line 267, before `POLICY_DOCUMENT='{...}'`):

```bash
# Add STS AssumeRole permission for the DevOpsAgentReadOnly role.
# The container assumes this role at startup; without this grant the
# AssumeRole call returns AccessDenied even though the trust policy allows it.
if [ "${MCP_SERVER}" = "aws" ]; then
  ASSUMED_ROLE_ARN="${AWS_ASSUMED_ROLE_ARN:-arn:aws:iam::${ACCOUNT_ID}:role/DevOpsAgentReadOnly}"
  POLICY_STATEMENTS="${POLICY_STATEMENTS}"',
    {
      "Sid": "AssumeDevOpsAgentReadOnly",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "'"${ASSUMED_ROLE_ARN}"'"
    }'
fi
```

**2d. Env-vars case** (in the `case "${MCP_SERVER}"` block near line 301):

```bash
  aws)
    ASSUMED_ROLE_ARN="${AWS_ASSUMED_ROLE_ARN:-arn:aws:iam::${ACCOUNT_ID}:role/DevOpsAgentReadOnly}"
    EXTERNAL_ID="${AWS_EXTERNAL_ID:-aws-mcp-readonly-2026}"
    ENV_VARS="${ENV_VARS},AWS_ASSUMED_ROLE_ARN=${ASSUMED_ROLE_ARN}"
    ENV_VARS="${ENV_VARS},AWS_EXTERNAL_ID=${EXTERNAL_ID}"
    ;;
```

`AWS_REGION` is already added unconditionally at the top of the env-vars block; no change needed there.

### Change 3 — `packages/mcp-server-aws/src/index.ts`

Add the same proxy-mode branch Kafka uses, reading the AWS-scoped env var with fallback to the generic one:

```typescript
if (import.meta.main) {
  const runtimeArn = process.env.AWS_AGENTCORE_RUNTIME_ARN ?? process.env.AGENTCORE_RUNTIME_ARN;

  if (runtimeArn) {
    // Proxy-only mode: forward to the deployed AgentCore runtime over SigV4.
    process.env.AGENTCORE_RUNTIME_ARN = runtimeArn;
    process.env.AGENTCORE_PROXY_PORT = process.env.AGENTCORE_PROXY_PORT ?? "3001";

    const { startAgentCoreProxy } = await import("@devops-agent/shared");
    logger.info({ arn: runtimeArn, transport: "agentcore-proxy" }, "Starting AWS MCP Server");
    const proxy = await startAgentCoreProxy();
    logger.info({ port: proxy.port, url: proxy.url }, "AWS MCP Server ready");

    let isShuttingDown = false;
    const shutdown = async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.info("Shutting down aws-mcp-server...");
      await proxy.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    // Local mode: existing createMcpApplication() block unchanged.
    createMcpApplication<AwsDatasource>({ /* ... unchanged ... */ });
  }
}
```

Kafka's index.ts is **not** modified in this phase — its existing read of `AGENTCORE_RUNTIME_ARN` continues to work. The fallback chain in AWS (new var first, generic second) honours the "no breaking change for existing setups" promise from brainstorming.

### Change 4 — Manual probe runbook (spec only, no script)

After `MCP_SERVER=aws ./scripts/agentcore/deploy.sh` returns success and writes `.agentcore-deployment.json`:

```bash
# Read the runtime ARN
RUNTIME_ARN=$(jq -r .runtimeArn .agentcore-deployment.json)

# Start the local proxy on :3001
AWS_AGENTCORE_RUNTIME_ARN="${RUNTIME_ARN}" \
  bun run --filter @devops-agent/mcp-server-aws dev &

# Wait for proxy to bind
until curl -sf http://localhost:3001/healthz >/dev/null 2>&1; do sleep 1; done

# Probe 1 — tools/list
curl -s -X POST http://localhost:3001/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | jq '.result.tools | length'
# Pass: >= 1 (the AWS tool catalogue is registered)

# Probe 2 — sts:GetCallerIdentity (confirms AssumeRole chain works)
curl -s -X POST http://localhost:3001/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"call_aws","arguments":{"cli_command":"aws sts get-caller-identity"}}}' \
  | jq '.result.content[0].text' | grep -o 'DevOpsAgentReadOnly'
# Pass: outputs "DevOpsAgentReadOnly"

# Probe 3 — CloudWatch Logs reachability
curl -s -X POST http://localhost:3001/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"call_aws","arguments":{"cli_command":"aws logs describe-log-groups --max-items 1"}}}' \
  | jq '.result.content[0].text' | grep -q 'logGroups'
# Pass: response body contains "logGroups" (may be an empty array; the IAM grant works)
```

The actual tool name (`call_aws` vs. another) is taken from the registered tool catalogue in `packages/mcp-server-aws/src/tools/`. If the tool name differs, the probe commands are adjusted accordingly during execution — the **probe semantics** (tools/list, sts:GetCallerIdentity, logs:DescribeLogGroups) are the gate.

## Gate

Phase 3 is complete when:

1. `MCP_SERVER=aws ./scripts/agentcore/deploy.sh` runs end-to-end and reaches `Status: ACTIVE`.
2. `.agentcore-deployment.json` contains a valid `runtimeArn`.
3. All three manual probes above return their expected output.
4. Probe 2's response contains `arn:aws:sts::356994971776:assumed-role/DevOpsAgentReadOnly/<session>` — proving the cross-role AssumeRole chain landed (placeholder execution role -> DevOpsAgentReadOnly with ExternalId).

## Error modes and recovery

| Failure | Symptom | Recovery |
|---|---|---|
| `Dockerfile.agentcore` missing the new `package.json` COPY line | `docker build` fails at `bun install --frozen-lockfile` with "lockfile out of date" | Confirm Change 1 is applied; rerun the build |
| Trust-policy lockout (DevOpsAgentReadOnly trust not pointing at `aws-mcp-server-agentcore-role`) | Probe 2 returns `AccessDenied: User ... is not authorized to perform: sts:AssumeRole` | Re-run `scripts/agentcore/setup-aws-readonly-role.sh` to re-apply trust; verify with `aws iam get-role --role-name DevOpsAgentReadOnly` |
| Placeholder execution role missing the `sts:AssumeRole` grant | Probe 2 returns AccessDenied; deploy.sh's IAM step succeeded but the policy version didn't attach | Verify `aws iam list-attached-role-policies --role-name aws-mcp-server-agentcore-role` includes the new managed policy; re-run deploy.sh |
| ExternalId mismatch | Probe 2 returns `AccessDenied` mentioning the trust policy condition | Confirm `AWS_EXTERNAL_ID` env-var on the runtime matches what `DevOpsAgentReadOnly`'s trust expects (`aws-mcp-readonly-2026`) |
| Port `:3001` already bound | Proxy startup fails with `EADDRINUSE` | `lsof -i :3001` to identify holder; kill and restart, or set `AGENTCORE_PROXY_PORT=3002` and re-probe |
| Runtime stuck in `CREATING` past 30 attempts | deploy.sh loop times out, no `RUNTIME_ARN` printed | Inspect with `aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id <id>`; check CloudWatch Logs under `/aws/bedrock-agentcore/runtimes/*` for container startup errors |

## Reversibility

Phase 3 is independently revertable:

- Delete the AgentCore runtime: `aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id <id>`.
- Detach the AWS-specific managed policy from `aws-mcp-server-agentcore-role` and delete it: leaves the placeholder role intact for a future redeploy.
- Revert the three source-file changes via `git revert`.
- `DevOpsAgentReadOnly` and its trust policy are unaffected — Phase 1 state is preserved.

After revert, Phase 1 + Phase 2 state is fully restored: package builds, IAM exists, nothing live in AgentCore.

## Testing

No automated tests added in this phase. Verification is the manual probe runbook above, executed once after deploy. Rationale:

- The existing `packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts` already covers SigV4 proxy mechanics generically; no AWS-specific path is added to that surface.
- `packages/mcp-server-aws/__tests__/` already covers tool wiring and config validation from Phase 2.
- The only new code paths are (a) a one-line Dockerfile addition, (b) three small case-arms in a bash script, and (c) a 20-line proxy-mode branch mirroring Kafka. None of these benefit from new unit tests beyond what already exists.

The Phase 2 test suite must continue to pass after Change 3 lands.

## Open questions

None. Items deferred to later phases per parent design:

- Auto-spawning the AWS proxy from a dev-runner script (Phase 4).
- Hard-switching Kafka MCP to `KAFKA_AGENTCORE_RUNTIME_ARN` (Phase 4 cleanup or later).
- Multi-account expansion to `352896877281` (post-launch follow-up).
- Cold-start warming (parent design open question).

## References

- Parent design: `docs/superpowers/specs/2026-05-15-aws-datasource-design.md` (Phase 3 outline at lines 312–317; Appendix A: Phase 1 verification record at line 370+).
- Phase 1: `docs/superpowers/specs/2026-05-15-aws-datasource-phase-1-iam-scaffolding.md`, `docs/superpowers/plans/2026-05-15-aws-datasource-phase-1-iam-scaffolding.md`.
- Phase 2: `docs/superpowers/specs/2026-05-15-aws-mcp-server-package-design.md`, `docs/superpowers/plans/2026-05-15-aws-datasource-phase-2-mcp-server-package.md`.
- `scripts/agentcore/deploy.sh` — the file extended in Change 2.
- `scripts/agentcore/setup-aws-readonly-role.sh` — the Phase 1 script that owns DevOpsAgentReadOnly trust.
- `scripts/agentcore/policies/devops-agent-readonly-trust-policy.json` — the trust document naming `aws-mcp-server-agentcore-role`.
- `packages/shared/src/agentcore-proxy.ts` — the SigV4 proxy reused for the second runtime.
- `packages/mcp-server-kafka/src/index.ts:76-110` — the Kafka proxy-mode branch mirrored by Change 3.
- Memory notes referenced during brainstorming: `reference_aws_iam_role_and_externalid`, `reference_aws_iam_gotchas`, `project_deployment_target_agentcore`, `feedback_probe_agentcore_via_sigv4_proxy`.

---

## Appendix A: Phase 3 Verification Record

**Date verified:** 2026-05-15
**Verified by:** Simon Owusu (test account `356994971776`)
**Linear issue:** SIO-759 (sub-issue of SIO-756)

### What was deployed

- ECR image: `356994971776.dkr.ecr.eu-central-1.amazonaws.com/aws-mcp-agentcore:latest` (sha `c6a3d02c...`)
- AgentCore runtime: `aws_mcp_server-57wIOB35U1` (ARN: `arn:aws:bedrock-agentcore:eu-central-1:356994971776:runtime/aws_mcp_server-57wIOB35U1`), version 2, status READY
- Execution role: `aws-mcp-server-agentcore-role` (ARN: `arn:aws:iam::356994971776:role/aws-mcp-server-agentcore-role`) with managed policy `aws-mcp-server-agentcore-role-policy` v4 (CloudWatchLogs + ECRPull + AssumeDevOpsAgentReadOnly)
- Container env: `AWS_REGION=eu-central-1`, `AWS_ASSUMED_ROLE_ARN=arn:aws:iam::356994971776:role/DevOpsAgentReadOnly`, `AWS_EXTERNAL_ID=aws-mcp-readonly-2026`

### Probe results

| Probe | Tool | Result |
|---|---|---|
| 1 | `tools/list` | PASS — 39 tools returned across 17 service families (cloudformation, cloudwatch, config, dynamodb, ec2, ecs, elasticache, health, lambda, logs, sns, sqs, eventbridge, stepfunctions, rds, s3, resourcegroupstagging, xray) |
| 2 | `aws_s3_list_buckets` (substituted for `sts:GetCallerIdentity` — no `call_aws` tool in the catalogue) | PASS — HTTP 200, 2 buckets returned, requestId `BWG8MD13C9TAWCXX`. AssumeRole chain works because S3 ListAllMyBuckets is granted via `DevOpsAgentReadOnly`. Container log line at startup confirms `assumedRole: arn:aws:iam::356994971776:role/DevOpsAgentReadOnly` |
| 3 | `aws_logs_describe_log_groups` (limit 3) | PASS — HTTP 200, 3 log groups returned including `/aws/bedrock-agentcore/runtimes/aws_mcp_server-57wIOB35U1-DEFAULT`. Confirms the AssumeRole grant + LogsListUnscoped policy statement both work |

### Pre-existing bugs surfaced and fixed during Phase 3

Six pre-existing bugs were uncovered and fixed inline so the Phase 3 gate could complete. All are unrelated to Phase 3's scope but blocked it:

1. `tools/logs/` directory missing (Phase 2 escape) — added 3 CloudWatch Logs tools mirroring the `cloudwatch/` family pattern.
2. `${MCP_SERVER^}` bash 4+ expansion in `deploy.sh` line 126 — replaced with bash 3.2-portable `printf | tr`.
3. `RUNTIME_NAME=${MCP_SERVER}-mcp-server` violated AgentCore's regex `[a-zA-Z][a-zA-Z0-9_]{0,47}` — changed default to underscores `${MCP_SERVER}_mcp_server` and decoupled `ROLE_NAME` to keep the Phase 1 placeholder reusable.
4. `deploy.sh` defaulted to `AWS_REGION=eu-west-1` while every other AgentCore tool defaulted to `eu-central-1` — aligned the default.
5. `deploy.sh` polling loop checked for status `ACTIVE`, but AgentCore reports `READY` — accepts both now.
6. `EXISTING_RUNTIME` lookup used jmespath key `agentRuntimeSummaries` instead of `agentRuntimes` — re-deploys always fell through to `create-agent-runtime` and failed with `ConflictException`.
7. AWS config schema only read `TRANSPORT_PORT`/`TRANSPORT_HOST`, ignoring the `MCP_PORT`/`MCP_HOST` env vars set by `Dockerfile.agentcore` — container listened on 9085, AgentCore expected 8000. Added the same fallback pattern already used for `TRANSPORT_MODE` (`MCP_TRANSPORT ?? TRANSPORT_MODE`).

### Gate

Phase 3 is complete. The runtime is reachable end-to-end via the local SigV4 proxy on :3001; the AssumeRole chain works; CloudWatch Logs is reachable from inside the container. Phase 4 (`aws-agent` gitagent + supervisor wiring) can begin against this runtime.
