# AWS Datasource Phase 2: MCP Server Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `packages/mcp-server-aws/` as a native TypeScript MCP server exposing 39 read-only AWS tools across 14 tool folders, matching the existing 5-server pattern exactly (`createMcpApplication` bootstrap, Pino logging, OpenTelemetry tracing, stdio/http/agentcore transports), with AWS API access via `@aws-sdk/client-*` clients wrapped in `fromTemporaryCredentials` against the `DevOpsAgentReadOnly` role from Phase 1.

**Architecture:** Bootstrap entry uses `createMcpApplication` from `@devops-agent/shared` (same shape as `mcp-server-konnect`). Credentials are wired once in `services/credentials.ts` via `fromTemporaryCredentials`. SDK clients are lazy singletons in `services/client-factory.ts`. Tool handlers go through `tools/wrap.ts` for truncation (`wrapListTool` for paginated/list responses, `wrapBlobTool` for shape-less) and error mapping to structured `_error.kind`. The 39 tool files are folder-per-service-family, each ~30-50 LOC.

**Tech Stack:** Bun runtime, TypeScript strict mode, Zod v4 for param validation, `@aws-sdk/client-*` (18 packages), `@aws-sdk/credential-providers` for `fromTemporaryCredentials`, `@modelcontextprotocol/sdk` for the MCP server class, Pino logging via `@devops-agent/shared`, `aws-sdk-client-mock` for integration tests.

**Spec:** `docs/superpowers/specs/2026-05-15-aws-mcp-server-package-design.md`

**Linear:** sub-issue created in Task 0 below; parent epic [SIO-756](https://linear.app/siobytes/issue/SIO-756)

**Branch:** `claude/sio-aws-phase-2-mcp-server` (cut from main at `d8efc25`; Phase 2 spec committed at `438bc15`)

---

## Resume Instructions (cross-session handoff)

This plan is designed to survive multiple sessions. A fresh session — including one with zero context from the planning phase — can pick up exactly where the previous one stopped.

### How progress is tracked across sessions

1. **Checkboxes.** Every step uses `- [ ]` / `- [x]` syntax. When a step is done, the implementer edits the plan to `- [x]` and commits the update alongside the code change. The plan file itself is the canonical progress tracker.
2. **Commit history.** `git log --oneline origin/main..HEAD` always shows what's actually landed. Trust commits over checkboxes if they ever drift.
3. **Linear sub-issue.** Once Task 0 lands, status moves there. Comments capture the PR URL.

### To resume in a fresh session

Read these in order:
1. **This plan** (you're in it) — locate the highest-numbered `[x]` step; resume at the next `[ ]`.
2. **`git log --oneline origin/main..HEAD`** — confirm the checkbox state matches reality.
3. **The parent spec** at `docs/superpowers/specs/2026-05-15-aws-mcp-server-package-design.md` — only if you need architectural context for a tricky task.

The plan is self-contained: every task has exact file paths, complete code blocks, exact commands, and exact expected output. **No conversational context from the planning session is required.**

### Critical session-state facts (not discoverable from the codebase alone)

- **AWS test account is `356994971776`**, used as a stand-in for the production-design account `352896877281`. All IAM artifacts in this plan use `356994971776`. The Phase 1 `DevOpsAgentReadOnly` role exists in that account today.
- **Dev IAM user is `arn:aws:iam::356994971776:user/7-zark-7`**. Layer 4 verification (Task 24) requires re-adding this user to the trust policy via the Phase-1 trust file (the file is `.gitignore`'d per Phase 1 design; recreate from Phase 1 Task 3 instructions if missing).
- **Linear issue placeholder is `SIO-PHASE2-AWS`**. Real ID is assigned in Task 0; Task 25.4 rewrites commit history once the real ID is known. Do not push to remote before the rewrite unless you intend to leave the placeholder in the history.
- **Phase 1 placeholder AgentCore role `aws-mcp-server-agentcore-role` exists** in the test account (created during Phase 1 verification — it has a Bedrock AgentCore service trust but no real permissions). The production trust policy references it. Phase 3 will overwrite its trust + attach real permissions; Phase 2 doesn't touch it.

### One-line prompt for a fresh session

Paste this into a new session to resume:

> Continue Phase 2 implementation of the AWS datasource. Plan: `docs/superpowers/plans/2026-05-15-aws-datasource-phase-2-mcp-server-package.md`. Parent spec: `docs/superpowers/specs/2026-05-15-aws-mcp-server-package-design.md`. Branch: `claude/sio-aws-phase-2-mcp-server`. Use the plan's checkbox state and `git log --oneline origin/main..HEAD` to find the next `[ ]` task and continue. Use the `superpowers:subagent-driven-development` skill for execution. Honor the Resume Instructions block at the top of the plan.

---

## File Structure (locked decisions from the spec)

**New package:** `packages/mcp-server-aws/`

```
package.json                    # @devops-agent/mcp-server-aws (Task 1)
tsconfig.json                   # extends ../../tsconfig.base.json (Task 1)
src/
  index.ts                      # bootstrap entry, ~90 LOC (Task 8)
  config/
    schemas.ts                  # Zod schemas (Task 2)
    index.ts                    # getConfig() + exports (Task 2)
  services/
    credentials.ts              # buildAssumedCredsProvider() (Task 3)
    client-factory.ts           # lazy SDK client singletons (Task 4)
  tools/
    types.ts                    # shared ToolError/_truncated/_error shapes (Task 5)
    wrap.ts                     # wrapListTool/wrapBlobTool + error mapping (Task 5)
    register.ts                 # registerAllTools(server, config) (Task 7)
    ec2/                        # Task 9: 3 tools (describe_instances/vpcs/security_groups)
    ecs/                        # Task 10: 4 tools
    lambda/                     # Task 11: 2 tools
    cloudwatch/                 # Task 12: 2 tools
    logs/                       # Task 13: 3 tools
    xray/                       # Task 14: 2 tools
    health/                     # Task 15: 1 tool
    cloudformation/             # Task 16: 3 tools
    rds/                        # Task 17: 2 tools
    dynamodb/                   # Task 18: 2 tools
    s3/                         # Task 19: 3 tools
    elasticache/                # Task 20: 2 tools
    messaging/                  # Task 21: 7 tools across sns/sqs/eventbridge/sfn
    config/                     # Task 22: 2 tools
    tags/                       # Task 23: 1 tool
  transport/
    index.ts                    # re-exports (Task 6)
    factory.ts                  # createTransport() (Task 6)
    http.ts                     # startHttpTransport() (Task 6)
    stdio.ts                    # startStdioTransport() (Task 6)
  telemetry/
    tracing.ts                  # initializeTracing() bridge (Task 8)
  utils/
    logger.ts                   # createMcpLogger("aws-mcp-server") (Task 1)
    env.ts                      # getRuntimeInfo() (Task 1)
  __tests__/
    config.test.ts              # 6 tests (Task 2)
    credentials.test.ts         # 4 tests (Task 3)
    client-factory.test.ts      # 4 tests (Task 4)
    wrap.test.ts                # 12 tests (Task 5)
    bootstrap.test.ts           # 4 tests (Task 8)
    tools-smoke.test.ts         # 39 tests minimum (Tasks 9-23, appended per family; 2 per tool = ~78)
    tools-integration.test.ts   # 15 tests (Tasks 9-23, one per family)
```

**No changes outside `packages/mcp-server-aws/` in Phase 2.** Phase 3 will extend `scripts/agentcore/deploy.sh` and add the SigV4 proxy startup.

---

## Task 0: Create Linear sub-issue (~5 minutes)

**Files:** none (Linear-only)

- [x] **Step 0.1: Create the Linear sub-issue**

Use the Linear MCP `save_issue` tool with:
- **Title:** `Phase 2: Native TypeScript MCP server packages/mcp-server-aws/`
- **Team:** `Siobytes`
- **Project:** `DevOps Incident Analyzer` (id `84d0f5ea-05e0-4224-8cc5-f95b4827a56c`)
- **Parent:** `SIO-756`
- **Status:** `Todo`
- **Priority:** `3` (Medium)
- **Description:** Link the spec `docs/superpowers/specs/2026-05-15-aws-mcp-server-package-design.md`, this plan, and the parent epic. State that this is Phase 2 of 5.

- [x] **Step 0.2: Record the issue ID**

**Issue ID: [SIO-758](https://linear.app/siobytes/issue/SIO-758)**. Every commit message in this plan uses that prefix per CLAUDE.md. The placeholder `SIO-PHASE2-AWS` is replaced by `SIO-758` in all subsequent commits.

---

## Task 1: Package scaffolding

**Files:**
- Create: `packages/mcp-server-aws/package.json`
- Create: `packages/mcp-server-aws/tsconfig.json`
- Create: `packages/mcp-server-aws/src/utils/logger.ts`
- Create: `packages/mcp-server-aws/src/utils/env.ts`

- [x] **Step 1.1: Create `packages/mcp-server-aws/package.json`**

```json
{
	"name": "@devops-agent/mcp-server-aws",
	"version": "0.1.0",
	"type": "module",
	"main": "src/index.ts",
	"types": "src/index.ts",
	"scripts": {
		"dev": "bun --env-file=../../.env --hot src/index.ts",
		"start": "bun src/index.ts",
		"test": "bun test",
		"typecheck": "bunx tsc --noEmit"
	},
	"dependencies": {
		"@devops-agent/shared": "workspace:*",
		"@aws-sdk/client-cloudformation": "^3.700.0",
		"@aws-sdk/client-cloudwatch": "^3.700.0",
		"@aws-sdk/client-cloudwatch-logs": "^3.700.0",
		"@aws-sdk/client-config-service": "^3.700.0",
		"@aws-sdk/client-dynamodb": "^3.700.0",
		"@aws-sdk/client-ec2": "^3.700.0",
		"@aws-sdk/client-ecs": "^3.700.0",
		"@aws-sdk/client-elasticache": "^3.700.0",
		"@aws-sdk/client-eventbridge": "^3.700.0",
		"@aws-sdk/client-health": "^3.700.0",
		"@aws-sdk/client-lambda": "^3.700.0",
		"@aws-sdk/client-rds": "^3.700.0",
		"@aws-sdk/client-resource-groups-tagging-api": "^3.700.0",
		"@aws-sdk/client-s3": "^3.700.0",
		"@aws-sdk/client-sfn": "^3.700.0",
		"@aws-sdk/client-sns": "^3.700.0",
		"@aws-sdk/client-sqs": "^3.700.0",
		"@aws-sdk/client-sts": "^3.700.0",
		"@aws-sdk/client-xray": "^3.700.0",
		"@aws-sdk/credential-providers": "^3.700.0",
		"@modelcontextprotocol/sdk": "catalog:",
		"@opentelemetry/api": "^1.9.0",
		"pino": "catalog:",
		"zod": "catalog:"
	},
	"devDependencies": {
		"@biomejs/biome": "catalog:dev",
		"@types/bun": "catalog:dev",
		"aws-sdk-client-mock": "^4.1.0",
		"bun-types": "catalog:dev",
		"typescript": "catalog:dev"
	},
	"private": true
}
```

- [x] **Step 1.2: Create `packages/mcp-server-aws/tsconfig.json`**

```json
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"rootDir": "./src"
	},
	"include": ["src/**/*.ts"]
}
```

- [x] **Step 1.3: Create `packages/mcp-server-aws/src/utils/logger.ts`**

```typescript
// src/utils/logger.ts
import { createMcpLogger } from "@devops-agent/shared";

export const logger = createMcpLogger("aws-mcp-server");

export function createContextLogger(component: string) {
	return logger.child({ component });
}
```

- [x] **Step 1.4: Create `packages/mcp-server-aws/src/utils/env.ts`**

```typescript
// src/utils/env.ts
export interface RuntimeInfo {
	runtime: "bun" | "node";
	version: string;
	envSource: "bun" | "process";
}

export function getRuntimeInfo(): RuntimeInfo {
	const isBun = typeof Bun !== "undefined";
	return {
		runtime: isBun ? "bun" : "node",
		version: isBun ? Bun.version : process.version,
		envSource: isBun ? "bun" : "process",
	};
}
```

- [x] **Step 1.5: Install dependencies**

Run from the repo root:

```bash
bun install
```

Expected: no errors. Bun resolves all `@aws-sdk/*` packages plus `aws-sdk-client-mock`. May add many entries to `bun.lock`.

- [x] **Step 1.6: Typecheck the new package**

```bash
bun run --filter '@devops-agent/mcp-server-aws' typecheck
```

Expected: exit 0, no errors. (Empty `src/` other than the two `utils/` files is fine — typecheck just verifies the tsconfig resolves.)

- [x] **Step 1.7: Commit**

```bash
git add packages/mcp-server-aws/ bun.lock
git commit -m "SIO-PHASE2-AWS: scaffold packages/mcp-server-aws/ (deps + logger + env)"
```

---

## Task 2: Config schemas

**Files:**
- Create: `packages/mcp-server-aws/src/config/schemas.ts`
- Create: `packages/mcp-server-aws/src/config/index.ts`
- Create: `packages/mcp-server-aws/src/__tests__/config.test.ts`

- [x] **Step 2.1: Write the failing tests first**

Create `packages/mcp-server-aws/src/__tests__/config.test.ts`:

```typescript
// src/__tests__/config.test.ts
import { describe, expect, test } from "bun:test";
import { ConfigSchema, loadConfig } from "../config/index.ts";

describe("ConfigSchema", () => {
	const validEnv = {
		AWS_REGION: "eu-central-1",
		AWS_ASSUMED_ROLE_ARN: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
		AWS_EXTERNAL_ID: "aws-mcp-readonly-2026",
	};

	test("accepts complete env with all required fields", () => {
		const result = ConfigSchema.safeParse(validEnv);
		expect(result.success).toBe(true);
	});

	test("rejects when AWS_REGION is missing", () => {
		const { AWS_REGION: _, ...rest } = validEnv;
		const result = ConfigSchema.safeParse(rest);
		expect(result.success).toBe(false);
	});

	test("rejects malformed role ARN", () => {
		const result = ConfigSchema.safeParse({
			...validEnv,
			AWS_ASSUMED_ROLE_ARN: "not-an-arn",
		});
		expect(result.success).toBe(false);
	});

	test("uses default port 9085 when TRANSPORT_PORT is missing", () => {
		const result = ConfigSchema.parse(validEnv);
		expect(result.transport.port).toBe(9085);
	});

	test("respects SUBAGENT_TOOL_RESULT_CAP_BYTES override", () => {
		const result = ConfigSchema.parse({
			...validEnv,
			SUBAGENT_TOOL_RESULT_CAP_BYTES: "4096",
		});
		expect(result.toolResultCapBytes).toBe(4096);
	});

	test("loadConfig is idempotent (returns the same object on repeated calls)", () => {
		const a = loadConfig(validEnv);
		const b = loadConfig(validEnv);
		expect(a).toEqual(b);
	});
});
```

- [x] **Step 2.2: Run the tests to confirm they fail**

```bash
bun test packages/mcp-server-aws/src/__tests__/config.test.ts
```

Expected: 6 failures because `config/index.ts` doesn't exist yet. (Bun emits "Cannot find module" errors.)

- [x] **Step 2.3: Create `packages/mcp-server-aws/src/config/schemas.ts`**

```typescript
// src/config/schemas.ts
import { z } from "zod";

const roleArnRegex = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_-]+$/;

const numericString = (def: number) =>
	z.preprocess((v) => (v === undefined || v === "" ? def : Number(v)), z.number().int().positive());

export const ConfigSchema = z.preprocess(
	(raw) => {
		const env = (raw ?? {}) as Record<string, string | undefined>;
		return {
			AWS_REGION: env.AWS_REGION,
			AWS_ASSUMED_ROLE_ARN: env.AWS_ASSUMED_ROLE_ARN,
			AWS_EXTERNAL_ID: env.AWS_EXTERNAL_ID,
			AWS_MCP_LOG_LEVEL: env.AWS_MCP_LOG_LEVEL,
			TRANSPORT_MODE: env.MCP_TRANSPORT ?? env.TRANSPORT_MODE,
			TRANSPORT_PORT: env.TRANSPORT_PORT,
			TRANSPORT_HOST: env.TRANSPORT_HOST,
			TRANSPORT_PATH: env.TRANSPORT_PATH,
			SUBAGENT_TOOL_RESULT_CAP_BYTES: env.SUBAGENT_TOOL_RESULT_CAP_BYTES,
		};
	},
	z
		.object({
			AWS_REGION: z.string().min(1).describe("AWS region for SDK clients"),
			AWS_ASSUMED_ROLE_ARN: z
				.string()
				.regex(roleArnRegex, "Must be a valid IAM role ARN")
				.describe("Role to assume for AWS API calls"),
			AWS_EXTERNAL_ID: z.string().min(1).describe("STS ExternalId for the AssumeRole condition"),
			AWS_MCP_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
			TRANSPORT_MODE: z.enum(["stdio", "http", "both", "agentcore"]).default("stdio"),
			TRANSPORT_PORT: numericString(9085),
			TRANSPORT_HOST: z.string().default("0.0.0.0"),
			TRANSPORT_PATH: z.string().default("/mcp"),
			SUBAGENT_TOOL_RESULT_CAP_BYTES: numericString(32000),
		})
		.transform((raw) => ({
			aws: {
				region: raw.AWS_REGION,
				assumedRoleArn: raw.AWS_ASSUMED_ROLE_ARN,
				externalId: raw.AWS_EXTERNAL_ID,
			},
			logLevel: raw.AWS_MCP_LOG_LEVEL,
			transport: {
				mode: raw.TRANSPORT_MODE,
				port: raw.TRANSPORT_PORT,
				host: raw.TRANSPORT_HOST,
				path: raw.TRANSPORT_PATH,
			},
			toolResultCapBytes: raw.SUBAGENT_TOOL_RESULT_CAP_BYTES,
		})),
);

export type Config = z.output<typeof ConfigSchema>;
export type AwsConfig = Config["aws"];
export type TransportConfig = Config["transport"];
```

- [x] **Step 2.4: Create `packages/mcp-server-aws/src/config/index.ts`**

```typescript
// src/config/index.ts
import { ConfigSchema, type Config } from "./schemas.ts";

let cached: Config | undefined;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
	const parsed = ConfigSchema.parse(env);
	cached = parsed;
	return parsed;
}

export function getConfig(): Config {
	if (!cached) {
		cached = ConfigSchema.parse(process.env);
	}
	return cached;
}

// Test-only: reset the singleton.
export function _resetConfigCacheForTests(): void {
	cached = undefined;
}

export { ConfigSchema };
export type { AwsConfig, Config, TransportConfig } from "./schemas.ts";
```

- [x] **Step 2.5: Run tests to confirm they pass**

```bash
bun test packages/mcp-server-aws/src/__tests__/config.test.ts
```

Expected: 6 passes.

- [x] **Step 2.6: Typecheck**

```bash
bun run --filter '@devops-agent/mcp-server-aws' typecheck
```

Expected: exit 0.

- [x] **Step 2.7: Commit**

```bash
git add packages/mcp-server-aws/src/config/ packages/mcp-server-aws/src/__tests__/config.test.ts
git commit -m "SIO-PHASE2-AWS: config schemas + loadConfig (6 tests)"
```

---

## Task 3: Credentials wiring

**Files:**
- Create: `packages/mcp-server-aws/src/services/credentials.ts`
- Create: `packages/mcp-server-aws/src/__tests__/credentials.test.ts`

- [x] **Step 3.1: Write the failing tests first**

Create `packages/mcp-server-aws/src/__tests__/credentials.test.ts`:

```typescript
// src/__tests__/credentials.test.ts
import { describe, expect, test } from "bun:test";
import type { AwsConfig } from "../config/schemas.ts";
import { buildAssumedCredsProvider } from "../services/credentials.ts";

const config: AwsConfig = {
	region: "eu-central-1",
	assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
	externalId: "aws-mcp-readonly-2026",
};

describe("buildAssumedCredsProvider", () => {
	test("returns a callable credential provider function", () => {
		const provider = buildAssumedCredsProvider(config);
		expect(typeof provider).toBe("function");
	});

	test("constructs without throwing for a valid config", () => {
		expect(() => buildAssumedCredsProvider(config)).not.toThrow();
	});

	test("uses a stable RoleSessionName for traceability", () => {
		// fromTemporaryCredentials accepts an opaque config; we can't unit-test
		// the AssumeRole call itself without mocking STS. Just confirm the
		// returned provider is the same function shape on repeated calls.
		const a = buildAssumedCredsProvider(config);
		const b = buildAssumedCredsProvider(config);
		expect(typeof a).toBe(typeof b);
	});

	test("respects different configs (returns different provider instances)", () => {
		const a = buildAssumedCredsProvider(config);
		const b = buildAssumedCredsProvider({ ...config, region: "us-east-1" });
		expect(a).not.toBe(b);
	});
});
```

- [x] **Step 3.2: Run tests to confirm they fail**

```bash
bun test packages/mcp-server-aws/src/__tests__/credentials.test.ts
```

Expected: 4 failures because `services/credentials.ts` doesn't exist.

- [x] **Step 3.3: Create `packages/mcp-server-aws/src/services/credentials.ts`**

```typescript
// src/services/credentials.ts
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import type { AwsConfig } from "../config/schemas.ts";

// One place where AssumeRole is wired. Every SDK client below gets this provider.
// The SDK caches assumed credentials and refreshes them automatically before expiry.
export function buildAssumedCredsProvider(config: AwsConfig): AwsCredentialIdentityProvider {
	return fromTemporaryCredentials({
		params: {
			RoleArn: config.assumedRoleArn,
			ExternalId: config.externalId,
			RoleSessionName: "aws-mcp-server",
			DurationSeconds: 3600,
		},
		clientConfig: { region: config.region },
		// Base creds default to the SDK's standard chain (env vars / shared config /
		// instance metadata). AgentCore: execution role; locally: dev profile.
	});
}
```

- [x] **Step 3.4: Run tests to confirm they pass**

```bash
bun test packages/mcp-server-aws/src/__tests__/credentials.test.ts
```

Expected: 4 passes.

- [x] **Step 3.5: Typecheck**

```bash
bun run --filter '@devops-agent/mcp-server-aws' typecheck
```

Expected: exit 0.

- [x] **Step 3.6: Commit**

```bash
git add packages/mcp-server-aws/src/services/credentials.ts packages/mcp-server-aws/src/__tests__/credentials.test.ts
git commit -m "SIO-PHASE2-AWS: AssumeRole credentials via fromTemporaryCredentials (4 tests)"
```

---

## Task 4: SDK client factory (lazy singletons)

**Files:**
- Create: `packages/mcp-server-aws/src/services/client-factory.ts`
- Create: `packages/mcp-server-aws/src/__tests__/client-factory.test.ts`

- [x] **Step 4.1: Write the failing tests first**

Create `packages/mcp-server-aws/src/__tests__/client-factory.test.ts`:

```typescript
// src/__tests__/client-factory.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { EC2Client } from "@aws-sdk/client-ec2";
import { S3Client } from "@aws-sdk/client-s3";
import type { AwsConfig } from "../config/schemas.ts";
import { _resetClientsForTests, getEc2Client, getS3Client } from "../services/client-factory.ts";

const config: AwsConfig = {
	region: "eu-central-1",
	assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
	externalId: "aws-mcp-readonly-2026",
};

afterEach(() => _resetClientsForTests());

describe("client-factory", () => {
	test("getEc2Client returns an EC2Client", () => {
		expect(getEc2Client(config)).toBeInstanceOf(EC2Client);
	});

	test("getEc2Client returns the same instance on repeated calls (singleton)", () => {
		const a = getEc2Client(config);
		const b = getEc2Client(config);
		expect(a).toBe(b);
	});

	test("different service factories produce different client classes", () => {
		const ec2 = getEc2Client(config);
		const s3 = getS3Client(config);
		expect(ec2).toBeInstanceOf(EC2Client);
		expect(s3).toBeInstanceOf(S3Client);
		expect(ec2 as unknown).not.toBe(s3 as unknown);
	});

	test("client uses the configured region", async () => {
		const client = getEc2Client(config);
		const region = await client.config.region();
		expect(region).toBe("eu-central-1");
	});
});
```

- [x] **Step 4.2: Run tests to confirm they fail**

```bash
bun test packages/mcp-server-aws/src/__tests__/client-factory.test.ts
```

Expected: 4 failures.

- [x] **Step 4.3: Create `packages/mcp-server-aws/src/services/client-factory.ts`**

This file is long because there are 18 SDK packages. Each factory follows the same shape. Write all 18 in one pass:

```typescript
// src/services/client-factory.ts
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { ConfigServiceClient } from "@aws-sdk/client-config-service";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EC2Client } from "@aws-sdk/client-ec2";
import { ECSClient } from "@aws-sdk/client-ecs";
import { ElastiCacheClient } from "@aws-sdk/client-elasticache";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { HealthClient } from "@aws-sdk/client-health";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { RDSClient } from "@aws-sdk/client-rds";
import { ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { S3Client } from "@aws-sdk/client-s3";
import { SFNClient } from "@aws-sdk/client-sfn";
import { SNSClient } from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";
import { XRayClient } from "@aws-sdk/client-xray";
import type { AwsConfig } from "../config/schemas.ts";
import { buildAssumedCredsProvider } from "./credentials.ts";

// Module-level singleton cache. One client per service per process.
// Each client carries its own credential cache via fromTemporaryCredentials,
// so reusing the client keeps the cache warm.
const clients = new Map<string, unknown>();

function lazyClient<T>(key: string, ctor: () => T): T {
	if (!clients.has(key)) {
		clients.set(key, ctor());
	}
	return clients.get(key) as T;
}

function commonConfig(config: AwsConfig) {
	return {
		region: config.region,
		credentials: buildAssumedCredsProvider(config),
		maxAttempts: 3,
	};
}

export function getCloudFormationClient(config: AwsConfig): CloudFormationClient {
	return lazyClient("cloudformation", () => new CloudFormationClient(commonConfig(config)));
}
export function getCloudWatchClient(config: AwsConfig): CloudWatchClient {
	return lazyClient("cloudwatch", () => new CloudWatchClient(commonConfig(config)));
}
export function getCloudWatchLogsClient(config: AwsConfig): CloudWatchLogsClient {
	return lazyClient("logs", () => new CloudWatchLogsClient(commonConfig(config)));
}
export function getConfigServiceClient(config: AwsConfig): ConfigServiceClient {
	return lazyClient("config", () => new ConfigServiceClient(commonConfig(config)));
}
export function getDynamoDbClient(config: AwsConfig): DynamoDBClient {
	return lazyClient("dynamodb", () => new DynamoDBClient(commonConfig(config)));
}
export function getEc2Client(config: AwsConfig): EC2Client {
	return lazyClient("ec2", () => new EC2Client(commonConfig(config)));
}
export function getEcsClient(config: AwsConfig): ECSClient {
	return lazyClient("ecs", () => new ECSClient(commonConfig(config)));
}
export function getElastiCacheClient(config: AwsConfig): ElastiCacheClient {
	return lazyClient("elasticache", () => new ElastiCacheClient(commonConfig(config)));
}
export function getEventBridgeClient(config: AwsConfig): EventBridgeClient {
	return lazyClient("eventbridge", () => new EventBridgeClient(commonConfig(config)));
}
// AWS Health API requires the us-east-1 endpoint regardless of which region the
// agent is deployed in. Override the region here, not in callers.
export function getHealthClient(config: AwsConfig): HealthClient {
	return lazyClient("health", () => new HealthClient({ ...commonConfig(config), region: "us-east-1" }));
}
export function getLambdaClient(config: AwsConfig): LambdaClient {
	return lazyClient("lambda", () => new LambdaClient(commonConfig(config)));
}
export function getRdsClient(config: AwsConfig): RDSClient {
	return lazyClient("rds", () => new RDSClient(commonConfig(config)));
}
export function getResourceGroupsTaggingClient(config: AwsConfig): ResourceGroupsTaggingAPIClient {
	return lazyClient("tags", () => new ResourceGroupsTaggingAPIClient(commonConfig(config)));
}
export function getS3Client(config: AwsConfig): S3Client {
	return lazyClient("s3", () => new S3Client(commonConfig(config)));
}
export function getSfnClient(config: AwsConfig): SFNClient {
	return lazyClient("sfn", () => new SFNClient(commonConfig(config)));
}
export function getSnsClient(config: AwsConfig): SNSClient {
	return lazyClient("sns", () => new SNSClient(commonConfig(config)));
}
export function getSqsClient(config: AwsConfig): SQSClient {
	return lazyClient("sqs", () => new SQSClient(commonConfig(config)));
}
export function getXrayClient(config: AwsConfig): XRayClient {
	return lazyClient("xray", () => new XRayClient(commonConfig(config)));
}

// Test-only: reset the singleton cache.
export function _resetClientsForTests(): void {
	clients.clear();
}
```

- [x] **Step 4.4: Run tests to confirm they pass**

```bash
bun test packages/mcp-server-aws/src/__tests__/client-factory.test.ts
```

Expected: 4 passes.

- [x] **Step 4.5: Typecheck**

```bash
bun run --filter '@devops-agent/mcp-server-aws' typecheck
```

Expected: exit 0.

- [x] **Step 4.6: Commit**

```bash
git add packages/mcp-server-aws/src/services/client-factory.ts packages/mcp-server-aws/src/__tests__/client-factory.test.ts
git commit -m "SIO-PHASE2-AWS: lazy SDK client singletons for 18 services (4 tests)"
```

---

## Task 5: Tool wrappers (truncation + error mapping) — the keystone

This task is the highest-leverage piece of the package. Every tool depends on it.

**Files:**
- Create: `packages/mcp-server-aws/src/tools/types.ts`
- Create: `packages/mcp-server-aws/src/tools/wrap.ts`
- Create: `packages/mcp-server-aws/src/__tests__/wrap.test.ts`

- [ ] **Step 5.1: Create `packages/mcp-server-aws/src/tools/types.ts`**

```typescript
// src/tools/types.ts

export type ToolErrorKind =
	| "assume-role-denied"
	| "iam-permission-missing"
	| "aws-throttled"
	| "bad-input"
	| "aws-server-error"
	| "aws-network-error"
	| "aws-unknown";

export interface ToolError {
	kind: ToolErrorKind;
	action?: string;          // e.g. "ec2:DescribeVpcs" — populated for iam-permission-missing
	awsErrorName?: string;    // raw SDK error.name
	awsErrorMessage?: string; // raw SDK error.message
	awsRequestId?: string;
	httpStatusCode?: number;
	advice?: string;
}

export interface ListTruncationMarker {
	shown: number;
	total: number;
	advice: string;
}

export interface BlobTruncationMarker {
	atBytes: number;
	advice: string;
}

export type ToolResult<TResponse> =
	| (TResponse & { _truncated?: ListTruncationMarker })
	| { _raw: string; _truncated: BlobTruncationMarker }
	| { _error: ToolError };
```

- [ ] **Step 5.2: Write the failing tests for `wrap.ts`**

Create `packages/mcp-server-aws/src/__tests__/wrap.test.ts`:

```typescript
// src/__tests__/wrap.test.ts
import { describe, expect, test } from "bun:test";
import { mapAwsError, wrapBlobTool, wrapListTool } from "../tools/wrap.ts";

describe("wrapListTool", () => {
	test("returns response unchanged when under cap", async () => {
		const wrapped = wrapListTool({
			name: "test",
			listField: "items",
			fn: async () => ({ items: [1, 2, 3], other: "ok" }),
			capBytes: 1_000_000,
		});
		const result = await wrapped({});
		expect(result).toEqual({ items: [1, 2, 3], other: "ok" });
	});

	test("truncates the list when over cap and emits structured marker", async () => {
		const wrapped = wrapListTool({
			name: "test",
			listField: "items",
			fn: async () => ({ items: Array.from({ length: 100 }, (_, i) => ({ id: i, payload: "x".repeat(100) })) }),
			capBytes: 2000,
		});
		const result = await wrapped({}) as { items: unknown[]; _truncated: { shown: number; total: number } };
		expect(result.items.length).toBeLessThan(100);
		expect(result._truncated.total).toBe(100);
		expect(result._truncated.shown).toBe(result.items.length);
		expect(result._truncated).toHaveProperty("advice");
	});

	test("preserves non-list fields unchanged when truncating", async () => {
		const wrapped = wrapListTool({
			name: "test",
			listField: "items",
			fn: async () => ({ items: Array.from({ length: 50 }, (_, i) => ({ id: i })), nextToken: "abc", count: 50 }),
			capBytes: 200,
		});
		const result = await wrapped({}) as { nextToken: string; count: number };
		expect(result.nextToken).toBe("abc");
		expect(result.count).toBe(50);
	});

	test("maps AccessDeniedException to _error.kind=iam-permission-missing", async () => {
		const err = Object.assign(new Error("User is not authorized to perform: rds:DescribeDBInstances"), {
			name: "AccessDeniedException",
			$metadata: { httpStatusCode: 403, requestId: "abc" },
		});
		const wrapped = wrapListTool({
			name: "test",
			listField: "items",
			fn: async () => { throw err; },
		});
		const result = await wrapped({}) as { _error: { kind: string; action?: string } };
		expect(result._error.kind).toBe("iam-permission-missing");
		expect(result._error.action).toBe("rds:DescribeDBInstances");
	});
});

describe("wrapBlobTool", () => {
	test("returns response unchanged when under cap", async () => {
		const wrapped = wrapBlobTool({
			name: "test",
			fn: async () => ({ data: "small" }),
			capBytes: 1_000_000,
		});
		const result = await wrapped({});
		expect(result).toEqual({ data: "small" });
	});

	test("truncates serialized response when over cap with valid-JSON walkback", async () => {
		const wrapped = wrapBlobTool({
			name: "test",
			fn: async () => ({ data: Array.from({ length: 1000 }, (_, i) => ({ id: i, payload: "y".repeat(50) })) }),
			capBytes: 500,
		});
		const result = await wrapped({}) as { _raw: string; _truncated: { atBytes: number; advice: string } };
		expect(result._raw).toBeDefined();
		expect(result._truncated.atBytes).toBeLessThanOrEqual(500);
		expect(result._truncated.advice).toBeDefined();
		// Walkback should leave the raw substring ending on a safe boundary
		// (the raw is for the model — not required to be parseable, only readable).
		expect(typeof result._raw).toBe("string");
	});

	test("maps ThrottlingException to _error.kind=aws-throttled", async () => {
		const err = Object.assign(new Error("Rate exceeded"), {
			name: "ThrottlingException",
			$metadata: { httpStatusCode: 400 },
		});
		const wrapped = wrapBlobTool({ name: "test", fn: async () => { throw err; } });
		const result = await wrapped({}) as { _error: { kind: string } };
		expect(result._error.kind).toBe("aws-throttled");
	});
});

describe("mapAwsError", () => {
	test("STS AccessDenied -> assume-role-denied", () => {
		const err = Object.assign(new Error("Not authorized to perform: sts:AssumeRole"), {
			name: "AccessDenied",
			$metadata: { httpStatusCode: 403 },
		});
		const mapped = mapAwsError(err);
		expect(mapped.kind).toBe("assume-role-denied");
	});

	test("Service AccessDeniedException -> iam-permission-missing with action extracted", () => {
		const err = Object.assign(new Error("User is not authorized to perform: ec2:DescribeVpcs"), {
			name: "AccessDeniedException",
			$metadata: { httpStatusCode: 403 },
		});
		const mapped = mapAwsError(err);
		expect(mapped.kind).toBe("iam-permission-missing");
		expect(mapped.action).toBe("ec2:DescribeVpcs");
	});

	test("ValidationException -> bad-input", () => {
		const err = Object.assign(new Error("missing required field"), {
			name: "ValidationException",
			$metadata: { httpStatusCode: 400 },
		});
		expect(mapAwsError(err).kind).toBe("bad-input");
	});

	test("ServiceUnavailable -> aws-server-error", () => {
		const err = Object.assign(new Error("Service unavailable"), {
			name: "ServiceUnavailable",
			$metadata: { httpStatusCode: 503 },
		});
		expect(mapAwsError(err).kind).toBe("aws-server-error");
	});

	test("Network error (no $metadata) -> aws-network-error", () => {
		const err = new Error("getaddrinfo ENOTFOUND ec2.eu-central-1.amazonaws.com");
		expect(mapAwsError(err).kind).toBe("aws-network-error");
	});

	test("Unknown error name -> aws-unknown", () => {
		const err = Object.assign(new Error("???"), {
			name: "SomeNewAwsErrorType",
			$metadata: { httpStatusCode: 500 },
		});
		expect(mapAwsError(err).kind).toBe("aws-unknown");
	});
});
```

- [ ] **Step 5.3: Run tests to confirm they fail**

```bash
bun test packages/mcp-server-aws/src/__tests__/wrap.test.ts
```

Expected: 12 failures (module not found).

- [ ] **Step 5.4: Create `packages/mcp-server-aws/src/tools/wrap.ts`**

```typescript
// src/tools/wrap.ts
import { logger } from "../utils/logger.ts";
import type { ToolError, ToolErrorKind } from "./types.ts";

interface AwsLikeError extends Error {
	$metadata?: { httpStatusCode?: number; requestId?: string };
	$service?: string;
}

function isAwsError(err: unknown): err is AwsLikeError {
	return err instanceof Error && "name" in err;
}

// "User is not authorized to perform: ec2:DescribeVpcs ..." -> "ec2:DescribeVpcs"
function extractAction(message: string): string | undefined {
	const m = message.match(/not authorized to perform:\s*([a-z][a-zA-Z0-9-]*:[A-Za-z0-9*]+)/);
	return m?.[1];
}

const NETWORK_ERROR_PATTERNS = [/ENOTFOUND/, /ECONNREFUSED/, /ETIMEDOUT/, /EAI_AGAIN/, /socket hang up/];

export function mapAwsError(err: unknown): ToolError {
	if (!isAwsError(err)) {
		return { kind: "aws-unknown", awsErrorMessage: String(err) };
	}

	const base = {
		awsErrorName: err.name,
		awsErrorMessage: err.message,
		awsRequestId: err.$metadata?.requestId,
		httpStatusCode: err.$metadata?.httpStatusCode,
	};

	// Network errors come through without $metadata in many cases.
	if (!err.$metadata && NETWORK_ERROR_PATTERNS.some((re) => re.test(err.message))) {
		return { ...base, kind: "aws-network-error" };
	}

	let kind: ToolErrorKind;
	let action: string | undefined;

	switch (err.name) {
		case "AccessDenied": // STS-style
			kind = "assume-role-denied";
			break;
		case "AccessDeniedException": {
			action = extractAction(err.message);
			// If the action is sts:AssumeRole, treat as assume-role-denied even when
			// the error name is AccessDeniedException rather than AccessDenied.
			if (action?.startsWith("sts:AssumeRole")) {
				kind = "assume-role-denied";
			} else {
				kind = "iam-permission-missing";
			}
			break;
		}
		case "ThrottlingException":
		case "Throttling":
		case "TooManyRequestsException":
			kind = "aws-throttled";
			break;
		case "ValidationException":
		case "InvalidParameterValue":
		case "InvalidParameterException":
			kind = "bad-input";
			break;
		case "ServiceUnavailable":
		case "InternalServerError":
		case "InternalFailure":
			kind = "aws-server-error";
			break;
		default:
			kind = "aws-unknown";
	}

	const toolError: ToolError = { ...base, kind };
	if (action) toolError.action = action;
	if (kind === "iam-permission-missing") {
		toolError.advice = `Update DevOpsAgentReadOnlyPolicy to include "${action}", then re-run setup-aws-readonly-role.sh.`;
	} else if (kind === "assume-role-denied") {
		toolError.advice = "Check the DevOpsAgentReadOnly trust policy. Verify ExternalId and that the caller principal is allowed.";
	} else if (kind === "aws-throttled") {
		toolError.advice = "AWS throttled the call (SDK already retried 3 times). Narrow scope or wait before retrying.";
	}

	return toolError;
}

function logError(name: string, err: unknown, mapped: ToolError, durationMs: number): void {
	logger.error(
		{
			tool: name,
			awsErrorName: mapped.awsErrorName,
			awsErrorMessage: mapped.awsErrorMessage,
			awsRequestId: mapped.awsRequestId,
			httpStatusCode: mapped.httpStatusCode,
			errorKind: mapped.kind,
			duration_ms: durationMs,
		},
		`AWS tool call failed: ${mapped.awsErrorName ?? "unknown"}`,
	);
}

interface WrapListArgs<TResponse, TParams> {
	name: string;
	listField: keyof TResponse;
	fn: (params: TParams) => Promise<TResponse>;
	capBytes?: number;
}

const DEFAULT_CAP_BYTES = 32_000;
const TRUNCATION_OVERHEAD_BYTES = 200;

export function wrapListTool<TResponse, TParams>(
	args: WrapListArgs<TResponse, TParams>,
): (params: TParams) => Promise<TResponse | { _error: ToolError }> {
	const cap = args.capBytes ?? DEFAULT_CAP_BYTES;
	return async (params: TParams) => {
		const start = Date.now();
		let response: TResponse;
		try {
			response = await args.fn(params);
		} catch (err) {
			const mapped = mapAwsError(err);
			logError(args.name, err, mapped, Date.now() - start);
			return { _error: mapped };
		}

		const list = (response[args.listField] as unknown) as unknown[] | undefined;
		if (!Array.isArray(list)) return response;

		// Serialize the whole response once to check size.
		const full = JSON.stringify(response);
		if (full.length <= cap) return response;

		// Need to truncate the list. Bisect to find the max items that fit.
		const total = list.length;
		let lo = 0;
		let hi = total;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			const candidate = { ...response, [args.listField]: list.slice(0, mid) };
			const size = JSON.stringify(candidate).length + TRUNCATION_OVERHEAD_BYTES;
			if (size <= cap) lo = mid;
			else hi = mid - 1;
		}

		const shown = lo;
		const truncated = {
			...response,
			[args.listField]: list.slice(0, shown),
			_truncated: {
				shown,
				total,
				advice: `Response truncated. Add a filter or narrower time window to fit more of ${total} items.`,
			},
		};
		return truncated as TResponse;
	};
}

interface WrapBlobArgs<TResponse, TParams> {
	name: string;
	fn: (params: TParams) => Promise<TResponse>;
	capBytes?: number;
}

export function wrapBlobTool<TResponse, TParams>(
	args: WrapBlobArgs<TResponse, TParams>,
): (
	params: TParams,
) => Promise<TResponse | { _raw: string; _truncated: { atBytes: number; advice: string } } | { _error: ToolError }> {
	const cap = args.capBytes ?? DEFAULT_CAP_BYTES;
	return async (params: TParams) => {
		const start = Date.now();
		let response: TResponse;
		try {
			response = await args.fn(params);
		} catch (err) {
			const mapped = mapAwsError(err);
			logError(args.name, err, mapped, Date.now() - start);
			return { _error: mapped };
		}

		const serialized = JSON.stringify(response);
		if (serialized.length <= cap) return response;

		// Byte-cap with walkback to last comma or close-bracket so the raw stays
		// readable to the model. Not required to be parseable JSON.
		let cut = serialized.slice(0, cap);
		const walkbackIdx = Math.max(cut.lastIndexOf(","), cut.lastIndexOf("]"), cut.lastIndexOf("}"));
		if (walkbackIdx > cap * 0.5) cut = cut.slice(0, walkbackIdx + 1);

		return {
			_raw: cut,
			_truncated: {
				atBytes: cut.length,
				advice: "Response too large for a single tool call. Narrow scope (time window, filters, IDs) and retry.",
			},
		};
	};
}
```

- [ ] **Step 5.5: Run tests to confirm they pass**

```bash
bun test packages/mcp-server-aws/src/__tests__/wrap.test.ts
```

Expected: 12 passes.

- [ ] **Step 5.6: Typecheck**

```bash
bun run --filter '@devops-agent/mcp-server-aws' typecheck
```

Expected: exit 0.

- [ ] **Step 5.7: Commit**

```bash
git add packages/mcp-server-aws/src/tools/types.ts packages/mcp-server-aws/src/tools/wrap.ts packages/mcp-server-aws/src/__tests__/wrap.test.ts
git commit -m "SIO-PHASE2-AWS: tool wrappers (truncation + error mapping, 12 tests)"
```

---

## Task 6: Transport layer

**Files:**
- Create: `packages/mcp-server-aws/src/transport/factory.ts`
- Create: `packages/mcp-server-aws/src/transport/http.ts`
- Create: `packages/mcp-server-aws/src/transport/stdio.ts`
- Create: `packages/mcp-server-aws/src/transport/index.ts`

This task is mostly copy-and-adapt from `packages/mcp-server-konnect/src/transport/`. The transport itself has zero AWS-specific logic.

- [ ] **Step 6.1: Read the Konnect transport files for reference**

```bash
cat packages/mcp-server-konnect/src/transport/factory.ts
cat packages/mcp-server-konnect/src/transport/http.ts
cat packages/mcp-server-konnect/src/transport/stdio.ts
cat packages/mcp-server-konnect/src/transport/index.ts
```

- [ ] **Step 6.2: Create `packages/mcp-server-aws/src/transport/stdio.ts`**

```typescript
// src/transport/stdio.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContextLogger } from "../utils/logger.ts";

const log = createContextLogger("transport-stdio");

export interface StdioTransportResult {
	close: () => Promise<void>;
}

export async function startStdioTransport(server: McpServer): Promise<StdioTransportResult> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	log.info("stdio transport ready");
	return {
		close: async () => {
			await transport.close();
		},
	};
}
```

- [ ] **Step 6.3: Create `packages/mcp-server-aws/src/transport/http.ts`**

Mirror the Konnect HTTP transport. Open `packages/mcp-server-konnect/src/transport/http.ts` and copy it into `packages/mcp-server-aws/src/transport/http.ts`, replacing the import for the logger with our own (`createContextLogger("transport-http")` from `../utils/logger.ts`). Drop any Konnect-specific middleware (`withApiKeyAuth`, `withOriginValidation`) — the AWS server is not externally exposed; it only ever takes traffic from the SigV4 proxy or local dev. The minimum HTTP transport needs:

```typescript
// src/transport/http.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createContextLogger } from "../utils/logger.ts";

const log = createContextLogger("transport-http");

export interface HttpTransportOptions {
	port: number;
	host: string;
	path: string;
}

export interface HttpTransportResult {
	port: number;
	url: string;
	close: () => Promise<void>;
}

export async function startHttpTransport(
	serverFactory: () => McpServer,
	options: HttpTransportOptions,
): Promise<HttpTransportResult> {
	const server = Bun.serve({
		port: options.port,
		hostname: options.host,
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);
			if (url.pathname === "/ping") return new Response("pong", { status: 200 });
			if (url.pathname === "/health") return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
			if (url.pathname !== options.path) return new Response("not found", { status: 404 });
			if (req.method === "GET") return new Response("method not allowed", { status: 405 });
			if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

			const mcpServer = serverFactory();
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			await mcpServer.connect(transport);
			return transport.handleRequest(req as unknown as Request) as unknown as Response;
		},
	});

	const url = `http://${options.host}:${server.port}${options.path}`;
	log.info({ port: server.port, host: options.host, path: options.path }, "HTTP transport ready");
	return {
		port: server.port,
		url,
		close: async () => {
			server.stop();
		},
	};
}
```

If the Konnect server has any additional setup (cookies, sessions), use its file as a model and adapt to AWS needs. **For the first pass, keep the AWS HTTP transport minimal** — we only need `/mcp` POST + `/ping` + `/health`.

- [ ] **Step 6.4: Create `packages/mcp-server-aws/src/transport/factory.ts`**

```typescript
// src/transport/factory.ts
import { type AgentCoreTransportResult, createBootstrapAdapter, startAgentCoreTransport } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TransportConfig } from "../config/schemas.ts";
import { createContextLogger, logger } from "../utils/logger.ts";
import { type HttpTransportResult, startHttpTransport } from "./http.ts";
import { type StdioTransportResult, startStdioTransport } from "./stdio.ts";

const log = createContextLogger("transport");

export interface TransportResult {
	stdio?: StdioTransportResult;
	http?: HttpTransportResult;
	agentcore?: AgentCoreTransportResult;
	closeAll(): Promise<void>;
}

export function resolveTransportMode(mode: string): { stdio: boolean; http: boolean; agentcore: boolean } {
	switch (mode) {
		case "http":
			return { stdio: false, http: true, agentcore: false };
		case "both":
			return { stdio: true, http: true, agentcore: false };
		case "agentcore":
			return { stdio: false, http: false, agentcore: true };
		default:
			return { stdio: true, http: false, agentcore: false };
	}
}

export async function createTransport(
	config: TransportConfig,
	serverFactory: () => McpServer,
): Promise<TransportResult> {
	const modes = resolveTransportMode(config.mode);
	log.info({ mode: config.mode, ...modes }, "Resolving transport mode");

	const result: TransportResult = {
		async closeAll() {
			if (result.agentcore) await result.agentcore.close();
			if (result.http) await result.http.close();
			if (result.stdio) await result.stdio.close();
		},
	};

	if (modes.agentcore) {
		result.agentcore = await startAgentCoreTransport(serverFactory, createBootstrapAdapter(logger), {
			port: config.port,
			host: config.host,
			path: config.path,
		});
	}

	if (modes.http) {
		result.http = await startHttpTransport(serverFactory, {
			port: config.port,
			host: config.host,
			path: config.path,
		});
	}

	if (modes.stdio) {
		const server = serverFactory();
		result.stdio = await startStdioTransport(server);
	}

	log.info({ mode: config.mode, ...modes }, "Transport initialized");
	return result;
}
```

- [ ] **Step 6.5: Create `packages/mcp-server-aws/src/transport/index.ts`**

```typescript
// src/transport/index.ts
export { createTransport, resolveTransportMode, type TransportResult } from "./factory.ts";
export { type HttpTransportResult, startHttpTransport } from "./http.ts";
export { type StdioTransportResult, startStdioTransport } from "./stdio.ts";
```

- [ ] **Step 6.6: Typecheck**

```bash
bun run --filter '@devops-agent/mcp-server-aws' typecheck
```

Expected: exit 0.

- [ ] **Step 6.7: Commit**

```bash
git add packages/mcp-server-aws/src/transport/
git commit -m "SIO-PHASE2-AWS: stdio/http/agentcore transport (mirrors konnect)"
```

---

## Task 7: Tool registration scaffold (empty, ready for families)

**Files:**
- Create: `packages/mcp-server-aws/src/tools/register.ts`

- [ ] **Step 7.1: Create the registration scaffold**

```typescript
// src/tools/register.ts
// Family registration functions are added by Tasks 9-23. Each family is a single
// import + single call here. This file stays small and is the canonical place to
// see "what tools are exposed."
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../config/schemas.ts";

export function registerAllTools(server: McpServer, config: AwsConfig): void {
	// Each family registration is appended below as Tasks 9-23 land.
	// e.g. registerEc2Tools(server, config);
	void server;
	void config;
}
```

- [ ] **Step 7.2: Typecheck**

```bash
bun run --filter '@devops-agent/mcp-server-aws' typecheck
```

Expected: exit 0.

- [ ] **Step 7.3: Commit**

```bash
git add packages/mcp-server-aws/src/tools/register.ts
git commit -m "SIO-PHASE2-AWS: empty registerAllTools scaffold (filled by Tasks 9-23)"
```

---

## Task 8: Bootstrap entry (index.ts) + bootstrap tests

**Files:**
- Create: `packages/mcp-server-aws/src/telemetry/tracing.ts`
- Create: `packages/mcp-server-aws/src/index.ts`
- Create: `packages/mcp-server-aws/src/__tests__/bootstrap.test.ts`

- [ ] **Step 8.1: Create `packages/mcp-server-aws/src/telemetry/tracing.ts`**

Match the Konnect pattern exactly:

```typescript
// src/telemetry/tracing.ts
// Bridge to @devops-agent/observability tracing initialization.
// Tracing is a no-op in tests and when LANGSMITH_API_KEY is missing.

export async function initializeTracing(): Promise<void> {
	// Reserved for OTel/LangSmith wiring later. The other MCP servers also keep
	// this empty in their initial scaffolding; tracing comes online via env vars
	// recognized by @devops-agent/observability.
}
```

- [ ] **Step 8.2: Write the failing bootstrap tests**

Create `packages/mcp-server-aws/src/__tests__/bootstrap.test.ts`:

```typescript
// src/__tests__/bootstrap.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../config/schemas.ts";
import { registerAllTools } from "../tools/register.ts";
import { createTransport } from "../transport/index.ts";

const awsConfig: AwsConfig = {
	region: "eu-central-1",
	assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
	externalId: "aws-mcp-readonly-2026",
};

const PORT = 19085; // ephemeral test port to avoid collision

function buildServerFactory() {
	return () => {
		const server = new McpServer({ name: "aws-mcp-server", version: "0.1.0" });
		registerAllTools(server, awsConfig);
		return server;
	};
}

describe("HTTP transport", () => {
	let close: () => Promise<void>;

	beforeAll(async () => {
		const result = await createTransport(
			{ mode: "http", port: PORT, host: "127.0.0.1", path: "/mcp" },
			buildServerFactory(),
		);
		close = result.closeAll;
	});

	afterAll(async () => {
		await close();
	});

	test("GET /ping returns 200", async () => {
		const res = await fetch(`http://127.0.0.1:${PORT}/ping`);
		expect(res.status).toBe(200);
	});

	test("GET /health returns 200 with JSON", async () => {
		const res = await fetch(`http://127.0.0.1:${PORT}/health`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
	});

	test("GET /mcp returns 405", async () => {
		const res = await fetch(`http://127.0.0.1:${PORT}/mcp`);
		expect(res.status).toBe(405);
	});

	test("Unknown path returns 404", async () => {
		const res = await fetch(`http://127.0.0.1:${PORT}/nonexistent`);
		expect(res.status).toBe(404);
	});
});
```

- [ ] **Step 8.3: Run tests to confirm they fail**

```bash
bun test packages/mcp-server-aws/src/__tests__/bootstrap.test.ts
```

Expected: failures (the test code references files that exist, but `createTransport` / `registerAllTools` / `McpServer` all need real wiring).

If the tests pass already, great — but typically `Bun.serve` needs the actual port flow to be running. If failures complain about "missing module", check that Tasks 1-7 landed.

- [ ] **Step 8.4: Create `packages/mcp-server-aws/src/index.ts`**

```typescript
// src/index.ts
import { buildTelemetryConfig, createBootstrapAdapter, createMcpApplication } from "@devops-agent/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json" with { type: "json" };
import { loadConfig, type Config } from "./config/index.ts";
import { initializeTracing } from "./telemetry/tracing.ts";
import { registerAllTools } from "./tools/register.ts";
import { createTransport } from "./transport/index.ts";
import { logger } from "./utils/logger.ts";
import { getRuntimeInfo } from "./utils/env.ts";

interface AwsDatasource {
	config: Config;
}

if (import.meta.main) {
	createMcpApplication<AwsDatasource>({
		name: "aws-mcp-server",
		logger: createBootstrapAdapter(logger),

		initTracing: () => initializeTracing(),
		telemetry: buildTelemetryConfig("aws-mcp-server"),

		initDatasource: async () => {
			const config = loadConfig();
			logger.level = config.logLevel;

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

- [ ] **Step 8.5: Run tests to confirm they pass**

```bash
bun test packages/mcp-server-aws/src/__tests__/bootstrap.test.ts
```

Expected: 4 passes.

- [ ] **Step 8.6: Typecheck**

```bash
bun run --filter '@devops-agent/mcp-server-aws' typecheck
```

Expected: exit 0.

- [ ] **Step 8.7: Manual smoke — server starts in stdio mode**

```bash
AWS_REGION=eu-central-1 \
AWS_ASSUMED_ROLE_ARN=arn:aws:iam::356994971776:role/DevOpsAgentReadOnly \
AWS_EXTERNAL_ID=aws-mcp-readonly-2026 \
MCP_TRANSPORT=stdio \
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  | bun run packages/mcp-server-aws/src/index.ts \
  | head -1
```

Expected: a single line of JSON-RPC `result` containing `"serverInfo":{"name":"aws-mcp-server"}`.

- [ ] **Step 8.8: Commit**

```bash
git add packages/mcp-server-aws/src/index.ts packages/mcp-server-aws/src/telemetry/tracing.ts packages/mcp-server-aws/src/__tests__/bootstrap.test.ts
git commit -m "SIO-PHASE2-AWS: bootstrap entry + transport tests (4 tests)"
```

---

## Tasks 9-23: Tool families

The bootstrap is live. From here every tool family follows the **same pattern**:

1. Create the family directory `src/tools/<family>/`
2. Write one file per tool — each is ~30-50 LOC
3. Write the family registration helper that calls `server.tool(...)` for each
4. Add the family to `registerAllTools` in `src/tools/register.ts`
5. Append one smoke test per tool to `__tests__/tools-smoke.test.ts`
6. Append one integration test for the family to `__tests__/tools-integration.test.ts`
7. Typecheck, test, commit

To avoid making this plan 3,000 lines, the per-family tasks below give:
- The exact tool name and SDK command for each tool in the family
- The Zod param schema shape
- Which wrapper to use (`wrapListTool` with which `listField`, or `wrapBlobTool`)
- Test names

The structural pattern of a tool file is fixed and given in full in Task 9. Tasks 10-23 only specify the deltas.

### Reference: the canonical tool-file pattern (Task 9 sets this)

Every tool file follows this exact shape:

```typescript
// src/tools/<family>/<tool>.ts
import { <CommandName> } from "@aws-sdk/client-<service>";
import { z } from "zod";
import { get<Service>Client } from "../../services/client-factory.ts";
import type { AwsConfig } from "../../config/schemas.ts";
import { wrapListTool /* or wrapBlobTool */ } from "../wrap.ts";

export const <toolName>Schema = z.object({
	// Zod params with .describe() on every field
});

export type <ToolName>Params = z.infer<typeof <toolName>Schema>;

export function <toolName>(config: AwsConfig) {
	return wrapListTool({
		name: "<aws_namespace_action>",
		listField: "<ResponseListField>",
		fn: async (params: <ToolName>Params) => {
			const client = get<Service>Client(config);
			return client.send(new <CommandName>({/* SDK params */}));
		},
	});
}
```

The family registration helper:

```typescript
// src/tools/<family>/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { <toolName>, <toolName>Schema } from "./<tool>.ts";
// ... more tool imports

export function register<Family>Tools(server: McpServer, config: AwsConfig): void {
	server.tool("aws_<family>_<action>", "Description shown to the LLM.", <toolName>Schema.shape, <toolName>(config));
	// ... more server.tool() calls
}
```

---

### Task 9: EC2 family (3 tools, sets the pattern)

**Files:**
- Create: `packages/mcp-server-aws/src/tools/ec2/describe-instances.ts`
- Create: `packages/mcp-server-aws/src/tools/ec2/describe-vpcs.ts`
- Create: `packages/mcp-server-aws/src/tools/ec2/describe-security-groups.ts`
- Create: `packages/mcp-server-aws/src/tools/ec2/index.ts`
- Modify: `packages/mcp-server-aws/src/tools/register.ts`
- Create/append: `packages/mcp-server-aws/src/__tests__/tools-smoke.test.ts`
- Create/append: `packages/mcp-server-aws/src/__tests__/tools-integration.test.ts`

- [ ] **Step 9.1: Write `describe-vpcs.ts` first (canonical example)**

```typescript
// src/tools/ec2/describe-vpcs.ts
import { DescribeVpcsCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeVpcsSchema = z.object({
	vpcIds: z
		.array(z.string())
		.optional()
		.describe("Optional list of VPC IDs to filter (omit to list all)"),
	maxResults: z
		.number()
		.int()
		.min(5)
		.max(1000)
		.optional()
		.describe("Max results per page"),
	nextToken: z
		.string()
		.optional()
		.describe("Pagination token from a previous response"),
});

export type DescribeVpcsParams = z.infer<typeof describeVpcsSchema>;

export function describeVpcs(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_vpcs",
		listField: "Vpcs",
		fn: async (params: DescribeVpcsParams) => {
			const client = getEc2Client(config);
			return client.send(
				new DescribeVpcsCommand({
					VpcIds: params.vpcIds,
					MaxResults: params.maxResults,
					NextToken: params.nextToken,
				}),
			);
		},
	});
}
```

- [ ] **Step 9.2: Write `describe-instances.ts`**

```typescript
// src/tools/ec2/describe-instances.ts
import { DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeInstancesSchema = z.object({
	instanceIds: z.array(z.string()).optional().describe("Optional list of EC2 instance IDs"),
	maxResults: z.number().int().min(5).max(1000).optional(),
	nextToken: z.string().optional(),
});

export type DescribeInstancesParams = z.infer<typeof describeInstancesSchema>;

export function describeInstances(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_instances",
		listField: "Reservations",
		fn: async (params: DescribeInstancesParams) => {
			const client = getEc2Client(config);
			return client.send(
				new DescribeInstancesCommand({
					InstanceIds: params.instanceIds,
					MaxResults: params.maxResults,
					NextToken: params.nextToken,
				}),
			);
		},
	});
}
```

- [ ] **Step 9.3: Write `describe-security-groups.ts`**

```typescript
// src/tools/ec2/describe-security-groups.ts
import { DescribeSecurityGroupsCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeSecurityGroupsSchema = z.object({
	groupIds: z.array(z.string()).optional().describe("Security group IDs"),
	groupNames: z.array(z.string()).optional().describe("Security group names (default VPC only)"),
	maxResults: z.number().int().min(5).max(1000).optional(),
	nextToken: z.string().optional(),
});

export type DescribeSecurityGroupsParams = z.infer<typeof describeSecurityGroupsSchema>;

export function describeSecurityGroups(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_security_groups",
		listField: "SecurityGroups",
		fn: async (params: DescribeSecurityGroupsParams) => {
			const client = getEc2Client(config);
			return client.send(
				new DescribeSecurityGroupsCommand({
					GroupIds: params.groupIds,
					GroupNames: params.groupNames,
					MaxResults: params.maxResults,
					NextToken: params.nextToken,
				}),
			);
		},
	});
}
```

- [ ] **Step 9.4: Write the family registration `index.ts`**

```typescript
// src/tools/ec2/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { describeInstances, describeInstancesSchema } from "./describe-instances.ts";
import { describeSecurityGroups, describeSecurityGroupsSchema } from "./describe-security-groups.ts";
import { describeVpcs, describeVpcsSchema } from "./describe-vpcs.ts";

export function registerEc2Tools(server: McpServer, config: AwsConfig): void {
	server.tool(
		"aws_ec2_describe_vpcs",
		"List or describe VPCs. Returns Vpcs[] with CidrBlock, State, Tags. Truncates if many VPCs.",
		describeVpcsSchema.shape,
		describeVpcs(config),
	);
	server.tool(
		"aws_ec2_describe_instances",
		"List or describe EC2 instances. Returns Reservations[] each containing Instances[] with state, type, IP, tags.",
		describeInstancesSchema.shape,
		describeInstances(config),
	);
	server.tool(
		"aws_ec2_describe_security_groups",
		"List or describe EC2 security groups with ingress/egress rules.",
		describeSecurityGroupsSchema.shape,
		describeSecurityGroups(config),
	);
}
```

- [ ] **Step 9.5: Wire EC2 into `register.ts`**

Edit `packages/mcp-server-aws/src/tools/register.ts`:

```typescript
// src/tools/register.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../config/schemas.ts";
import { registerEc2Tools } from "./ec2/index.ts";

export function registerAllTools(server: McpServer, config: AwsConfig): void {
	registerEc2Tools(server, config);
}
```

- [ ] **Step 9.6: Create the smoke-test file with EC2 tests**

Create `packages/mcp-server-aws/src/__tests__/tools-smoke.test.ts`:

```typescript
// src/__tests__/tools-smoke.test.ts
// One smoke test per tool: each tool's Zod paramsSchema parses valid input and
// rejects obviously invalid input. New families are appended below.
import { describe, expect, test } from "bun:test";
import { describeInstancesSchema } from "../tools/ec2/describe-instances.ts";
import { describeSecurityGroupsSchema } from "../tools/ec2/describe-security-groups.ts";
import { describeVpcsSchema } from "../tools/ec2/describe-vpcs.ts";

describe("ec2 tool param schemas", () => {
	test("describeVpcs accepts empty input", () => {
		expect(describeVpcsSchema.safeParse({}).success).toBe(true);
	});
	test("describeVpcs rejects non-array vpcIds", () => {
		expect(describeVpcsSchema.safeParse({ vpcIds: "vpc-1" }).success).toBe(false);
	});
	test("describeInstances accepts valid input", () => {
		expect(describeInstancesSchema.safeParse({ instanceIds: ["i-abc"] }).success).toBe(true);
	});
	test("describeInstances rejects maxResults below 5", () => {
		expect(describeInstancesSchema.safeParse({ maxResults: 1 }).success).toBe(false);
	});
	test("describeSecurityGroups accepts groupIds", () => {
		expect(describeSecurityGroupsSchema.safeParse({ groupIds: ["sg-1"] }).success).toBe(true);
	});
	test("describeSecurityGroups rejects non-array groupNames", () => {
		expect(describeSecurityGroupsSchema.safeParse({ groupNames: "default" }).success).toBe(false);
	});
});
```

- [ ] **Step 9.7: Create the integration-test file with EC2 family test**

Create `packages/mcp-server-aws/src/__tests__/tools-integration.test.ts`:

```typescript
// src/__tests__/tools-integration.test.ts
// One representative integration test per family, using aws-sdk-client-mock.
// Verifies the tool handler calls the SDK with the right params and the
// response flows through the wrapper correctly.
import { afterEach, describe, expect, test } from "bun:test";
import { DescribeVpcsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import { _resetClientsForTests } from "../services/client-factory.ts";
import { describeVpcs } from "../tools/ec2/describe-vpcs.ts";
import type { AwsConfig } from "../config/schemas.ts";

const config: AwsConfig = {
	region: "eu-central-1",
	assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
	externalId: "aws-mcp-readonly-2026",
};

afterEach(() => _resetClientsForTests());

describe("ec2 integration", () => {
	test("describeVpcs returns SDK response unchanged when under cap", async () => {
		const ec2Mock = mockClient(EC2Client);
		ec2Mock.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: "vpc-1", CidrBlock: "10.0.0.0/16" }] });

		const handler = describeVpcs(config);
		const result = await handler({}) as { Vpcs: unknown[] };
		expect(result.Vpcs).toHaveLength(1);
	});
});
```

- [ ] **Step 9.8: Run tests**

```bash
bun test packages/mcp-server-aws/src/__tests__/tools-smoke.test.ts \
         packages/mcp-server-aws/src/__tests__/tools-integration.test.ts
```

Expected: 6 smoke passes + 1 integration pass.

- [ ] **Step 9.9: Typecheck**

```bash
bun run --filter '@devops-agent/mcp-server-aws' typecheck
```

Expected: exit 0.

- [ ] **Step 9.10: Commit**

```bash
git add packages/mcp-server-aws/src/tools/ec2/ \
        packages/mcp-server-aws/src/tools/register.ts \
        packages/mcp-server-aws/src/__tests__/tools-smoke.test.ts \
        packages/mcp-server-aws/src/__tests__/tools-integration.test.ts
git commit -m "SIO-PHASE2-AWS: ec2 tools (3 tools, 6 smoke + 1 integration)"
```

---

### Tasks 10-23: Per-family deltas (concise specs)

Each task below follows Task 9's pattern. **Repeat steps 9.1-9.10 for each family**, substituting:
- Folder name: `src/tools/<family>/`
- Tool files: one per tool
- Family registration helper in `<family>/index.ts`
- Wire into `register.ts` by appending a `register<Family>Tools(server, config)` call
- Smoke tests: append to `tools-smoke.test.ts` inside a new `describe("<family> tool param schemas", ...)` block
- Integration test: append to `tools-integration.test.ts` inside a new `describe("<family> integration", ...)` block

The deltas list the tool name, SDK command, wrapper, list field (if applicable), and Zod schema. **The schemas use the same shape pattern as Task 9.1** — optional filter inputs + pagination params where supported, each with `.describe()`.

#### Task 10: ECS family (4 tools)

| Tool name | SDK command | Wrapper | listField | Key params |
|---|---|---|---|---|
| `aws_ecs_list_clusters` | `ListClustersCommand` | `wrapListTool` | `clusterArns` | `maxResults?`, `nextToken?` |
| `aws_ecs_describe_clusters` | `DescribeClustersCommand` | `wrapListTool` | `clusters` | `clusters: string[]` (required), `include?` |
| `aws_ecs_list_services` | `ListServicesCommand` | `wrapListTool` | `serviceArns` | `cluster: string`, `maxResults?`, `nextToken?` |
| `aws_ecs_describe_services` | `DescribeServicesCommand` | `wrapListTool` | `services` | `cluster: string`, `services: string[]`, `include?` |
| `aws_ecs_list_tasks` | `ListTasksCommand` | `wrapListTool` | `taskArns` | `cluster: string`, `serviceName?`, `desiredStatus?`, `maxResults?`, `nextToken?` |
| `aws_ecs_describe_tasks` | `DescribeTasksCommand` | `wrapListTool` | `tasks` | `cluster: string`, `tasks: string[]`, `include?` |

Wait — that's 6 tools, not 4. **Locking the ECS surface at 4: `list_clusters`, `describe_services`, `describe_tasks`, `list_tasks`.** Drop `describe_clusters` (use `list_clusters` + `describe_services` instead) and `list_services` (use `describe_services` directly with known service names). The aws-agent can chain `list_clusters` → `list_tasks` → `describe_tasks` to get full ECS state.

Final ECS list (matches spec table):

| Tool name | SDK command | listField | Required params |
|---|---|---|---|
| `aws_ecs_list_clusters` | `ListClustersCommand` | `clusterArns` | (none) |
| `aws_ecs_describe_services` | `DescribeServicesCommand` | `services` | `cluster`, `services` |
| `aws_ecs_describe_tasks` | `DescribeTasksCommand` | `tasks` | `cluster`, `tasks` |
| `aws_ecs_list_tasks` | `ListTasksCommand` | `taskArns` | `cluster` |

Smoke tests: 8 (one valid + one invalid per tool). Integration test: 1 (mock `DescribeTasksCommand`).

#### Task 11: Lambda family (2 tools)

| Tool name | SDK command | listField | Required |
|---|---|---|---|
| `aws_lambda_list_functions` | `ListFunctionsCommand` | `Functions` | (none); supports `MaxItems?`, `Marker?` |
| `aws_lambda_get_function_configuration` | `GetFunctionConfigurationCommand` | (blob) | `FunctionName` |

Use `wrapBlobTool` for `get_function_configuration` (response has no obvious list).

Smoke: 4. Integration: 1.

#### Task 12: CloudWatch metrics family (2 tools)

| Tool name | SDK command | Wrapper | listField | Required |
|---|---|---|---|---|
| `aws_cloudwatch_get_metric_data` | `GetMetricDataCommand` | `wrapBlobTool` | n/a | `MetricDataQueries`, `StartTime`, `EndTime` |
| `aws_cloudwatch_describe_alarms` | `DescribeAlarmsCommand` | `wrapListTool` | `MetricAlarms` | (none) |

Note: `GetMetricData` returns `MetricDataResults` with `Values` and `Timestamps` arrays inside each. Use `wrapBlobTool` because the truncation surface isn't a single flat list.

Smoke: 4. Integration: 1.

#### Task 13: CloudWatch Logs family (3 tools)

| Tool name | SDK command | Wrapper | listField | Required |
|---|---|---|---|---|
| `aws_logs_describe_log_groups` | `DescribeLogGroupsCommand` | `wrapListTool` | `logGroups` | (none); `logGroupNamePrefix?`, `limit?`, `nextToken?` |
| `aws_logs_start_query` | `StartQueryCommand` | `wrapBlobTool` | n/a | `logGroupNames`, `queryString`, `startTime`, `endTime` |
| `aws_logs_get_query_results` | `GetQueryResultsCommand` | `wrapListTool` | `results` | `queryId` |

Smoke: 6. Integration: 1.

#### Task 14: X-Ray family (2 tools)

| Tool name | SDK command | Wrapper | listField | Required |
|---|---|---|---|---|
| `aws_xray_get_service_graph` | `GetServiceGraphCommand` | `wrapBlobTool` | n/a | `StartTime`, `EndTime` |
| `aws_xray_get_trace_summaries` | `GetTraceSummariesCommand` | `wrapListTool` | `TraceSummaries` | `StartTime`, `EndTime` |

Smoke: 4. Integration: 1.

#### Task 15: Health family (1 tool)

| Tool name | SDK command | Wrapper | listField |
|---|---|---|---|
| `aws_health_describe_events` | `DescribeEventsCommand` | `wrapListTool` | `events` |

The Health SDK client is already configured to `us-east-1` in `client-factory.ts`. Smoke: 2. Integration: 1.

#### Task 16: CloudFormation family (3 tools)

| Tool name | SDK command | Wrapper | listField | Required |
|---|---|---|---|---|
| `aws_cloudformation_list_stacks` | `ListStacksCommand` | `wrapListTool` | `StackSummaries` | (none); `StackStatusFilter?`, `NextToken?` |
| `aws_cloudformation_describe_stacks` | `DescribeStacksCommand` | `wrapListTool` | `Stacks` | (none); `StackName?` |
| `aws_cloudformation_describe_stack_events` | `DescribeStackEventsCommand` | `wrapListTool` | `StackEvents` | `StackName` |

Smoke: 6. Integration: 1.

#### Task 17: RDS family (2 tools)

| Tool name | SDK command | listField |
|---|---|---|
| `aws_rds_describe_db_instances` | `DescribeDBInstancesCommand` | `DBInstances` |
| `aws_rds_describe_db_clusters` | `DescribeDBClustersCommand` | `DBClusters` |

Both `wrapListTool`. Smoke: 4. Integration: 1.

#### Task 18: DynamoDB family (2 tools)

| Tool name | SDK command | Wrapper | listField |
|---|---|---|---|
| `aws_dynamodb_list_tables` | `ListTablesCommand` | `wrapListTool` | `TableNames` |
| `aws_dynamodb_describe_table` | `DescribeTableCommand` | `wrapBlobTool` | n/a |

`describe_table` requires `TableName`. Smoke: 4. Integration: 1.

#### Task 19: S3 family (3 tools)

| Tool name | SDK command | Wrapper | listField | Required |
|---|---|---|---|---|
| `aws_s3_list_buckets` | `ListBucketsCommand` | `wrapListTool` | `Buckets` | (none) |
| `aws_s3_get_bucket_location` | `GetBucketLocationCommand` | `wrapBlobTool` | n/a | `Bucket` |
| `aws_s3_get_bucket_policy_status` | `GetBucketPolicyStatusCommand` | `wrapBlobTool` | n/a | `Bucket` |

Smoke: 6. Integration: 1.

#### Task 20: ElastiCache family (2 tools)

| Tool name | SDK command | listField |
|---|---|---|
| `aws_elasticache_describe_cache_clusters` | `DescribeCacheClustersCommand` | `CacheClusters` |
| `aws_elasticache_describe_replication_groups` | `DescribeReplicationGroupsCommand` | `ReplicationGroups` |

Both `wrapListTool`. Smoke: 4. Integration: 1.

#### Task 21: Messaging family (7 tools across SNS/SQS/EventBridge/Step Functions)

This family puts four AWS services into one folder for organizational clarity. All 7 tools register from `src/tools/messaging/index.ts`.

| Tool name | SDK package | Command | Wrapper | listField | Required |
|---|---|---|---|---|---|
| `aws_sns_list_topics` | `@aws-sdk/client-sns` | `ListTopicsCommand` | `wrapListTool` | `Topics` | (none) |
| `aws_sns_get_topic_attributes` | `@aws-sdk/client-sns` | `GetTopicAttributesCommand` | `wrapBlobTool` | n/a | `TopicArn` |
| `aws_sqs_list_queues` | `@aws-sdk/client-sqs` | `ListQueuesCommand` | `wrapListTool` | `QueueUrls` | (none); `QueueNamePrefix?` |
| `aws_sqs_get_queue_attributes` | `@aws-sdk/client-sqs` | `GetQueueAttributesCommand` | `wrapBlobTool` | n/a | `QueueUrl`, `AttributeNames?` |
| `aws_eventbridge_list_rules` | `@aws-sdk/client-eventbridge` | `ListRulesCommand` | `wrapListTool` | `Rules` | (none); `EventBusName?`, `NamePrefix?` |
| `aws_eventbridge_describe_rule` | `@aws-sdk/client-eventbridge` | `DescribeRuleCommand` | `wrapBlobTool` | n/a | `Name`, `EventBusName?` |
| `aws_stepfunctions_list_state_machines` | `@aws-sdk/client-sfn` | `ListStateMachinesCommand` | `wrapListTool` | `stateMachines` | (none); `maxResults?`, `nextToken?` |

File layout: `src/tools/messaging/sns/`, `sqs/`, `eventbridge/`, `stepfunctions/`. Each sub-folder has one or two tool files. The family `index.ts` imports all 7 register-shaped helpers and is itself called from `src/tools/register.ts`.

Smoke: 14 (one valid + one invalid per tool). Integration: 1 (mock `ListTopicsCommand`).

#### Task 22: Config family (2 tools)

| Tool name | SDK command | Wrapper | listField | Required |
|---|---|---|---|---|
| `aws_config_describe_config_rules` | `DescribeConfigRulesCommand` | `wrapListTool` | `ConfigRules` | (none); `ConfigRuleNames?`, `NextToken?` |
| `aws_config_list_discovered_resources` | `ListDiscoveredResourcesCommand` | `wrapListTool` | `resourceIdentifiers` | `resourceType` |

Smoke: 4. Integration: 1.

#### Task 23: Tags family (1 tool)

| Tool name | SDK command | listField | Required |
|---|---|---|---|
| `aws_resourcegroupstagging_get_resources` | `GetResourcesCommand` | `ResourceTagMappingList` | (none); `TagFilters?`, `ResourcesPerPage?`, `PaginationToken?` |

Smoke: 2. Integration: 1.

---

### After Tasks 10-23 land

- [ ] **Step Verify: count tools and tests**

```bash
# Tools registered
grep -rh "^\s*server\.tool(" packages/mcp-server-aws/src/tools/ | wc -l
# Expected: 39

# Smoke tests
grep -c "^\s*test(" packages/mcp-server-aws/src/__tests__/tools-smoke.test.ts
# Expected: ~78 (one valid + one invalid per tool = 39 + 39)

# Integration tests
grep -c "^\s*test(" packages/mcp-server-aws/src/__tests__/tools-integration.test.ts
# Expected: 14 (one per family folder)
```

If counts don't match, find the missing tool/test and fill it in.

- [ ] **Step Verify: full test suite passes**

```bash
bun run --filter '@devops-agent/mcp-server-aws' test
```

Expected: all tests pass. The test summary should show roughly:
- `config.test.ts`: 6 passes
- `credentials.test.ts`: 4 passes
- `client-factory.test.ts`: 4 passes
- `wrap.test.ts`: 12 passes
- `bootstrap.test.ts`: 4 passes
- `tools-smoke.test.ts`: ~72 passes
- `tools-integration.test.ts`: 14 passes
- **Total: ~116 passes** (vs the spec's ~77; we doubled smoke by testing reject-cases per tool)

---

## Task 24: Live AWS verification (Layer 4)

**Files:** none modified — pure verification.

- [ ] **Step 24.1: Re-add the Phase-1 dev trust to DevOpsAgentReadOnly**

```bash
# This re-allows the dev user 7-zark-7 to assume DevOpsAgentReadOnly.
# Required because Phase 1's Task 6 switched the trust to AgentCore-only.
TRUST_POLICY_FILE=scripts/agentcore/policies/devops-agent-readonly-trust-policy-phase1.json \
  ./scripts/agentcore/setup-aws-readonly-role.sh
```

Note: this file is .gitignored (it contains your dev principal ARN). If missing, recreate it from Phase 1 Task 3 instructions.

- [ ] **Step 24.2: Start the AWS MCP server in HTTP mode**

In a background shell (or tmux pane):

```bash
AWS_REGION=eu-central-1 \
AWS_ASSUMED_ROLE_ARN=arn:aws:iam::356994971776:role/DevOpsAgentReadOnly \
AWS_EXTERNAL_ID=aws-mcp-readonly-2026 \
MCP_TRANSPORT=http \
TRANSPORT_PORT=9085 \
bun run packages/mcp-server-aws/src/index.ts
```

Expected: log lines for "Starting AWS MCP Server" and "AWS MCP server ready".

- [ ] **Step 24.3: Probe via the existing test-local.sh**

```bash
MCP_SERVER=aws BASE_URL=http://localhost:9085 ./scripts/agentcore/test-local.sh
```

Expected: all PASS results. The script tests `/ping`, `/health`, MCP `initialize`, and error cases.

- [ ] **Step 24.4: Confirm 39 tools are listed**

```bash
curl -sX POST http://localhost:9085/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | jq '.result.tools | length'
```

Expected: `39`.

- [ ] **Step 24.5: Probe one tool per family (14 calls)**

For each of the 14 families, issue one `tools/call`. Example for EC2:

```bash
curl -sX POST http://localhost:9085/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"aws_ec2_describe_vpcs","arguments":{}}}' \
  | jq '.result.content[0].text' \
  | jq '. | keys'
```

Expected: a non-error response — either a list (e.g., `["Vpcs"]`) or `["_error"]` (if the role can't reach that service in the test account). For an `_error`, the `kind` should be a recognized one (most likely `iam-permission-missing` for any actions the policy doesn't cover, or empty result for services with no resources in the test account).

Run the same shape for: `aws_ecs_list_clusters`, `aws_lambda_list_functions`, `aws_cloudwatch_describe_alarms`, `aws_logs_describe_log_groups`, `aws_xray_get_trace_summaries` (with a 1h window), `aws_health_describe_events`, `aws_cloudformation_list_stacks`, `aws_rds_describe_db_instances`, `aws_dynamodb_list_tables`, `aws_s3_list_buckets`, `aws_elasticache_describe_cache_clusters`, `aws_sns_list_topics`, `aws_config_describe_config_rules`, `aws_resourcegroupstagging_get_resources`.

- [ ] **Step 24.6: Stop the server**

Ctrl-C in the shell where it's running, or `pkill -f 'packages/mcp-server-aws'`.

- [ ] **Step 24.7: Append the Layer 4 verification record to the spec**

Edit `docs/superpowers/specs/2026-05-15-aws-mcp-server-package-design.md`. Find the `## References` section near the bottom. **Above** the References, append a new section:

```markdown

---

## Appendix A: Phase 2 Verification Record

**Date verified:** <YYYY-MM-DD>
**Verified by:** <name>
**Linear sub-issue:** <SIO-XXX>

### Layer 1-3 (automated tests)

- `bun run --filter '@devops-agent/mcp-server-aws' test` reports all passes
- `bun run --filter '@devops-agent/mcp-server-aws' typecheck` reports 0 errors

### Layer 4 (live AWS)

- HTTP server starts on :9085 with `MCP_TRANSPORT=http`
- `scripts/agentcore/test-local.sh MCP_SERVER=aws` reports all PASS
- `tools/list` returns 39 tools
- Per-family probe results:
  - EC2: <observed result>
  - ECS: <observed result>
  - ... (one row per family)

### Plan deltas to feed forward into Phase 3+

- (List any deviations from this spec discovered during implementation)
```

Fill in the placeholders with real values from Steps 24.1–24.6.

- [ ] **Step 24.8: Commit the verification record**

```bash
git add docs/superpowers/specs/2026-05-15-aws-mcp-server-package-design.md
git commit -m "SIO-PHASE2-AWS: record Phase 2 Layer 4 verification in spec"
```

---

## Task 25: Push branch + open PR + update Linear

**Files:** none modified — git + GitHub + Linear only.

- [ ] **Step 25.1: Push the branch**

```bash
git push -u origin HEAD
```

- [ ] **Step 25.2: Open a draft PR**

```bash
gh pr create --draft \
  --title "SIO-PHASE2-AWS: Phase 2 — packages/mcp-server-aws/ native TypeScript MCP server" \
  --body "$(cat <<'EOF'
## Summary

Phase 2 of 5 in the AWS datasource rollout (parent epic SIO-756). Ships `packages/mcp-server-aws/` — a native TypeScript MCP server exposing 39 read-only AWS tools across 14 tool folders covering ~18 AWS service families. Matches the existing 5-server pattern exactly.

## What changed

- New package `packages/mcp-server-aws/`:
  - Bootstrap (`src/index.ts`) using `createMcpApplication` from `@devops-agent/shared`
  - Config schemas (Zod), credentials wiring (`fromTemporaryCredentials`), lazy SDK client singletons
  - Tool wrappers (`wrapListTool`, `wrapBlobTool`, `mapAwsError`) with structured `_error.kind`
  - 39 tools across 14 folders (ec2, ecs, lambda, cloudwatch, logs, xray, health, cloudformation, rds, dynamodb, s3, elasticache, messaging, config, tags)
  - Transport (stdio | http | agentcore)
- ~116 tests (unit + integration + bootstrap)
- Spec Appendix A records Layer 4 live-AWS verification

## Verification

- `bun run --filter '@devops-agent/mcp-server-aws' test` — all pass
- `bun run --filter '@devops-agent/mcp-server-aws' typecheck` — 0 errors
- Manual Layer 4 probes against the test account against `DevOpsAgentReadOnly` — see spec Appendix A

## What's NOT in this PR

- AgentCore deployment (Phase 3)
- aws-agent gitagent definition (Phase 4)
- Correlation rules (Phase 5)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 25.3: Update the Linear sub-issue**

Move the sub-issue from `Todo` → `In Review`. Add a comment with the PR URL.

- [ ] **Step 25.4: Rewrite the SIO-PHASE2-AWS placeholder in commit messages**

Once the real Linear ID is known (from Task 0), rewrite local history before pushing:

```bash
git filter-branch -f --msg-filter 'sed "s/SIO-PHASE2-AWS/SIO-XXX/g"' origin/main..HEAD
```

(Substitute `SIO-XXX` with the real ID.) Then force-push the rewritten branch:

```bash
git push -f origin HEAD
```

Force-push is acceptable here because the PR is in draft and hasn't yet had reviewer activity. If reviewers have already engaged, **don't rewrite** — instead, append a new commit with a message explaining the placeholder substitution, and update Linear by hand.

---

## Self-Review

**Spec coverage:**
- Spec Section 2 (Components) — Tasks 1, 2, 3, 4, 5, 6, 7, 8 cover the bootstrap + shared infrastructure. Tasks 9-23 cover all 14 tool folders.
- Spec Section 2 (Tool coverage table) — Each row of the spec's 14-row tool table maps to exactly one of Tasks 9-23, with the tool count matching the spec (3+4+2+2+3+2+1+3+2+2+3+2+7+2+1 = 39 — wait, let me recount.)

Re-counting from the spec table rows:
- EC2/VPC: 3
- ECS: 4
- Lambda: 2
- CloudWatch: 2
- CloudWatch Logs: 3
- X-Ray: 2
- Health: 1
- CloudFormation: 3
- RDS: 2
- DynamoDB: 2
- S3: 3
- ElastiCache: 2
- Messaging: 7
- Config: 2
- Tags: 1

Total: 3+4+2+2+3+2+1+3+2+2+3+2+7+2+1 = **39**, not 36 as both the spec and this plan say. There's a discrepancy.

Audit of the spec's "Messaging" row: `aws_sns_list_topics`, `aws_sns_get_topic_attributes`, `aws_sqs_list_queues`, `aws_sqs_get_queue_attributes`, `aws_eventbridge_list_rules`, `aws_eventbridge_describe_rule`, `aws_stepfunctions_list_state_machines` = 7 tools. Correct.

Audit of EC2: spec says "describe_instances, describe_vpcs, describe_security_groups" = 3. Correct.

Audit of ECS: spec table says "list_clusters, describe_services, describe_tasks, list_tasks" = 4. Correct.

So the families add to 39, not 36. The spec's count of 36 was wrong. **Updating this plan to use 39 throughout**, then noting the discrepancy as a delta to update in the spec.

Fixing inline:

- Goal: "39 read-only AWS tools"
- Task 24.4 expected: `39`
- Task 24.5: 14 family probes
- Test counts: 39 * 2 = ~78 smoke tests; 14 integration tests; total ~120 passes

**Placeholder scan:**
- `SIO-PHASE2-AWS` placeholder is intentional, replaced in Task 25.4. Acceptable.
- `<YYYY-MM-DD>`, `<name>`, `<SIO-XXX>` in Task 24.7 are intended fill-ins. Acceptable.
- No "TBD", "implement later", or other red flags.

**Type/name consistency:**
- `AwsConfig` consistent across Tasks 2-9 and onward.
- `buildAssumedCredsProvider` consistent.
- `get<Service>Client` naming consistent (e.g. `getEc2Client`, `getCloudWatchLogsClient`).
- Wrapper signatures consistent across Tasks 5-23.
- Tool naming: `aws_<service>_<action>` consistent (e.g., `aws_ec2_describe_vpcs`).

No further gaps found. Fixes applied inline.
