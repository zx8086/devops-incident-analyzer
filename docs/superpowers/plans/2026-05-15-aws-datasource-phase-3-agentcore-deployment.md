# AWS Datasource Phase 3 — AgentCore Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy `packages/mcp-server-aws/` to AWS Bedrock AgentCore Runtime in account `356994971776` so a local SigV4 proxy on `:3001` can reach it, with manual probes confirming the AssumeRole chain works end-to-end.

**Architecture:** Three bounded source-file edits (one Dockerfile line, three case-arms in `scripts/agentcore/deploy.sh`, one proxy-mode branch in `packages/mcp-server-aws/src/index.ts`), followed by a one-shot deploy run and a three-probe manual verification. No new files. No new tests. Mirrors the existing Kafka deployment pattern.

**Tech Stack:** Bash 5+, AWS CLI v2, Docker, jq, Bun, TypeScript, AWS Bedrock AgentCore Runtime, `@devops-agent/shared` SigV4 proxy.

**Spec:** [docs/superpowers/specs/2026-05-15-aws-datasource-phase-3-agentcore-deployment.md](../specs/2026-05-15-aws-datasource-phase-3-agentcore-deployment.md)

**Parent design:** [docs/superpowers/specs/2026-05-15-aws-datasource-design.md](../specs/2026-05-15-aws-datasource-design.md)

**Linear:** Create a sub-issue under [SIO-756](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a) before starting Task 1. Commits use the new sub-issue ID (assume `SIO-759` below — replace with the real ID after creation).

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `Dockerfile.agentcore` | Modify | Add `mcp-server-aws/package.json` to the deps-stage COPY list so `bun install --frozen-lockfile` sees the new workspace package |
| `scripts/agentcore/deploy.sh` | Modify | Add `aws` arms to the print-config case (line 127), IAM policy block (after line 267), env-vars case (line 301); plus a header comment |
| `packages/mcp-server-aws/src/index.ts` | Modify | Add `AWS_AGENTCORE_RUNTIME_ARN` → SigV4 proxy mode branch; preserve existing local mode |

No test files added — the existing `packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts` already covers proxy mechanics generically; the new code paths are mechanical mirrors of Kafka's `index.ts` and bash case-arms that don't benefit from new unit tests.

---

## Pre-Task: Create Linear sub-issue and worktree

- [ ] **Step 1: Create Linear sub-issue under SIO-756**

Use the Linear MCP. Title: `Phase 3 — AgentCore deployment for AWS datasource`. State: `In Progress` (NOT `Done`). Parent: `SIO-756`. Description: link the spec at `docs/superpowers/specs/2026-05-15-aws-datasource-phase-3-agentcore-deployment.md`.

Capture the issue ID (expected to be the next free number after SIO-758). All commit subjects below use placeholder `SIO-759`; **replace with the real ID** before committing.

- [ ] **Step 2: Create a worktree for this phase**

Per `superpowers:using-git-worktrees`. From the repo root:

```bash
# Replace 759 if Linear assigned a different number
git worktree add ../devops-incident-analyzer-sio-759 -b sio-759-phase-3-agentcore
cd ../devops-incident-analyzer-sio-759
```

All subsequent tasks run inside this worktree.

- [ ] **Step 3: Verify pre-conditions**

```bash
# Confirm Phase 1 + Phase 2 are present
git log --oneline | grep -E "SIO-(757|758)" | head -5
# Expected: both SIO-757 and SIO-758 commits visible

# Confirm the package and IAM scaffolding exist
ls packages/mcp-server-aws/src/index.ts
ls scripts/agentcore/policies/devops-agent-readonly-trust-policy.json
ls scripts/agentcore/setup-aws-readonly-role.sh
# Expected: all three exist

# Confirm local AWS creds are set to test account 356994971776
aws sts get-caller-identity --query Account --output text
# Expected: 356994971776
```

If account does not match, switch profiles before continuing. **Do not** run deploy.sh against the wrong account — it will create orphan resources.

---

## Task 1: Add `mcp-server-aws` to the Dockerfile workspace manifest

**Files:**
- Modify: `Dockerfile.agentcore` (insert one line after the existing `mcp-server-konnect` line in the deps stage)

- [ ] **Step 1: Read the current Dockerfile to confirm the insertion point**

```bash
grep -n "mcp-server-" Dockerfile.agentcore
```

Expected output (the order shown is what currently exists — `mcp-server-aws` is missing):
```
27:COPY packages/mcp-server-atlassian/package.json packages/mcp-server-atlassian/
28:COPY packages/mcp-server-couchbase/package.json packages/mcp-server-couchbase/
29:COPY packages/mcp-server-elastic/package.json packages/mcp-server-elastic/
30:COPY packages/mcp-server-gitlab/package.json packages/mcp-server-gitlab/
31:COPY packages/mcp-server-kafka/package.json packages/mcp-server-kafka/
32:COPY packages/mcp-server-konnect/package.json packages/mcp-server-konnect/
```

The new line goes **before** `mcp-server-atlassian` (alphabetical: `aws` < `atlassian`).

- [ ] **Step 2: Add the COPY line**

Use the Edit tool. Find:

```dockerfile
COPY packages/mcp-server-atlassian/package.json packages/mcp-server-atlassian/
```

Replace with:

```dockerfile
COPY packages/mcp-server-aws/package.json packages/mcp-server-aws/
COPY packages/mcp-server-atlassian/package.json packages/mcp-server-atlassian/
```

- [ ] **Step 3: Verify the line is present and the file is still valid Dockerfile syntax**

```bash
grep -n "mcp-server-aws/package.json" Dockerfile.agentcore
# Expected: one line, in the deps stage

# Lint by re-reading the structure
grep -c "^COPY packages/" Dockerfile.agentcore
# Expected: 11 (was 10, plus the new aws line)
```

- [ ] **Step 4: Commit**

```bash
git add Dockerfile.agentcore
git commit -m "SIO-759: add mcp-server-aws to Dockerfile.agentcore workspace manifest

Required for bun install --frozen-lockfile to see the Phase 2 package
when building the AgentCore container.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Extend `scripts/agentcore/deploy.sh` — header comment

**Files:**
- Modify: `scripts/agentcore/deploy.sh` (add 4 lines to the env-var documentation block near the top)

- [ ] **Step 1: Find the insertion point**

```bash
grep -n "Konnect-specific:" scripts/agentcore/deploy.sh
```

Expected: one match around line 51 (`# Konnect-specific:` is the last per-server section in the comment block).

- [ ] **Step 2: Add the AWS-specific header comment**

Use the Edit tool. Find:

```bash
# Konnect-specific:
#   KONNECT_ACCESS_TOKEN    - Kong Konnect API access token
#   KONNECT_REGION          - Konnect region (us|eu|au|me|in)

set -euo pipefail
```

Replace with:

```bash
# Konnect-specific:
#   KONNECT_ACCESS_TOKEN    - Kong Konnect API access token
#   KONNECT_REGION          - Konnect region (us|eu|au|me|in)
#
# AWS-specific:
#   AWS_ASSUMED_ROLE_ARN    - DevOpsAgentReadOnly role to assume in the runtime
#                             (default: arn:aws:iam::${ACCOUNT_ID}:role/DevOpsAgentReadOnly)
#   AWS_EXTERNAL_ID         - STS ExternalId required by the assumed role's trust
#                             policy (default: aws-mcp-readonly-2026)

set -euo pipefail
```

- [ ] **Step 3: Verify**

```bash
grep -A 4 "AWS-specific:" scripts/agentcore/deploy.sh
# Expected: the 5 lines above are present, with no broken indentation
bash -n scripts/agentcore/deploy.sh
# Expected: exits 0 (syntax-valid)
```

**Do not commit yet** — Tasks 2, 3, 4, 5 are all small bash edits to the same file. Bundle them into one commit at Task 5.

---

## Task 3: Extend `scripts/agentcore/deploy.sh` — print-config case

**Files:**
- Modify: `scripts/agentcore/deploy.sh` (one line inside `case "${MCP_SERVER}"` at line 127)

- [ ] **Step 1: Inspect the current case block**

```bash
sed -n '127,132p' scripts/agentcore/deploy.sh
```

Expected output (the current 4-arm switch):
```bash
case "${MCP_SERVER}" in
  kafka)    echo "  Kafka:        ${KAFKA_PROVIDER} (auth=${MSK_AUTH_MODE})" ;;
  elastic)  echo "  Elastic:      ${ELASTICSEARCH_URL:-not set}" ;;
  couchbase) echo "  Couchbase:    ${CB_HOSTNAME:-not set}" ;;
  konnect)  echo "  Konnect:      region=${KONNECT_REGION:-us}" ;;
esac
```

- [ ] **Step 2: Add the `aws` arm**

Use the Edit tool. Find:

```bash
  konnect)  echo "  Konnect:      region=${KONNECT_REGION:-us}" ;;
esac
```

Replace with:

```bash
  konnect)  echo "  Konnect:      region=${KONNECT_REGION:-us}" ;;
  aws)      echo "  AWS:          role=${AWS_ASSUMED_ROLE_ARN:-DevOpsAgentReadOnly (default)}, externalId=set" ;;
esac
```

- [ ] **Step 3: Verify syntax**

```bash
bash -n scripts/agentcore/deploy.sh
# Expected: exits 0
```

Do not commit yet. Bundling at Task 5.

---

## Task 4: Extend `scripts/agentcore/deploy.sh` — IAM policy block

**Files:**
- Modify: `scripts/agentcore/deploy.sh` (insert ~12 lines after the kafka MSK block ending around line 267, before `POLICY_DOCUMENT='{...}'` at line 269)

The execution role (`aws-mcp-server-agentcore-role`) needs `sts:AssumeRole` permission on `DevOpsAgentReadOnly`. Without it, the trust policy allows it but the principal lacks the permission, and AssumeRole returns AccessDenied.

- [ ] **Step 1: Inspect the current insertion point**

```bash
sed -n '263,272p' scripts/agentcore/deploy.sh
```

Expected output:
```bash
      "Resource": "arn:aws:kafka:'"${AWS_REGION}"':'"${ACCOUNT_ID}"':cluster/*"
    }'
fi

POLICY_DOCUMENT='{"Version":"2012-10-17","Statement":'"${POLICY_STATEMENTS}"']}'
```

The new block goes **between** the closing `fi` of the kafka MSK block and the `POLICY_DOCUMENT=` line.

- [ ] **Step 2: Insert the AWS policy block**

Use the Edit tool. Find:

```bash
      "Resource": "arn:aws:kafka:'"${AWS_REGION}"':'"${ACCOUNT_ID}"':cluster/*"
    }'
fi

POLICY_DOCUMENT='{"Version":"2012-10-17","Statement":'"${POLICY_STATEMENTS}"']}'
```

Replace with:

```bash
      "Resource": "arn:aws:kafka:'"${AWS_REGION}"':'"${ACCOUNT_ID}"':cluster/*"
    }'
fi

# AWS: grant sts:AssumeRole on DevOpsAgentReadOnly. The trust policy on
# DevOpsAgentReadOnly already names this execution role as the only permitted
# principal; this statement is the matching permission side of the contract.
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

POLICY_DOCUMENT='{"Version":"2012-10-17","Statement":'"${POLICY_STATEMENTS}"']}'
```

- [ ] **Step 3: Verify syntax and JSON validity of the assembled policy**

```bash
bash -n scripts/agentcore/deploy.sh
# Expected: exits 0

# Spot-check that the produced JSON is well-formed by simulating the block:
ACCOUNT_ID=356994971776 MCP_SERVER=aws AWS_REGION=eu-central-1 bash -c '
  POLICY_STATEMENTS='"'"'[{"Sid":"CloudWatchLogs"}]'"'"'
  if [ "${MCP_SERVER}" = "aws" ]; then
    ASSUMED_ROLE_ARN="${AWS_ASSUMED_ROLE_ARN:-arn:aws:iam::${ACCOUNT_ID}:role/DevOpsAgentReadOnly}"
    POLICY_STATEMENTS="${POLICY_STATEMENTS}"'"'"',
      {
        "Sid": "AssumeDevOpsAgentReadOnly",
        "Effect": "Allow",
        "Action": "sts:AssumeRole",
        "Resource": "'"'"'"${ASSUMED_ROLE_ARN}"'"'"'"
      }'"'"'
  fi
  POLICY_DOCUMENT='"'"'{"Version":"2012-10-17","Statement":'"'"'"${POLICY_STATEMENTS}"'"'"']}'"'"'
  echo "${POLICY_DOCUMENT}" | jq .
'
# Expected: jq prints valid JSON containing both CloudWatchLogs and AssumeDevOpsAgentReadOnly statements
```

If jq errors out with "parse error", the bash quoting is wrong — review the Edit before continuing.

Do not commit yet.

---

## Task 5: Extend `scripts/agentcore/deploy.sh` — env-vars case + commit

**Files:**
- Modify: `scripts/agentcore/deploy.sh` (add an arm to the `case "${MCP_SERVER}"` block at line 301; ends at `esac` near line 396)

- [ ] **Step 1: Inspect the current konnect arm (which ends the case)**

```bash
sed -n '388,397p' scripts/agentcore/deploy.sh
```

Expected:
```bash
  konnect)
    if [ -n "${KONNECT_ACCESS_TOKEN:-}" ]; then
      ENV_VARS="${ENV_VARS},KONNECT_ACCESS_TOKEN=${KONNECT_ACCESS_TOKEN}"
    fi
    if [ -n "${KONNECT_REGION:-}" ]; then
      ENV_VARS="${ENV_VARS},KONNECT_REGION=${KONNECT_REGION}"
    fi
    ;;
esac
```

- [ ] **Step 2: Add the `aws` arm before `esac`**

Use the Edit tool. Find:

```bash
  konnect)
    if [ -n "${KONNECT_ACCESS_TOKEN:-}" ]; then
      ENV_VARS="${ENV_VARS},KONNECT_ACCESS_TOKEN=${KONNECT_ACCESS_TOKEN}"
    fi
    if [ -n "${KONNECT_REGION:-}" ]; then
      ENV_VARS="${ENV_VARS},KONNECT_REGION=${KONNECT_REGION}"
    fi
    ;;
esac
```

Replace with:

```bash
  konnect)
    if [ -n "${KONNECT_ACCESS_TOKEN:-}" ]; then
      ENV_VARS="${ENV_VARS},KONNECT_ACCESS_TOKEN=${KONNECT_ACCESS_TOKEN}"
    fi
    if [ -n "${KONNECT_REGION:-}" ]; then
      ENV_VARS="${ENV_VARS},KONNECT_REGION=${KONNECT_REGION}"
    fi
    ;;
  aws)
    AWS_ASSUMED_ROLE_ARN_RESOLVED="${AWS_ASSUMED_ROLE_ARN:-arn:aws:iam::${ACCOUNT_ID}:role/DevOpsAgentReadOnly}"
    AWS_EXTERNAL_ID_RESOLVED="${AWS_EXTERNAL_ID:-aws-mcp-readonly-2026}"
    ENV_VARS="${ENV_VARS},AWS_ASSUMED_ROLE_ARN=${AWS_ASSUMED_ROLE_ARN_RESOLVED}"
    ENV_VARS="${ENV_VARS},AWS_EXTERNAL_ID=${AWS_EXTERNAL_ID_RESOLVED}"
    ;;
esac
```

(`AWS_REGION` is unconditionally added at the top of the env-vars block — no separate line needed.)

- [ ] **Step 3: Verify the full script parses and the case-arm renders correctly**

```bash
bash -n scripts/agentcore/deploy.sh
# Expected: exits 0

# Simulate the env-var build for MCP_SERVER=aws
ACCOUNT_ID=356994971776 MCP_SERVER=aws AWS_REGION=eu-central-1 bash -c '
  ENV_VARS="AWS_REGION=${AWS_REGION}"
  case "${MCP_SERVER}" in
    aws)
      AWS_ASSUMED_ROLE_ARN_RESOLVED="${AWS_ASSUMED_ROLE_ARN:-arn:aws:iam::${ACCOUNT_ID}:role/DevOpsAgentReadOnly}"
      AWS_EXTERNAL_ID_RESOLVED="${AWS_EXTERNAL_ID:-aws-mcp-readonly-2026}"
      ENV_VARS="${ENV_VARS},AWS_ASSUMED_ROLE_ARN=${AWS_ASSUMED_ROLE_ARN_RESOLVED}"
      ENV_VARS="${ENV_VARS},AWS_EXTERNAL_ID=${AWS_EXTERNAL_ID_RESOLVED}"
      ;;
  esac
  echo "${ENV_VARS}"
'
# Expected: AWS_REGION=eu-central-1,AWS_ASSUMED_ROLE_ARN=arn:aws:iam::356994971776:role/DevOpsAgentReadOnly,AWS_EXTERNAL_ID=aws-mcp-readonly-2026
```

- [ ] **Step 4: Commit Tasks 2 + 3 + 4 + 5 as a single bash change**

```bash
git add scripts/agentcore/deploy.sh
git commit -m "SIO-759: extend deploy.sh to handle MCP_SERVER=aws

Adds:
- Header comment documenting AWS_ASSUMED_ROLE_ARN, AWS_EXTERNAL_ID
- Print-config aws arm
- IAM policy arm granting sts:AssumeRole on DevOpsAgentReadOnly
- Env-vars aws arm injecting AWS_ASSUMED_ROLE_ARN + AWS_EXTERNAL_ID

The matching trust policy on DevOpsAgentReadOnly was set in Phase 1
(SIO-757); this commit closes the permissions side of the AssumeRole
contract.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Add proxy-mode branch to `packages/mcp-server-aws/src/index.ts`

**Files:**
- Modify: `packages/mcp-server-aws/src/index.ts` (wrap the existing `if (import.meta.main)` body in an outer `if (runtimeArn) { ... } else { ... }`)

- [ ] **Step 1: Read the current file**

```bash
cat packages/mcp-server-aws/src/index.ts
```

The current `if (import.meta.main) { ... }` block calls `createMcpApplication<AwsDatasource>({ ... })` directly. The new structure wraps that in a proxy-mode check.

- [ ] **Step 2: Replace the body of `if (import.meta.main)`**

Use the Edit tool. Find:

```typescript
if (import.meta.main) {
	createMcpApplication<AwsDatasource>({
		name: "aws-mcp-server",
		logger: createBootstrapAdapter(logger),

		initTracing: () => initializeTracing(),
		telemetry: buildTelemetryConfig("aws-mcp-server"),

		initDatasource: async () => {
			const config = loadConfig();
			logger.level = config.logLevel;
			setDefaultCapBytes(config.toolResultCapBytes);

			const runtimeInfo = getRuntimeInfo();
			logger.info(
				{
					runtime: runtimeInfo.runtime,
					version: runtimeInfo.version,
					region: config.aws.region,
					transport: config.transport.mode,
					assumedRole: config.aws.assumedRoleArn,
				},
				"Starting AWS MCP Server",
			);

			return { config };
		},

		createServerFactory: (ds) => () => {
			const server = new McpServer({ name: "aws-mcp-server", version: pkg.version });
			registerAllTools(server, ds.config.aws);
			return server;
		},

		createTransport: (serverFactory, ds) => createTransport(ds.config.transport, serverFactory),

		onStarted: (ds) => {
			logger.info(
				{
					region: ds.config.aws.region,
					transport: ds.config.transport.mode,
					port: ds.config.transport.mode !== "stdio" ? ds.config.transport.port : undefined,
				},
				"AWS MCP server ready",
			);
		},
	});
}
```

Replace with:

```typescript
if (import.meta.main) {
	// Proxy-only mode: when an AgentCore runtime ARN is set, the AWS MCP server
	// runs remotely on AWS. Start only the local SigV4 proxy so the agent can
	// reach it. AWS_AGENTCORE_RUNTIME_ARN takes precedence over the generic
	// AGENTCORE_RUNTIME_ARN to support running both Kafka and AWS proxies
	// side-by-side without env-var collision.
	const runtimeArn = process.env.AWS_AGENTCORE_RUNTIME_ARN ?? process.env.AGENTCORE_RUNTIME_ARN;

	if (runtimeArn) {
		process.env.AGENTCORE_RUNTIME_ARN = runtimeArn;
		process.env.AGENTCORE_PROXY_PORT = process.env.AGENTCORE_PROXY_PORT ?? "3001";

		const { startAgentCoreProxy } = await import("@devops-agent/shared");
		logger.info({ arn: runtimeArn, transport: "agentcore-proxy" }, "Starting AWS MCP Server");
		const proxy = await startAgentCoreProxy();
		logger.info(
			{ transport: "agentcore-proxy", port: proxy.port, url: proxy.url },
			"AWS MCP Server ready",
		);

		let isShuttingDown = false;
		const shutdown = async () => {
			if (isShuttingDown) return;
			isShuttingDown = true;
			logger.info("Shutting down aws-mcp-server...");
			await proxy.close();
			logger.info("aws-mcp-server shutdown completed");
			process.exit(0);
		};
		process.on("SIGINT", () => shutdown());
		process.on("SIGTERM", () => shutdown());
	} else {
		createMcpApplication<AwsDatasource>({
			name: "aws-mcp-server",
			logger: createBootstrapAdapter(logger),

			initTracing: () => initializeTracing(),
			telemetry: buildTelemetryConfig("aws-mcp-server"),

			initDatasource: async () => {
				const config = loadConfig();
				logger.level = config.logLevel;
				setDefaultCapBytes(config.toolResultCapBytes);

				const runtimeInfo = getRuntimeInfo();
				logger.info(
					{
						runtime: runtimeInfo.runtime,
						version: runtimeInfo.version,
						region: config.aws.region,
						transport: config.transport.mode,
						assumedRole: config.aws.assumedRoleArn,
					},
					"Starting AWS MCP Server",
				);

				return { config };
			},

			createServerFactory: (ds) => () => {
				const server = new McpServer({ name: "aws-mcp-server", version: pkg.version });
				registerAllTools(server, ds.config.aws);
				return server;
			},

			createTransport: (serverFactory, ds) => createTransport(ds.config.transport, serverFactory),

			onStarted: (ds) => {
				logger.info(
					{
						region: ds.config.aws.region,
						transport: ds.config.transport.mode,
						port: ds.config.transport.mode !== "stdio" ? ds.config.transport.port : undefined,
					},
					"AWS MCP server ready",
				);
			},
		});
	}
}
```

- [ ] **Step 3: Typecheck**

```bash
bun run --filter @devops-agent/mcp-server-aws typecheck
# Expected: no errors
```

- [ ] **Step 4: Lint**

```bash
bun run lint
# Expected: no errors. Biome may reorder the import block — accept that and run lint:fix if it complains.
```

If Biome reorders imports, run:
```bash
bun run lint:fix
```

- [ ] **Step 5: Run the existing AWS MCP test suite**

```bash
bun run --filter @devops-agent/mcp-server-aws test
# Expected: all pass (the new branch is gated on env vars; tests don't set them)
```

- [ ] **Step 6: Smoke-test local stdio mode is unaffected**

```bash
# Without AWS_AGENTCORE_RUNTIME_ARN set, the server must still start in stdio mode.
AWS_REGION=eu-central-1 \
AWS_ASSUMED_ROLE_ARN=arn:aws:iam::356994971776:role/DevOpsAgentReadOnly \
AWS_EXTERNAL_ID=aws-mcp-readonly-2026 \
MCP_TRANSPORT=stdio \
timeout 3 bun packages/mcp-server-aws/src/index.ts < /dev/null 2>&1 | head -20 || true
# Expected: log line "Starting AWS MCP Server" with transport: "stdio"; no proxy-related log
```

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server-aws/src/index.ts
git commit -m "SIO-759: add AgentCore proxy-mode branch to mcp-server-aws

When AWS_AGENTCORE_RUNTIME_ARN (or generic AGENTCORE_RUNTIME_ARN) is
set, bun run dev in this package starts the local SigV4 proxy on :3001
instead of a local MCP server. Mirrors the Kafka pattern.

Reads AWS_AGENTCORE_RUNTIME_ARN with fallback to AGENTCORE_RUNTIME_ARN
so existing single-proxy setups keep working while multi-proxy setups
can scope per-server.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Deploy to AgentCore

**Files:** none (executes the modified `scripts/agentcore/deploy.sh`)

This is the moment the code changes meet AWS. **Confirm you are pointed at account `356994971776`** before running.

- [ ] **Step 1: Re-confirm the account and region**

```bash
aws sts get-caller-identity --query Account --output text
# Expected: 356994971776

# Confirm the placeholder execution role from Phase 1 exists
aws iam get-role --role-name aws-mcp-server-agentcore-role --query 'Role.RoleName' --output text
# Expected: aws-mcp-server-agentcore-role

# Confirm DevOpsAgentReadOnly's trust policy still names that role
aws iam get-role --role-name DevOpsAgentReadOnly \
  --query 'Role.AssumeRolePolicyDocument.Statement[?Sid==`AllowAgentCoreExecutionRoleToAssume`].Principal.AWS' \
  --output text
# Expected: arn:aws:iam::356994971776:role/aws-mcp-server-agentcore-role
```

If any of these fail, **stop**. Re-run `scripts/agentcore/setup-aws-readonly-role.sh` to restore Phase 1 state before deploying.

- [ ] **Step 2: Confirm Docker daemon is running**

```bash
docker version --format '{{.Server.Version}}'
# Expected: any version string; non-zero exit means Docker Desktop is off
```

- [ ] **Step 3: Run the deploy**

```bash
MCP_SERVER=aws ./scripts/agentcore/deploy.sh 2>&1 | tee /tmp/aws-deploy.log
```

Expected timeline (~5-10 min):
- `[1/5]` ECR repo created (or exists)
- `[2/5]` Docker build succeeds, image pushed
- `[3/5]` IAM role updated, policy created/updated
- `[4/5]` Runtime created or updated, polls until `Status: ACTIVE`
- `[5/5]` "Deployment Complete" with a `Runtime ARN` printed
- `.agentcore-deployment.json` written in the worktree root

**If the build fails at `bun install --frozen-lockfile`:** Task 1 missed; verify `Dockerfile.agentcore` contains the `mcp-server-aws/package.json` COPY line.

**If the runtime never reaches `ACTIVE`:** check CloudWatch Logs under `/aws/bedrock-agentcore/runtimes/*` for container startup errors. Most likely missing env-var (re-check Task 5) or AssumeRole denial (re-check Task 4).

- [ ] **Step 4: Capture the runtime ARN**

```bash
RUNTIME_ARN=$(jq -r .runtimeArn .agentcore-deployment.json)
echo "${RUNTIME_ARN}"
# Expected: arn:aws:bedrock-agentcore:eu-west-1:356994971776:runtime/aws-mcp-server-XXXXX
```

Save the ARN to your shell session for Task 8.

---

## Task 8: Manual probe verification (Phase 3 gate)

**Files:** none (verification only)

The spec defines three probes. **All three must pass** to declare Phase 3 complete.

- [ ] **Step 1: Start the local SigV4 proxy on :3001 in the background**

```bash
# Confirm port 3001 is free
lsof -i :3001 || echo "port 3001 is free"
# Expected: "port 3001 is free"

# Start the proxy (replace RUNTIME_ARN with the value from Task 7 Step 4)
AWS_AGENTCORE_RUNTIME_ARN="${RUNTIME_ARN}" \
  bun run --filter @devops-agent/mcp-server-aws dev > /tmp/aws-proxy.log 2>&1 &
PROXY_PID=$!
echo "proxy PID: ${PROXY_PID}"

# Wait for proxy to bind
for i in $(seq 1 15); do
  if lsof -i :3001 >/dev/null 2>&1; then break; fi
  sleep 1
done
lsof -i :3001
# Expected: bun process listening on :3001
```

If the proxy fails to start, check `/tmp/aws-proxy.log` for AWS credential errors. The proxy needs local AWS creds (the same ones used by `aws sts get-caller-identity`) to sign requests.

- [ ] **Step 2: Probe 1 — `tools/list`**

```bash
curl -s -X POST http://localhost:3001/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | tee /tmp/probe1.json \
  | jq '.result.tools | length'
```

**Pass criterion:** integer >= 1.

If output is `null` or an error, inspect `/tmp/probe1.json`. JSON-RPC `-32xxx` errors mean the AgentCore runtime is reachable but the inner MCP server failed; check CloudWatch Logs.

- [ ] **Step 3: Probe 2 — `sts:GetCallerIdentity` (confirms AssumeRole chain)**

Note: tool name is taken from the catalogue returned by Probe 1. If `call_aws` is not the registered tool, adjust accordingly:

```bash
# First, identify the AWS-call tool name from Probe 1's response
jq -r '.result.tools[].name' /tmp/probe1.json
# Look for a tool that takes a `cli_command` or `command` argument
```

Assuming the tool is `call_aws` with arg `cli_command`:

```bash
curl -s -X POST http://localhost:3001/mcp \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":2,"method":"tools/call",
    "params":{"name":"call_aws","arguments":{"cli_command":"aws sts get-caller-identity"}}
  }' \
  | tee /tmp/probe2.json \
  | jq -r '.result.content[0].text'
```

**Pass criterion:** output contains `arn:aws:sts::356994971776:assumed-role/DevOpsAgentReadOnly/`.

If output instead contains `arn:aws:sts::356994971776:assumed-role/aws-mcp-server-agentcore-role/`, the AssumeRole step never happened — the container is running as its execution role directly. Verify `AWS_ASSUMED_ROLE_ARN` and `AWS_EXTERNAL_ID` env-vars are set on the runtime:

```bash
aws bedrock-agentcore-control get-agent-runtime \
  --agent-runtime-id $(jq -r .runtimeId .agentcore-deployment.json) \
  --query 'environmentVariables' --output json
# Expected: includes AWS_ASSUMED_ROLE_ARN and AWS_EXTERNAL_ID
```

If output contains `AccessDenied: ... is not authorized to perform: sts:AssumeRole`, the execution role lacks the new IAM statement — re-check Task 4 and re-run `MCP_SERVER=aws ./scripts/agentcore/deploy.sh` to push the updated policy.

- [ ] **Step 4: Probe 3 — `logs:DescribeLogGroups` (reachability of CloudWatch under the assumed role)**

```bash
curl -s -X POST http://localhost:3001/mcp \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":3,"method":"tools/call",
    "params":{"name":"call_aws","arguments":{"cli_command":"aws logs describe-log-groups --max-items 1"}}
  }' \
  | tee /tmp/probe3.json \
  | jq -r '.result.content[0].text' \
  | grep -q 'logGroups' && echo "PASS" || echo "FAIL"
```

**Pass criterion:** prints `PASS`.

Empty `logGroups` arrays are acceptable — the IAM grant works, there just happens to be no matching log group. A real AccessDenied means the `DevOpsAgentReadOnly` policy is missing the LogsListUnscoped statement (verify with `aws iam get-policy-version --policy-arn arn:aws:iam::356994971776:policy/DevOpsAgentReadOnlyPolicy --version-id $(aws iam get-policy --policy-arn arn:aws:iam::356994971776:policy/DevOpsAgentReadOnlyPolicy --query 'Policy.DefaultVersionId' --output text)`).

- [ ] **Step 5: Stop the proxy**

```bash
kill ${PROXY_PID} 2>/dev/null || true
# Wait for the port to be released
for i in $(seq 1 5); do
  lsof -i :3001 >/dev/null 2>&1 || break
  sleep 1
done
lsof -i :3001 || echo "port 3001 freed"
```

- [ ] **Step 6: Record verification results**

Append a verification record to the spec under a new "Appendix A: Phase 3 Verification Record" section (similar to the parent design's Appendix A). Capture:

```bash
# Use Edit tool to add the following to
# docs/superpowers/specs/2026-05-15-aws-datasource-phase-3-agentcore-deployment.md
# at the very end of the file:
```

Append this exact text (replace the timestamp, runtime ID, and probe output snippets with real values):

```markdown
---

## Appendix A: Phase 3 Verification Record

**Date verified:** 2026-05-15
**Verified by:** Simon Owusu (test account `356994971776`)
**Linear issue:** SIO-759 (sub-issue of SIO-756)

### What was deployed

- ECR image: `<ECR_URI>:latest`
- AgentCore runtime ID: `<RUNTIME_ID>` (ARN: `<RUNTIME_ARN>`)
- Execution role permissions: CloudWatchLogs + ECRPull + AssumeDevOpsAgentReadOnly (from deploy.sh)

### Probe results

| Probe | Result |
|---|---|
| 1 — tools/list | PASS — N tools returned |
| 2 — sts:GetCallerIdentity | PASS — session ARN `arn:aws:sts::356994971776:assumed-role/DevOpsAgentReadOnly/<session>` |
| 3 — logs:DescribeLogGroups | PASS — response contained `logGroups` |
```

- [ ] **Step 7: Commit the verification record**

```bash
git add docs/superpowers/specs/2026-05-15-aws-datasource-phase-3-agentcore-deployment.md
git commit -m "SIO-759: append Phase 3 verification record to spec

All three Layer 5 probes passed against the deployed AgentCore runtime
in test account 356994971776.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Finishing the branch

- [ ] **Step 1: Run the full project lint + typecheck once more**

```bash
bun run typecheck
# Expected: no errors

bun run lint
# Expected: no errors
```

- [ ] **Step 2: Push the branch**

```bash
git push -u origin sio-759-phase-3-agentcore
```

- [ ] **Step 3: Open a PR**

Use `gh pr create`. Title: `SIO-759: Phase 3 — AWS datasource AgentCore deployment`. Body:

```markdown
## Summary

- Extends `scripts/agentcore/deploy.sh` to handle `MCP_SERVER=aws`
- Adds `mcp-server-aws/package.json` to `Dockerfile.agentcore` workspace manifest
- Adds AgentCore proxy-mode branch to `packages/mcp-server-aws/src/index.ts` reading `AWS_AGENTCORE_RUNTIME_ARN` with fallback to `AGENTCORE_RUNTIME_ARN`
- Deployment verified in test account 356994971776 against the placeholder execution role from Phase 1 (SIO-757)

Builds on Phase 1 (#91, SIO-757) IAM scaffolding and Phase 2 (#92, SIO-758) MCP package.

## Verification

All three Layer 5 manual probes passed (recorded in spec Appendix A):

1. `tools/list` returned the AWS tool catalogue
2. `call_aws sts get-caller-identity` showed the `DevOpsAgentReadOnly` assumed-role session
3. `call_aws logs describe-log-groups` returned a `logGroups` payload

## Test plan

- [ ] CI: `bun run typecheck` passes
- [ ] CI: `bun run lint` passes
- [ ] CI: `bun run --filter @devops-agent/mcp-server-aws test` passes
- [ ] Manual: probes 1-3 above re-run if needed against the deployed runtime

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 4: Move the Linear sub-issue to `In Review`**

Use Linear MCP to set SIO-759 state to `In Review` (NOT `Done`). Comment on the issue with the PR URL.

- [ ] **Step 5: Per `superpowers:finishing-a-development-branch`, wait for review**

Do **not** merge. Do **not** set the Linear issue to `Done`. Wait for the user's explicit approval before either.

---

## Out of scope (Phase 4 / Phase 5)

For clarity to anyone reading this plan:

- `agents/incident-analyzer/agents/aws-agent/` directory — Phase 4
- `state.ts`, `supervisor.ts`, `sub-agent.ts` edits adding `aws-agent` to the union/mapping — Phase 4
- Dev-runner script changes to auto-spawn both Kafka and AWS proxies — Phase 4
- Hard-switching Kafka to `KAFKA_AGENTCORE_RUNTIME_ARN` — Phase 4 cleanup (or later)
- Correlation rules referencing AWS findings — Phase 5
- Multi-account expansion to `352896877281` — post-launch

If a reviewer asks "why didn't you also do X", check whether X is listed above before adding scope.
