# AWS MCP — Multi-Estate Support (one runtime, N target accounts)

**Date:** 2026-05-27 (revised 2026-05-27 for boot-validator + role-creation corrections)
**Status:** Design — pending Linear ticket SIO-828
**Author:** brainstorming session with Simon
**Related code:** `packages/mcp-server-aws/`, `packages/agent/src/`, `scripts/agentcore/deploy.sh`

## Problem

The AWS MCP runtime today supports exactly one assumed-role ARN (`AWS_ASSUMED_ROLE_ARN`) baked into its env at deploy time. Switching target estates (dev / staging / prod) requires redeploying the runtime or running parallel runtimes — expensive in IAM hygiene, ECR storage, CloudWatch log groups, and cold-start cost. Users need to ask "show me prod CloudWatch alarms in eu-oit-prd" and "compare RDS metrics across eu-b2b-ecom-prd and eu-b2becom-v2-prd" in the same conversation without infrastructure churn.

## Goals

- Single `aws_mcp_server` AgentCore runtime per AWS account, hosting N estates simultaneously.
- Estate is chosen by a routing node in the agent pipeline, not by the LLM at tool-call time.
- Ambiguous user prompts fan out to all configured estates.
- Misconfigured estates are **visible** at boot via structured warnings and an `aws_list_estates` health field — but the runtime always starts (4-pillar pattern).
- Onboarding a new estate is a one-line env change + one redeploy + one trust-policy update.

## Non-goals

- Per-estate feature flags or tool surface differences.
- Cross-estate query orchestration inside a single tool call.
- Estate aliases (e.g. `production` → `prod`).
- UI changes in `apps/web` for estate picking.
- Backward-compatibility shim for `AWS_ASSUMED_ROLE_ARN` / `AWS_EXTERNAL_ID`.
- IAM role creation by `deploy.sh` (execution role is an account-setup prerequisite; deploy.sh consumes its ARN via env).

## Account Architecture

| Role | Account ID | Account Name |
|---|---|---|
| AgentCore runtime host (execution role lives here) | `399987695868` | `eu-shared-services-prd` |
| Monitored estate `eu-oit-prd` | `762715229080` | `eu-oit-prd` |
| Monitored estate `eu-ediservices-prd` | `523422062084` | `eu-ediservices-prd` |
| Monitored estate `eu-mendix-platform-prd` | `654654584630` | `eu-mendix-platform-prd` |
| Monitored estate `eu-b2becom-v2-prd` | `178531813197` | `eu-b2becom-v2-prd` |
| Monitored estate `eu-b2b-ecom-prd` | `105329690220` | `eu-b2b-ecom-prd` |
| Monitored estate `eu-b2bonboarding-prd` | `728412486223` | `eu-b2bonboarding-prd` |

The AgentCore execution role `DevOpsAgentCoreRole` in `eu-shared-services-prd` is created **once, manually**, as part of account setup. It is the trusted principal in all six monitored accounts' `DevOpsAgentReadOnly` trust policies. Its ARN is passed to the AgentCore runtime via `EXECUTION_ROLE_ARN` env — `deploy.sh` does NOT create or modify this role.

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
    estate-validator (boot)  -- warns per-estate; runtime always starts (4-pillar)
        |
        v
    MCP server ready -- aws_list_estates reports per-estate health
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

`deploy.sh` is a thin packager: it builds the Docker image, pushes to ECR, and updates the AgentCore runtime's `--environment-variables` and `--role-arn`. It does **NOT** create or modify IAM roles. The execution role `DevOpsAgentCoreRole` (in account `399987695868`) is an account-setup prerequisite created and owned outside the deploy script — its ARN is consumed via `EXECUTION_ROLE_ARN` env, and its inline `DevOpsAgentCoreAssumePolicy` (covering all six estate ARNs + ECR + CloudWatch Logs) is managed manually per the implementation guide.

### Required env when deploying the aws server type

```bash
# Runtime image build + push (unchanged from other servers)
MCP_SERVER=aws
AWS_REGION=eu-central-1

# NEW: pre-created execution role ARN (the script no longer creates roles)
EXECUTION_ROLE_ARN=arn:aws:iam::399987695868:role/DevOpsAgentCoreRole

# NEW: estate map, passed verbatim into the runtime container env
AWS_ESTATES='{"eu-oit-prd":{"assumedRoleArn":"arn:aws:iam::762715229080:role/DevOpsAgentReadOnly","externalId":"devops-agent-prod-access"}, ...}'
```

### Key changes inside `deploy.sh` (vs. pre-SIO-828)

1. **Remove the IAM-role-creation block entirely.** The previous Step 3 (`Creating IAM role...`, `put-role-policy AgentCoreAssumeEstateRoles`, `attach-role-policy`, and the 10s wait for IAM propagation) is deleted. The script now requires `EXECUTION_ROLE_ARN` to be set and passes it through unchanged.

2. **Validate `EXECUTION_ROLE_ARN` exists in the target account** before image build. Cheap pre-flight check via `aws iam get-role`; loud failure if the role hasn't been provisioned.

3. **AWS_ESTATES validation only** (no IAM writes):

```bash
if [ "${MCP_SERVER}" = "aws" ]; then
  if [ -z "${AWS_ESTATES:-}" ]; then
    echo "ERROR: AWS_ESTATES is required for the aws server type." >&2
    exit 1
  fi
  ESTATE_COUNT=$(echo "${AWS_ESTATES}" | jq -er 'length') || {
    echo "ERROR: AWS_ESTATES is not valid JSON" >&2
    exit 1
  }
  # Sanity-check the assumed roles are present in the execution role's inline policy.
  # Surface a warning if any estate ARN is NOT covered by DevOpsAgentCoreAssumePolicy
  # so operators know to update the policy manually before traffic hits.
  POLICY_RESOURCES=$(aws iam get-role-policy \
    --role-name "${EXECUTION_ROLE_NAME}" \
    --policy-name "DevOpsAgentCoreAssumePolicy" \
    --query 'PolicyDocument.Statement[].Resource' --output json 2>/dev/null || echo "[]")
  for arn in $(echo "${AWS_ESTATES}" | jq -r '.[].assumedRoleArn'); do
    if ! echo "${POLICY_RESOURCES}" | jq -e --arg a "${arn}" 'tostring | contains($a)' >/dev/null; then
      echo "  WARNING: ${arn} not found in DevOpsAgentCoreAssumePolicy; sts:AssumeRole will fail at runtime." >&2
    fi
  done
fi
```

4. **ENV_VARS line** (replaces the two-line legacy block):

```bash
ENV_VARS="${ENV_VARS},AWS_ESTATES=${AWS_ESTATES}"
```

5. **Runtime update uses the pre-existing role ARN:**

```bash
aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id "${EXISTING_RUNTIME}" \
  --agent-runtime-artifact "containerConfiguration={containerUri=${ECR_URI}:${IMAGE_TAG}}" \
  --role-arn "${EXECUTION_ROLE_ARN}" \
  --network-configuration "${NETWORK_CONFIG}" \
  --protocol-configuration "serverProtocol=MCP" \
  --environment-variables "${ENV_VARS}" \
  --region "${AWS_REGION}"
```

### Details

- **`jq` is a hard prerequisite** for parsing `AWS_ESTATES`.
- **No IAM writes from deploy.sh.** All `iam:CreateRole`, `iam:PutRolePolicy`, `iam:AttachRolePolicy` calls are removed.
- **Pre-flight policy check** is a warning, not a hard fail — lets the deploy proceed (consistent with the 4-pillar boot pattern) while making the misconfiguration visible.
- **Quoting** verified by `scripts/agentcore/test-env-construction.sh`.
- **No trust-policy reminder** in the deploy output — trust policies are owned by the monitored accounts' teams and have a separate provisioning workflow documented in `docs/runbooks/aws-estate-onboarding.md`.

---

## Section 6 — Boot-time Estate Validation (warn-and-continue, 4-pillar)

The runtime calls `sts:AssumeRole` (via `STSClient.GetCallerIdentity` through each estate's credential provider) for every configured estate during boot. **Failures do NOT block startup.** Each result is logged, stored in a module-level health map, and surfaced through the `aws_list_estates` MCP tool so operators see broken estates without grepping logs. Per-tool calls against a broken estate still surface the real `iam-permission-missing` / `assume-role-denied` error at call time — the validator gives an earlier signal, not a different one.

### Why warn-and-continue (4-pillar)

The 4-pillar pattern (config / runtime / telemetry / signal-handling) requires the runtime to boot regardless of downstream-dependency state so that:

- **Operators can probe the runtime** (`/health`, `/identity`, `aws_list_estates`) even when some estates are broken.
- **A single bad estate doesn't take down 5 good ones.** Multi-estate is multi-tenant; partial degradation must not cascade to total outage.
- **Trust-policy fixes don't require a redeploy.** When an account team fixes their trust policy, the next per-estate STS call inside a tool invocation succeeds — no AgentCore container restart needed.
- **Observability flows are upstream of correctness.** OTEL + LangSmith traces depend on the runtime being alive to emit them.

### New file `packages/mcp-server-aws/src/services/estate-validator.ts`

```ts
export interface EstateValidationResult {
  estate: string;
  ok: boolean;
  assumedArn?: string;
  error?: string;
  durationMs: number;
  validatedAt: string;  // ISO timestamp -- aws_list_estates surfaces this
}

// Process-lifetime health map. The bootstrap populates this; aws_list_estates reads it.
let lastValidationResults: EstateValidationResult[] = [];
export function getEstateHealth(): EstateValidationResult[] {
  return lastValidationResults;
}

export async function validateEstates(config: AwsConfig): Promise<EstateValidationResult[]> {
  const entries = Object.entries(config.estates);
  const results = await Promise.all(
    entries.map(async ([estate, estateConfig]) => {
      const started = Date.now();
      try {
        const provider = buildAssumedCredsProvider(estateConfig, config.region);
        const sts = new STSClient({ region: config.region, credentials: provider, maxAttempts: 1 });
        const res = await sts.send(new GetCallerIdentityCommand({}));
        return {
          estate,
          ok: true,
          assumedArn: res.Arn,
          durationMs: Date.now() - started,
          validatedAt: new Date().toISOString(),
        };
      } catch (err) {
        return {
          estate,
          ok: false,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          durationMs: Date.now() - started,
          validatedAt: new Date().toISOString(),
        };
      }
    }),
  );
  lastValidationResults = results;
  return results;
}
```

### Bootstrap wiring (`packages/mcp-server-aws/src/index.ts`)

```ts
// Boot validator: runs once, never throws, populates the health map.
const results = await validateEstates(config.aws);
const failed = results.filter((r) => !r.ok);
const ok = results.filter((r) => r.ok);

for (const r of ok) {
  logger.info({ estate: r.estate, assumedArn: r.assumedArn, durationMs: r.durationMs },
    "Estate validation OK");
}
for (const r of failed) {
  logger.warn(
    { estate: r.estate, error: r.error, durationMs: r.durationMs },
    "Estate validation FAILED -- runtime will still start; tool calls against this estate will surface AccessDenied",
  );
}

if (failed.length > 0) {
  // Single prominent banner line summarising the degraded state. Operators see
  // this at boot and can correlate with aws_list_estates afterwards.
  logger.warn(
    {
      degradedEstateCount: failed.length,
      totalEstateCount: results.length,
      degradedEstates: failed.map((r) => r.estate),
    },
    `Starting with ${failed.length}/${results.length} estate(s) DEGRADED -- see aws_list_estates for per-estate status`,
  );
} else {
  logger.info(
    { estateCount: results.length, slowestMs: Math.max(...results.map((r) => r.durationMs)) },
    "All estates validated OK",
  );
}

// IMPORTANT: do NOT throw. The runtime starts regardless.
```

### `aws_list_estates` enriched output

The introspection tool reports per-estate health in addition to the ID list:

```ts
{
  "estates": ["eu-oit-prd", "eu-ediservices-prd", ...],
  "health": [
    {
      "estate": "eu-oit-prd",
      "ok": true,
      "assumedArn": "arn:aws:sts::762715229080:assumed-role/DevOpsAgentReadOnly/aws-mcp-server",
      "validatedAt": "2026-05-27T13:42:11.234Z"
    },
    {
      "estate": "eu-ediservices-prd",
      "ok": false,
      "error": "AccessDenied: User: arn:aws:sts::399987695868:assumed-role/... is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::523422062084:role/DevOpsAgentReadOnly",
      "validatedAt": "2026-05-27T13:42:11.456Z"
    }
  ]
}
```

The agent's `awsEstateRouter` can use this to skip dispatching to known-degraded estates (saves a round-trip when the user said "all" but one estate is broken). Optional — not in v1.

### Cost

300-600ms for 6 estates in parallel (`Promise.all`, scales as O(slowest) not O(sum)). Acceptable inside AgentCore cold-start.

### Test coverage

- All-OK case via `aws-sdk-client-mock`
- Mixed-success case (boot succeeds, health map reports 1 failed)
- All-failed case (boot still succeeds, health map reports all failed, prominent banner logged)
- `aws_list_estates` returns the health map alongside the ID list
- `getEstateHealth()` is stable between calls (process-lifetime cache)

### Re-validation

V1 does NOT re-run the validator after boot. If a trust policy is fixed mid-life, the next per-tool `STSClient.send` inside the affected client picks it up (the SDK's credential provider re-AssumeRoles on cache miss). For an explicit refresh, operators redeploy or restart the runtime.

### No escape hatch needed

The previous `SKIP_ESTATE_VALIDATION` flag is removed. Boot is always validated; validation never throws.

---

## Section 7 — Migration, Local Dev, Backout

### Prerequisite: execution role + monitored-account roles must exist

Before any deploy, the AWS account topology must be in place (per the implementation guide and account architecture above):

1. **In `399987695868` (`eu-shared-services-prd`):** `DevOpsAgentCoreRole` IAM role exists with inline policy `DevOpsAgentCoreAssumePolicy` covering all 6 estate ARNs + ECR + CloudWatch Logs.
2. **In each of the 6 monitored accounts:** `DevOpsAgentReadOnly` IAM role exists with trust policy naming `arn:aws:iam::399987695868:role/DevOpsAgentCoreRole` as `Principal` and `sts:ExternalId` condition `devops-agent-prod-access`.

The deploy script (Section 5) no longer creates or modifies these roles — it consumes the execution role ARN via env.

### `.env` migration (one-time edit)

```diff
- AWS_ASSUMED_ROLE_ARN=arn:aws:iam::762715229080:role/DevOpsAgentReadOnly
- AWS_EXTERNAL_ID=devops-agent-prod-access
+ EXECUTION_ROLE_ARN=arn:aws:iam::399987695868:role/DevOpsAgentCoreRole
+ AWS_ESTATES='{"eu-oit-prd":{"assumedRoleArn":"arn:aws:iam::762715229080:role/DevOpsAgentReadOnly","externalId":"devops-agent-prod-access"},"eu-ediservices-prd":{"assumedRoleArn":"arn:aws:iam::523422062084:role/DevOpsAgentReadOnly","externalId":"devops-agent-prod-access"},"eu-mendix-platform-prd":{"assumedRoleArn":"arn:aws:iam::654654584630:role/DevOpsAgentReadOnly","externalId":"devops-agent-prod-access"},"eu-b2becom-v2-prd":{"assumedRoleArn":"arn:aws:iam::178531813197:role/DevOpsAgentReadOnly","externalId":"devops-agent-prod-access"},"eu-b2b-ecom-prd":{"assumedRoleArn":"arn:aws:iam::105329690220:role/DevOpsAgentReadOnly","externalId":"devops-agent-prod-access"},"eu-b2bonboarding-prd":{"assumedRoleArn":"arn:aws:iam::728412486223:role/DevOpsAgentReadOnly","externalId":"devops-agent-prod-access"}}'
```

The SigV4 proxy block (`AWS_AGENTCORE_*`) is untouched — multi-estate is entirely a runtime-side + execution-role concern.

### Local dev

- `bun --env-file=.env packages/mcp-server-aws/src/index.ts` works as today; validator runs first but never throws.
- `.env.example` updated with single + multi-estate JSON examples plus the 6-account real-world block.
- Smoke-test script's `aws_list_estates` step now also asserts the `health` array is present and reports each estate's status.

### Backout

Single PR, 8 commits (one per design section). Backout = `git revert -m 1 <merge-sha>` + redeploy (~5 min). Because the deploy script no longer mutates IAM, there is no IAM-side cleanup — revert is purely image + runtime env. `.env` reverts to the old two-line pair documented above.

---

## Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Leaf-role trust policy missing the runtime execution role principal | High at first deploy of each new estate | Boot-time validator warns at startup + `aws_list_estates` reports per-estate health; first tool call surfaces structured `assume-role-denied` error |
| `EXECUTION_ROLE_ARN` not pre-created in `399987695868` | Medium | deploy.sh pre-flight `aws iam get-role` check fails the deploy loudly with the exact role name + account expected |
| Estate listed in `AWS_ESTATES` but not in `DevOpsAgentCoreAssumePolicy` Resource list | Medium | deploy.sh per-estate scan against the inline policy emits a warning naming the missing ARN; tool calls would fail with `sts:AssumeRole AccessDenied` until the policy is updated |
| AgentCore `--environment-variables` mangling JSON quoting | Medium | `scripts/agentcore/test-env-construction.sh`; verify first deploy via `aws bedrock-agentcore-control get-agent-runtime` |
| LLM router picks wrong estate → over-fan-out | Medium | "Be conservative" prompt; per-decision logging; `AWS_MAX_FANOUT_ESTATES` cap |
| Per-tool `estate` arg confuses sub-agent LLM | Low | Supervisor injects via ALS; sub-agent LLM never sees the field |
| 39-file PR too large to review | Medium | Mechanical-edit nature; PR description highlights pattern; reviewer spot-checks 3 files |
| Runtime boots with all estates degraded → silent total failure | Low | Single banner log line at boot summarising N/M degraded; `aws_list_estates` health always queryable; per-tool errors are structured + actionable |

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
6. `deploy.sh` consumes `EXECUTION_ROLE_ARN` from env (does NOT create IAM roles); pre-flights with `aws iam get-role`; warns on any estate ARN missing from `DevOpsAgentCoreAssumePolicy`.
7. Runtime boot calls `STSClient.GetCallerIdentity` per estate in parallel; results stored in process-lifetime health map; **runtime always starts** with a banner log line when any estate is degraded (4-pillar pattern).
8. `aws_list_estates` MCP tool returns configured estate IDs **plus per-estate health** (ok / error / assumedArn / validatedAt).
9. `.env.example` updated with `EXECUTION_ROLE_ARN` + 6-estate `AWS_ESTATES` example; migration documented in PR description.
10. `bun run typecheck && bun run lint && bun run test` pass.

---

## Memory references

- `reference_c72_msk_service_mapping` — team already thinks in dev/prd estate pairs
- `reference_first_deploy_to_fresh_account_bugs` — multi-account deploy gotchas surfaced previously
- `reference_aws_iam_role_and_externalid` — current single-role setup that this design supersedes
- `reference_aws_iam_gotchas` — IAM policy quirks (Logs Describe* limits, EC2 UnauthorizedOperation)
- `reference_agentcore_logs_via_otel` — runtime logs live in OTEL/LangSmith, not CloudWatch
- `reference_agentcore_sse_response_shape` — proxy response shape (affects smoke-test parsing)
