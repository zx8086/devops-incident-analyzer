# AWS MCP — Multi-Estate Support (one runtime, N target accounts)

**Date:** 2026-05-27
**Status:** Design — pending Linear ticket
**Author:** brainstorming session with Simon
**Related code:** `packages/mcp-server-aws/`, `packages/agent/src/`, `scripts/agentcore/deploy.sh`

## Problem

The AWS MCP runtime today supports exactly one assumed-role ARN (`AWS_ASSUMED_ROLE_ARN`) baked into its env at deploy time. Switching target estates (dev / staging / prod) requires redeploying the runtime or running parallel runtimes — expensive in IAM hygiene, ECR storage, CloudWatch log groups, and cold-start cost. Users need to ask "show me prod CloudWatch alarms" and "compare staging RDS" in the same conversation without infrastructure churn.

## Goals

- Single `aws_mcp_server` AgentCore runtime per AWS account, hosting N estates simultaneously.
- Estate is chosen by a routing node in the agent pipeline, not by the LLM at tool-call time.
- Ambiguous user prompts fan out to all configured estates.
- Misconfigured estates fail loudly at deploy/boot, not at first user request.
- Onboarding a new estate is a one-line env change + one redeploy + one trust-policy update.

## Non-goals

- Per-estate feature flags or tool surface differences.
- Cross-estate query orchestration inside a single tool call.
- Estate aliases (e.g. `production` → `prod`).
- UI changes in `apps/web` for estate picking.
- Backward-compatibility shim for `AWS_ASSUMED_ROLE_ARN` / `AWS_EXTERNAL_ID`.

## Architecture

```
.env / AgentCore env
    AWS_ESTATES (JSON map)
        |
        v
mcp-server-aws (single runtime)
    ConfigSchema -> { estates: Record<id, {assumedRoleArn, externalId}> }
        |
        v
    estate-validator (boot)  -- fails closed if any estate's sts:AssumeRole fails
        |
        v
    MCP server ready
        ^
        |  every tool: required `estate` enum arg, injected by supervisor
        |
packages/agent
    awsEstateRouter node (new) -> awsTargetEstates: string[]
        |
        v
    supervisor fan-out: one Send per estate, extraToolArgs.estate = <id>
        |
        v
    align / aggregate / findings keyed by aws:<estate>
```

One runtime, N estates in memory, fan-out at the agent layer. Tools are estate-aware via a required `estate` arg that the supervisor pre-fills from `awsTargetEstates`.

---

## Section 1 — Configuration Schema

Single JSON env var replaces today's two singletons:

```bash
AWS_ESTATES='{
  "dev":     { "assumedRoleArn": "arn:aws:iam::111111111111:role/DevOpsAgentReadOnly", "externalId": "devops-agent-dev-access" },
  "staging": { "assumedRoleArn": "arn:aws:iam::222222222222:role/DevOpsAgentReadOnly", "externalId": "devops-agent-staging-access" },
  "prod":    { "assumedRoleArn": "arn:aws:iam::333333333333:role/DevOpsAgentReadOnly", "externalId": "devops-agent-prod-access" }
}'
AWS_REGION=eu-central-1
```

JSON is preferred over N prefixed scalars because:

- AgentCore's `--environment-variables` flag takes `KEY=VAL,KEY=VAL`; one quoted JSON is one arg, not six.
- Adding/removing an estate is one atomic edit, no orphaned siblings.
- Schema-validated as a typed object, no custom prefix-discovery code.

### Zod schema (in `packages/mcp-server-aws/src/config/schemas.ts`)

```ts
const roleArnRegex = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/;
const estateIdRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const EstateSchema = z.object({
  assumedRoleArn: z.string().regex(roleArnRegex).describe("Target role in the estate's account"),
  externalId: z.string().min(1).describe("STS ExternalId required by the role's trust policy"),
});

// In ConfigSchema preprocess: AWS_ESTATES: env.AWS_ESTATES (raw string)
// In the Zod object:
AWS_ESTATES: z.string()
  .min(1, "AWS_ESTATES is required")
  .transform((raw, ctx) => {
    try { return JSON.parse(raw); }
    catch (e) {
      ctx.addIssue({ code: "custom", message: `AWS_ESTATES must be valid JSON: ${(e as Error).message}` });
      return z.NEVER;
    }
  })
  .pipe(z.record(z.string().regex(estateIdRegex), EstateSchema))
  .refine((map) => Object.keys(map).length >= 1, "At least one estate required"),
```

Output shape:

```ts
aws: {
  region: string,
  estates: Record<string, { assumedRoleArn: string; externalId: string }>,
}
```

Legacy `AWS_ASSUMED_ROLE_ARN` / `AWS_EXTERNAL_ID` are removed entirely. No backward-compat shim — the runtime is internal and the deploy script is the only consumer.

---

## Section 2 — Credential Provider + Client Factory

### `credentials.ts` — new signature

```ts
export function buildAssumedCredsProvider(
  estate: { assumedRoleArn: string; externalId: string },
  region: string,
): ReturnType<typeof fromTemporaryCredentials> {
  return fromTemporaryCredentials({
    params: {
      RoleArn: estate.assumedRoleArn,
      ExternalId: estate.externalId,
      RoleSessionName: "aws-mcp-server",
      DurationSeconds: 3600,
    },
    clientConfig: { region },
  });
}
```

Stateless; SDK handles credential caching/refresh inside the returned provider.

### `client-factory.ts` — cache by `${service}:${estate}`

```ts
const clients = new Map<string, AwsClient>();

export function getClient<S extends ServiceName>(
  config: AwsConfig,
  service: S,
  estate: string,
): ServiceClient<S> {
  const cacheKey = `${service}:${estate}`;
  const cached = clients.get(cacheKey);
  if (cached) return cached as ServiceClient<S>;

  const estateConfig = config.estates[estate];
  if (!estateConfig) {
    throw new Error(`Unknown estate "${estate}". Known: ${Object.keys(config.estates).join(", ")}`);
  }

  const client = new ServiceClientCtor[service]({
    region: config.region,
    credentials: buildAssumedCredsProvider(estateConfig, config.region),
  });
  clients.set(cacheKey, client);
  return client as ServiceClient<S>;
}
```

`estate` passed as string (not resolved object) so `getClient` is the single chokepoint that fails on unknown estates with one consistent error.

Cache lifetime unchanged (process lifetime). Worst case ~5 estates × 18 services = 90 cached clients — AWS SDK clients are lightweight.

---

## Section 3 — Tool Wrapper Surface

All 39 tool files in `packages/mcp-server-aws/src/tools/**/*.ts` get the same mechanical edit. Shipped as one PR (review fatigue is lower than the coordination cost of phasing).

### Per-tool pattern (illustrated with `describe-alarms.ts`)

```ts
// BEFORE
export const describeAlarmsSchema = z.object({
  AlarmNames: z.array(z.string()).optional().describe("..."),
});
export function describeAlarms(config: AwsConfig) {
  return wrapListTool({
    name: "aws_cloudwatch_describe_alarms",
    listField: "MetricAlarms",
    fn: async (params: DescribeAlarmsParams) => {
      const client = getCloudWatchClient(config);
      return client.send(new DescribeAlarmsCommand({ /* ... */ }));
    },
  });
}

// AFTER
import { estateSchemaFor } from "../estate-schema.ts";
export const describeAlarmsSchema = (config: AwsConfig) => z.object({
  estate: estateSchemaFor(config),
  AlarmNames: z.array(z.string()).optional().describe("..."),
});
export function describeAlarms(config: AwsConfig) {
  return wrapListTool({
    name: "aws_cloudwatch_describe_alarms",
    listField: "MetricAlarms",
    fn: async (params: DescribeAlarmsParams) => {
      const client = getCloudWatchClient(config, params.estate);
      return client.send(new DescribeAlarmsCommand({ /* ... */ }));
    },
  });
}
```

### Helpers

**`src/tools/estate-schema.ts` (new file):**

```ts
export function estateSchemaFor(config: AwsConfig) {
  const estateIds = Object.keys(config.estates) as [string, ...string[]];
  return z.enum(estateIds).describe(
    `AWS estate to query. One of: ${estateIds.join(", ")}. ` +
    `Pick based on which environment the user is asking about.`
  );
}
```

Builds Zod enum dynamically from loaded config so invalid estate IDs fail at Zod validation.

**`getXxxClient(config, estate)` helpers** — every service-specific getter grows a second arg that flows to `getClient(config, service, estate)`.

### Why `estate` is required, not optional

There is no default estate. The router (Section 4) always pins one. Optional would invite silent fallback bugs.

### Tool error mapping

`wrap.ts` unchanged. Existing `iam-permission-missing` / `assume-role-denied` classification still applies. Structured log lines gain an `estate` field.

### New tool: `aws_list_estates`

Zero-arg tool returning `{ estates: string[] }`. Used by:

- The smoke-test script for round-trip "are my estates wired right" checks.
- The LLM in the sub-agent if it ever needs to introspect available estates (rare; usually unnecessary because the router pre-pins).

---

## Section 4 — `awsEstateRouter` Node + Fan-out Wiring

### Position in pipeline

```
... -> entityExtractor -> awsEstateRouter -> [fan-out: elastic, kafka, capella, konnect, gitlab, aws] -> align -> ...
```

Runs after `entityExtractor`, before fan-out. Leaf node — no Sends, only a state update. Skipped if `aws` is not in `selectedDataSources`.

### Implementation (`packages/agent/src/aws-estate-router.ts`, new file)

```ts
export const awsEstateRouter = async (
  state: AgentState,
  config: RunnableConfig,
): Promise<Partial<AgentState>> => {
  if (!state.selectedDataSources.includes("aws")) {
    return { awsTargetEstates: [] };
  }

  const allEstates = readAwsEstatesFromAgentConfig();
  if (allEstates.length === 0) {
    throw new Error("AWS in selectedDataSources but no estates configured");
  }

  const decision = await classifyEstates({
    prompt: state.normalizedPrompt,
    entities: state.extractedEntities,
    available: allEstates,
  });

  const targets = decision.kind === "ambiguous" ? allEstates : decision.estates;

  logger.info({ awsTargetEstates: targets, decision }, "awsEstateRouter resolved");
  return { awsTargetEstates: targets };
};
```

### State annotation (`packages/agent/src/state.ts`)

```ts
awsTargetEstates: Annotation<string[]>({
  reducer: (_, next) => next,
  default: () => [],
}),
```

### Classifier

Small structured-output Bedrock call returning either `{ kind: "explicit", estates: ["prod"] }` or `{ kind: "ambiguous" }`. Examples in the prompt:

- "production CloudWatch alarms" → `{ kind: "explicit", estates: ["prod"] }`
- "RDS metrics" → `{ kind: "ambiguous" }`
- "compare staging and prod" → `{ kind: "explicit", estates: ["staging", "prod"] }`

Prompt includes "be conservative — only return ambiguous when truly unclear" to keep fan-out cost in check.

### Supervisor fan-out change

Replace the single AWS Send with N Sends, one per estate:

```ts
for (const estate of state.awsTargetEstates) {
  sends.push(new Send("queryDataSource", {
    currentDataSource: "aws",
    estateContext: estate,
  }));
}
```

The sub-agent's tool-binding layer reads `estateContext` from invocation state and pre-fills the `estate` argument on every AWS tool. The sub-agent's LLM never sees the `estate` field — it's authoritative from the router.

### Aggregation

`align` and `aggregate` key by `aws:<estate>` instead of `aws`. The findings extractor (SIO-764) treats each estate's results as independent `DataSourceResult` entries, so per-estate findings flow through the rule engine untouched.

### Cost cap

Env knob `AWS_MAX_FANOUT_ESTATES` (default unlimited) lets ops cap blast radius if over-fan-out becomes a problem. The classifier prompt's conservative-by-default instruction is the primary mitigation; this is a backstop.

---

## Section 5 — Deployment Script (`scripts/agentcore/deploy.sh`)

`deploy.sh` reads `AWS_ESTATES` JSON and patches the runtime execution role's inline policy to allow `sts:AssumeRole` on every estate's target ARN. The leaf-role trust policy (in the target account) is documented in a printed reminder but not automated — the script only has credentials for the runtime's account.

### Key changes (around current lines 286-330 and 425-461)

```bash
if [ "${SERVER}" = "aws" ]; then
  if [ -z "${AWS_ESTATES:-}" ]; then
    echo "ERROR: AWS_ESTATES is required for aws server type" >&2
    exit 1
  fi

  ESTATE_ARNS=$(echo "${AWS_ESTATES}" | jq -er '[.[].assumedRoleArn] | unique | .[]' 2>/dev/null) || {
    echo "ERROR: AWS_ESTATES is not valid JSON or missing assumedRoleArn fields" >&2
    exit 1
  }
  RESOURCE_LIST=$(echo "${ESTATE_ARNS}" | jq -R . | jq -sc .)

  ASSUME_ROLE_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": ${RESOURCE_LIST}
    }
  ]
}
EOF
)

  aws iam put-role-policy \
    --role-name "${EXECUTION_ROLE_NAME}" \
    --policy-name "AgentCoreAssumeEstateRoles" \
    --policy-document "${ASSUME_ROLE_POLICY}" \
    --region "${AWS_REGION}"

  echo "  IAM updated: execution role can assume $(echo "${ESTATE_ARNS}" | wc -l | tr -d ' ') estate role(s)"
fi

# In ENV_VARS construction (around line 428-429), replace the two-line
# ASSUMED_ROLE_ARN_RESOLVED / EXTERNAL_ID_RESOLVED block with:
ENV_VARS="${ENV_VARS},AWS_ESTATES=${AWS_ESTATES}"
```

### Details

- **`jq` is a hard prerequisite.** Documented in `scripts/agentcore/README.md`; fail with clear message if missing.
- **Inline policy, not managed.** Lifecycles with the role; can't drift.
- **Single statement with N resources.** Stays under IAM's 10KB inline-policy limit.
- **Quoting** verified by a new shell test `scripts/agentcore/test-env-construction.sh`.
- **Trust-policy reminder** printed on success:

```
Reminder: each estate's DevOpsAgentReadOnly trust policy must include:
  Principal: arn:aws:iam::<runtime-account>:role/<EXECUTION_ROLE_NAME>
Estates configured:
  - prod (arn:aws:iam::333333333333:role/DevOpsAgentReadOnly)
  - dev  (arn:aws:iam::111111111111:role/DevOpsAgentReadOnly)
```

---

## Section 6 — Boot-time Estate Validation

The runtime calls `sts:AssumeRole` (via `STSClient.GetCallerIdentity` through each estate's credential provider) for every configured estate during boot. Any failure → process exits with non-zero code and a structured error log line naming the failed estate(s).

### New file `packages/mcp-server-aws/src/services/estate-validator.ts`

```ts
export interface EstateValidationResult {
  estate: string;
  ok: boolean;
  assumedArn?: string;
  error?: string;
  durationMs: number;
}

export async function validateEstates(config: AwsConfig): Promise<EstateValidationResult[]> {
  const entries = Object.entries(config.estates);
  return Promise.all(
    entries.map(async ([estate, estateConfig]) => {
      const started = Date.now();
      try {
        const provider = buildAssumedCredsProvider(estateConfig, config.region);
        const sts = new STSClient({ region: config.region, credentials: provider });
        const res = await sts.send(new GetCallerIdentityCommand({}));
        return { estate, ok: true, assumedArn: res.Arn, durationMs: Date.now() - started };
      } catch (err) {
        return {
          estate,
          ok: false,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          durationMs: Date.now() - started,
        };
      }
    }),
  );
}
```

### Bootstrap wiring (`packages/mcp-server-aws/src/index.ts`)

```ts
const results = await validateEstates(config.aws);
const failed = results.filter((r) => !r.ok);

for (const r of results) {
  if (r.ok) {
    logger.info({ estate: r.estate, assumedArn: r.assumedArn, durationMs: r.durationMs },
      "Estate validation OK");
  } else {
    logger.error({ estate: r.estate, error: r.error, durationMs: r.durationMs },
      "Estate validation FAILED");
  }
}

if (failed.length > 0) {
  const summary = failed.map((r) => `  - ${r.estate}: ${r.error}`).join("\n");
  throw new Error(
    `Refusing to start: ${failed.length}/${results.length} estate(s) failed STS:AssumeRole check.\n${summary}\n` +
    `Check that each estate's DevOpsAgentReadOnly trust policy lists the runtime's execution role as a Principal.`
  );
}
```

### Cost

300-600ms for 3 estates in parallel (`Promise.all`, scales as O(slowest) not O(sum)). Acceptable inside AgentCore cold-start.

### Why fail-closed

Partial success (prod-OK, dev-FAILED) would make the fan-out router silently skip dev estates with errors that look like "no results". Hard stop at boot is loud, recoverable, and matches the deploy script's posture.

### Test coverage

- All-OK case via `aws-sdk-client-mock`
- Mixed-success case
- Empty-estates case (guarded though unreachable due to Zod minimum-1)
- Bootstrap integration test asserting `process.exit(1)` on any failure

### Escape hatch

`SKIP_ESTATE_VALIDATION=true` honored ONLY when `MCP_TRANSPORT !== "agentcore"`. Logged at WARN when active.

---

## Section 7 — Migration, Local Dev, Backout

### `.env` migration (one-time edit)

Replace lines 71-72 of today's `.env`:

```diff
- AWS_ASSUMED_ROLE_ARN=arn:aws:iam::762715229080:role/DevOpsAgentReadOnly
- AWS_EXTERNAL_ID=devops-agent-prod-access
+ AWS_ESTATES='{"prod":{"assumedRoleArn":"arn:aws:iam::762715229080:role/DevOpsAgentReadOnly","externalId":"devops-agent-prod-access"}}'
```

The SigV4 proxy block (lines 64-68) is untouched — multi-estate is entirely runtime-side.

### Local dev

- `bun --env-file=.env packages/mcp-server-aws/src/index.ts` works as today; validator runs first.
- `.env.example` updated with single-estate `AWS_ESTATES` plus inline multi-estate comment.
- Smoke-test script gains an `aws_list_estates` round-trip step between initialize and tools/call.

### Backout

Single PR, 8 commits (one per design section). Backout = `git revert -m 1 <merge-sha>` + redeploy (~5 min). The inline `AgentCoreAssumeEstateRoles` policy is overwritten on every deploy; rollback redeploys the singleton-shape policy automatically. `.env` reverts to the old two-line pair documented in this spec.

---

## Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Leaf-role trust policy missing the runtime execution role principal | High at first deploy of each new estate | Boot-time validator (Section 6); deploy-script reminder (Section 5) |
| AgentCore `--environment-variables` mangling JSON quoting | Medium | `scripts/agentcore/test-env-construction.sh`; verify first deploy via `aws bedrock-agentcore-control get-agent-runtime` |
| LLM router picks wrong estate → over-fan-out | Medium | "Be conservative" prompt; per-decision logging; `AWS_MAX_FANOUT_ESTATES` cap |
| Per-tool `estate` arg confuses sub-agent LLM | Low | Supervisor injects via `extraToolArgs`; sub-agent LLM never sees the field |
| 39-file PR too large to review | Medium | Mechanical-edit nature; PR description highlights pattern; reviewer spot-checks 3 files |

---

## Out of Scope (explicit)

- Per-estate feature flags or tool surface differences
- Per-estate IAM policy customization
- Cross-estate query orchestration in a single tool call
- Estate aliases
- UI changes to `apps/web` for estate picking
- Backward-compatibility shim for `AWS_ASSUMED_ROLE_ARN` / `AWS_EXTERNAL_ID`

---

## Acceptance Criteria

1. `AWS_ESTATES` JSON env var validated by Zod; legacy `AWS_ASSUMED_ROLE_ARN` / `AWS_EXTERNAL_ID` removed entirely.
2. `client-factory.ts` caches by `${service}:${estate}`; unknown estate → single chokepoint error.
3. All 39 AWS tool files accept required `estate` enum arg; helper `estateSchemaFor(config)` builds enum dynamically.
4. `awsEstateRouter` node in `packages/agent` populates `awsTargetEstates`; fan-out emits one Send per estate with `estateContext`.
5. `align` / `aggregate` / findings extractor key by `aws:<estate>`.
6. `deploy.sh` auto-patches inline IAM policy `AgentCoreAssumeEstateRoles` from `AWS_ESTATES`; prints trust-policy reminder.
7. Runtime boot calls `STSClient.GetCallerIdentity` per estate in parallel; refuses to start on any failure.
8. `aws_list_estates` MCP tool returns configured estate IDs.
9. `.env.example` updated; migration documented in PR description.
10. `bun run typecheck && bun run lint && bun run test` pass.

---

## Memory references

- `reference_c72_msk_service_mapping` — team already thinks in dev/prd estate pairs
- `reference_first_deploy_to_fresh_account_bugs` — multi-account deploy gotchas surfaced previously
- `reference_aws_iam_role_and_externalid` — current single-role setup that this design supersedes
- `reference_aws_iam_gotchas` — IAM policy quirks (Logs Describe* limits, EC2 UnauthorizedOperation)
- `reference_agentcore_logs_via_otel` — runtime logs live in OTEL/LangSmith, not CloudWatch
- `reference_agentcore_sse_response_shape` — proxy response shape (affects smoke-test parsing)
