# AgentCore Proxy Config Isolation

**Status:** Approved
**Discovered during:** Phase 5 manual validation (after SIO-761 merged) — `bun run dev` produced a `:3000` port collision when both Kafka and AWS proxies tried to share `AGENTCORE_RUNTIME_ARN` and `AGENTCORE_PROXY_PORT`
**Date:** 2026-05-16

## Goal

Eliminate two structural footguns in `packages/shared/src/agentcore-proxy.ts` that surfaced when running two SigV4 proxies (Kafka + AWS) in the same `bun run dev` process:

1. **Shared-env fallback**: `AWS_AGENTCORE_RUNTIME_ARN ?? AGENTCORE_RUNTIME_ARN` (and the analogous Kafka pattern) lets a generic env var leak across server boundaries. When `.env` sets `AGENTCORE_RUNTIME_ARN` for Kafka and the developer forgets to set `AWS_AGENTCORE_RUNTIME_ARN`, the AWS package silently targets the Kafka runtime.
2. **Module-scoped credential cache**: `cachedCreds` in `agentcore-proxy.ts` is a module singleton. Two proxies running in the same process share it; whichever initializes first "wins" and the other picks up wrong creds. Critical when the two runtimes live in different AWS accounts (current setup: Kafka in `399987695868`, AWS in `356994971776`).

Fix both by giving each MCP package its own scoped config namespace (`KAFKA_AGENTCORE_*`, `AWS_AGENTCORE_*`) and changing `startAgentCoreProxy()` to accept its config as a function argument rather than reading `process.env` directly.

## Non-goals

- Migrating to AWS SDK's standard credential provider chain (`@aws-sdk/credential-providers`) — the existing `aws configure export-credentials` shellout is ugly but works; replacing is a separate concern.
- Pre-emptively adding proxy-mode branches to `elastic`/`couchbase`/`konnect`/`gitlab` packages — YAGNI; only Kafka and AWS currently have AgentCore deploys.
- A central dev-runner script that auto-spawns both proxies with health checks — out of scope; `bun run --filter '*' dev` already does the spawn.
- Per-server retry/timeout overrides — current values are global constants in the proxy module; leaving as-is.
- Backward compatibility for the generic `AGENTCORE_*` env vars — explicit decision (see Migration below).

## Inputs from prior phases

- Phase 3 (SIO-759) added the `process.env.AWS_AGENTCORE_RUNTIME_ARN ?? process.env.AGENTCORE_RUNTIME_ARN` pattern to `mcp-server-aws/src/index.ts`. The `?? AGENTCORE_RUNTIME_ARN` half is the footgun.
- Phase 4 (SIO-760) added the same pattern to `mcp-server-kafka/src/index.ts` with `KAFKA_AGENTCORE_RUNTIME_ARN`.
- `packages/shared/src/agentcore-proxy.ts:50-60` reads 8 env vars (runtime ARN, region, port, qualifier, server name, 3 cred fields). Module-level state: `cachedCreds`, `credsExpiresAt`.
- `startAgentCoreProxy()` (line 341) takes no arguments today.
- Three existing test files in `packages/shared/src/__tests__/` exercise this code: `agentcore-proxy-roundtrip.test.ts` and `agentcore-proxy-retry.test.ts` set env vars before calling `startAgentCoreProxy()`; `agentcore-proxy-tool-status.test.ts` only tests helpers and stays untouched.
- `.env.example` does not include any `AGENTCORE_*` cred or ARN env vars — the production path is "AWS CLI profile fallback". Local `.env` overrides commonly add `AGENTCORE_AWS_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY`.

## Architecture

```
BEFORE                                  AFTER
======                                  =====
mcp-server-aws/index.ts                 mcp-server-aws/index.ts
   |                                       |
   | process.env.AWS_AGENTCORE_ARN         | loadProxyConfigFromEnv("AWS")
   |   ?? process.env.AGENTCORE_ARN        |   -> ProxyConfig {runtimeArn, region,
   | process.env.AGENTCORE_PROXY_PORT      |       port, qualifier, serverName,
   |   = "3001" (mutation!)                |       credentials}
   v                                       v
   startAgentCoreProxy()                   startAgentCoreProxy(awsConfig)
       |                                       |
       v                                       v
   reads 8 env vars                        reads cfg.* — no env access
   shares cachedCreds singleton           per-handle credential cache
```

Same shape applies symmetrically to `mcp-server-kafka`. The shared module loses all `process.env.*` reads (except for the credential-resolution code path, which can still use AWS CLI fallback via a per-prefix `_AGENTCORE_AWS_PROFILE` env var when no explicit creds are provided).

## Changes

### Change 1 — New `ProxyConfig` interface and `loadProxyConfigFromEnv` helper

Add to `packages/shared/src/agentcore-proxy.ts` (existing file; could split into a sibling `agentcore-config.ts` but keeping in one file matches the current pattern):

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
	 * Credentials to use when signing requests. Either a static object (for
	 * env-var creds) or an async function (for AWS-CLI profile fallback, which
	 * may need to re-shell when session-tokens expire).
	 */
	credentials: ProxyCredentials | (() => Promise<ProxyCredentials>);
}

/**
 * Build a ProxyConfig from per-server-prefixed env vars. Reads ONLY the
 * <prefix>_AGENTCORE_* namespace; never falls back to a generic AGENTCORE_*
 * var. Throws if required vars are missing.
 *
 * @param prefix Per-server prefix, e.g. "KAFKA" or "AWS". Conventionally
 *               uppercase, matching the package's identity in DATA_SOURCE_IDS.
 *
 * Required env vars per prefix:
 *   - <PREFIX>_AGENTCORE_RUNTIME_ARN
 *   - <PREFIX>_AGENTCORE_REGION
 *   - <PREFIX>_AGENTCORE_PROXY_PORT
 *
 * Optional env vars:
 *   - <PREFIX>_AGENTCORE_QUALIFIER (default "DEFAULT")
 *   - <PREFIX>_AGENTCORE_SERVER_NAME (default "mcp-server")
 *
 * Credentials resolution order (first match wins):
 *   1. <PREFIX>_AGENTCORE_AWS_ACCESS_KEY_ID + _SECRET_ACCESS_KEY (+ optional _SESSION_TOKEN)
 *   2. AWS CLI profile from <PREFIX>_AGENTCORE_AWS_PROFILE env var
 *   3. Default AWS CLI profile
 *
 * When (2) or (3), credentials are returned as an async function that
 * shells out to `aws configure export-credentials` lazily (so we don't pay
 * the ~100ms shellout if creds aren't actually used).
 */
export function loadProxyConfigFromEnv(prefix: string): ProxyConfig;
```

Implementation notes:
- Required-var validation throws an `Error` whose message names the missing var and the prefix (e.g., `"KAFKA_AGENTCORE_RUNTIME_ARN is required"`). The caller in each MCP package's `index.ts` should already have checked `<PREFIX>_AGENTCORE_RUNTIME_ARN` is set before calling `loadProxyConfigFromEnv`, so the runtime-arn-missing case is defense-in-depth.
- The port must be an integer in 1..65535; `parseInt` failures throw.
- Credentials function shape: when env creds are set, returns `() => Promise.resolve({...})`; when only profile is set, returns a function that shells `aws configure export-credentials --profile X` (or no `--profile` for default) on each call. The proxy caches the result per-handle (see Change 2).

### Change 2 — Modify `startAgentCoreProxy` signature

Current:
```typescript
export async function startAgentCoreProxy(): Promise<AgentCoreProxyHandle> {
	const cfg = readProxyConfig();
	// ... reads process.env directly via readProxyConfig() and module-level cachedCreds
}
```

New:
```typescript
export async function startAgentCoreProxy(config: ProxyConfig): Promise<AgentCoreProxyHandle> {
	// per-handle cache, scoped via closure
	let cachedCreds: ProxyCredentials | null = null;
	let credsExpiresAt = 0;

	async function getCredentials(): Promise<ProxyCredentials> {
		if (cachedCreds && Date.now() < credsExpiresAt - 300_000) return cachedCreds;

		const creds =
			typeof config.credentials === "function" ? await config.credentials() : config.credentials;
		cachedCreds = creds;
		credsExpiresAt = creds.sessionToken
			? Date.now() + 2_700_000  // 45 min for session-tokened
			: Date.now() + 3_600_000; // 1 hour for static creds
		return cachedCreds;
	}

	const server = Bun.serve({
		port: config.port,
		// ... rest of existing logic, but reads config.region / config.runtimeArn / etc.
		// instead of cfg.region / cfg.runtimeArn
	});

	return { port: config.port, url: `http://127.0.0.1:${config.port}`, close: () => server.stop() };
}
```

- The module-level `cachedCreds`, `credsExpiresAt`, and `clearCredentialCache` exports are **removed**. Tests that depended on `clearCredentialCache` are updated to construct a fresh proxy instance per test (each `startAgentCoreProxy` call has its own closure-scoped cache, so re-calling `startAgentCoreProxy(config)` gives a fresh cache).
- `readProxyConfig` (the existing internal env-reader function around line 50) is **removed**. Its job is now `loadProxyConfigFromEnv`'s in callers.

### Change 3 — Update `mcp-server-aws/src/index.ts`

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
		createMcpApplication<AwsDatasource>({ /* ... unchanged ... */ });
	}
}
```

Changes from Phase 3's code:
- The `runtimeArn = AWS_AGENTCORE_RUNTIME_ARN ?? AGENTCORE_RUNTIME_ARN` fallback is gone.
- The `process.env.AGENTCORE_RUNTIME_ARN = runtimeArn` mutation is gone.
- The `process.env.AGENTCORE_PROXY_PORT = ... ?? "3001"` mutation is gone.
- The proxy receives `config` explicitly; no env reads inside the call.

### Change 4 — Update `mcp-server-kafka/src/index.ts`

Same pattern, prefix `"KAFKA"`:

```typescript
if (process.env.KAFKA_AGENTCORE_RUNTIME_ARN) {
	const { loadProxyConfigFromEnv, startAgentCoreProxy } = await import("@devops-agent/shared");
	const config = loadProxyConfigFromEnv("KAFKA");

	logger.info({ arn: config.runtimeArn, transport: "agentcore-proxy" }, "Starting Kafka MCP Server");
	const proxy = await startAgentCoreProxy(config);
	// ... rest mirrors AWS verbatim with logger label changes
}
```

Phase 4's `?? AGENTCORE_RUNTIME_ARN` fallback gone. No more `process.env.AGENTCORE_RUNTIME_ARN` mutation.

### Change 5 — Update `.env.example`

Remove the generic `AGENTCORE_*` block (lines describing single-runtime use). Add the per-server template:

```bash
# === AgentCore Runtime config (per-server) ===
# Each MCP server that runs against an AgentCore-deployed runtime needs its
# own <PREFIX>_AGENTCORE_* block. Required: RUNTIME_ARN, REGION, PROXY_PORT.
# Optional: QUALIFIER, SERVER_NAME, AWS_ACCESS_KEY_ID/_SECRET_ACCESS_KEY (or AWS_PROFILE).

# Kafka MCP via AgentCore (uncomment + fill in when deploying):
# KAFKA_AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:eu-central-1:<account>:runtime/kafka_mcp_server-XXXXX
# KAFKA_AGENTCORE_REGION=eu-central-1
# KAFKA_AGENTCORE_PROXY_PORT=3000
# KAFKA_AGENTCORE_AWS_PROFILE=default   # or set explicit creds below
# KAFKA_AGENTCORE_AWS_ACCESS_KEY_ID=
# KAFKA_AGENTCORE_AWS_SECRET_ACCESS_KEY=

# AWS MCP via AgentCore (uncomment + fill in when deploying):
# AWS_AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:eu-central-1:<account>:runtime/aws_mcp_server-XXXXX
# AWS_AGENTCORE_REGION=eu-central-1
# AWS_AGENTCORE_PROXY_PORT=3001
# AWS_AGENTCORE_AWS_PROFILE=default
```

### Change 6 — Migrate local `.env`

The user's local `.env` (gitignored) needs manual migration. Document the steps in the spec + Linear issue:

```bash
# Before (single-runtime):
AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:eu-central-1:399987695868:runtime/kafka_mcp_server-7RjmF16MqA
AGENTCORE_PROXY_PORT=3000
AGENTCORE_AWS_ACCESS_KEY_ID=...
AGENTCORE_AWS_SECRET_ACCESS_KEY=...

# After (per-server):
KAFKA_AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:eu-central-1:399987695868:runtime/kafka_mcp_server-7RjmF16MqA
KAFKA_AGENTCORE_REGION=eu-central-1
KAFKA_AGENTCORE_PROXY_PORT=3000
KAFKA_AGENTCORE_AWS_ACCESS_KEY_ID=...
KAFKA_AGENTCORE_AWS_SECRET_ACCESS_KEY=...

AWS_AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:eu-central-1:356994971776:runtime/aws_mcp_server-57wIOB35U1
AWS_AGENTCORE_REGION=eu-central-1
AWS_AGENTCORE_PROXY_PORT=3001
AWS_AGENTCORE_AWS_PROFILE=default   # or whatever profile assumes into 356994971776
```

The implementation will not auto-migrate the local `.env`. The error message from `loadProxyConfigFromEnv` (when a required var is missing) names the missing var so the developer can see exactly what to add.

## Testing

### Update existing tests (2 files)

**`packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts`**: Replace the `process.env.AGENTCORE_*` setup block with explicit config construction.

```typescript
// Before:
process.env.AGENTCORE_RUNTIME_ARN = TEST_ARN;
process.env.AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATESTACCESSKEY123";
process.env.AGENTCORE_AWS_SECRET_ACCESS_KEY = "test-secret-key";
process.env.AGENTCORE_AWS_SESSION_TOKEN = "test-session-token";
process.env.AGENTCORE_PROXY_PORT = "0";
// ... clearCredentialCache(); proxy = await startAgentCoreProxy();

// After:
const TEST_CONFIG: ProxyConfig = {
	runtimeArn: TEST_ARN,
	region: "eu-central-1",
	port: 0,           // 0 = ephemeral
	qualifier: "DEFAULT",
	serverName: "mcp-server",
	credentials: {
		accessKeyId: "AKIATESTACCESSKEY123",
		secretAccessKey: "test-secret-key",
		sessionToken: "test-session-token",
	},
};
proxy = await startAgentCoreProxy(TEST_CONFIG);
```

The `clearCredentialCache()` calls are removed (no module-level cache to clear). Each test that needs a fresh credential state now constructs a fresh proxy (which has its own closure-scoped cache).

The "no session token" subtest (line 191) constructs a config without `sessionToken`:
```typescript
proxy = await startAgentCoreProxy({ ...TEST_CONFIG, credentials: { accessKeyId: "...", secretAccessKey: "..." } });
```

**`packages/shared/src/__tests__/agentcore-proxy-retry.test.ts`**: Same pattern. `clearCredentialCache` import removed; `startAgentCoreProxy(TEST_CONFIG)` everywhere.

### Add new test file (1 file)

**`packages/shared/src/__tests__/agentcore-config.test.ts`** — 8 unit tests for `loadProxyConfigFromEnv`:

1. `loadProxyConfigFromEnv("KAFKA")` reads `KAFKA_AGENTCORE_RUNTIME_ARN` correctly
2. throws when `<PREFIX>_AGENTCORE_RUNTIME_ARN` is missing (error message names the var)
3. throws when `<PREFIX>_AGENTCORE_REGION` is missing
4. throws when `<PREFIX>_AGENTCORE_PROXY_PORT` is missing
5. throws when `<PREFIX>_AGENTCORE_PROXY_PORT` is non-numeric or out of range
6. uses defaults for `QUALIFIER` and `SERVER_NAME` when not set
7. returns static credentials object when `<PREFIX>_AGENTCORE_AWS_ACCESS_KEY_ID` + `_SECRET_ACCESS_KEY` are set
8. returns a function (lazy AWS-CLI fallback) when only `<PREFIX>_AGENTCORE_AWS_PROFILE` is set

Each test sets/unsets only the env vars it needs (test-isolated). Use `bun:test`'s `beforeEach` to snapshot/restore `process.env`.

### Out of scope for testing

- A live two-proxy-running-side-by-side integration test (would need real AWS and the actual deployed runtimes). The per-handle-cache fix is testable via the unit tests; cross-process isolation is testable by inspection of the diff (no module-level state remains).
- Updating `agentcore-proxy-tool-status.test.ts` — that file doesn't call `startAgentCoreProxy()` and stays untouched.

## Gate

Refactor is complete when:

1. `startAgentCoreProxy()` accepts a `ProxyConfig` argument and reads no `process.env.*` inside its body or in any internal helper.
2. Module-level `cachedCreds`, `credsExpiresAt`, `clearCredentialCache`, `readProxyConfig` are all removed.
3. `loadProxyConfigFromEnv(prefix)` exists in `@devops-agent/shared` and is exported.
4. Both `mcp-server-aws/src/index.ts` and `mcp-server-kafka/src/index.ts` call `loadProxyConfigFromEnv` + `startAgentCoreProxy(config)`; neither mutates `process.env.AGENTCORE_*`.
5. `.env.example` documents the per-server template.
6. `agentcore-proxy-roundtrip.test.ts` and `agentcore-proxy-retry.test.ts` pass with the new API.
7. `agentcore-config.test.ts` exists with 8 passing tests.
8. `bun run --filter @devops-agent/shared test` shows all proxy tests pass, no `cachedCreds`-related test failures.
9. `bun run --filter @devops-agent/mcp-server-aws test`: 130 pass, 0 fail.
10. `bun run --filter @devops-agent/mcp-server-kafka test`: 307 pass, 0 fail.
11. Manual smoke: with both `KAFKA_AGENTCORE_*` and `AWS_AGENTCORE_*` set in `.env`, `bun run dev` brings up two proxies on :3000 and :3001 without collision.
12. Typecheck + biome clean.

## Error modes and recovery

| Failure | Symptom | Recovery |
|---|---|---|
| Developer's `.env` still has generic `AGENTCORE_*` only | Proxy boot fails with `"KAFKA_AGENTCORE_RUNTIME_ARN is required"` (or AWS) | Rename env vars per Migration section |
| `<PREFIX>_AGENTCORE_REGION` missing | `loadProxyConfigFromEnv` throws naming the var | Add the var |
| `<PREFIX>_AGENTCORE_PROXY_PORT` invalid (e.g. `"abc"`) | `loadProxyConfigFromEnv` throws naming the var | Set to a valid integer port |
| AWS CLI profile in `<PREFIX>_AGENTCORE_AWS_PROFILE` doesn't exist | `aws configure export-credentials` exits non-zero; credentials function rejects | Fix the profile name or use explicit env-var creds |
| Both proxies need the same port (misconfiguration) | Second proxy fails to bind with `EADDRINUSE` | Set different `<PREFIX>_AGENTCORE_PROXY_PORT` values |
| Existing tests still using `clearCredentialCache` import | TypeScript compile error: `clearCredentialCache is not exported` | Remove the import; construct a fresh proxy per test instead |

## Reversibility

This is a breaking config change (the generic `AGENTCORE_*` env vars stop working). Reverting requires:

1. Revert the 4 modified source files (`agentcore-proxy.ts`, `mcp-server-aws/index.ts`, `mcp-server-kafka/index.ts`, `.env.example`)
2. Restore the developer's local `.env` to the old generic var names

The deployed AgentCore runtimes themselves are unaffected (they don't read `.env`). Phase 3's runtime and Phase 4's wiring stay live. Only the local proxy boot logic changes.

## Out of scope (later)

- Migrating to `@aws-sdk/credential-providers` for proper AWS SDK credential resolution (replace the AWS-CLI shellout)
- Pre-emptive proxy-mode branches for `elastic`/`couchbase`/`konnect`/`gitlab` MCP packages (add when those servers actually get AgentCore deploys)
- Central dev-runner orchestration script with health checks
- Per-server retry/timeout/idleTimeout overrides
- Adding the `<PREFIX>_AGENTCORE_*` env vars to the Phase 3 `deploy.sh` so deployments emit the right block automatically

## References

- Phase 3 spec (introduced the `??` fallback): `docs/superpowers/specs/2026-05-15-aws-datasource-phase-3-agentcore-deployment.md`
- Phase 4 spec (added the same pattern for Kafka): `docs/superpowers/specs/2026-05-15-aws-datasource-phase-4-agent-pipeline-integration.md`
- `packages/shared/src/agentcore-proxy.ts` — the file refactored
- `packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts:11,20-25,46-47` — the test setup pattern that needs updating
- `packages/shared/src/__tests__/agentcore-proxy-retry.test.ts:10,16,26-31,207-208,256-257` — same
- Memory note `reference_first_deploy_to_fresh_account_bugs` — Phase 3 surfaced multiple dormant bugs; this is the latest
- Memory note `feedback_probe_agentcore_via_sigv4_proxy` — manual two-proxy smoke pattern
