# AgentCore Proxy Config Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `startAgentCoreProxy(config: ProxyConfig)` accept its configuration as a function argument and eliminate the module-scoped `cachedCreds` singleton, so two MCP proxies (Kafka + AWS) can run side-by-side in the same `bun run dev` process with isolated credentials and isolated ARNs.

**Architecture:** Refactor `packages/shared/src/agentcore-proxy.ts` to remove `process.env.AGENTCORE_*` reads from the proxy body, move the credential cache into the function closure (per-handle), add a new `loadProxyConfigFromEnv(prefix)` helper that reads `<PREFIX>_AGENTCORE_*` env vars, then migrate `mcp-server-aws/index.ts` and `mcp-server-kafka/index.ts` to the new API. Breaking change: generic `AGENTCORE_*` env vars stop working.

**Tech Stack:** Bun, TypeScript strict, `Bun.serve`, `Bun.spawn` for AWS CLI shellout. No new deps.

**Spec:** [docs/superpowers/specs/2026-05-16-agentcore-proxy-config-isolation.md](../specs/2026-05-16-agentcore-proxy-config-isolation.md)

**Linear:** Create a new Linear issue (not a sub-issue of SIO-756 — this is a standalone refactor surfacing a Phase 3+4 architectural bug) before starting Task 1. Commits use that issue ID (assume `SIO-767` below — replace with the real ID after creation).

---

## File Map

**New (1 file)**
- `packages/shared/src/__tests__/agentcore-config.test.ts` — 8 unit tests for `loadProxyConfigFromEnv`

**Modified (5 files)**
- `packages/shared/src/agentcore-proxy.ts` — refactor: remove `readProxyConfig`/`cachedCreds`/`credsExpiresAt`/`clearCredentialCache`/`getCredentials`; add `ProxyConfig`/`ProxyCredentials` interfaces; add `loadProxyConfigFromEnv(prefix)`; change `startAgentCoreProxy()` to `startAgentCoreProxy(config: ProxyConfig)` with closure-scoped credential cache; remove standalone-run block at line 612.
- `packages/shared/src/index.ts` — export the new `ProxyConfig`, `ProxyCredentials`, `loadProxyConfigFromEnv`. Remove `clearCredentialCache` export.
- `packages/mcp-server-aws/src/index.ts` — call `loadProxyConfigFromEnv("AWS")` + `startAgentCoreProxy(config)`. Remove `AWS_AGENTCORE_RUNTIME_ARN ?? AGENTCORE_RUNTIME_ARN` fallback and the `process.env.AGENTCORE_*` mutations.
- `packages/mcp-server-kafka/src/index.ts` — same pattern, prefix `"KAFKA"`.
- `.env.example` — replace the generic AgentCore block (if any) with per-server template documenting `KAFKA_AGENTCORE_*` and `AWS_AGENTCORE_*` env vars.

**Modified tests (2 files)**
- `packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts` — remove `clearCredentialCache` import + calls; replace `process.env.AGENTCORE_*` setup with explicit `ProxyConfig` construction; pass config to `startAgentCoreProxy(config)`.
- `packages/shared/src/__tests__/agentcore-proxy-retry.test.ts` — same.

No deletions. No new dependencies.

---

## Pre-Task: Create Linear issue and worktree

- [ ] **Step 1: Create Linear issue**

Use the Linear MCP. Title: `AgentCore proxy config isolation`. State: `In Progress` (NOT `Done`). Project: `DevOps Incident Analyzer`. Team: `Siobytes`. Priority: Medium. **No parent** — this is a standalone refactor, not a sub-issue of SIO-756. Description: link the spec at `docs/superpowers/specs/2026-05-16-agentcore-proxy-config-isolation.md` and reference the manual-smoke `:3000` collision discovered after SIO-761 merged.

Capture the issue ID (expected: SIO-767, the next free number after SIO-766). All commit subjects below use placeholder `SIO-767`; **replace with the real ID** before committing.

- [ ] **Step 2: Create a worktree**

Per `superpowers:using-git-worktrees`. From the repo root:

```bash
# Replace 767 if Linear assigned a different number
git worktree add ../devops-incident-analyzer-sio-767 -b sio-767-agentcore-proxy-config-isolation main
cd ../devops-incident-analyzer-sio-767
```

All subsequent tasks run inside this worktree.

- [ ] **Step 3: Install dependencies**

```bash
bun install
```

Expected: completes without errors.

- [ ] **Step 4: Confirm pre-conditions**

```bash
# Phase 5 must be on main
git log --oneline | head -3
# Expected: commit a4286d8 SIO-761 (Phase 5) visible

# Shared package tests are green
bun run --filter @devops-agent/shared test 2>&1 | tail -5
# Expected: pass > 0, fail = 0

# Spec is present
ls docs/superpowers/specs/2026-05-16-agentcore-proxy-config-isolation.md
# Expected: file exists
```

If any check fails, stop and investigate.

---

## Task 1: Add `ProxyConfig` interface + `loadProxyConfigFromEnv` helper

**Files:**
- Modify: `packages/shared/src/agentcore-proxy.ts` (add new types + function near line 70, before the existing `interface AwsCreds`)
- Create: `packages/shared/src/__tests__/agentcore-config.test.ts`

TDD: write the test file first, then add the helper.

- [ ] **Step 1: Write the test file**

Use the Write tool to create `packages/shared/src/__tests__/agentcore-config.test.ts`:

```typescript
// packages/shared/src/__tests__/agentcore-config.test.ts
// Unit tests for loadProxyConfigFromEnv. Reads <PREFIX>_AGENTCORE_* env vars
// and produces a ProxyConfig object; throws on missing required vars.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadProxyConfigFromEnv } from "../agentcore-proxy.ts";

const VARS_TO_RESTORE = [
	"AWS_AGENTCORE_RUNTIME_ARN",
	"AWS_AGENTCORE_REGION",
	"AWS_AGENTCORE_PROXY_PORT",
	"AWS_AGENTCORE_QUALIFIER",
	"AWS_AGENTCORE_SERVER_NAME",
	"AWS_AGENTCORE_AWS_ACCESS_KEY_ID",
	"AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY",
	"AWS_AGENTCORE_AWS_SESSION_TOKEN",
	"AWS_AGENTCORE_AWS_PROFILE",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
	saved = {};
	for (const v of VARS_TO_RESTORE) {
		saved[v] = process.env[v];
		delete process.env[v];
	}
});

afterEach(() => {
	for (const v of VARS_TO_RESTORE) {
		if (saved[v] === undefined) delete process.env[v];
		else process.env[v] = saved[v];
	}
});

const TEST_ARN = "arn:aws:bedrock-agentcore:eu-central-1:356994971776:runtime/aws_mcp_server-57wIOB35U1";

describe("loadProxyConfigFromEnv", () => {
	test("reads <PREFIX>_AGENTCORE_RUNTIME_ARN correctly", () => {
		process.env.AWS_AGENTCORE_RUNTIME_ARN = TEST_ARN;
		process.env.AWS_AGENTCORE_REGION = "eu-central-1";
		process.env.AWS_AGENTCORE_PROXY_PORT = "3001";
		process.env.AWS_AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATEST";
		process.env.AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY = "secret";

		const cfg = loadProxyConfigFromEnv("AWS");

		expect(cfg.runtimeArn).toBe(TEST_ARN);
		expect(cfg.region).toBe("eu-central-1");
		expect(cfg.port).toBe(3001);
	});

	test("throws when <PREFIX>_AGENTCORE_RUNTIME_ARN is missing", () => {
		process.env.AWS_AGENTCORE_REGION = "eu-central-1";
		process.env.AWS_AGENTCORE_PROXY_PORT = "3001";
		process.env.AWS_AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATEST";
		process.env.AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY = "secret";

		expect(() => loadProxyConfigFromEnv("AWS")).toThrow(/AWS_AGENTCORE_RUNTIME_ARN/);
	});

	test("throws when <PREFIX>_AGENTCORE_REGION is missing", () => {
		process.env.AWS_AGENTCORE_RUNTIME_ARN = TEST_ARN;
		process.env.AWS_AGENTCORE_PROXY_PORT = "3001";
		process.env.AWS_AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATEST";
		process.env.AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY = "secret";

		expect(() => loadProxyConfigFromEnv("AWS")).toThrow(/AWS_AGENTCORE_REGION/);
	});

	test("throws when <PREFIX>_AGENTCORE_PROXY_PORT is missing", () => {
		process.env.AWS_AGENTCORE_RUNTIME_ARN = TEST_ARN;
		process.env.AWS_AGENTCORE_REGION = "eu-central-1";
		process.env.AWS_AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATEST";
		process.env.AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY = "secret";

		expect(() => loadProxyConfigFromEnv("AWS")).toThrow(/AWS_AGENTCORE_PROXY_PORT/);
	});

	test("throws when <PREFIX>_AGENTCORE_PROXY_PORT is non-numeric", () => {
		process.env.AWS_AGENTCORE_RUNTIME_ARN = TEST_ARN;
		process.env.AWS_AGENTCORE_REGION = "eu-central-1";
		process.env.AWS_AGENTCORE_PROXY_PORT = "not-a-number";
		process.env.AWS_AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATEST";
		process.env.AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY = "secret";

		expect(() => loadProxyConfigFromEnv("AWS")).toThrow(/AWS_AGENTCORE_PROXY_PORT/);
	});

	test("uses defaults for QUALIFIER and SERVER_NAME when not set", () => {
		process.env.AWS_AGENTCORE_RUNTIME_ARN = TEST_ARN;
		process.env.AWS_AGENTCORE_REGION = "eu-central-1";
		process.env.AWS_AGENTCORE_PROXY_PORT = "3001";
		process.env.AWS_AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATEST";
		process.env.AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY = "secret";

		const cfg = loadProxyConfigFromEnv("AWS");

		expect(cfg.qualifier).toBe("DEFAULT");
		expect(cfg.serverName).toBe("mcp-server");
	});

	test("returns static credentials when <PREFIX>_AGENTCORE_AWS_ACCESS_KEY_ID is set", async () => {
		process.env.AWS_AGENTCORE_RUNTIME_ARN = TEST_ARN;
		process.env.AWS_AGENTCORE_REGION = "eu-central-1";
		process.env.AWS_AGENTCORE_PROXY_PORT = "3001";
		process.env.AWS_AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATEST";
		process.env.AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY = "secret";
		process.env.AWS_AGENTCORE_AWS_SESSION_TOKEN = "session-token-value";

		const cfg = loadProxyConfigFromEnv("AWS");

		// Static path: credentials is the object directly, not a function.
		expect(typeof cfg.credentials).toBe("object");
		const creds = cfg.credentials as { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
		expect(creds.accessKeyId).toBe("AKIATEST");
		expect(creds.secretAccessKey).toBe("secret");
		expect(creds.sessionToken).toBe("session-token-value");
	});

	test("returns a credentials function when only AWS_PROFILE is set (lazy AWS-CLI fallback)", () => {
		process.env.AWS_AGENTCORE_RUNTIME_ARN = TEST_ARN;
		process.env.AWS_AGENTCORE_REGION = "eu-central-1";
		process.env.AWS_AGENTCORE_PROXY_PORT = "3001";
		process.env.AWS_AGENTCORE_AWS_PROFILE = "test-profile";

		const cfg = loadProxyConfigFromEnv("AWS");

		// Lazy path: credentials is a function, not an object. Do NOT call the
		// function here -- it shells to `aws configure export-credentials` which
		// requires a real AWS CLI setup. Just assert the shape.
		expect(typeof cfg.credentials).toBe("function");
	});
});
```

- [ ] **Step 2: Run the test to confirm it fails (import error)**

```bash
bun test packages/shared/src/__tests__/agentcore-config.test.ts 2>&1 | tail -8
# Expected: error: Export named 'loadProxyConfigFromEnv' not found in module 'packages/shared/src/agentcore-proxy.ts'
```

The failure mode is what the test was designed to catch — the function doesn't exist yet.

- [ ] **Step 3: Add the `ProxyConfig` interface and `loadProxyConfigFromEnv` to agentcore-proxy.ts**

Use the Edit tool. Find:

```typescript
function readProxyConfig() {
	const runtimeArn = process.env.AGENTCORE_RUNTIME_ARN;
	if (!runtimeArn) {
		logger.fatal(
			"AGENTCORE_RUNTIME_ARN is required. Example: arn:aws:bedrock:eu-central-1:123456789:agent-runtime/my_mcp_server-XXXXX",
		);
		process.exit(1);
	}

	const region = process.env.AGENTCORE_REGION || process.env.AWS_REGION || "eu-central-1";
	const port = parseInt(process.env.AGENTCORE_PROXY_PORT || "3000", 10);
	const qualifier = process.env.AGENTCORE_QUALIFIER || "DEFAULT";
	const serverName = process.env.MCP_SERVER_NAME || "mcp-server";

	const encodedArn = encodeURIComponent(runtimeArn);
	const basePath = `/runtimes/${encodedArn}/invocations`;
	const baseUrl = `https://bedrock-agentcore.${region}.amazonaws.com`;
	const queryString = `qualifier=${qualifier}`;
	const fullUrl = `${baseUrl}${basePath}?${queryString}`;

	return { runtimeArn, region, port, qualifier, serverName, basePath, baseUrl, queryString, fullUrl };
}
```

Replace with:

```typescript
export interface ProxyCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

/**
 * Configuration for one running SigV4 proxy instance. Passed explicitly to
 * startAgentCoreProxy(); no process.env reads inside the proxy.
 */
export interface ProxyConfig {
	runtimeArn: string;
	region: string;
	port: number;
	qualifier: string;
	serverName: string;
	/**
	 * Either a static credentials object (for env-var creds) or an async
	 * function (for AWS-CLI profile fallback, which may need to re-shell when
	 * session-tokens expire).
	 */
	credentials: ProxyCredentials | (() => Promise<ProxyCredentials>);
}

/**
 * Build a ProxyConfig from per-server-prefixed env vars. Reads ONLY the
 * <prefix>_AGENTCORE_* namespace; never falls back to a generic AGENTCORE_*
 * var. Throws if required vars are missing.
 *
 * Required env vars per prefix:
 *   - <PREFIX>_AGENTCORE_RUNTIME_ARN
 *   - <PREFIX>_AGENTCORE_REGION
 *   - <PREFIX>_AGENTCORE_PROXY_PORT
 *
 * Optional env vars:
 *   - <PREFIX>_AGENTCORE_QUALIFIER (default "DEFAULT")
 *   - <PREFIX>_AGENTCORE_SERVER_NAME (default "mcp-server")
 *   - <PREFIX>_AGENTCORE_AWS_ACCESS_KEY_ID + _SECRET_ACCESS_KEY (+ _SESSION_TOKEN)
 *   - <PREFIX>_AGENTCORE_AWS_PROFILE (AWS CLI profile for lazy fallback)
 */
export function loadProxyConfigFromEnv(prefix: string): ProxyConfig {
	const runtimeArn = process.env[`${prefix}_AGENTCORE_RUNTIME_ARN`];
	if (!runtimeArn) {
		throw new Error(`${prefix}_AGENTCORE_RUNTIME_ARN is required`);
	}
	const region = process.env[`${prefix}_AGENTCORE_REGION`];
	if (!region) {
		throw new Error(`${prefix}_AGENTCORE_REGION is required`);
	}
	const portRaw = process.env[`${prefix}_AGENTCORE_PROXY_PORT`];
	if (!portRaw) {
		throw new Error(`${prefix}_AGENTCORE_PROXY_PORT is required`);
	}
	const port = Number.parseInt(portRaw, 10);
	if (!Number.isFinite(port) || port < 1 || port > 65535) {
		throw new Error(`${prefix}_AGENTCORE_PROXY_PORT must be an integer in 1..65535, got: ${portRaw}`);
	}
	const qualifier = process.env[`${prefix}_AGENTCORE_QUALIFIER`] ?? "DEFAULT";
	const serverName = process.env[`${prefix}_AGENTCORE_SERVER_NAME`] ?? "mcp-server";

	const accessKeyId = process.env[`${prefix}_AGENTCORE_AWS_ACCESS_KEY_ID`];
	const secretAccessKey = process.env[`${prefix}_AGENTCORE_AWS_SECRET_ACCESS_KEY`];
	const sessionToken = process.env[`${prefix}_AGENTCORE_AWS_SESSION_TOKEN`];
	const awsProfile = process.env[`${prefix}_AGENTCORE_AWS_PROFILE`];

	let credentials: ProxyConfig["credentials"];
	if (accessKeyId && secretAccessKey) {
		credentials = { accessKeyId, secretAccessKey, sessionToken };
	} else {
		// Lazy AWS-CLI fallback. The function shells out on each call; the
		// proxy caches the result per-handle (see startAgentCoreProxy below).
		credentials = async () => {
			const args = ["configure", "export-credentials", "--format", "env-no-export"];
			if (awsProfile) args.push("--profile", awsProfile);
			const proc = Bun.spawn(["aws", ...args], { stdout: "pipe", stderr: "pipe" });
			const output = await new Response(proc.stdout).text();
			await proc.exited;

			const vars: Record<string, string> = {};
			for (const line of output.split("\n")) {
				const eq = line.indexOf("=");
				if (eq > 0) vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
			}
			if (!vars.AWS_ACCESS_KEY_ID || !vars.AWS_SECRET_ACCESS_KEY) {
				const profileNote = awsProfile ? ` (profile: ${awsProfile})` : "";
				throw new Error(`No AWS credentials from 'aws configure export-credentials'${profileNote}`);
			}
			return {
				accessKeyId: vars.AWS_ACCESS_KEY_ID,
				secretAccessKey: vars.AWS_SECRET_ACCESS_KEY,
				sessionToken: vars.AWS_SESSION_TOKEN,
			};
		};
	}

	return { runtimeArn, region, port, qualifier, serverName, credentials };
}

function readProxyConfig() {
	const runtimeArn = process.env.AGENTCORE_RUNTIME_ARN;
	if (!runtimeArn) {
		logger.fatal(
			"AGENTCORE_RUNTIME_ARN is required. Example: arn:aws:bedrock:eu-central-1:123456789:agent-runtime/my_mcp_server-XXXXX",
		);
		process.exit(1);
	}

	const region = process.env.AGENTCORE_REGION || process.env.AWS_REGION || "eu-central-1";
	const port = parseInt(process.env.AGENTCORE_PROXY_PORT || "3000", 10);
	const qualifier = process.env.AGENTCORE_QUALIFIER || "DEFAULT";
	const serverName = process.env.MCP_SERVER_NAME || "mcp-server";

	const encodedArn = encodeURIComponent(runtimeArn);
	const basePath = `/runtimes/${encodedArn}/invocations`;
	const baseUrl = `https://bedrock-agentcore.${region}.amazonaws.com`;
	const queryString = `qualifier=${qualifier}`;
	const fullUrl = `${baseUrl}${basePath}?${queryString}`;

	return { runtimeArn, region, port, qualifier, serverName, basePath, baseUrl, queryString, fullUrl };
}
```

Note: this Task 1 adds the new types/function ALONGSIDE the existing `readProxyConfig`. Task 3 removes `readProxyConfig` and rewires `startAgentCoreProxy` to use the new config. Splitting like this means the proxy still works for the existing test harness while Task 1's new helper gets tested standalone.

- [ ] **Step 4: Export the new types and helper from `packages/shared/src/index.ts`**

```bash
grep -n "agentcore-proxy" packages/shared/src/index.ts
```

Expected: one line, around line 32, that says `export { type AgentCoreProxyHandle, startAgentCoreProxy } from "./agentcore-proxy.ts";`.

Use the Edit tool. Find:

```typescript
export { type AgentCoreProxyHandle, startAgentCoreProxy } from "./agentcore-proxy.ts";
```

Replace with:

```typescript
export {
	type AgentCoreProxyHandle,
	loadProxyConfigFromEnv,
	type ProxyConfig,
	type ProxyCredentials,
	startAgentCoreProxy,
} from "./agentcore-proxy.ts";
```

- [ ] **Step 5: Run the tests to confirm they pass**

```bash
bun test packages/shared/src/__tests__/agentcore-config.test.ts 2>&1 | tail -8
# Expected: 8 pass, 0 fail
```

- [ ] **Step 6: Verify typecheck + biome**

```bash
bun run --filter @devops-agent/shared typecheck 2>&1 | tail -2
# Expected: Exited with code 0

bunx biome check packages/shared/src/agentcore-proxy.ts packages/shared/src/index.ts packages/shared/src/__tests__/agentcore-config.test.ts 2>&1 | tail -3
# Expected: No fixes applied (if biome reformats, run with --write and re-verify)
```

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/agentcore-proxy.ts packages/shared/src/index.ts packages/shared/src/__tests__/agentcore-config.test.ts
git commit -m "SIO-767: add ProxyConfig + loadProxyConfigFromEnv helper

New types ProxyConfig and ProxyCredentials, plus the helper that reads
<PREFIX>_AGENTCORE_* env vars and returns a structured ProxyConfig.
Throws on missing required vars (RUNTIME_ARN, REGION, PROXY_PORT).
Credentials resolution: env-var creds first, then lazy AWS-CLI profile
fallback (no module-level cache).

Adds 8 unit tests. The existing readProxyConfig and startAgentCoreProxy
are unchanged in this commit -- Task 3 rewires them to use the new
config shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Update `agentcore-proxy-roundtrip.test.ts` to use the new API

**Files:**
- Modify: `packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts`

Update the existing roundtrip tests to construct a `ProxyConfig` explicitly. The tests currently rely on `process.env.AGENTCORE_*` + `clearCredentialCache()` which will both be removed in Task 3. Updating the tests FIRST means Task 3's signature change won't have to also rewrite tests in one giant commit.

This task fails until Task 3 lands (the new `startAgentCoreProxy(config)` signature doesn't exist yet). That's expected — commits in this plan are sequential.

- [ ] **Step 1: Read the current test setup**

```bash
sed -n '1,55p' packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts
```

Look for the lines:
- `import { type AgentCoreProxyHandle, clearCredentialCache, startAgentCoreProxy } from "../agentcore-proxy.ts";` (line ~11)
- `process.env.AGENTCORE_RUNTIME_ARN = TEST_ARN;` (line ~20)
- `process.env.AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATESTACCESSKEY123";` (line ~22)
- `process.env.AGENTCORE_AWS_SECRET_ACCESS_KEY = "test-secret-key";` (line ~23)
- `process.env.AGENTCORE_AWS_SESSION_TOKEN = "test-session-token";` (line ~24)
- `process.env.AGENTCORE_PROXY_PORT = "0";` (line ~25)
- `clearCredentialCache();` (lines ~46, ~195)
- `proxy = await startAgentCoreProxy();` (lines ~47, ~196)

- [ ] **Step 2: Update the imports**

Use the Edit tool. Find:

```typescript
import { type AgentCoreProxyHandle, clearCredentialCache, startAgentCoreProxy } from "../agentcore-proxy.ts";
```

Replace with:

```typescript
import {
	type AgentCoreProxyHandle,
	type ProxyConfig,
	startAgentCoreProxy,
} from "../agentcore-proxy.ts";
```

- [ ] **Step 3: Replace the env-setup block with a TEST_CONFIG constant**

```bash
sed -n '15,30p' packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts
```

You'll see the `beforeAll(()=>{...})` block setting env vars. Replace the full block. Use the Edit tool to find the exact env-setup lines (the test currently uses `port: "0"` for ephemeral) and replace with a `TEST_CONFIG` constant declared just above where the existing env-setup block runs.

The existing env-setup block looks roughly like:

```typescript
beforeAll(() => {
	process.env.AGENTCORE_RUNTIME_ARN = TEST_ARN;
	process.env.AGENTCORE_REGION = "eu-central-1";
	process.env.AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATESTACCESSKEY123";
	process.env.AGENTCORE_AWS_SECRET_ACCESS_KEY = "test-secret-key";
	process.env.AGENTCORE_AWS_SESSION_TOKEN = "test-session-token";
	process.env.AGENTCORE_PROXY_PORT = "0";
});
```

(The exact shape may differ; the actual lines are what to match against.)

Replace with a `TEST_CONFIG` constant declared at the top of the file (just after the imports) and remove the `beforeAll` env-setup entirely:

```typescript
const TEST_ARN = "arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/test_mcp_server-AAAAAA";

const TEST_CONFIG: ProxyConfig = {
	runtimeArn: TEST_ARN,
	region: "eu-central-1",
	port: 0, // 0 = ephemeral; Bun.serve assigns a free port
	qualifier: "DEFAULT",
	serverName: "mcp-server",
	credentials: {
		accessKeyId: "AKIATESTACCESSKEY123",
		secretAccessKey: "test-secret-key",
		sessionToken: "test-session-token",
	},
};
```

(If `TEST_ARN` already exists as a top-of-file constant, don't duplicate it; just add `TEST_CONFIG` referencing it.)

Then replace every `await startAgentCoreProxy()` call with `await startAgentCoreProxy(TEST_CONFIG)`.

For the "no session token" subtest around line 191, replace the env-mutation pattern:

```typescript
// Before:
const savedToken = process.env.AGENTCORE_AWS_SESSION_TOKEN;
try {
	delete process.env.AGENTCORE_AWS_SESSION_TOKEN;
	clearCredentialCache();
	proxy = await startAgentCoreProxy();
	// ...
} finally {
	if (savedToken) process.env.AGENTCORE_AWS_SESSION_TOKEN = savedToken;
}
```

with:

```typescript
const configWithoutToken: ProxyConfig = {
	...TEST_CONFIG,
	credentials: {
		accessKeyId: TEST_CONFIG.credentials.accessKeyId!,
		secretAccessKey: (TEST_CONFIG.credentials as ProxyCredentials).secretAccessKey,
		// sessionToken intentionally omitted
	},
};
proxy = await startAgentCoreProxy(configWithoutToken);
// ...
```

Note: cast `TEST_CONFIG.credentials` to `ProxyCredentials` (not the function variant) because we know it's a static object in this test. The `as` cast is needed because the union type loses the static-shape info.

If the type assertion adds noise, an alternative: extract the static creds to a const:

```typescript
const TEST_CREDS: ProxyCredentials = {
	accessKeyId: "AKIATESTACCESSKEY123",
	secretAccessKey: "test-secret-key",
	sessionToken: "test-session-token",
};
const TEST_CONFIG: ProxyConfig = { ..., credentials: TEST_CREDS };
const configWithoutToken: ProxyConfig = {
	...TEST_CONFIG,
	credentials: { accessKeyId: TEST_CREDS.accessKeyId, secretAccessKey: TEST_CREDS.secretAccessKey },
};
```

Use whichever shape is cleaner; both are correct. Add the `ProxyCredentials` import if you use the type annotation.

- [ ] **Step 4: Remove all `clearCredentialCache()` calls**

These are the `clearCredentialCache()` invocations on lines ~46 and ~195. Each call's purpose was to reset the module-level cache between proxy restarts. After Task 3, each `startAgentCoreProxy(config)` call has its own closure-scoped cache, so this is a no-op.

Use the Edit tool to delete each `clearCredentialCache();` line. Don't replace with anything; just remove.

- [ ] **Step 5: Verify the file's imports + structure**

```bash
grep -n "clearCredentialCache\|process.env.AGENTCORE_" packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts
# Expected: no matches (both have been removed)

grep -n "startAgentCoreProxy(TEST_CONFIG)\|startAgentCoreProxy(configWithoutToken)" packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts
# Expected: at least 2 matches
```

- [ ] **Step 6: Verify typecheck and biome (tests don't run yet — Task 3 will make them run)**

```bash
bun run --filter @devops-agent/shared typecheck 2>&1 | tail -3
# Expected: errors about clearCredentialCache not being exported (existing) AND
# about startAgentCoreProxy expecting 0 args (the import) -- BOTH are expected
# and resolved when Task 3 lands.
```

Wait, that's incorrect. After Task 2 the test file imports `startAgentCoreProxy` but calls it with `TEST_CONFIG`, while the production signature still takes 0 args. The typecheck WILL fail at this point. **That's by design**: Task 2 lands the test-side changes first; Task 3 lands the matching production change in the same branch immediately after, restoring the invariant.

For the purpose of this task, the verification is just that the test file is syntactically valid and ready for Task 3:

```bash
bunx biome check packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts 2>&1 | tail -3
# Expected: No fixes applied (biome doesn't care about type errors)
```

- [ ] **Step 7: Commit (DO NOT run typecheck — it will fail by design)**

```bash
git add packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts
git commit -m "SIO-767: migrate roundtrip test to ProxyConfig API

Replaces process.env.AGENTCORE_* setup with an explicit TEST_CONFIG
constant. Removes all clearCredentialCache() calls (the function is
removed in Task 3; the cache moves into a per-handle closure so reset
is automatic between proxy instances).

Typecheck will fail after this commit until Task 3 lands -- Task 3
changes startAgentCoreProxy to accept the config arg, restoring the
invariant.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Update `agentcore-proxy-retry.test.ts` to use the new API

**Files:**
- Modify: `packages/shared/src/__tests__/agentcore-proxy-retry.test.ts`

Same pattern as Task 2. This is a separate commit so the diff stays reviewable.

- [ ] **Step 1: Inspect**

```bash
sed -n '1,35p' packages/shared/src/__tests__/agentcore-proxy-retry.test.ts
```

Look for the same import-with-`clearCredentialCache`, `process.env.AGENTCORE_*` setup block, `clearCredentialCache()` calls (lines ~207 and ~257).

- [ ] **Step 2: Update imports**

Use the Edit tool. Find the existing import line (typically around line 10):

```typescript
import {
	clearCredentialCache,
	// ... other imports
	startAgentCoreProxy,
} from "../agentcore-proxy.ts";
```

Replace with the new shape (remove `clearCredentialCache`, add `ProxyConfig`):

```typescript
import {
	// ... other imports preserved (whatever was in the original)
	type ProxyConfig,
	startAgentCoreProxy,
} from "../agentcore-proxy.ts";
```

The actual surrounding imports in this file (`computeJitteredBackoff`, etc.) should be preserved.

- [ ] **Step 3: Replace env-setup with TEST_CONFIG**

Same pattern as Task 2. Define a top-of-file `TEST_CONFIG: ProxyConfig` constant. Remove the `process.env.AGENTCORE_*` `beforeAll` block. Replace every `await startAgentCoreProxy()` with `await startAgentCoreProxy(TEST_CONFIG)`.

- [ ] **Step 4: Remove `clearCredentialCache()` calls**

Two occurrences (lines ~207, ~257). Delete both.

- [ ] **Step 5: Verify**

```bash
grep -n "clearCredentialCache\|process.env.AGENTCORE_" packages/shared/src/__tests__/agentcore-proxy-retry.test.ts
# Expected: no matches

bunx biome check packages/shared/src/__tests__/agentcore-proxy-retry.test.ts 2>&1 | tail -3
# Expected: No fixes applied
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/__tests__/agentcore-proxy-retry.test.ts
git commit -m "SIO-767: migrate retry test to ProxyConfig API

Same shape as Task 2's roundtrip migration. Typecheck still fails
until Task 4 lands the matching production signature change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Refactor `startAgentCoreProxy` to take a `ProxyConfig` argument; remove module-level cache

**Files:**
- Modify: `packages/shared/src/agentcore-proxy.ts`

This is the big one. Three sub-edits in one file:

1. Change `startAgentCoreProxy()` signature → `startAgentCoreProxy(config: ProxyConfig)`
2. Move `cachedCreds` / `credsExpiresAt` / `getCredentials` from module scope INTO the function (closure-scoped)
3. Remove `readProxyConfig`, `clearCredentialCache`, the module-scoped `cachedCreds`/`credsExpiresAt`, and the standalone-run block at line 612

After this commit, typecheck passes again and Tasks 2 and 3's tests run green.

- [ ] **Step 1: Inspect the current proxy function and surrounding state**

```bash
sed -n '70,140p' packages/shared/src/agentcore-proxy.ts
```

You should see the `interface AwsCreds`, the module-level `cachedCreds`/`credsExpiresAt`, the `clearCredentialCache` export, and the `getCredentials` async function.

```bash
sed -n '340,400p' packages/shared/src/agentcore-proxy.ts
```

You should see `startAgentCoreProxy()` taking no args, declaring `const cfg = readProxyConfig();`, and using `cfg.port`/`cfg.basePath`/etc.

```bash
sed -n '605,615p' packages/shared/src/agentcore-proxy.ts
```

You should see the trailing `if (import.meta.main) { startAgentCoreProxy(); }` block.

- [ ] **Step 2: Delete the module-level credential cache + clearCredentialCache + getCredentials**

Use the Edit tool. Find:

```typescript
interface AwsCreds {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

let cachedCreds: AwsCreds | null = null;
let credsExpiresAt = 0;

// SIO-733: test seam. Lets the round-trip suite reset the cache between
// proxy restarts when credential env vars change mid-suite. Not used by
// production code.
export function clearCredentialCache(): void {
	cachedCreds = null;
	credsExpiresAt = 0;
}

async function getCredentials(): Promise<AwsCreds> {
	// Return cached if still valid (5min buffer)
	if (cachedCreds && Date.now() < credsExpiresAt - 300_000) {
		return cachedCreds;
	}

	// Try proxy-specific env vars first (AGENTCORE_AWS_*), then generic AWS_*
	const accessKeyId = process.env.AGENTCORE_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
	const secretAccessKey = process.env.AGENTCORE_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
	const sessionToken = process.env.AGENTCORE_AWS_SESSION_TOKEN || process.env.AWS_SESSION_TOKEN;

	if (accessKeyId && secretAccessKey) {
		cachedCreds = { accessKeyId, secretAccessKey, sessionToken };
		credsExpiresAt = Date.now() + 3600_000; // env creds don't expire, refresh hourly
		return cachedCreds;
	}

	// Fall back to AWS CLI credential export
	try {
		const proc = Bun.spawn(["aws", "configure", "export-credentials", "--format", "env-no-export"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = await new Response(proc.stdout).text();
		await proc.exited;

		const vars: Record<string, string> = {};
		for (const line of output.split("\n")) {
			const eq = line.indexOf("=");
			if (eq > 0) vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
		}

		if (vars.AWS_ACCESS_KEY_ID && vars.AWS_SECRET_ACCESS_KEY) {
			cachedCreds = {
				accessKeyId: vars.AWS_ACCESS_KEY_ID,
				secretAccessKey: vars.AWS_SECRET_ACCESS_KEY,
				sessionToken: vars.AWS_SESSION_TOKEN,
			};
			// Session tokens typically expire in 1h; refresh after 45min
			credsExpiresAt = Date.now() + 2700_000;
			return cachedCreds;
		}
	} catch {
		// fall through
	}

	throw new Error("No AWS credentials found. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or configure AWS CLI.");
}
```

Replace with:

```typescript
// AwsCreds → ProxyCredentials (defined earlier in the file via Task 1).
// Module-level credential cache and clearCredentialCache removed; each
// startAgentCoreProxy invocation has its own closure-scoped cache.
```

(Just the comment, no code. The `AwsCreds` interface is replaced by `ProxyCredentials` from Task 1; everything else moves into the function closure.)

- [ ] **Step 3: Delete `readProxyConfig`**

Use the Edit tool. Find:

```typescript
function readProxyConfig() {
	const runtimeArn = process.env.AGENTCORE_RUNTIME_ARN;
	if (!runtimeArn) {
		logger.fatal(
			"AGENTCORE_RUNTIME_ARN is required. Example: arn:aws:bedrock:eu-central-1:123456789:agent-runtime/my_mcp_server-XXXXX",
		);
		process.exit(1);
	}

	const region = process.env.AGENTCORE_REGION || process.env.AWS_REGION || "eu-central-1";
	const port = parseInt(process.env.AGENTCORE_PROXY_PORT || "3000", 10);
	const qualifier = process.env.AGENTCORE_QUALIFIER || "DEFAULT";
	const serverName = process.env.MCP_SERVER_NAME || "mcp-server";

	const encodedArn = encodeURIComponent(runtimeArn);
	const basePath = `/runtimes/${encodedArn}/invocations`;
	const baseUrl = `https://bedrock-agentcore.${region}.amazonaws.com`;
	const queryString = `qualifier=${qualifier}`;
	const fullUrl = `${baseUrl}${basePath}?${queryString}`;

	return { runtimeArn, region, port, qualifier, serverName, basePath, baseUrl, queryString, fullUrl };
}
```

Replace with nothing — delete the function entirely.

- [ ] **Step 4: Update `startAgentCoreProxy` signature and body**

Use the Edit tool. Find:

```typescript
export async function startAgentCoreProxy(): Promise<AgentCoreProxyHandle> {
	const cfg = readProxyConfig();
	let mcpSessionId: string | undefined;
```

Replace with:

```typescript
export async function startAgentCoreProxy(config: ProxyConfig): Promise<AgentCoreProxyHandle> {
	// Derive URL pieces from runtimeArn + region. Equivalent to the old
	// readProxyConfig but using the explicitly-passed config.
	const encodedArn = encodeURIComponent(config.runtimeArn);
	const basePath = `/runtimes/${encodedArn}/invocations`;
	const baseUrl = `https://bedrock-agentcore.${config.region}.amazonaws.com`;
	const queryString = `qualifier=${config.qualifier}`;
	const fullUrl = `${baseUrl}${basePath}?${queryString}`;

	// Per-handle credential cache (replaces the deleted module-level
	// cachedCreds singleton). Each invocation of startAgentCoreProxy gets
	// its own cache via closure -- enables two proxies in one process to
	// hold credentials for different AWS accounts.
	let cachedCreds: ProxyCredentials | null = null;
	let credsExpiresAt = 0;

	async function getCredentials(): Promise<ProxyCredentials> {
		if (cachedCreds && Date.now() < credsExpiresAt - 300_000) return cachedCreds;

		const creds =
			typeof config.credentials === "function" ? await config.credentials() : config.credentials;
		cachedCreds = creds;
		// Static creds (env-var) refresh hourly; lazy creds (AWS-CLI) refresh
		// after 45min to stay ahead of typical session-token expiry.
		credsExpiresAt =
			typeof config.credentials === "function" ? Date.now() + 2_700_000 : Date.now() + 3_600_000;
		return cachedCreds;
	}

	let mcpSessionId: string | undefined;
```

- [ ] **Step 5: Update all `cfg.*` references inside the proxy body to use `config.*` or local vars**

Find every `cfg.port`, `cfg.region`, `cfg.basePath`, `cfg.queryString`, `cfg.baseUrl`, `cfg.fullUrl`, `cfg.serverName` in the proxy function body. Replace with:

- `cfg.port` → `config.port`
- `cfg.region` → `config.region`
- `cfg.serverName` → `config.serverName`
- `cfg.basePath` → `basePath` (the local const declared at the top of the function)
- `cfg.queryString` → `queryString`
- `cfg.baseUrl` → `baseUrl`
- `cfg.fullUrl` → `fullUrl`

There are 6 `cfg.*` references in total (per the grep we ran during planning):

```
350:		port: cfg.port,
389:								const targetUrl = new URL(`${cfg.basePath}?${cfg.queryString}`, cfg.baseUrl);
390:								const headers = signRequest("POST", targetUrl, body, creds, cfg.region);
579:						return Response.json({ status: "ok", target: "agentcore", region: cfg.region });
587:				GET: () => Response.json({ status: "ok", proxy: true, target: cfg.fullUrl }),
597:		{ port: server.port, target: cfg.fullUrl, region: cfg.region, serverName: cfg.serverName },
```

Use the Edit tool with `replace_all: true` for `cfg.port`, then for each other field. Or do six separate Edits. Whichever is cleaner.

Verify after:

```bash
grep -n "\\bcfg\\." packages/shared/src/agentcore-proxy.ts
# Expected: no matches (every cfg.* has been replaced)
```

- [ ] **Step 6: Update `AwsCreds` interface references**

The `signRequest` function takes a `creds: AwsCreds` parameter. After Task 1 introduced `ProxyCredentials` and Task 4 deletes `interface AwsCreds`, the type reference becomes invalid.

```bash
grep -n "AwsCreds\b" packages/shared/src/agentcore-proxy.ts
```

Expected output:
```
154:function signRequest(method: string, url: URL, body: string, creds: AwsCreds, region: string): Record<string, string> {
```

Use the Edit tool. Find:

```typescript
function signRequest(method: string, url: URL, body: string, creds: AwsCreds, region: string): Record<string, string> {
```

Replace with:

```typescript
function signRequest(method: string, url: URL, body: string, creds: ProxyCredentials, region: string): Record<string, string> {
```

- [ ] **Step 7: Remove the standalone-run block at the end of the file**

Use the Edit tool. Find:

```typescript
// Standalone execution: `bun run shared/src/agentcore-proxy.ts`
if (import.meta.main) {
	startAgentCoreProxy();
}
```

Replace with:

```typescript
// Standalone-run block removed: startAgentCoreProxy now requires an explicit
// ProxyConfig argument. The proxy is a library; spawning it standalone would
// require choosing an arbitrary <PREFIX>_AGENTCORE_* namespace.
```

- [ ] **Step 8: Run the agentcore tests**

```bash
bun test packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts 2>&1 | tail -10
# Expected: all roundtrip tests pass (Task 2's TEST_CONFIG-based tests now work)

bun test packages/shared/src/__tests__/agentcore-proxy-retry.test.ts 2>&1 | tail -10
# Expected: all retry tests pass (Task 3's migration now works)

bun test packages/shared/src/__tests__/agentcore-config.test.ts 2>&1 | tail -8
# Expected: 8 pass (Task 1's tests still green)

bun test packages/shared/src/__tests__/agentcore-proxy-tool-status.test.ts 2>&1 | tail -5
# Expected: existing tests still pass (this file doesn't call startAgentCoreProxy)
```

- [ ] **Step 9: Verify typecheck + biome**

```bash
bun run --filter @devops-agent/shared typecheck 2>&1 | tail -3
# Expected: Exited with code 0

bunx biome check packages/shared/src/agentcore-proxy.ts 2>&1 | tail -3
# Expected: No fixes applied
```

- [ ] **Step 10: Update `packages/shared/src/index.ts` to remove the `clearCredentialCache` export if it was added in Task 1**

Wait — Task 1 didn't add `clearCredentialCache` to the new export block. Check:

```bash
grep "clearCredentialCache" packages/shared/src/index.ts
# Expected: no match (Task 1 already removed it implicitly by overwriting the export block)
```

If somehow it's still there, remove it.

- [ ] **Step 11: Commit**

```bash
git add packages/shared/src/agentcore-proxy.ts packages/shared/src/index.ts
git commit -m "SIO-767: startAgentCoreProxy takes ProxyConfig; per-handle creds cache

Three changes in one commit:
1. startAgentCoreProxy() -> startAgentCoreProxy(config: ProxyConfig).
   No more process.env reads inside the proxy body.
2. Module-level cachedCreds/credsExpiresAt removed. The credential
   cache moves into a closure inside startAgentCoreProxy(), so two
   proxies in the same process hold independent caches.
3. readProxyConfig, clearCredentialCache, and the standalone-run block
   are deleted. The signRequest helper now takes ProxyCredentials
   instead of the removed AwsCreds interface.

Restores typecheck after Tasks 2 and 3's test migrations.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Migrate `mcp-server-aws/src/index.ts` to the new API

**Files:**
- Modify: `packages/mcp-server-aws/src/index.ts`

Remove the Phase 3 fallback (`AWS_AGENTCORE_RUNTIME_ARN ?? AGENTCORE_RUNTIME_ARN`) and the `process.env.AGENTCORE_*` mutations. Call `loadProxyConfigFromEnv("AWS")` + `startAgentCoreProxy(config)`.

- [ ] **Step 1: Inspect**

```bash
sed -n '15,60p' packages/mcp-server-aws/src/index.ts
```

You should see (after Phase 3 and the in-flight uncommitted edit from earlier this session) something like:

```typescript
if (import.meta.main) {
	// Proxy-only mode: when AWS_AGENTCORE_RUNTIME_ARN is set, ...
	const runtimeArn = process.env.AWS_AGENTCORE_RUNTIME_ARN;

	if (runtimeArn) {
		process.env.AGENTCORE_RUNTIME_ARN = runtimeArn;
		process.env.AGENTCORE_PROXY_PORT = process.env.AWS_AGENTCORE_PROXY_PORT ?? "3001";

		const { startAgentCoreProxy } = await import("@devops-agent/shared");
		logger.info({ arn: runtimeArn, transport: "agentcore-proxy" }, "Starting AWS MCP Server");
		const proxy = await startAgentCoreProxy();
```

Note: the actual file on `main` (Phase 3 shape) reads `AWS_AGENTCORE_RUNTIME_ARN ?? AGENTCORE_RUNTIME_ARN`. The worktree might or might not have the partial fix from earlier this session; the migration works either way.

- [ ] **Step 2: Replace the proxy-mode branch**

Use the Edit tool. Find the entire `if (import.meta.main)` body's proxy branch (everything inside the outer `if (import.meta.main)` and the inner `if (runtimeArn)`):

The simplest approach: find the `if (import.meta.main)` block, replace the whole `if (runtimeArn)` proxy branch verbatim.

Find:

```typescript
if (import.meta.main) {
```

Read the file to see the exact current shape, then use the Edit tool to replace from `if (import.meta.main) {` through the closing `} else {` of the proxy branch with:

```typescript
if (import.meta.main) {
	if (process.env.AWS_AGENTCORE_RUNTIME_ARN) {
		const { loadProxyConfigFromEnv, startAgentCoreProxy } = await import("@devops-agent/shared");
		const config = loadProxyConfigFromEnv("AWS");

		logger.info({ arn: config.runtimeArn, transport: "agentcore-proxy" }, "Starting AWS MCP Server");
		const proxy = await startAgentCoreProxy(config);
		logger.info(
			{ transport: "agentcore-proxy", port: proxy.port, url: proxy.url },
			"AWS MCP Server ready",
		);
		logger.info("aws-mcp-server started successfully");

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
```

The `else { createMcpApplication<AwsDatasource>({ ... }); }` block remains unchanged — only the proxy branch is replaced.

Important details:
- The outer guard is now `if (process.env.AWS_AGENTCORE_RUNTIME_ARN)` not `if (runtimeArn)`. We check the env var directly because `loadProxyConfigFromEnv` will throw on missing — guarding here lets us short-circuit to local mode cleanly.
- No `process.env.AGENTCORE_*` mutation. All config flows through `config`.
- No `?? process.env.AGENTCORE_RUNTIME_ARN` fallback. If `AWS_AGENTCORE_RUNTIME_ARN` is unset, the package boots in local mode.

- [ ] **Step 3: Verify typecheck + biome**

```bash
bun run --filter @devops-agent/mcp-server-aws typecheck 2>&1 | tail -3
# Expected: Exited with code 0

bunx biome check packages/mcp-server-aws/src/index.ts 2>&1 | tail -3
# Expected: No fixes applied
```

If biome reformats, run with `--write` and re-verify.

- [ ] **Step 4: Run AWS MCP tests**

```bash
bun run --filter @devops-agent/mcp-server-aws test 2>&1 | tail -5
# Expected: 130 pass, 0 fail
```

These tests don't exercise the proxy-mode branch (it only fires when AWS_AGENTCORE_RUNTIME_ARN is set, which it isn't in the test env). The tests confirm the local-mode branch is unaffected.

- [ ] **Step 5: Smoke-test that the env-var check still works**

```bash
# Without AWS_AGENTCORE_RUNTIME_ARN, the server boots in local mode.
AWS_REGION=eu-central-1 \
AWS_ASSUMED_ROLE_ARN=arn:aws:iam::356994971776:role/DevOpsAgentReadOnly \
AWS_EXTERNAL_ID=aws-mcp-readonly-2026 \
MCP_TRANSPORT=stdio \
timeout 3 bun packages/mcp-server-aws/src/index.ts < /dev/null 2>&1 | head -5 || true
# Expected: "Starting AWS MCP Server" log with transport: "stdio". No agentcore-proxy log.
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server-aws/src/index.ts
git commit -m "SIO-767: migrate mcp-server-aws to ProxyConfig API

Replaces the Phase 3 fallback (AWS_AGENTCORE_RUNTIME_ARN ??
AGENTCORE_RUNTIME_ARN) and the process.env.AGENTCORE_* mutations
with a single loadProxyConfigFromEnv('AWS') + startAgentCoreProxy(config)
pair. The package now reads ONLY the AWS_AGENTCORE_* namespace; the
generic AGENTCORE_RUNTIME_ARN is no longer consulted, closing the
:3000 collision footgun.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Migrate `mcp-server-kafka/src/index.ts` to the new API

**Files:**
- Modify: `packages/mcp-server-kafka/src/index.ts`

Same shape as Task 5, prefix `"KAFKA"`.

- [ ] **Step 1: Inspect**

```bash
sed -n '76,115p' packages/mcp-server-kafka/src/index.ts
```

You should see (after Phase 4 / SIO-760):

```typescript
if (import.meta.main) {
	// Proxy-only mode: when an AgentCore runtime ARN is set, the Kafka MCP
	// server runs remotely on AWS. ...
	const runtimeArn = process.env.KAFKA_AGENTCORE_RUNTIME_ARN ?? process.env.AGENTCORE_RUNTIME_ARN;
	if (runtimeArn) {
		process.env.AGENTCORE_RUNTIME_ARN = runtimeArn;
		const { startAgentCoreProxy } = await import("@devops-agent/shared");
		logger.info(...);
		const proxy = await startAgentCoreProxy();
		...
```

- [ ] **Step 2: Replace the proxy-mode branch**

Use the Edit tool. Find the current proxy branch (the `if (runtimeArn) { ... }` block including all the existing logger and shutdown logic) and replace with:

```typescript
	if (process.env.KAFKA_AGENTCORE_RUNTIME_ARN) {
		const { loadProxyConfigFromEnv, startAgentCoreProxy } = await import("@devops-agent/shared");
		const config = loadProxyConfigFromEnv("KAFKA");

		logger.info(
			{ arn: config.runtimeArn, transport: "agentcore-proxy" },
			"Starting Kafka MCP Server",
		);
		const proxy = await startAgentCoreProxy(config);
		logger.info(
			{ transport: "agentcore-proxy", port: proxy.port, url: proxy.url },
			"Kafka MCP Server ready",
		);
		logger.info("kafka-mcp-server started successfully");

		let isShuttingDown = false;
		const shutdown = async () => {
			if (isShuttingDown) return;
			isShuttingDown = true;
			logger.info("Shutting down kafka-mcp-server...");
			await proxy.close();
			logger.info("kafka-mcp-server shutdown completed");
			process.exit(0);
		};
		process.on("SIGINT", () => shutdown());
		process.on("SIGTERM", () => shutdown());
	} else {
```

(The `} else {` line is the existing branch into local mode; preserve it.)

Same shape as Task 5: outer guard is now `if (process.env.KAFKA_AGENTCORE_RUNTIME_ARN)`, no fallback to generic, no `process.env.AGENTCORE_*` mutation.

- [ ] **Step 3: Verify typecheck + biome**

```bash
bun run --filter @devops-agent/mcp-server-kafka typecheck 2>&1 | tail -3
# Expected: Exited with code 0

bunx biome check packages/mcp-server-kafka/src/index.ts 2>&1 | tail -3
# Expected: No fixes applied
```

- [ ] **Step 4: Run Kafka MCP tests**

```bash
bun run --filter @devops-agent/mcp-server-kafka test 2>&1 | tail -5
# Expected: 307 pass, 0 fail
```

- [ ] **Step 5: Smoke-test legacy generic AGENTCORE_RUNTIME_ARN no longer works**

```bash
# With only the GENERIC AGENTCORE_RUNTIME_ARN set (Phase 4 behavior),
# the proxy should now NOT start. The package falls back to local mode.
AGENTCORE_RUNTIME_ARN="arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/fake_kafka-XXXXX" \
KAFKA_PROVIDER=local \
timeout 3 bun packages/mcp-server-kafka/src/index.ts 2>&1 | head -5 || true
# Expected: log line "Starting Kafka MCP Server" with transport: "stdio" (NOT agentcore-proxy).
```

If the smoke test instead shows "Starting Kafka MCP Server" with `transport: "agentcore-proxy"`, the migration didn't take — `AGENTCORE_RUNTIME_ARN` is still being read somewhere.

- [ ] **Step 6: Smoke-test that KAFKA_AGENTCORE_RUNTIME_ARN triggers proxy mode**

```bash
KAFKA_AGENTCORE_RUNTIME_ARN="arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/fake_kafka-XXXXX" \
KAFKA_AGENTCORE_REGION=eu-central-1 \
KAFKA_AGENTCORE_PROXY_PORT=3000 \
KAFKA_AGENTCORE_AWS_ACCESS_KEY_ID=fake \
KAFKA_AGENTCORE_AWS_SECRET_ACCESS_KEY=fake \
timeout 3 bun packages/mcp-server-kafka/src/index.ts 2>&1 | head -5 || true
# Expected: log line "Starting Kafka MCP Server" with transport: "agentcore-proxy" and the fake ARN.
```

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server-kafka/src/index.ts
git commit -m "SIO-767: migrate mcp-server-kafka to ProxyConfig API

Same pattern as Task 5 (aws). Replaces the Phase 4 fallback
(KAFKA_AGENTCORE_RUNTIME_ARN ?? AGENTCORE_RUNTIME_ARN) with strict
per-server env-var reads via loadProxyConfigFromEnv('KAFKA').

The generic AGENTCORE_RUNTIME_ARN is no longer honored by the Kafka
package -- developers must migrate to KAFKA_AGENTCORE_RUNTIME_ARN +
the matching REGION/PROXY_PORT/etc. block. Migration documented in
.env.example (Task 7).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Update `.env.example` with the per-server template

**Files:**
- Modify: `.env.example`

Document the new per-server env-var block so the next developer who clones the repo knows what to set.

- [ ] **Step 1: Inspect the current AgentCore-related section of .env.example**

```bash
grep -n "AGENTCORE\|MCP_URL" .env.example | head -20
```

Look for any existing block that mentions AgentCore. If none exists (the current `.env.example` may not document AgentCore at all — it didn't include `AGENTCORE_AWS_*` previously), find a reasonable place to insert the new block (after the `*_MCP_URL` block at lines 107-111 + AWS_MCP_URL at line 112 from Phase 4).

- [ ] **Step 2: Add the per-server AgentCore template**

Use the Edit tool. Find:

```
AWS_MCP_URL=http://localhost:3001
```

Replace with:

```
AWS_MCP_URL=http://localhost:3001

# === AgentCore Runtime config (per-server) ===
# Each MCP server that runs against an AgentCore-deployed runtime needs its
# own <PREFIX>_AGENTCORE_* block. Required: RUNTIME_ARN, REGION, PROXY_PORT.
# Optional: QUALIFIER, SERVER_NAME, AWS_ACCESS_KEY_ID/_SECRET_ACCESS_KEY,
# AWS_PROFILE (for AWS CLI profile fallback).
#
# Migration note (SIO-767): the generic AGENTCORE_* env vars are no longer
# honored. If your local .env has them, rename per the block below.

# Kafka MCP via AgentCore (uncomment + fill in when deploying):
# KAFKA_AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:eu-central-1:<account>:runtime/kafka_mcp_server-XXXXX
# KAFKA_AGENTCORE_REGION=eu-central-1
# KAFKA_AGENTCORE_PROXY_PORT=3000
# KAFKA_AGENTCORE_AWS_PROFILE=default
# # OR explicit creds:
# # KAFKA_AGENTCORE_AWS_ACCESS_KEY_ID=
# # KAFKA_AGENTCORE_AWS_SECRET_ACCESS_KEY=

# AWS MCP via AgentCore (uncomment + fill in when deploying):
# AWS_AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:eu-central-1:<account>:runtime/aws_mcp_server-XXXXX
# AWS_AGENTCORE_REGION=eu-central-1
# AWS_AGENTCORE_PROXY_PORT=3001
# AWS_AGENTCORE_AWS_PROFILE=default
# # OR explicit creds:
# # AWS_AGENTCORE_AWS_ACCESS_KEY_ID=
# # AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY=
```

- [ ] **Step 3: Verify the file is syntactically valid**

```bash
grep -c "KAFKA_AGENTCORE_RUNTIME_ARN\|AWS_AGENTCORE_RUNTIME_ARN" .env.example
# Expected: 2 (one per server)
```

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "SIO-767: document per-server AgentCore env-var template in .env.example

The block lists required and optional <PREFIX>_AGENTCORE_* vars for
both Kafka and AWS proxies. Migration note explains that the generic
AGENTCORE_* vars are no longer honored.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole workspace**

```bash
bun run typecheck 2>&1 | tail -15
# Expected: every package "Exited with code 0".
# Known pre-existing failure:
# - @devops-agent/mcp-server-elastic langsmith/traceable (SIO-762, unrelated)
```

- [ ] **Step 2: Lint everything**

```bash
bun run lint 2>&1 | tail -5
# Expected: any errors are pre-existing nits unrelated to this refactor.
```

- [ ] **Step 3: Run all shared tests**

```bash
bun run --filter @devops-agent/shared test 2>&1 | tail -5
# Expected: pass count up by 8 vs main (Task 1's new agentcore-config tests).
# 0 fail.
```

- [ ] **Step 4: Run kafka and aws tests**

```bash
bun run --filter @devops-agent/mcp-server-kafka test 2>&1 | tail -3
# Expected: 307 pass, 0 fail

bun run --filter @devops-agent/mcp-server-aws test 2>&1 | tail -3
# Expected: 130 pass, 0 fail
```

- [ ] **Step 5: Run the full project test suite**

```bash
bun run test 2>&1 | tail -10
# Expected: every package's test job exits 0 (except elastic if its pre-existing typecheck issue affects it, which it doesn't — only typecheck fails on elastic, tests pass).
```

---

## Task 9: Push branch, open PR, move Linear to In Review

- [ ] **Step 1: Push the branch**

```bash
git push -u origin sio-767-agentcore-proxy-config-isolation
```

- [ ] **Step 2: Open the PR**

Use `gh pr create`. Title: `SIO-767: AgentCore proxy config isolation`. Body:

```markdown
## Summary

Eliminates two structural footguns in `packages/shared/src/agentcore-proxy.ts` that surfaced when running two SigV4 proxies (Kafka + AWS) side-by-side:

1. **Shared-env fallback**: `<SERVER>_AGENTCORE_RUNTIME_ARN ?? AGENTCORE_RUNTIME_ARN` let the generic env var leak across server boundaries.
2. **Module-scoped credential cache**: `cachedCreds` was a singleton; two proxies in one process shared it.

Both fixed by giving `startAgentCoreProxy(config: ProxyConfig)` an explicit config argument and moving the credential cache into a per-handle closure.

Discovered after SIO-761 merged — manual smoke of `bun run dev` hit a `:3000` collision.

## Breaking change

The generic `AGENTCORE_RUNTIME_ARN` / `AGENTCORE_PROXY_PORT` / `AGENTCORE_AWS_*` env vars are no longer honored. Migrate per the new template in `.env.example`:

| Old | New (Kafka) | New (AWS) |
|---|---|---|
| `AGENTCORE_RUNTIME_ARN` | `KAFKA_AGENTCORE_RUNTIME_ARN` | `AWS_AGENTCORE_RUNTIME_ARN` |
| `AGENTCORE_REGION` | `KAFKA_AGENTCORE_REGION` | `AWS_AGENTCORE_REGION` |
| `AGENTCORE_PROXY_PORT` | `KAFKA_AGENTCORE_PROXY_PORT` | `AWS_AGENTCORE_PROXY_PORT` |
| `AGENTCORE_AWS_ACCESS_KEY_ID` | `KAFKA_AGENTCORE_AWS_ACCESS_KEY_ID` | `AWS_AGENTCORE_AWS_ACCESS_KEY_ID` |
| `AGENTCORE_AWS_SECRET_ACCESS_KEY` | `KAFKA_AGENTCORE_AWS_SECRET_ACCESS_KEY` | `AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY` |

## Files touched

| Layer | Files |
|---|---|
| Shared lib | `packages/shared/src/agentcore-proxy.ts`, `packages/shared/src/index.ts` |
| Tests | `packages/shared/src/__tests__/agentcore-config.test.ts` (new), `agentcore-proxy-roundtrip.test.ts` (updated), `agentcore-proxy-retry.test.ts` (updated) |
| MCP packages | `packages/mcp-server-aws/src/index.ts`, `packages/mcp-server-kafka/src/index.ts` |
| Config template | `.env.example` |

## Test plan

- [x] `bun run --filter @devops-agent/shared test`: pass count +8 vs main, 0 fail
- [x] `bun run --filter @devops-agent/mcp-server-aws test`: 130 pass, 0 fail
- [x] `bun run --filter @devops-agent/mcp-server-kafka test`: 307 pass, 0 fail
- [x] Typecheck whole workspace (clean except pre-existing SIO-762 elastic gap)
- [ ] Manual: with both `KAFKA_AGENTCORE_*` and `AWS_AGENTCORE_*` set in local `.env`, `bun run dev` brings up two proxies on :3000 and :3001 without collision

## Out of scope

- Migrating to `@aws-sdk/credential-providers` (replaces the AWS-CLI shellout)
- Pre-emptive proxy-mode branches for elastic/couchbase/konnect/gitlab
- Central dev-runner orchestration

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 3: Move Linear sub-issue to In Review**

Use Linear MCP to set SIO-767 state to `In Review`. Comment on the issue with the PR URL.

- [ ] **Step 4: Wait for review**

Per `superpowers:finishing-a-development-branch`. Do not merge; do not set Linear to Done.

---

## Out of scope (later)

For clarity to anyone reading this plan:

- **`@aws-sdk/credential-providers` migration** — replaces the `aws configure export-credentials` shellout with the proper AWS SDK credential resolver. Separate ticket.
- **Pre-emptive proxy-mode branches** for elastic/couchbase/konnect/gitlab — add when those servers actually get AgentCore deploys.
- **Central dev-runner orchestration** that spawns both proxies with health checks — currently `bun run --filter '*' dev` handles parallel startup; no orchestration layer needed.
- **Per-server retry/timeout/idleTimeout overrides** — current values are module-level constants.
- **Updating `scripts/agentcore/deploy.sh`** to emit the per-server env-var block at deployment time — separate ticket.
- **Updating Phase 3 and Phase 4 spec/plan docs** to reflect the new env-var names — those are historical records; the migration table in this PR's description is the canonical reference.

If a reviewer asks "why didn't you also do X", check whether X is listed above before adding scope.
