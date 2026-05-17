# SIO-780 — MCP Identity + Three-Tier Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a three-tier probe model (`/health`, `/identity`, `/ready`) across all 7 MCP servers + 2 AgentCore proxies, plus an agent-side three-tier probe and a five-state UI, so the dashboard can distinguish ready / unready / down / replaced / misidentified.

**Architecture:** Single Linear ticket SIO-780 executed in three independently-shippable phases. Phase A adds `IdentityCard` + `/identity` route + bootstrap wiring (server-side only; agent ignores). Phase B hoists `createReadinessProbe` from kafka-mcp to `@devops-agent/shared` and wires per-MCP upstream probes (including SigV4-signed `tools/list` for the AgentCore proxies). Phase C replaces the agent's single-tier `healthCheckServer` with a five-state `probeServer`, adds boot-strict role checking, auto-reconnect on `replaced`, and a five-state UI.

**Tech Stack:** Bun, TypeScript strict mode, `@modelcontextprotocol/sdk`, `@langchain/mcp-adapters`, Zod, Biome, pino, OpenTelemetry, SvelteKit + Svelte 5 runes + Tailwind, Bun.serve(), AbortSignal, crypto.randomUUID, crypto.createHash.

**Spec:** `docs/superpowers/specs/2026-05-17-mcp-identity-readiness-design.md`

**Linear:** [SIO-780](https://linear.app/siobytes/issue/SIO-780) — In Progress

---

## Pre-flight

- [ ] **Step P1: Confirm branch and clean working tree**

```bash
git rev-parse --abbrev-ref HEAD
# Expected: simonowusupvh/sio-780-mcp-identity-three-tier-readiness
git status
# Expected: nothing to commit, working tree clean (spec already committed at 032fd0a)
git log --oneline -1
# Expected: 032fd0a SIO-780: spec — MCP identity + three-tier readiness design
```

- [ ] **Step P2: Verify baseline test/typecheck/lint state**

```bash
bun install
bun run typecheck
bun run lint
bun run test
```

Record the count of pre-existing SIO-779 lint warnings/errors. They are acceptable per the spec's verification section; new code must not add to that count.

---

## Phase A — IdentityCard + /identity route + bootstrap wiring

**Output:** All 7 MCP servers and both AgentCore proxies expose `GET /identity`. Agent ignores the route. Phase A ships as PR #1.

### Task A1: Shared identity module — `identity.ts`

**Files:**
- Create: `packages/shared/src/transport/identity.ts`
- Test: `packages/shared/src/transport/__tests__/identity.test.ts`
- Modify: `packages/shared/src/index.ts` (re-exports)

- [ ] **Step A1.1: Write failing tests**

Create `packages/shared/src/transport/__tests__/identity.test.ts`:

```ts
// packages/shared/src/transport/__tests__/identity.test.ts
import { describe, expect, test } from "bun:test";
import { buildIdentityCard, canonicalizeUpstream } from "../identity.ts";

describe("canonicalizeUpstream", () => {
    test("same input → same fingerprint", () => {
        const a = canonicalizeUpstream({ host: "x", port: 9080 });
        const b = canonicalizeUpstream({ host: "x", port: 9080 });
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{16}$/);
    });

    test("field order independence", () => {
        const a = canonicalizeUpstream({ host: "x", port: 9080 });
        const b = canonicalizeUpstream({ port: 9080, host: "x" });
        expect(a).toBe(b);
    });

    test("credential keys are redacted", () => {
        const withCreds = canonicalizeUpstream({ host: "x", password: "secret-1" });
        const withoutCreds = canonicalizeUpstream({ host: "x", password: "secret-2" });
        expect(withCreds).toBe(withoutCreds);
        const noCredKey = canonicalizeUpstream({ host: "x" });
        expect(withCreds).toBe(noCredKey);
    });

    test("allow-list keys (publicKey, instanceId) are NOT redacted", () => {
        const a = canonicalizeUpstream({ publicKey: "abc" });
        const b = canonicalizeUpstream({ publicKey: "xyz" });
        expect(a).not.toBe(b);
    });

    test("nested arrays of objects redact credentials", () => {
        const a = canonicalizeUpstream({ deployments: [{ name: "prod", apiKey: "key-1" }] });
        const b = canonicalizeUpstream({ deployments: [{ name: "prod", apiKey: "key-2" }] });
        expect(a).toBe(b);
    });
});

describe("buildIdentityCard", () => {
    test("instanceId rotates on each call", () => {
        const a = buildIdentityCard({ role: "elastic-mcp", version: "0.1.0", mode: "http", upstreamFingerprint: "abc" });
        const b = buildIdentityCard({ role: "elastic-mcp", version: "0.1.0", mode: "http", upstreamFingerprint: "abc" });
        expect(a.instanceId).not.toBe(b.instanceId);
        expect(a.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    });

    test("captures pid and bootedAt", () => {
        const card = buildIdentityCard({ role: "kafka-mcp", version: "0.2.0", mode: "http", upstreamFingerprint: "def" });
        expect(card.pid).toBe(process.pid);
        expect(card.bootedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(card.role).toBe("kafka-mcp");
        expect(card.version).toBe("0.2.0");
    });
});
```

- [ ] **Step A1.2: Run tests, expect failure**

```bash
bun test packages/shared/src/transport/__tests__/identity.test.ts
```

Expected: ENOENT or "Cannot find module ../identity.ts".

- [ ] **Step A1.3: Implement `identity.ts`**

Create `packages/shared/src/transport/identity.ts`:

```ts
// packages/shared/src/transport/identity.ts
import { createHash, randomUUID } from "node:crypto";

export type McpRole =
    | "elastic-mcp"
    | "kafka-mcp"
    | "couchbase-mcp"
    | "konnect-mcp"
    | "gitlab-mcp"
    | "atlassian-mcp"
    | "aws-mcp"
    | "aws-proxy"
    | "kafka-proxy";

export type McpTransportMode = "stdio" | "http" | "agentcore-proxy";

export interface IdentityCard {
    instanceId: string;
    role: McpRole;
    version: string;
    bootedAt: string;
    pid: number;
    mode: McpTransportMode;
    upstreamFingerprint: string;
}

export interface BuildIdentityCardOptions {
    role: McpRole;
    version: string;
    mode: McpTransportMode;
    upstreamFingerprint: string;
}

export function buildIdentityCard(opts: BuildIdentityCardOptions): IdentityCard {
    return {
        instanceId: randomUUID(),
        role: opts.role,
        version: opts.version,
        bootedAt: new Date().toISOString(),
        pid: process.pid,
        mode: opts.mode,
        upstreamFingerprint: opts.upstreamFingerprint,
    };
}

const CREDENTIAL_KEY_RE = /password|secret|token|key/i;
const ALLOWED_KEY_RE = /^(publicKey|instanceId)$/;

// 16-hex-char fingerprint over canonical JSON with sorted keys.
// Credential-bearing keys (matching /password|secret|token|key/i) are stripped
// before hashing, except for `publicKey` and `instanceId` which are public.
export function canonicalizeUpstream(config: Record<string, unknown>): string {
    const redacted = redactCredentials(config) as Record<string, unknown>;
    const sorted = JSON.stringify(redacted, Object.keys(redacted).sort());
    return createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

function redactCredentials(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactCredentials);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (CREDENTIAL_KEY_RE.test(k) && !ALLOWED_KEY_RE.test(k)) continue;
            out[k] = redactCredentials(v);
        }
        return out;
    }
    return value;
}
```

- [ ] **Step A1.4: Re-export from `packages/shared/src/index.ts`**

Append to the existing exports block:

```ts
export {
    type BuildIdentityCardOptions,
    buildIdentityCard,
    canonicalizeUpstream,
    type IdentityCard,
    type McpRole,
    type McpTransportMode,
} from "./transport/identity.ts";
```

- [ ] **Step A1.5: Run tests, expect pass**

```bash
bun test packages/shared/src/transport/__tests__/identity.test.ts
```

Expected: 7 tests pass.

- [ ] **Step A1.6: Typecheck + lint**

```bash
bun run typecheck
bun run --filter @devops-agent/shared lint
```

Expected: no new errors.

- [ ] **Step A1.7: Commit**

```bash
git add packages/shared/src/transport/identity.ts \
        packages/shared/src/transport/__tests__/identity.test.ts \
        packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
SIO-780: shared IdentityCard + canonicalizeUpstream helpers

New transport/identity.ts: buildIdentityCard() emits an IdentityCard
(instanceId, role, version, bootedAt, pid, mode, upstreamFingerprint).
canonicalizeUpstream() returns a 16-char sha256 over the upstream config
with credential-bearing keys stripped (regex /password|secret|token|key/i;
publicKey/instanceId allow-listed). Re-exported from shared/index.ts.

Phase A of SIO-780. Agent does not yet consume identity cards.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task A2: Extend `McpApplicationOptions<T>` + thread `IdentityCard` through bootstrap

**Files:**
- Modify: `packages/shared/src/bootstrap.ts:30-46` (options interface)
- Modify: `packages/shared/src/bootstrap.ts:53-159` (createMcpApplication body, around step 5)
- Test: `packages/shared/src/__tests__/bootstrap.identity.test.ts` (NEW)

- [ ] **Step A2.1: Write failing test**

Create `packages/shared/src/__tests__/bootstrap.identity.test.ts`:

```ts
// packages/shared/src/__tests__/bootstrap.identity.test.ts
import { describe, expect, test } from "bun:test";
import { createMcpApplication, type IdentityCard } from "../index.ts";

describe("createMcpApplication identity wiring", () => {
    test("constructs an IdentityCard from role + version + identityFingerprint", async () => {
        let received: IdentityCard | undefined;
        const app = await createMcpApplication<{ host: string }>({
            name: "test-identity",
            logger: { info: () => {}, error: () => {}, warn: () => {} },
            initTracing: () => {},
            telemetry: { serviceName: "test", serviceVersion: "0.0.0", enabled: false },
            mode: "proxy",
            role: "elastic-mcp",
            version: "9.9.9",
            identityFingerprint: (ds) => `fp-${ds.host}`,
            initDatasource: async () => ({ host: "fixture" }),
            createTransport: async (_factory, _ds, identityCard) => {
                received = identityCard;
                return { closeAll: async () => {} };
            },
        });
        expect(received).toBeDefined();
        expect(received?.role).toBe("elastic-mcp");
        expect(received?.version).toBe("9.9.9");
        expect(received?.upstreamFingerprint).toBe("fp-fixture");
        expect(received?.mode).toBe("agentcore-proxy");
        await app.shutdown().catch(() => {});  // shutdown calls process.exit(0); catch in test env
    });
});
```

Note: `app.shutdown()` calls `process.exit(0)` in production. The test should not actually await shutdown — comment out or expect the test to terminate the process. For the test runner, do NOT call shutdown; let the test return.

- [ ] **Step A2.2: Run tests, expect failure**

```bash
bun test packages/shared/src/__tests__/bootstrap.identity.test.ts
```

Expected: TypeScript error — `role`, `version`, `identityFingerprint` not in `McpApplicationOptions<T>`; `createTransport` doesn't accept a third arg.

- [ ] **Step A2.3: Extend `McpApplicationOptions<T>`**

Edit `packages/shared/src/bootstrap.ts`. Replace the `McpApplicationOptions<T>` interface (lines 30-46) with:

```ts
import type { IdentityCard, McpRole } from "./transport/identity.ts";

export interface McpApplicationOptions<T> {
    name: string;
    logger: BootstrapLogger;
    initTracing: () => void;
    telemetry: TelemetryConfig;
    initDatasource: () => Promise<T>;
    mode?: "server" | "proxy";
    createServerFactory?: (datasource: T) => () => McpServer;
    createTransport: (
        serverFactory: (() => McpServer) | undefined,
        datasource: T,
        identityCard: IdentityCard,
    ) => Promise<BootstrapTransportResult>;
    cleanupDatasource?: (datasource: T) => Promise<void>;
    onStarted?: (datasource: T) => void;
    readOnly?: ReadOnlyMiddlewareConfig;
    // SIO-780 Phase A
    role: McpRole;
    version: string;
    identityFingerprint: (datasource: T) => string;
}
```

- [ ] **Step A2.4: Build the `IdentityCard` inside `createMcpApplication`**

In `packages/shared/src/bootstrap.ts`, between step 4 (server factory creation) and step 5 (transport start), insert:

```ts
import { buildIdentityCard } from "./transport/identity.ts";

// inside createMcpApplication, just before `const transport = await options.createTransport(...)`:
const identityCard = buildIdentityCard({
    role: options.role,
    version: options.version,
    mode: mode === "proxy" ? "agentcore-proxy" : "http",
    upstreamFingerprint: options.identityFingerprint(datasource),
});
logger.info("Identity card built", {
    instanceId: identityCard.instanceId,
    role: identityCard.role,
    upstreamFingerprint: identityCard.upstreamFingerprint,
});
```

Then change the `createTransport` invocation (currently `await options.createTransport(serverFactory, datasource)`) to:

```ts
const transport = await options.createTransport(serverFactory, datasource, identityCard);
```

- [ ] **Step A2.5: Run tests, expect pass**

```bash
bun test packages/shared/src/__tests__/bootstrap.identity.test.ts
```

Expected: 1 test passes.

- [ ] **Step A2.6: Verify existing bootstrap tests still pass**

```bash
bun test packages/shared/src
```

Expected: previously-passing tests still pass. New required fields on `McpApplicationOptions` will break existing callers — they'll be fixed in Tasks A4–A10.

If existing `bootstrap.test.ts` cases fail because their fixture omits `role`/`version`/`identityFingerprint`, add those three fields to each fixture (use `role: "elastic-mcp"`, `version: "0.0.0-test"`, `identityFingerprint: () => "test"`).

- [ ] **Step A2.7: Commit**

```bash
git add packages/shared/src/bootstrap.ts packages/shared/src/__tests__/
git commit -m "$(cat <<'EOF'
SIO-780: thread IdentityCard through createMcpApplication

McpApplicationOptions<T> gains three new required fields: role (McpRole),
version (string from caller's package.json), and identityFingerprint
((datasource: T) => string). createMcpApplication builds the IdentityCard
between datasource init and transport start, then passes it as the third
arg to createTransport(serverFactory, datasource, identityCard).

Existing bootstrap test fixtures updated to satisfy the new required fields.
Per-package createTransport implementations updated in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task A3: AgentCore proxy transport — register `/identity` route

**Files:**
- Modify: `packages/shared/src/transport/agentcore-proxy.ts` (proxy-mode createTransport helper)
- Modify: `packages/shared/src/agentcore-proxy.ts:622-635` (route registration)

- [ ] **Step A3.1: Write failing test**

Create `packages/shared/src/transport/__tests__/agentcore-proxy.identity.test.ts`:

```ts
// packages/shared/src/transport/__tests__/agentcore-proxy.identity.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAgentCoreProxyTransport, type IdentityCard } from "../../index.ts";

// Stub env required by loadProxyConfigFromEnv. AgentCore credentials are not
// actually called in this test — we only verify the /identity route shape.
beforeAll(() => {
    process.env.TEST_AGENTCORE_RUNTIME_ARN = "arn:aws:bedrock-agentcore:eu-west-1:111:runtime/test";
    process.env.TEST_AGENTCORE_REGION = "eu-west-1";
});
afterAll(() => {
    delete process.env.TEST_AGENTCORE_RUNTIME_ARN;
    delete process.env.TEST_AGENTCORE_REGION;
});

describe("agentcore proxy /identity", () => {
    test("GET /identity returns the supplied IdentityCard", async () => {
        const card: IdentityCard = {
            instanceId: "11111111-1111-1111-1111-111111111111",
            role: "kafka-proxy",
            version: "1.2.3",
            bootedAt: "2026-05-17T00:00:00.000Z",
            pid: 1234,
            mode: "agentcore-proxy",
            upstreamFingerprint: "deadbeefcafef00d",
        };
        const transport = await createAgentCoreProxyTransport(
            "TEST",
            { info: () => {}, error: () => {}, warn: () => {} },
            card,
        );
        // createAgentCoreProxyTransport currently returns BootstrapTransportResult
        // ({ closeAll }), but for this test we need to peek at the bun-served URL.
        // Expose a `port` field via the implementation update in step A3.3.
        const url = `http://127.0.0.1:${(transport as unknown as { port: number }).port}/identity`;
        const res = await fetch(url);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual(card);
        await transport.closeAll();
    });
});
```

- [ ] **Step A3.2: Run test, expect failure**

```bash
bun test packages/shared/src/transport/__tests__/agentcore-proxy.identity.test.ts
```

Expected: TypeScript error — `createAgentCoreProxyTransport` doesn't accept an `IdentityCard` argument.

- [ ] **Step A3.3: Add `/identity` route in `agentcore-proxy.ts`**

Edit `packages/shared/src/agentcore-proxy.ts`. In the `Bun.serve({ routes: { ... } })` block (around lines 622-635), add a new sibling route right after `/ping`:

```ts
"/identity": {
    GET: () => Response.json(identityCard),
},
```

The route handler closes over `identityCard`. The function that builds the route table needs to accept `identityCard` as a parameter. Find the function in `agentcore-proxy.ts` (likely `startAgentCoreProxy` or similar) and add `identityCard: IdentityCard` to its parameters; thread the value through.

Then in `packages/shared/src/transport/agentcore-proxy.ts`, change `createAgentCoreProxyTransport` so it accepts a third arg `identityCard: IdentityCard` and forwards it to the proxy server constructor. Also expose `port` on the returned object (for tests) — if the underlying proxy already returns `{ port }`, just preserve it.

- [ ] **Step A3.4: Run test, expect pass**

```bash
bun test packages/shared/src/transport/__tests__/agentcore-proxy.identity.test.ts
```

Expected: 1 test passes.

- [ ] **Step A3.5: Manual probe**

```bash
# Start one proxy-mode MCP server (kafka in proxy mode is fine if .env is set).
bun run --filter '@devops-agent/mcp-server-kafka' dev &
sleep 3
curl -s http://localhost:3000/identity | jq
# expected: { instanceId: ..., role: "kafka-proxy", upstreamFingerprint: ..., ... }
kill %1
```

- [ ] **Step A3.6: Commit**

```bash
git add packages/shared/src/agentcore-proxy.ts \
        packages/shared/src/transport/agentcore-proxy.ts \
        packages/shared/src/transport/__tests__/agentcore-proxy.identity.test.ts
git commit -m "$(cat <<'EOF'
SIO-780: register /identity route on AgentCore SigV4 proxy

The proxy now serves GET /identity returning the IdentityCard built by
createMcpApplication. createAgentCoreProxyTransport accepts the card as
its third argument and threads it into the Bun.serve route registration.
The route returns the card body verbatim (no upstream call, no auth).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task A4: kafka-mcp — `/identity` route + bootstrap wiring

**Files:**
- Modify: `packages/mcp-server-kafka/src/transport/http.ts:255-267` (add route)
- Modify: `packages/mcp-server-kafka/src/transport/factory.ts` (accept `identityCard` arg)
- Modify: `packages/mcp-server-kafka/src/index.ts:81-96` and `:102-223` (pass role, version, identityFingerprint)

- [ ] **Step A4.1: Extend `http.ts` config + route**

In `packages/mcp-server-kafka/src/transport/http.ts`:

1. Add `identityCard?: IdentityCard` to `HttpTransportConfig` (~line 33):

```ts
import type { IdentityCard } from "@devops-agent/shared";

interface HttpTransportConfig {
    // ... existing fields
    identityCard?: IdentityCard;  // SIO-780
}
```

2. In the `routes: { ... }` block (around line 255), add `/identity`:

```ts
"/identity": {
    GET: () => config.identityCard
        ? Response.json(config.identityCard)
        : Response.json({ error: "identity not configured" }, { status: 503 }),
},
```

- [ ] **Step A4.2: Thread `identityCard` through `factory.ts`**

In `packages/mcp-server-kafka/src/transport/factory.ts`, change `createTransport` to accept a fourth arg:

```ts
import type { IdentityCard } from "@devops-agent/shared";

export async function createTransport(
    config: TransportConfig,
    serverFactory: () => McpServer,
    readinessProbe?: () => Promise<ReadinessSnapshot>,
    identityCard?: IdentityCard,
): Promise<TransportResult> {
    // ... existing logic, pass identityCard into startHttpTransport options:
    if (useHttp) {
        // ... existing options
        result.http = await startHttpTransport(serverFactory, {
            // ... existing options
            readinessProbe,
            drainTimeoutMs: config.drainTimeoutMs,
            identityCard,  // SIO-780
        });
    }
}
```

- [ ] **Step A4.3: Update `index.ts` to satisfy new `McpApplicationOptions` requirements**

In `packages/mcp-server-kafka/src/index.ts`:

For the proxy-mode branch (lines 81-96), add three fields to the `createMcpApplication` call:

```ts
createMcpApplication<KafkaProxyDatasource>({
    name: "kafka-mcp-server",
    role: "kafka-proxy",                            // SIO-780
    version: pkg.version,                           // SIO-780
    identityFingerprint: (ds) => canonicalizeUpstream({ runtimeArn: ds.config.runtimeArn, region: ds.config.region }),  // SIO-780
    // ... existing fields
    createTransport: async (_factory, ds, identityCard) =>
        createAgentCoreProxyTransport("KAFKA", createBootstrapAdapter(logger), identityCard),
    // ... rest unchanged
});
```

For the local-mode branch (lines 102-223):

```ts
import { canonicalizeUpstream } from "@devops-agent/shared";

createMcpApplication<KafkaDatasource>({
    name: "kafka-mcp-server",
    role: "kafka-mcp",                              // SIO-780
    version: pkg.version,                           // SIO-780
    identityFingerprint: () => canonicalizeUpstream({
        provider: config.kafka.provider,
        clientId: config.kafka.clientId,
        schemaRegistryEnabled: config.schemaRegistry.enabled,
        ksqlEnabled: config.ksql.enabled,
        connectEnabled: config.connect.enabled,
        restproxyEnabled: config.restproxy.enabled,
    }),
    // ... existing fields
    createTransport: (serverFactory, ds, identityCard) =>
        createTransport(
            config.transport,
            // biome-ignore lint/style/noNonNullAssertion: SIO-779
            serverFactory!,
            createReadinessProbe({ clientManager: ds.clientManager, toolOptions: ds.toolOptions, config }),
            identityCard,  // SIO-780
        ),
});
```

- [ ] **Step A4.4: Run kafka-mcp tests**

```bash
bun run --filter '@devops-agent/mcp-server-kafka' test
```

Expected: pre-existing tests pass; no new failures.

- [ ] **Step A4.5: Manual probe**

```bash
bun run --filter '@devops-agent/mcp-server-kafka' dev &
sleep 3
curl -s http://localhost:9081/identity | jq
# Expected: { role: "kafka-mcp", upstreamFingerprint: <16 hex>, pid: <number>, ... }
kill %1
```

- [ ] **Step A4.6: Commit**

```bash
git add packages/mcp-server-kafka/
git commit -m "$(cat <<'EOF'
SIO-780: kafka-mcp /identity route + bootstrap wiring

http.ts registers GET /identity returning the IdentityCard. factory.ts
threads the card from createMcpApplication into startHttpTransport.
index.ts now passes role ("kafka-mcp" local mode / "kafka-proxy" agentcore
mode), version (from package.json), and identityFingerprint (sha256 over
provider + clientId + service-enabled flags, credentials redacted) to
createMcpApplication.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task A5: elastic-mcp — `/identity` route + bootstrap wiring

**Files:**
- Modify: `packages/mcp-server-elastic/src/transport/http.ts` (add route)
- Modify: `packages/mcp-server-elastic/src/transport/factory.ts` (accept identityCard)
- Modify: `packages/mcp-server-elastic/src/index.ts` (pass role + version + identityFingerprint)

- [ ] **Step A5.1: Read existing elastic transport files**

```bash
ls packages/mcp-server-elastic/src/transport/
cat packages/mcp-server-elastic/src/index.ts | head -50
```

Confirm the elastic transport mirrors kafka's `http.ts`/`factory.ts` shape. If it diverges, follow the existing pattern but add the route and thread the card the same way.

- [ ] **Step A5.2: Apply the same three changes as Task A4**

For elastic, the bootstrap call should set:

```ts
role: "elastic-mcp",
version: pkg.version,
identityFingerprint: (ds) => canonicalizeUpstream({
    deployments: config.elastic.deployments.map(d => ({ id: d.id, url: d.url })),
    // do NOT include apiKey/cloudId — they're credentials, redacted automatically
    // but the redaction defends against future drift in env shape
}),
```

The deployment list is the upstream identity for elastic — if a deployment is added/removed, the fingerprint changes and the agent treats the MCP as `replaced` next poll.

- [ ] **Step A5.3: Run elastic-mcp tests**

```bash
bun run --filter '@devops-agent/mcp-server-elastic' test
```

- [ ] **Step A5.4: Manual probe**

```bash
bun run --filter '@devops-agent/mcp-server-elastic' dev &
sleep 3
curl -s http://localhost:9080/identity | jq
# Expected: { role: "elastic-mcp", ... }
kill %1
```

- [ ] **Step A5.5: Commit**

```bash
git add packages/mcp-server-elastic/
git commit -m "SIO-780: elastic-mcp /identity route + bootstrap wiring

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A6: couchbase-mcp — `/identity` route + bootstrap wiring

**Files:**
- Modify: `packages/mcp-server-couchbase/src/transport/http.ts`
- Modify: `packages/mcp-server-couchbase/src/transport/factory.ts`
- Modify: `packages/mcp-server-couchbase/src/index.ts`

- [ ] **Step A6.1: Apply the Task A4 pattern**

Bootstrap call additions:

```ts
role: "couchbase-mcp",
version: pkg.version,
identityFingerprint: () => canonicalizeUpstream({
    hostname: config.couchbase.hostname,
    bucket: config.couchbase.bucket,
    // username will be auto-redacted by the regex
}),
```

- [ ] **Step A6.2: Run tests + manual probe**

```bash
bun run --filter '@devops-agent/mcp-server-couchbase' test
bun run --filter '@devops-agent/mcp-server-couchbase' dev &
sleep 3
curl -s http://localhost:9082/identity | jq
kill %1
```

- [ ] **Step A6.3: Commit**

```bash
git add packages/mcp-server-couchbase/
git commit -m "SIO-780: couchbase-mcp /identity route + bootstrap wiring

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A7: konnect-mcp — `/identity` route + bootstrap wiring

**Files:**
- Modify: `packages/mcp-server-konnect/src/transport/http.ts`
- Modify: `packages/mcp-server-konnect/src/transport/factory.ts`
- Modify: `packages/mcp-server-konnect/src/index.ts`

- [ ] **Step A7.1: Apply the Task A4 pattern**

```ts
role: "konnect-mcp",
version: pkg.version,
identityFingerprint: () => canonicalizeUpstream({
    region: config.konnect.region,
    // accessToken auto-redacted
}),
```

- [ ] **Step A7.2: Run tests + manual probe**

```bash
bun run --filter '@devops-agent/mcp-server-konnect' test
bun run --filter '@devops-agent/mcp-server-konnect' dev &
sleep 3
curl -s http://localhost:9083/identity | jq '.role, .upstreamFingerprint'
kill %1
```

- [ ] **Step A7.3: Commit**

```bash
git add packages/mcp-server-konnect/
git commit -m "SIO-780: konnect-mcp /identity route + bootstrap wiring

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A8: gitlab-mcp — `/identity` route + bootstrap wiring

**Files:**
- Modify: `packages/mcp-server-gitlab/src/transport/http.ts`
- Modify: `packages/mcp-server-gitlab/src/transport/factory.ts`
- Modify: `packages/mcp-server-gitlab/src/index.ts`

- [ ] **Step A8.1: Apply the Task A4 pattern**

GitLab is a proxy-style MCP that forwards to GitLab's native `/api/v4/mcp` plus custom code-analysis tools. The fingerprint should cover its instance URL:

```ts
role: "gitlab-mcp",
version: pkg.version,
identityFingerprint: () => canonicalizeUpstream({
    instanceUrl: config.gitlab.instanceUrl,
    // personalAccessToken auto-redacted
}),
```

- [ ] **Step A8.2: Run tests + manual probe**

```bash
bun run --filter '@devops-agent/mcp-server-gitlab' test
bun run --filter '@devops-agent/mcp-server-gitlab' dev &
sleep 3
curl -s http://localhost:9084/identity | jq
kill %1
```

- [ ] **Step A8.3: Commit**

```bash
git add packages/mcp-server-gitlab/
git commit -m "SIO-780: gitlab-mcp /identity route + bootstrap wiring

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A9: atlassian-mcp — `/identity` route + bootstrap wiring

**Files:**
- Modify: `packages/mcp-server-atlassian/src/transport/http.ts`
- Modify: `packages/mcp-server-atlassian/src/transport/factory.ts`
- Modify: `packages/mcp-server-atlassian/src/index.ts`

- [ ] **Step A9.1: Apply the Task A4 pattern**

Atlassian is a proxy to Atlassian Cloud via OAuth 2.1:

```ts
role: "atlassian-mcp",
version: pkg.version,
identityFingerprint: () => canonicalizeUpstream({
    upstreamMcpUrl: config.atlassian.upstreamMcpUrl,
    siteName: config.atlassian.siteName,
    // OAuth tokens auto-redacted
}),
```

- [ ] **Step A9.2: Run tests + manual probe**

```bash
bun run --filter '@devops-agent/mcp-server-atlassian' test
bun run --filter '@devops-agent/mcp-server-atlassian' dev &
sleep 3
curl -s http://localhost:9085/identity | jq
kill %1
```

- [ ] **Step A9.3: Commit**

```bash
git add packages/mcp-server-atlassian/
git commit -m "SIO-780: atlassian-mcp /identity route + bootstrap wiring

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A10: aws-mcp — `/identity` route + bootstrap wiring

**Files:**
- Modify: `packages/mcp-server-aws/src/transport/http.ts`
- Modify: `packages/mcp-server-aws/src/transport/factory.ts`
- Modify: `packages/mcp-server-aws/src/index.ts`

The aws-mcp runs in two modes today: local (direct) and SigV4-proxy to AgentCore. Per the spec's `MCP_SERVER_TO_ROLE`, the *deployed* role is `aws-proxy`. For the local-direct mode (rare), the role would be `aws-mcp`. Both modes need `/identity`.

- [ ] **Step A10.1: Apply the Task A4 pattern**

For proxy mode (AWS_AGENTCORE_RUNTIME_ARN set):

```ts
role: "aws-proxy",
version: pkg.version,
identityFingerprint: (ds) => canonicalizeUpstream({
    runtimeArn: ds.config.runtimeArn,
    region: ds.config.region,
}),
```

For direct mode (no runtime ARN):

```ts
role: "aws-mcp",
version: pkg.version,
identityFingerprint: () => canonicalizeUpstream({
    region: config.aws.region,
    externalId: config.aws.externalId,
    // assumeRoleArn / credentials auto-redacted
}),
```

- [ ] **Step A10.2: Run tests + manual probe (proxy mode)**

```bash
bun run --filter '@devops-agent/mcp-server-aws' test
bun run --filter '@devops-agent/mcp-server-aws' dev &
sleep 3
curl -s http://localhost:3001/identity | jq
# Expected: { role: "aws-proxy", ... }
kill %1
```

- [ ] **Step A10.3: Commit**

```bash
git add packages/mcp-server-aws/
git commit -m "SIO-780: aws-mcp /identity route + bootstrap wiring (proxy + direct)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A11: End-to-end Phase A acceptance test

**Files:**
- Create: `scripts/sio780/check-identity.sh`

- [ ] **Step A11.1: Write probe script**

Create `scripts/sio780/check-identity.sh`:

```bash
#!/usr/bin/env bash
# SIO-780: probe every MCP server's /identity endpoint and verify role + fingerprint shape
set -euo pipefail

declare -A EXPECTED_ROLES=(
    [9080]="elastic-mcp"
    [9081]="kafka-mcp"
    [9082]="couchbase-mcp"
    [9083]="konnect-mcp"
    [9084]="gitlab-mcp"
    [9085]="atlassian-mcp"
    [3001]="aws-proxy"
)

failures=0
for port in 9080 9081 9082 9083 9084 9085 3001; do
    expected="${EXPECTED_ROLES[$port]}"
    body=$(curl -s --max-time 2 "http://localhost:$port/identity" || echo '{}')
    role=$(echo "$body" | jq -r '.role // "MISSING"')
    fp=$(echo "$body" | jq -r '.upstreamFingerprint // "MISSING"')
    if [[ "$role" == "$expected" ]] && [[ "$fp" =~ ^[0-9a-f]{16}$ ]]; then
        echo "ok    port=$port role=$role fingerprint=$fp"
    else
        echo "FAIL  port=$port expected=$expected actual=$role fingerprint=$fp"
        failures=$((failures + 1))
    fi
done

exit "$failures"
```

- [ ] **Step A11.2: Run it with all MCP servers up**

```bash
chmod +x scripts/sio780/check-identity.sh
bun run dev &
sleep 10
scripts/sio780/check-identity.sh
```

Expected: 7 `ok` lines; exit 0. If any line says `FAIL`, fix that server's wiring before merging Phase A.

- [ ] **Step A11.3: Verify fingerprint stability across reboots**

```bash
# Capture fingerprints
scripts/sio780/check-identity.sh > /tmp/fp1.txt
# restart
pkill -f 'bun.*mcp-server'
sleep 5
bun run dev &
sleep 10
scripts/sio780/check-identity.sh > /tmp/fp2.txt
diff /tmp/fp1.txt /tmp/fp2.txt
# Expected: no diff (same env vars → same fingerprints; instanceIds differ, not shown by this script)
```

- [ ] **Step A11.4: Commit**

```bash
git add scripts/sio780/
git commit -m "SIO-780: Phase A acceptance probe script

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A12: Phase A typecheck + lint + open PR

- [ ] **Step A12.1: Full repo gate**

```bash
bun run typecheck
bun run lint
bun run test
```

Expected: all green except pre-existing SIO-779 lint failures recorded in step P2.

- [ ] **Step A12.2: Push branch + open Phase A PR**

```bash
git push -u origin simonowusupvh/sio-780-mcp-identity-three-tier-readiness
gh pr create --title "SIO-780 Phase A: IdentityCard + /identity route across all MCPs" --body "$(cat <<'EOF'
## Summary
- New `packages/shared/src/transport/identity.ts` defines `IdentityCard`, `McpRole`, `buildIdentityCard()`, `canonicalizeUpstream()`
- `McpApplicationOptions<T>` gains required `role`, `version`, `identityFingerprint` fields; `createMcpApplication` builds the card and threads it into `createTransport`
- All 7 MCP servers + AgentCore SigV4 proxy now serve `GET /identity` returning the card
- Agent does NOT yet consume the route (Phase C territory)

## Test plan
- [x] `bun test packages/shared/src/transport/__tests__/identity.test.ts` — 7 unit tests
- [x] `bun test packages/shared/src/__tests__/bootstrap.identity.test.ts` — wiring smoke
- [x] `bun test packages/shared/src/transport/__tests__/agentcore-proxy.identity.test.ts` — proxy route
- [x] `scripts/sio780/check-identity.sh` — all 7 ports return correct role + 16-char fingerprint
- [x] Fingerprints stable across reboots with identical env

## Linear
SIO-780 — Phase A of three. Phase B + C will land in follow-up PRs.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step A12.3: Transition Linear status**

Move SIO-780 to "In Review" via the Linear MCP (or comment on the PR triggering Linear's automation).

**Phase A complete.** Wait for review + merge before starting Phase B.

---

## Phase B — Hoist readiness probe + per-MCP upstream probes

**Output:** Every MCP (including both proxies) serves a working `GET /ready` that actually pings its upstream. Phase B ships as PR #2 after Phase A merges to main.

### Task B1: Hoist `createReadinessProbe` to shared

**Files:**
- Create: `packages/shared/src/transport/readiness.ts`
- Create: `packages/shared/src/transport/__tests__/readiness.test.ts`
- Modify: `packages/shared/src/index.ts` (re-exports)
- Delete: `packages/mcp-server-kafka/src/transport/readiness.ts` (after migrating tests)

- [ ] **Step B1.1: Copy kafka's `readiness.ts` to shared, generalized**

Create `packages/shared/src/transport/readiness.ts`:

```ts
// packages/shared/src/transport/readiness.ts
// SIO-780: hoisted from packages/mcp-server-kafka/src/transport/readiness.ts (SIO-726).
// Generalized: callers pass a `components` map of probe functions instead of the
// kafka-specific clientManager/toolOptions/config shape. TTL + single-flight
// guard preserved.

export type ComponentStatus = "ok" | "unreachable" | "disabled";

export interface ReadinessSnapshot {
    ready: boolean;
    components: Record<string, ComponentStatus>;
    errors?: Record<string, string>;
    cachedAt: string;
}

export interface CreateReadinessProbeOptions {
    // Probe functions per component. Each must resolve on success and reject on
    // failure. Pass `null` to record a component as `disabled` (e.g. an opt-in
    // service that isn't enabled in this deployment).
    components: Record<string, (() => Promise<void>) | null>;
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        promise.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (e) => {
                clearTimeout(timer);
                reject(e);
            },
        );
    });
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export function createReadinessProbe(opts: CreateReadinessProbeOptions): () => Promise<ReadinessSnapshot> {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const now = opts.now ?? Date.now;

    let cached: { snapshot: ReadinessSnapshot; expiresAt: number } | null = null;
    let inflight: Promise<ReadinessSnapshot> | null = null;

    async function runProbe(): Promise<ReadinessSnapshot> {
        const startedAt = now();
        const componentNames = Object.keys(opts.components);
        const probes = componentNames.map((name) => {
            const fn = opts.components[name];
            if (fn === null || fn === undefined) {
                return { name, enabled: false, promise: Promise.resolve() };
            }
            return { name, enabled: true, promise: withTimeout(fn(), timeoutMs, `${name} probe`) };
        });

        const results = await Promise.allSettled(probes.map((p) => p.promise));

        const components: Record<string, ComponentStatus> = {};
        const errors: Record<string, string> = {};
        let ready = true;

        for (const [i, probe] of probes.entries()) {
            const result = results[i];
            if (!probe.enabled) {
                components[probe.name] = "disabled";
                continue;
            }
            if (result?.status === "fulfilled") {
                components[probe.name] = "ok";
                continue;
            }
            components[probe.name] = "unreachable";
            ready = false;
            if (result?.status === "rejected") {
                errors[probe.name] = errorMessage(result.reason);
            }
        }

        const snapshot: ReadinessSnapshot = { ready, components, cachedAt: new Date(startedAt).toISOString() };
        if (Object.keys(errors).length > 0) snapshot.errors = errors;
        return snapshot;
    }

    return async () => {
        const ts = now();
        if (cached && cached.expiresAt > ts) return cached.snapshot;
        if (inflight) return inflight;
        inflight = runProbe().finally(() => {
            inflight = null;
        });
        const snapshot = await inflight;
        cached = { snapshot, expiresAt: now() + ttlMs };
        return snapshot;
    };
}
```

- [ ] **Step B1.2: Write generalized tests**

Create `packages/shared/src/transport/__tests__/readiness.test.ts`:

```ts
// packages/shared/src/transport/__tests__/readiness.test.ts
import { describe, expect, test } from "bun:test";
import { createReadinessProbe } from "../readiness.ts";

describe("createReadinessProbe", () => {
    test("all probes succeed → ready: true", async () => {
        const probe = createReadinessProbe({
            components: {
                a: async () => {},
                b: async () => {},
            },
        });
        const snap = await probe();
        expect(snap.ready).toBe(true);
        expect(snap.components).toEqual({ a: "ok", b: "ok" });
    });

    test("one probe fails → ready: false + per-component error", async () => {
        const probe = createReadinessProbe({
            components: {
                a: async () => {},
                b: async () => {
                    throw new Error("boom");
                },
            },
        });
        const snap = await probe();
        expect(snap.ready).toBe(false);
        expect(snap.components).toEqual({ a: "ok", b: "unreachable" });
        expect(snap.errors).toEqual({ b: "boom" });
    });

    test("null/undefined probe → disabled", async () => {
        const probe = createReadinessProbe({
            components: {
                a: async () => {},
                disabledService: null,
            },
        });
        const snap = await probe();
        expect(snap.components.disabledService).toBe("disabled");
        expect(snap.ready).toBe(true);
    });

    test("TTL cache returns the same snapshot within window", async () => {
        let calls = 0;
        const probe = createReadinessProbe({
            components: {
                a: async () => {
                    calls++;
                },
            },
            ttlMs: 1_000,
        });
        await probe();
        await probe();
        await probe();
        expect(calls).toBe(1);
    });

    test("TTL expires → new probe call runs", async () => {
        let calls = 0;
        let clock = 0;
        const probe = createReadinessProbe({
            components: {
                a: async () => {
                    calls++;
                },
            },
            ttlMs: 100,
            now: () => clock,
        });
        await probe();
        clock = 200;
        await probe();
        expect(calls).toBe(2);
    });

    test("single-flight: concurrent calls share one in-flight probe", async () => {
        let calls = 0;
        let resolveProbe: (() => void) | undefined;
        const probe = createReadinessProbe({
            components: {
                a: () =>
                    new Promise<void>((resolve) => {
                        calls++;
                        resolveProbe = resolve;
                    }),
            },
        });
        const p1 = probe();
        const p2 = probe();
        const p3 = probe();
        expect(calls).toBe(1);
        resolveProbe?.();
        await Promise.all([p1, p2, p3]);
        expect(calls).toBe(1);
    });

    test("probe times out per timeoutMs", async () => {
        const probe = createReadinessProbe({
            components: {
                slow: () => new Promise(() => {}), // never resolves
            },
            timeoutMs: 50,
        });
        const snap = await probe();
        expect(snap.ready).toBe(false);
        expect(snap.components.slow).toBe("unreachable");
        expect(snap.errors?.slow).toContain("timed out");
    });
});
```

- [ ] **Step B1.3: Re-export from `packages/shared/src/index.ts`**

```ts
export {
    type ComponentStatus,
    type CreateReadinessProbeOptions,
    createReadinessProbe,
    type ReadinessSnapshot,
} from "./transport/readiness.ts";
```

- [ ] **Step B1.4: Run tests, expect pass**

```bash
bun test packages/shared/src/transport/__tests__/readiness.test.ts
```

Expected: 7 tests pass.

- [ ] **Step B1.5: Commit**

```bash
git add packages/shared/src/transport/readiness.ts \
        packages/shared/src/transport/__tests__/readiness.test.ts \
        packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
SIO-780: hoist createReadinessProbe to @devops-agent/shared

Generalized from kafka's components-as-union shape to a generic
Record<string, () => Promise<void> | null> so any MCP server can supply
its own component map. Null entry → "disabled" status. TTL cache +
single-flight guard preserved. 7 unit tests.

kafka-mcp's local copy will be deleted in the next task; consumers
updated to import from shared.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task B2: Migrate kafka-mcp to shared readiness probe

**Files:**
- Modify: `packages/mcp-server-kafka/src/index.ts:157-172` (import path; component-map shape)
- Modify: `packages/mcp-server-kafka/src/transport/http.ts:8` (type import)
- Modify: `packages/mcp-server-kafka/src/transport/factory.ts:9` (type import)
- Delete: `packages/mcp-server-kafka/src/transport/readiness.ts`
- Delete or move: `packages/mcp-server-kafka/src/transport/__tests__/readiness.test.ts` (tests now in shared)

- [ ] **Step B2.1: Rewrite kafka's probe builder to the new shape**

In `packages/mcp-server-kafka/src/index.ts`, replace the `createReadinessProbe({ clientManager, toolOptions, config })` call with the new components-map shape:

```ts
import { createReadinessProbe } from "@devops-agent/shared";

const kafkaProbe = createReadinessProbe({
    components: {
        kafka: () => ds.clientManager.withAdmin(async (admin) => {
            await admin.metadata({});
        }),
        schemaRegistry: ds.toolOptions.schemaRegistryService
            ? () => ds.toolOptions.schemaRegistryService!.probeReachability()
            : null,
        ksql: ds.toolOptions.ksqlService
            ? () => ds.toolOptions.ksqlService!.probeReachability()
            : null,
        connect: ds.toolOptions.connectService
            ? () => ds.toolOptions.connectService!.probeReachability()
            : null,
        restproxy: ds.toolOptions.restProxyService
            ? () => ds.toolOptions.restProxyService!.probeReachability()
            : null,
    },
});
```

- [ ] **Step B2.2: Update type imports**

In `packages/mcp-server-kafka/src/transport/http.ts` and `factory.ts`, replace `import type { ReadinessSnapshot } from "./readiness.ts"` with `import type { ReadinessSnapshot } from "@devops-agent/shared"`.

- [ ] **Step B2.3: Delete the local readiness file**

```bash
git rm packages/mcp-server-kafka/src/transport/readiness.ts
# Tests for createReadinessProbe now live in shared; delete kafka's copy too
git rm packages/mcp-server-kafka/src/transport/__tests__/readiness.test.ts
```

(If the kafka-side tests had kafka-specific assertions — e.g. about the `kafka` component's wiring to `withAdmin` — port those assertions into a new `packages/mcp-server-kafka/src/__tests__/readiness-wiring.test.ts` that mocks `clientManager` and verifies the component shape, rather than re-testing the shared probe logic.)

- [ ] **Step B2.4: Run kafka tests**

```bash
bun run --filter '@devops-agent/mcp-server-kafka' test
bun run typecheck
```

Expected: tests pass; no missing-import errors.

- [ ] **Step B2.5: Manual probe**

```bash
bun run --filter '@devops-agent/mcp-server-kafka' dev &
sleep 5
curl -s http://localhost:9081/ready | jq
# Expected: { ready: true, components: { kafka: "ok", ... }, ... }
kill %1
```

- [ ] **Step B2.6: Commit**

```bash
git add packages/mcp-server-kafka/
git commit -m "$(cat <<'EOF'
SIO-780: migrate kafka-mcp to shared createReadinessProbe

Local packages/mcp-server-kafka/src/transport/readiness.ts deleted in
favor of @devops-agent/shared. Component map shape: { kafka, schemaRegistry,
ksql, connect, restproxy } — null entries (disabled services) preserved.
http.ts/factory.ts type imports point at the shared ReadinessSnapshot type.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task B3: Wire `/ready` on elastic-mcp

**Files:**
- Modify: `packages/mcp-server-elastic/src/index.ts` (build + thread probe)
- Modify: `packages/mcp-server-elastic/src/transport/http.ts` (add /ready route, copy kafka pattern)
- Modify: `packages/mcp-server-elastic/src/transport/factory.ts` (accept probe arg)

- [ ] **Step B3.1: Read existing elastic transport http.ts**

```bash
cat packages/mcp-server-elastic/src/transport/http.ts | head -50
```

If `/ready` isn't already registered, add it. The kafka pattern at `packages/mcp-server-kafka/src/transport/http.ts:220-267` (before deletion in Phase A) is the reference. The new pattern after migration: the `readinessProbe` parameter on `HttpTransportConfig` triggers route registration.

Copy that exact route-registration block into elastic's `http.ts`:

```ts
import type { ReadinessSnapshot } from "@devops-agent/shared";

interface HttpTransportConfig {
    // ... existing fields
    readinessProbe?: () => Promise<ReadinessSnapshot>;
}

// inside Bun.serve routes:
const readinessHandler = config.readinessProbe
    ? async (): Promise<Response> => {
        try {
            const probe = config.readinessProbe;
            if (!probe) return Response.json({ error: "readiness probe not configured" }, { status: 503 });
            const snapshot = await probe();
            return Response.json(snapshot, { status: snapshot.ready ? 200 : 503 });
        } catch (err) {
            log.error({ error: err instanceof Error ? err.message : String(err) }, "Readiness probe threw");
            return Response.json({ ready: false, error: err instanceof Error ? err.message : String(err) }, { status: 503 });
        }
    }
    : null;
const readyHandler = readinessHandler ?? (() => Response.json({ error: "Not found" }, { status: 404 }));

// in routes:
"/ready": { GET: readyHandler },
```

- [ ] **Step B3.2: Build elastic probe in `index.ts`**

```ts
import { createReadinessProbe } from "@devops-agent/shared";

// inside initDatasource — after the elastic client is created:
const elasticProbe = createReadinessProbe({
    components: Object.fromEntries(
        config.elastic.deployments.map((dep) => [
            `elastic-${dep.id}`,
            async () => {
                await elasticClients[dep.id].cluster.health();
            },
        ]),
    ),
});

// thread into createTransport (signature already supports it after Task A5):
createTransport: (serverFactory, ds, identityCard) =>
    createTransport(config.transport, serverFactory!, elasticProbe, identityCard),
```

- [ ] **Step B3.3: Run tests + manual probe**

```bash
bun run --filter '@devops-agent/mcp-server-elastic' test
bun run --filter '@devops-agent/mcp-server-elastic' dev &
sleep 5
curl -s http://localhost:9080/ready | jq
# Expected: { ready: true, components: { "elastic-prod": "ok", "elastic-staging": "ok" }, ... }
kill %1
```

- [ ] **Step B3.4: Commit**

```bash
git add packages/mcp-server-elastic/
git commit -m "SIO-780: wire /ready on elastic-mcp (per-deployment cluster.health probe)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task B4: Wire `/ready` on couchbase-mcp

- [ ] **Step B4.1: Add `/ready` route + probe wiring**

In `packages/mcp-server-couchbase/src/index.ts`:

```ts
const couchbaseProbe = createReadinessProbe({
    components: {
        cluster: async () => {
            await ds.cluster.ping();
        },
    },
});
```

Route registration in `transport/http.ts` follows Task B3's pattern.

- [ ] **Step B4.2: Run tests + manual probe**

```bash
bun run --filter '@devops-agent/mcp-server-couchbase' test
bun run --filter '@devops-agent/mcp-server-couchbase' dev &
sleep 5
curl -s http://localhost:9082/ready | jq
kill %1
```

- [ ] **Step B4.3: Commit**

```bash
git add packages/mcp-server-couchbase/
git commit -m "SIO-780: wire /ready on couchbase-mcp (cluster.ping probe)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task B5: Wire `/ready` on konnect-mcp (the original bug's primary fix)

**Files:**
- Modify: `packages/mcp-server-konnect/src/index.ts`
- Modify: `packages/mcp-server-konnect/src/transport/http.ts`

- [ ] **Step B5.1: Add `/ready` route + probe wiring**

```ts
const konnectProbe = createReadinessProbe({
    components: {
        konnectControlPlane: async () => {
            // listControlPlanes with pageSize: 1 is the cheapest token-validating call
            await ds.kongApi.listControlPlanes({ pageSize: 1 });
        },
    },
});
```

- [ ] **Step B5.2: Bug replay test (manual)**

```bash
bun run --filter '@devops-agent/mcp-server-konnect' dev &
sleep 5
# Healthy state:
curl -s http://localhost:9083/ready | jq '.ready, .components.konnectControlPlane'
# Expected: true, "ok"

# Now simulate the bug: change KONNECT_ACCESS_TOKEN env to an invalid value and restart.
# Token validation will fail.
kill %1
KONNECT_ACCESS_TOKEN=invalid-token bun run --filter '@devops-agent/mcp-server-konnect' dev &
sleep 5
# Wait for TTL window to settle (or pass `?fresh=1` if implemented — not in v1)
sleep 30
curl -s http://localhost:9083/ready | jq
# Expected: { ready: false, components: { konnectControlPlane: "unreachable" },
#            errors: { konnectControlPlane: <401 message> }, ... }
kill %1
```

This replays the original bug scenario: an MCP whose `/health` says 200 but whose upstream is unreachable. Phase B catches it.

- [ ] **Step B5.3: Commit**

```bash
git add packages/mcp-server-konnect/
git commit -m "$(cat <<'EOF'
SIO-780: wire /ready on konnect-mcp — fixes the original bug

The original bug (orphan process serving /health 200 with expired Kong
token) is now caught by /ready returning 503 once the token-validating
listControlPlanes call fails. 30s TTL bounds upstream call volume to 2
calls/minute per konnect-mcp instance.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task B6: Wire `/ready` on gitlab-mcp

- [ ] **Step B6.1: Add probe**

```ts
const gitlabProbe = createReadinessProbe({
    components: {
        gitlab: async () => {
            await ds.gitlabClient.graphql(`query { currentUser { id } }`);
        },
    },
});
```

- [ ] **Step B6.2: Test + manual probe + commit**

```bash
bun run --filter '@devops-agent/mcp-server-gitlab' test
bun run --filter '@devops-agent/mcp-server-gitlab' dev &
sleep 5
curl -s http://localhost:9084/ready | jq
kill %1
git add packages/mcp-server-gitlab/
git commit -m "SIO-780: wire /ready on gitlab-mcp (currentUser GraphQL probe)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task B7: Wire `/ready` on atlassian-mcp

- [ ] **Step B7.1: Add probe**

```ts
const atlassianProbe = createReadinessProbe({
    components: {
        cloudId: async () => {
            await ds.proxy.resolveCloudId();  // cached, validates OAuth token
        },
    },
});
```

- [ ] **Step B7.2: Test + manual probe + commit**

```bash
bun run --filter '@devops-agent/mcp-server-atlassian' test
bun run --filter '@devops-agent/mcp-server-atlassian' dev &
sleep 5
curl -s http://localhost:9085/ready | jq
kill %1
git add packages/mcp-server-atlassian/
git commit -m "SIO-780: wire /ready on atlassian-mcp (resolveCloudId probe)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task B8: Wire `/ready` on aws-mcp (direct mode only — proxy mode in B9)

- [ ] **Step B8.1: Add probe**

In `packages/mcp-server-aws/src/index.ts` direct-mode branch:

```ts
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

const stsClient = new STSClient({ region: config.aws.region });
const awsProbe = createReadinessProbe({
    components: {
        sts: async () => {
            await stsClient.send(new GetCallerIdentityCommand({}));
        },
    },
});
```

- [ ] **Step B8.2: Test + manual probe + commit**

```bash
bun run --filter '@devops-agent/mcp-server-aws' test
# Direct mode requires AWS_AGENTCORE_RUNTIME_ARN unset
unset AWS_AGENTCORE_RUNTIME_ARN
bun run --filter '@devops-agent/mcp-server-aws' dev &
sleep 5
curl -s http://localhost:3001/ready | jq
kill %1
git add packages/mcp-server-aws/
git commit -m "SIO-780: wire /ready on aws-mcp direct mode (STS GetCallerIdentity probe)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task B9: Proxy readiness — SigV4 `tools/list` + role-sentinel check

**Files:**
- Create: `packages/shared/src/transport/proxy-readiness.ts`
- Create: `packages/shared/src/transport/__tests__/proxy-readiness.test.ts`
- Modify: `packages/shared/src/agentcore-proxy.ts` (add `/ready` route)
- Modify: `packages/shared/src/transport/agentcore-proxy.ts` (accept probe arg)

- [ ] **Step B9.1: Implement `proxy-readiness.ts`**

Create `packages/shared/src/transport/proxy-readiness.ts`:

```ts
// packages/shared/src/transport/proxy-readiness.ts
// SIO-780: readiness probe for the AgentCore SigV4 proxy. /ready combines:
//   1. getCredentials() — AWS creds available
//   2. SigV4-signed JSON-RPC tools/list to the upstream AgentCore endpoint
//   3. Role sentinel check — upstream's tool list must include the expected
//      sentinel tool for the configured role
// All three must succeed for ready: true.

import { createReadinessProbe, type ReadinessSnapshot } from "./readiness.ts";

const ROLE_SENTINEL_TOOLS: Record<"aws-proxy" | "kafka-proxy", string> = {
    "aws-proxy": "aws___call_aws",
    "kafka-proxy": "kafka_list_topics",
};

export interface CreateProxyReadinessProbeOptions {
    role: "aws-proxy" | "kafka-proxy";
    getCredentials: () => Promise<unknown>;
    upstreamUrl: string;
    sigv4Fetch: (req: Request) => Promise<Response>;
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
}

export function createProxyReadinessProbe(opts: CreateProxyReadinessProbeOptions): () => Promise<ReadinessSnapshot> {
    const sentinelTool = ROLE_SENTINEL_TOOLS[opts.role];

    return createReadinessProbe({
        components: {
            credentials: async () => {
                await opts.getCredentials();
            },
            agentcoreUpstream: async () => {
                const req = new Request(opts.upstreamUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
                });
                const res = await opts.sigv4Fetch(req);
                if (!res.ok) {
                    throw new Error(`tools/list returned ${res.status}`);
                }
                const body = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
                const tools = body.result?.tools ?? [];
                const found = tools.some((t) => t.name === sentinelTool);
                if (!found) {
                    throw new Error(
                        `expected sentinel tool "${sentinelTool}" for role "${opts.role}", upstream returned ${tools.length} tools without it`,
                    );
                }
            },
        },
        ttlMs: opts.ttlMs,
        timeoutMs: opts.timeoutMs,
        now: opts.now,
    });
}
```

- [ ] **Step B9.2: Write tests**

Create `packages/shared/src/transport/__tests__/proxy-readiness.test.ts`:

```ts
// packages/shared/src/transport/__tests__/proxy-readiness.test.ts
import { describe, expect, test } from "bun:test";
import { createProxyReadinessProbe } from "../proxy-readiness.ts";

function mockSigv4Fetch(body: unknown, status = 200) {
    return async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("createProxyReadinessProbe", () => {
    test("credentials + sentinel tool present → ready", async () => {
        const probe = createProxyReadinessProbe({
            role: "kafka-proxy",
            getCredentials: async () => ({}),
            upstreamUrl: "http://example.test/mcp",
            sigv4Fetch: mockSigv4Fetch({ result: { tools: [{ name: "kafka_list_topics" }] } }),
        });
        const snap = await probe();
        expect(snap.ready).toBe(true);
        expect(snap.components).toEqual({ credentials: "ok", agentcoreUpstream: "ok" });
    });

    test("credentials fail → not ready, agentcoreUpstream still probed", async () => {
        const probe = createProxyReadinessProbe({
            role: "aws-proxy",
            getCredentials: async () => {
                throw new Error("expired creds");
            },
            upstreamUrl: "http://example.test/mcp",
            sigv4Fetch: mockSigv4Fetch({ result: { tools: [{ name: "aws___call_aws" }] } }),
        });
        const snap = await probe();
        expect(snap.ready).toBe(false);
        expect(snap.components.credentials).toBe("unreachable");
        expect(snap.errors?.credentials).toBe("expired creds");
    });

    test("upstream returns wrong sentinel → not ready", async () => {
        const probe = createProxyReadinessProbe({
            role: "kafka-proxy",
            getCredentials: async () => ({}),
            upstreamUrl: "http://example.test/mcp",
            sigv4Fetch: mockSigv4Fetch({ result: { tools: [{ name: "elastic_search" }] } }),
        });
        const snap = await probe();
        expect(snap.ready).toBe(false);
        expect(snap.components.agentcoreUpstream).toBe("unreachable");
        expect(snap.errors?.agentcoreUpstream).toContain("kafka_list_topics");
    });

    test("upstream returns 503 → not ready", async () => {
        const probe = createProxyReadinessProbe({
            role: "aws-proxy",
            getCredentials: async () => ({}),
            upstreamUrl: "http://example.test/mcp",
            sigv4Fetch: mockSigv4Fetch({}, 503),
        });
        const snap = await probe();
        expect(snap.ready).toBe(false);
        expect(snap.components.agentcoreUpstream).toBe("unreachable");
        expect(snap.errors?.agentcoreUpstream).toContain("503");
    });

    test("empty tools list → not ready", async () => {
        const probe = createProxyReadinessProbe({
            role: "kafka-proxy",
            getCredentials: async () => ({}),
            upstreamUrl: "http://example.test/mcp",
            sigv4Fetch: mockSigv4Fetch({ result: { tools: [] } }),
        });
        const snap = await probe();
        expect(snap.ready).toBe(false);
        expect(snap.components.agentcoreUpstream).toBe("unreachable");
    });
});
```

- [ ] **Step B9.3: Add `/ready` route to `agentcore-proxy.ts`**

In `packages/shared/src/agentcore-proxy.ts`, the function that builds the Bun.serve route table needs to accept `readinessProbe?: () => Promise<ReadinessSnapshot>` and register `/ready`:

```ts
"/ready": {
    GET: async (): Promise<Response> => {
        if (!readinessProbe) return Response.json({ error: "Not found" }, { status: 404 });
        try {
            const snap = await readinessProbe();
            return Response.json(snap, { status: snap.ready ? 200 : 503 });
        } catch (err) {
            return Response.json(
                { ready: false, error: err instanceof Error ? err.message : String(err) },
                { status: 503 },
            );
        }
    },
},
```

- [ ] **Step B9.4: Wire the probe in `createAgentCoreProxyTransport`**

In `packages/shared/src/transport/agentcore-proxy.ts`, build the probe inside the proxy bootstrap and pass it to the proxy server:

```ts
import { createProxyReadinessProbe } from "./proxy-readiness.ts";

// inside createAgentCoreProxyTransport, after getCredentials + fullUrl are available:
const role: "kafka-proxy" | "aws-proxy" = serverPrefix === "KAFKA" ? "kafka-proxy" : "aws-proxy";
const readinessProbe = createProxyReadinessProbe({
    role,
    getCredentials,
    upstreamUrl: fullUrl,
    sigv4Fetch: async (req) => signedFetch(req),  // existing SigV4 signer used by the proxy
});

// pass `readinessProbe` into the underlying agentcore-proxy.ts server constructor
```

- [ ] **Step B9.5: Run tests + manual probe**

```bash
bun test packages/shared/src/transport/__tests__/proxy-readiness.test.ts
# Expected: 5 tests pass.

bun run --filter '@devops-agent/mcp-server-kafka' dev &  # proxy mode if KAFKA_AGENTCORE_RUNTIME_ARN set
sleep 8  # AgentCore cold start
curl -s http://localhost:9081/ready | jq
# Expected: { ready: true, components: { credentials: "ok", agentcoreUpstream: "ok" }, ... }
kill %1
```

- [ ] **Step B9.6: Commit**

```bash
git add packages/shared/src/transport/proxy-readiness.ts \
        packages/shared/src/transport/__tests__/proxy-readiness.test.ts \
        packages/shared/src/agentcore-proxy.ts \
        packages/shared/src/transport/agentcore-proxy.ts \
        packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
SIO-780: proxy readiness — SigV4 tools/list + role-sentinel check

createProxyReadinessProbe builds a two-component probe: getCredentials()
and a SigV4-signed JSON-RPC tools/list to the upstream AgentCore endpoint.
The upstream's response must include a role-specific sentinel tool
(aws___call_aws for aws-proxy, kafka_list_topics for kafka-proxy).
Catches misconfigured AWS_AGENTCORE_RUNTIME_ARN pointing at the wrong
runtime, plus credentials and reachability failures. 5 unit tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task B10: Phase B acceptance + open PR

- [ ] **Step B10.1: Extend the acceptance script**

Append to `scripts/sio780/check-identity.sh` (or create a sibling `check-ready.sh`):

```bash
#!/usr/bin/env bash
# scripts/sio780/check-ready.sh
set -euo pipefail
failures=0
for port in 9080 9081 9082 9083 9084 9085 3001; do
    body=$(curl -s --max-time 8 "http://localhost:$port/ready" || echo '{}')
    ready=$(echo "$body" | jq -r '.ready // "MISSING"')
    if [[ "$ready" == "true" ]]; then
        echo "ok    port=$port ready=true"
    elif [[ "$ready" == "false" ]]; then
        errs=$(echo "$body" | jq -c '.errors // {}')
        echo "WARN  port=$port ready=false errors=$errs"
    else
        echo "FAIL  port=$port no ready field"
        failures=$((failures + 1))
    fi
done
exit "$failures"
```

- [ ] **Step B10.2: Run full repo gate**

```bash
bun run typecheck
bun run lint
bun run test
chmod +x scripts/sio780/check-ready.sh
bun run dev &
sleep 15  # extra time for AgentCore cold starts
scripts/sio780/check-ready.sh
pkill -f 'bun.*mcp-server'
```

Expected: all `ok` lines (or `WARN ready=false` for any upstream genuinely degraded — operator's call).

- [ ] **Step B10.3: Push branch + open Phase B PR**

```bash
git push
gh pr create --title "SIO-780 Phase B: hoist createReadinessProbe + per-MCP /ready probes" --body "$(cat <<'EOF'
## Summary
- `packages/shared/src/transport/readiness.ts` (hoisted from kafka, generalized component map)
- `packages/shared/src/transport/proxy-readiness.ts` (new — SigV4 tools/list + role-sentinel check)
- Every MCP server + AgentCore proxy now serves `/ready` reflecting upstream health
- Konnect, the original bug's culprit, now returns 503 when the Kong token is expired

## Test plan
- [x] `bun test packages/shared/src/transport/__tests__/readiness.test.ts` — 7 tests
- [x] `bun test packages/shared/src/transport/__tests__/proxy-readiness.test.ts` — 5 tests
- [x] `scripts/sio780/check-ready.sh` — all 7 ports return ready: true
- [x] Konnect token-expiry replay — /ready returns 503 with per-component error

## Linear
SIO-780 — Phase B of three. Phase C lights up the agent + UI in the next PR.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Phase B complete.** Wait for review + merge before starting Phase C.

---

## Phase C — Agent-side three-tier probe + UI five-state surfacing

**Output:** Dashboard shows five distinct states. Agent boot-strict refuses on role mismatch; auto-reconnects on `replaced`. Phase C ships as PR #3.

### Task C1: `McpRoleMismatchError` + `MCP_SERVER_TO_ROLE` map

**Files:**
- Modify: `packages/agent/src/mcp-bridge.ts` (add error class + map)

- [ ] **Step C1.1: Write failing test**

Create `packages/agent/src/__tests__/mcp-bridge.boot-strict.test.ts`:

```ts
// packages/agent/src/__tests__/mcp-bridge.boot-strict.test.ts
import { describe, expect, test } from "bun:test";
import { McpRoleMismatchError, MCP_SERVER_TO_ROLE } from "../mcp-bridge.ts";

describe("McpRoleMismatchError", () => {
    test("is an Error subclass with the expected name", () => {
        const err = new McpRoleMismatchError("test message");
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe("McpRoleMismatchError");
        expect(err.message).toBe("test message");
    });
});

describe("MCP_SERVER_TO_ROLE", () => {
    test("maps all 7 server names to expected roles", () => {
        expect(MCP_SERVER_TO_ROLE).toEqual({
            "elastic-mcp": "elastic-mcp",
            "kafka-mcp": "kafka-proxy",
            "couchbase-mcp": "couchbase-mcp",
            "konnect-mcp": "konnect-mcp",
            "gitlab-mcp": "gitlab-mcp",
            "atlassian-mcp": "atlassian-mcp",
            "aws-mcp": "aws-proxy",
        });
    });
});
```

- [ ] **Step C1.2: Run test, expect failure**

```bash
bun test packages/agent/src/__tests__/mcp-bridge.boot-strict.test.ts
```

Expected: TypeScript error — `McpRoleMismatchError`, `MCP_SERVER_TO_ROLE` not exported.

- [ ] **Step C1.3: Implement in `mcp-bridge.ts`**

Add to `packages/agent/src/mcp-bridge.ts` (next to the existing `DATASOURCE_TO_MCP_SERVER` at line 225):

```ts
import type { McpRole } from "@devops-agent/shared";

export class McpRoleMismatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "McpRoleMismatchError";
    }
}

// SIO-780: expected role per logical server name. Proxy roles for kafka and aws
// reflect today's deployment topology (both run via AgentCore SigV4 proxies).
// Mismatches between the card returned by /identity and this map → boot-strict
// throw at agent startup.
export const MCP_SERVER_TO_ROLE: Record<string, McpRole> = {
    "elastic-mcp": "elastic-mcp",
    "kafka-mcp": "kafka-proxy",
    "couchbase-mcp": "couchbase-mcp",
    "konnect-mcp": "konnect-mcp",
    "gitlab-mcp": "gitlab-mcp",
    "atlassian-mcp": "atlassian-mcp",
    "aws-mcp": "aws-proxy",
};
```

- [ ] **Step C1.4: Run test, expect pass**

```bash
bun test packages/agent/src/__tests__/mcp-bridge.boot-strict.test.ts
```

Expected: 2 tests pass.

- [ ] **Step C1.5: Commit**

```bash
git add packages/agent/src/mcp-bridge.ts packages/agent/src/__tests__/mcp-bridge.boot-strict.test.ts
git commit -m "$(cat <<'EOF'
SIO-780: McpRoleMismatchError + MCP_SERVER_TO_ROLE map

MCP_SERVER_TO_ROLE encodes the expected /identity role per logical server
name. Lives next to DATASOURCE_TO_MCP_SERVER so the two stay coherent.
kafka-mcp and aws-mcp map to *-proxy roles because both run via AgentCore
SigV4 proxies in today's deployments.

McpRoleMismatchError is a named Error subclass for the boot-strict check
in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task C2: `probeServer` — replace `healthCheckServer`

**Files:**
- Modify: `packages/agent/src/mcp-bridge.ts:247-258` (replace healthCheckServer with probeServer)
- Modify: `packages/agent/src/mcp-bridge.ts:302-337` (rewrite pollServerHealth)
- Create: `packages/agent/src/__tests__/mcp-bridge.probe.test.ts`

- [ ] **Step C2.1: Write failing tests for `probeServer`**

Create `packages/agent/src/__tests__/mcp-bridge.probe.test.ts`:

```ts
// packages/agent/src/__tests__/mcp-bridge.probe.test.ts
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { IdentityCard } from "@devops-agent/shared";
import { _probeServerForTest, _resetExpectedIdentityForTest } from "../mcp-bridge.ts";

const fixtureCard = (overrides: Partial<IdentityCard> = {}): IdentityCard => ({
    instanceId: "fixture-id",
    role: "konnect-mcp",
    version: "0.0.0",
    bootedAt: "2026-05-17T00:00:00.000Z",
    pid: 1,
    mode: "http",
    upstreamFingerprint: "abc123",
    ...overrides,
});

afterEach(() => _resetExpectedIdentityForTest());

describe("probeServer", () => {
    test("/health 200 + /identity 200 (first time) + /ready 200 → ready", async () => {
        const card = fixtureCard();
        global.fetch = mock(async (input) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/health")) return new Response("ok");
            if (url.endsWith("/identity")) return Response.json(card);
            if (url.endsWith("/ready")) return Response.json({ ready: true, components: {}, cachedAt: "" });
            return new Response("404", { status: 404 });
        }) as typeof fetch;
        const result = await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
        expect(result.state).toBe("ready");
    });

    test("/health 503 → down", async () => {
        global.fetch = mock(async () => new Response("nope", { status: 503 })) as typeof fetch;
        const result = await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
        expect(result.state).toBe("down");
        expect(result.state === "down" && result.reason).toContain("503");
    });

    test("/health 200 + /identity 200 with different instanceId → replaced", async () => {
        const old = fixtureCard({ instanceId: "old-id" });
        const newCard = fixtureCard({ instanceId: "new-id" });
        // first probe seeds expectedIdentity
        global.fetch = mock(async (input) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/health")) return new Response("ok");
            if (url.endsWith("/identity")) return Response.json(old);
            if (url.endsWith("/ready")) return Response.json({ ready: true, components: {}, cachedAt: "" });
            return new Response("404", { status: 404 });
        }) as typeof fetch;
        await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
        // second probe returns a different instanceId
        global.fetch = mock(async (input) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/health")) return new Response("ok");
            if (url.endsWith("/identity")) return Response.json(newCard);
            return new Response("404", { status: 404 });
        }) as typeof fetch;
        const result = await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
        expect(result.state).toBe("replaced");
        expect(result.state === "replaced" && result.reason).toContain("instanceId");
    });

    test("/identity returns wrong role → misidentified", async () => {
        const seed = fixtureCard({ role: "konnect-mcp" });
        global.fetch = mock(async (input) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/health")) return new Response("ok");
            if (url.endsWith("/identity")) return Response.json(seed);
            if (url.endsWith("/ready")) return Response.json({ ready: true, components: {}, cachedAt: "" });
            return new Response("404", { status: 404 });
        }) as typeof fetch;
        await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");

        const wrong = fixtureCard({ role: "elastic-mcp", instanceId: seed.instanceId });
        global.fetch = mock(async (input) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/health")) return new Response("ok");
            if (url.endsWith("/identity")) return Response.json(wrong);
            return new Response("404", { status: 404 });
        }) as typeof fetch;
        const result = await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
        expect(result.state).toBe("misidentified");
    });

    test("/ready returns 503 → unready (still has card)", async () => {
        const card = fixtureCard();
        // first probe to seed
        global.fetch = mock(async (input) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/health")) return new Response("ok");
            if (url.endsWith("/identity")) return Response.json(card);
            if (url.endsWith("/ready")) return Response.json({ ready: true, components: {}, cachedAt: "" });
            return new Response("404", { status: 404 });
        }) as typeof fetch;
        await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");

        // now /ready returns 503
        global.fetch = mock(async (input) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/health")) return new Response("ok");
            if (url.endsWith("/identity")) return Response.json(card);
            if (url.endsWith("/ready")) return Response.json({ ready: false, components: { foo: "unreachable" }, errors: { foo: "401" }, cachedAt: "" }, { status: 503 });
            return new Response("404", { status: 404 });
        }) as typeof fetch;
        const result = await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
        expect(result.state).toBe("unready");
    });

    test("/ready 404 (Phase B not deployed yet) → ready", async () => {
        const card = fixtureCard();
        global.fetch = mock(async (input) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/health")) return new Response("ok");
            if (url.endsWith("/identity")) return Response.json(card);
            if (url.endsWith("/ready")) return new Response("not found", { status: 404 });
            return new Response("404", { status: 404 });
        }) as typeof fetch;
        const result = await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
        expect(result.state).toBe("ready");
    });
});
```

- [ ] **Step C2.2: Run tests, expect failure**

```bash
bun test packages/agent/src/__tests__/mcp-bridge.probe.test.ts
```

Expected: TypeScript error — `_probeServerForTest`, `_resetExpectedIdentityForTest` not exported.

- [ ] **Step C2.3: Implement `probeServer` in `mcp-bridge.ts`**

Replace `healthCheckServer` (lines 246-258) with:

```ts
import type { IdentityCard, ReadinessSnapshot } from "@devops-agent/shared";

type ProbeState = "ready" | "unready" | "down" | "replaced" | "misidentified";

type ProbeResult =
    | { state: "ready"; card: IdentityCard }
    | { state: "unready"; card: IdentityCard; snapshot: ReadinessSnapshot }
    | { state: "down"; reason: string }
    | { state: "replaced"; reason: string; card: IdentityCard }
    | { state: "misidentified"; reason: string; card: IdentityCard };

const expectedIdentity = new Map<string, IdentityCard>();
const lastProbeState = new Map<string, ProbeState>();

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

async function probeServer(name: string, url: string): Promise<ProbeResult> {
    const baseUrl = url.replace(/\/mcp$/, "");

    // Tier 1: alive (2s budget)
    try {
        const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
        if (!r.ok) return { state: "down", reason: `health returned ${r.status}` };
    } catch (err) {
        return { state: "down", reason: `health unreachable: ${errorMessage(err)}` };
    }

    // Tier 2: identity (1s budget)
    let card: IdentityCard;
    try {
        const r = await fetch(`${baseUrl}/identity`, { signal: AbortSignal.timeout(1_000) });
        if (!r.ok) return { state: "down", reason: `identity returned ${r.status}` };
        card = (await r.json()) as IdentityCard;
    } catch (err) {
        return { state: "down", reason: `identity unreachable: ${errorMessage(err)}` };
    }

    const expected = expectedIdentity.get(name);
    if (!expected) {
        expectedIdentity.set(name, card);
        // fall through to tier 3
    } else {
        if (card.role !== expected.role) {
            return { state: "misidentified", reason: `role mismatch: expected ${expected.role}, got ${card.role}`, card };
        }
        if (card.instanceId !== expected.instanceId) {
            return { state: "replaced", reason: "instanceId changed", card };
        }
        if (card.upstreamFingerprint !== expected.upstreamFingerprint) {
            return { state: "replaced", reason: "upstream config fingerprint changed", card };
        }
    }

    // Tier 3: readiness (5s budget)
    try {
        const r = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(5_000) });
        if (r.status === 404) return { state: "ready", card };  // /ready not deployed yet
        if (!r.ok) {
            const snapshot = (await r.json().catch(() => ({}))) as ReadinessSnapshot;
            return { state: "unready", card, snapshot };
        }
        return { state: "ready", card };
    } catch (err) {
        return {
            state: "unready",
            card,
            snapshot: {
                ready: false,
                components: {},
                cachedAt: new Date().toISOString(),
                errors: { _probe: errorMessage(err) },
            },
        };
    }
}

// Test escape hatches
export const _probeServerForTest = probeServer;
export function _resetExpectedIdentityForTest(): void {
    expectedIdentity.clear();
    lastProbeState.clear();
}

export function getServerStates(): Record<string, ProbeState> {
    return Object.fromEntries(lastProbeState.entries());
}
```

- [ ] **Step C2.4: Replace `pollServerHealth` with a state-aware version**

Replace the existing `pollServerHealth` (lines 302-337) with:

```ts
async function pollServerHealth(): Promise<void> {
    if (isPolling) return;
    isPolling = true;

    try {
        const checks = [...serverUrls.entries()].map(async ([name, url]) => {
            const result = await probeServer(name, url);
            return { name, url, result };
        });

        const settled = await Promise.allSettled(checks);

        for (const settledResult of settled) {
            if (settledResult.status !== "fulfilled") continue;
            const { name, url, result } = settledResult.value;
            lastProbeState.set(name, result.state);

            switch (result.state) {
                case "ready":
                    if (!connectedServers.has(name)) {
                        const hasTools = (toolsByServer.get(name)?.length ?? 0) > 0;
                        if (hasTools) {
                            connectedServers.add(name);
                            logger.info({ serverName: name }, "MCP server back online (tools cached)");
                        } else {
                            await reconnectServer(name, url);
                        }
                    }
                    break;
                case "down":
                    if (connectedServers.has(name)) {
                        connectedServers.delete(name);
                        logger.warn({ serverName: name, reason: result.reason }, "MCP server down, marking disconnected");
                    }
                    break;
                case "unready":
                    // keep connected; UI shows yellow border via getServerStates()
                    logger.warn({ serverName: name, components: result.snapshot.components }, "MCP server upstream degraded");
                    break;
                case "replaced": {
                    const oldCard = expectedIdentity.get(name);
                    logger.info(
                        {
                            serverName: name,
                            reason: result.reason,
                            oldInstanceId: oldCard?.instanceId ?? null,
                            newInstanceId: result.card.instanceId,
                        },
                        "MCP server replaced, reconnecting",
                    );
                    await reconnectServer(name, url);
                    expectedIdentity.set(name, result.card);
                    // SSE event emitted in Task C5
                    break;
                }
                case "misidentified":
                    logger.error({ serverName: name, reason: result.reason }, "MCP server misidentified mid-session");
                    connectedServers.delete(name);
                    break;
            }
        }
    } finally {
        isPolling = false;
    }
}
```

- [ ] **Step C2.5: Run tests, expect pass**

```bash
bun test packages/agent/src/__tests__/mcp-bridge.probe.test.ts
```

Expected: 6 tests pass.

- [ ] **Step C2.6: Commit**

```bash
git add packages/agent/src/mcp-bridge.ts \
        packages/agent/src/__tests__/mcp-bridge.probe.test.ts
git commit -m "$(cat <<'EOF'
SIO-780: replace healthCheckServer with three-tier probeServer

probeServer returns a discriminated ProbeResult with five states:
ready / unready / down / replaced / misidentified. Tiers hit /health
(2s), /identity (1s), /ready (5s) in sequence. Total worst-case budget
8s — comfortably inside the 35s AgentCore connect window.

pollServerHealth dispatches per state: down → drop connection, unready
→ log + keep tools, replaced → reconnect + update expectedIdentity,
misidentified → drop + log error. Auto-reconnect on replaced is A1
default; SSE notification deferred to Task C5.

getServerStates() returns the lastProbeState snapshot for the dashboard
endpoint (wired in Task C4).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task C3: Boot-strict identity check in `initMcpClient`

**Files:**
- Modify: `packages/agent/src/mcp-bridge.ts:127-218` (after connection succeeds, before startHealthPolling)

- [ ] **Step C3.1: Write failing test**

Append to `packages/agent/src/__tests__/mcp-bridge.boot-strict.test.ts`:

```ts
import { afterEach, beforeEach, mock } from "bun:test";
import { _resetExpectedIdentityForTest, createMcpClient } from "../mcp-bridge.ts";

describe("boot-strict identity check", () => {
    beforeEach(() => _resetExpectedIdentityForTest());

    test("throws McpRoleMismatchError when /identity role doesn't match", async () => {
        // Stub MultiServerMCPClient to return a single fake tool so connection succeeds
        // (existing tests in this file likely already do this; reuse the pattern).
        // Then mock fetch for /identity to return a wrong role.
        global.fetch = mock(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/identity")) {
                return Response.json({
                    instanceId: "x",
                    role: "elastic-mcp",  // WRONG — expected konnect-mcp
                    version: "0.0.0",
                    bootedAt: "2026-05-17T00:00:00.000Z",
                    pid: 1,
                    mode: "http",
                    upstreamFingerprint: "abc",
                });
            }
            return new Response("ok");
        }) as typeof fetch;

        // Existing initMcpClient signature; the test asserts the boot-strict throw
        await expect(
            createMcpClient({ konnectUrl: "http://localhost:9083" })
        ).rejects.toBeInstanceOf(McpRoleMismatchError);
    });

    test("accepts identity card when role matches", async () => {
        global.fetch = mock(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/identity")) {
                return Response.json({
                    instanceId: "x",
                    role: "konnect-mcp",
                    version: "0.0.0",
                    bootedAt: "2026-05-17T00:00:00.000Z",
                    pid: 1,
                    mode: "http",
                    upstreamFingerprint: "abc",
                });
            }
            return new Response("ok");
        }) as typeof fetch;

        // Should resolve without throwing
        await createMcpClient({ konnectUrl: "http://localhost:9083" });
    });
});
```

Note: the test will need to stub `@langchain/mcp-adapters` to skip the actual MCP handshake. Look at how existing tests in `packages/agent/src/__tests__/` mock it — copy that pattern.

- [ ] **Step C3.2: Run, expect failure**

```bash
bun test packages/agent/src/__tests__/mcp-bridge.boot-strict.test.ts
```

Expected: the rejection assertion fails because `createMcpClient` doesn't yet fetch `/identity`.

- [ ] **Step C3.3: Add boot-strict check to `createMcpClient`**

In `packages/agent/src/mcp-bridge.ts`, after the existing connection loop succeeds (around line 211, after `logger.info({ toolCount: allTools.length, ... }, "MCP tools loaded")`) and BEFORE `startHealthPolling()`:

```ts
// SIO-780: boot-strict identity check (B1). Refuse to start the agent if any
// connected MCP returns a /identity card with a role that doesn't match the
// expected MCP_SERVER_TO_ROLE entry. Operators see a precise error message
// naming the env var to fix; no silent misrouting.
for (const { name, url } of serverEntries) {
    if (!connectedServers.has(name)) continue;
    const baseUrl = url.replace(/\/mcp$/, "");
    let card: IdentityCard;
    try {
        const r = await fetch(`${baseUrl}/identity`, { signal: AbortSignal.timeout(2_000) });
        if (!r.ok) {
            logger.warn({ serverName: name, status: r.status }, "MCP server /identity unavailable at boot — skipping strict check");
            continue;
        }
        card = (await r.json()) as IdentityCard;
    } catch (err) {
        logger.warn(
            { serverName: name, error: errorMessage(err) },
            "MCP server /identity probe failed at boot — skipping strict check",
        );
        continue;
    }
    const expectedRole = MCP_SERVER_TO_ROLE[name];
    if (!expectedRole) continue;  // defensive — shouldn't happen with current names
    if (card.role !== expectedRole) {
        throw new McpRoleMismatchError(
            `${name} (${url}) returned identity card with role="${card.role}", expected "${expectedRole}". ` +
                `Check ${name.toUpperCase().replace(/-/g, "_")}_URL env var.`,
        );
    }
    expectedIdentity.set(name, card);
}

startHealthPolling();
```

The "skipping strict check" branch handles the case where a server is up but its `/identity` endpoint isn't reachable in time — we log loudly but don't block boot. This matters during the rollout window when some servers are still on Phase A code and others haven't deployed.

(Note: once Phase A is fully rolled out, every server reachable via `MultiServerMCPClient.getTools()` must also be reachable via `/identity` — same `Bun.serve()` instance. The skipping branch is defense-in-depth.)

- [ ] **Step C3.4: Run tests, expect pass**

```bash
bun test packages/agent/src/__tests__/mcp-bridge.boot-strict.test.ts
```

Expected: 4 tests pass (2 from C1, 2 new).

- [ ] **Step C3.5: Manual boot-strict replay**

```bash
# Point KAFKA_MCP_URL at the elastic-mcp port intentionally
KAFKA_MCP_URL=http://localhost:9080 bun run --filter '@devops-agent/web' dev
# Expected: process exits non-zero with McpRoleMismatchError naming KAFKA_MCP_URL
```

- [ ] **Step C3.6: Commit**

```bash
git add packages/agent/src/mcp-bridge.ts packages/agent/src/__tests__/mcp-bridge.boot-strict.test.ts
git commit -m "$(cat <<'EOF'
SIO-780: boot-strict identity check refuses misconfigured MCP routing

After createMcpClient successfully connects to all configured MCPs, the
agent fetches /identity for each and compares the returned role against
MCP_SERVER_TO_ROLE. Mismatch throws McpRoleMismatchError naming the
offending env var. Servers whose /identity is unreachable at boot are
logged-warn and skipped (defense-in-depth during rollout). No
MCP_BOOT_LENIENT escape hatch in v1 — the error message is the fix.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task C4: Surface `states` in the dashboard endpoint

**Files:**
- Modify: `apps/web/src/routes/api/datasources/+server.ts`
- Modify: `apps/web/src/routes/api/datasources/+server.test.ts` (or create)

- [ ] **Step C4.1: Write failing test**

Create `apps/web/src/routes/api/datasources/+server.test.ts`:

```ts
// apps/web/src/routes/api/datasources/+server.test.ts
import { describe, expect, test, mock } from "bun:test";

// Stub the agent imports before importing the route module.
mock.module("@devops-agent/agent", () => ({
    getConnectedServers: () => ["elastic-mcp", "kafka-mcp"],
    getServerStates: () => ({
        "elastic-mcp": "ready",
        "kafka-mcp": "unready",
        "konnect-mcp": "down",
    }),
}));
mock.module("$lib/server/agent", () => ({
    ensureMcpConnected: async () => {},
}));

const { GET } = await import("./+server.ts");

describe("GET /api/datasources", () => {
    test("returns dataSources, connected, and states", async () => {
        process.env.ELASTIC_MCP_URL = "http://localhost:9080";
        process.env.KAFKA_MCP_URL = "http://localhost:9081";
        process.env.KONNECT_MCP_URL = "http://localhost:9083";

        const res = await GET({} as never);
        const body = await res.json();

        expect(body.dataSources).toEqual(expect.arrayContaining(["elastic", "kafka", "konnect"]));
        expect(body.connected).toEqual(expect.arrayContaining(["elastic", "kafka"]));
        expect(body.states).toEqual({
            elastic: "ready",
            kafka: "unready",
            konnect: "down",
        });
    });
});
```

- [ ] **Step C4.2: Run, expect failure**

```bash
bun test apps/web/src/routes/api/datasources/+server.test.ts
```

Expected: `getServerStates is not a function` or `body.states is undefined`.

- [ ] **Step C4.3: Update the route**

Edit `apps/web/src/routes/api/datasources/+server.ts`:

```ts
import { getConnectedServers, getServerStates } from "@devops-agent/agent";
import { json } from "@sveltejs/kit";
import { ensureMcpConnected } from "$lib/server/agent";
import type { RequestHandler } from "./$types";

const SERVER_TO_DATASOURCE: Record<string, string> = {
    "elastic-mcp": "elastic",
    "kafka-mcp": "kafka",
    "couchbase-mcp": "couchbase",
    "konnect-mcp": "konnect",
    "gitlab-mcp": "gitlab",
    "atlassian-mcp": "atlassian",
    "aws-mcp": "aws",
};

export const GET: RequestHandler = async () => {
    await ensureMcpConnected();

    const dataSources: string[] = [];
    if (process.env.ELASTIC_MCP_URL) dataSources.push("elastic");
    if (process.env.KAFKA_MCP_URL) dataSources.push("kafka");
    if (process.env.COUCHBASE_MCP_URL) dataSources.push("couchbase");
    if (process.env.KONNECT_MCP_URL) dataSources.push("konnect");
    if (process.env.GITLAB_MCP_URL) dataSources.push("gitlab");
    if (process.env.ATLASSIAN_MCP_URL) dataSources.push("atlassian");
    if (process.env.AWS_MCP_URL) dataSources.push("aws");

    const connected = getConnectedServers()
        .map((s) => SERVER_TO_DATASOURCE[s])
        .filter(Boolean);

    // SIO-780 Phase C: surface five-state probe results for the UI
    const rawStates = getServerStates();
    const states: Record<string, string> = {};
    for (const [serverName, state] of Object.entries(rawStates)) {
        const dsId = SERVER_TO_DATASOURCE[serverName];
        if (dsId) states[dsId] = state;
    }

    return json({ dataSources, connected, states });
};
```

- [ ] **Step C4.4: Re-export `getServerStates` from `@devops-agent/agent`**

Check `packages/agent/src/index.ts` (or wherever `getConnectedServers` is re-exported from) and add `getServerStates`:

```ts
export { getConnectedServers, getServerStates } from "./mcp-bridge.ts";
```

- [ ] **Step C4.5: Run test, expect pass**

```bash
bun test apps/web/src/routes/api/datasources/+server.test.ts
```

Expected: 1 test passes.

- [ ] **Step C4.6: Commit**

```bash
git add apps/web/src/routes/api/datasources/ packages/agent/src/index.ts
git commit -m "$(cat <<'EOF'
SIO-780: surface states in /api/datasources

Endpoint now returns { dataSources, connected, states } where states is
Record<datasourceId, ProbeState>. Phase C's frontend consumes states to
render five-color UI. connected is preserved for back-compat (downstream
callers that haven't been updated).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task C5: Emit `mcp_replaced` SSE event

**Files:**
- Modify: `packages/agent/src/mcp-bridge.ts` (export an event emitter)
- Create or modify: `apps/web/src/lib/server/sse-bus.ts` (per-process EventEmitter)
- Create or modify: `apps/web/src/routes/api/events/+server.ts` (SSE stream endpoint)

- [ ] **Step C5.1: Decide on the SSE channel**

Inspect `apps/web/src/routes/api/chat/+server.ts` (or wherever streams currently live). If a general-purpose event channel exists, use it. Otherwise create a minimal one:

```bash
ls apps/web/src/routes/api/
grep -r "ReadableStream\|sse" apps/web/src/routes/api/ | head
```

- [ ] **Step C5.2: Add an event emitter to `mcp-bridge.ts`**

```ts
import { EventEmitter } from "node:events";

export const mcpEvents = new EventEmitter();

export interface McpReplacedEvent {
    type: "mcp_replaced";
    server: string;
    oldInstanceId: string | null;
    newInstanceId: string;
    toolCountDelta: number;
}
```

In `pollServerHealth`'s `replaced` branch, after `expectedIdentity.set(name, result.card)`:

```ts
const oldToolCount = toolsByServer.get(name)?.length ?? 0;
await reconnectServer(name, url);
const newToolCount = toolsByServer.get(name)?.length ?? 0;
expectedIdentity.set(name, result.card);
const event: McpReplacedEvent = {
    type: "mcp_replaced",
    server: name,
    oldInstanceId: oldCard?.instanceId ?? null,
    newInstanceId: result.card.instanceId,
    toolCountDelta: newToolCount - oldToolCount,
};
mcpEvents.emit("mcp_replaced", event);
logger.info(event, "MCP replaced event emitted");
```

- [ ] **Step C5.3: Wire `/api/events` SSE endpoint**

Create `apps/web/src/routes/api/events/+server.ts`:

```ts
// apps/web/src/routes/api/events/+server.ts
import { mcpEvents } from "@devops-agent/agent";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
    const stream = new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();
            const onReplaced = (event: unknown) => {
                controller.enqueue(encoder.encode(`event: mcp_replaced\ndata: ${JSON.stringify(event)}\n\n`));
            };
            mcpEvents.on("mcp_replaced", onReplaced);
            // Initial comment so the client knows the channel is open
            controller.enqueue(encoder.encode(":ok\n\n"));
            // Cleanup on cancel
            return () => mcpEvents.off("mcp_replaced", onReplaced);
        },
    });
    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        },
    });
};
```

- [ ] **Step C5.4: Frontend hook (minimal — console log only in v1)**

In `apps/web/src/routes/+page.svelte` (or wherever the layout root lives), add a one-time EventSource subscriber:

```svelte
<script lang="ts">
import { onMount } from "svelte";

onMount(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("mcp_replaced", (e) => {
        console.log("[mcp_replaced]", JSON.parse((e as MessageEvent).data));
    });
    return () => es.close();
});
</script>
```

- [ ] **Step C5.5: Manual replay**

```bash
# Start everything
bun run dev &
sleep 10
# In another shell, watch the events stream:
curl -N http://localhost:5173/api/events &
# Now kill + restart konnect to trigger replaced
pkill -f mcp-server-konnect
sleep 2
bun run --filter '@devops-agent/mcp-server-konnect' dev &
sleep 35  # wait for one poll cycle (30s) plus reconnect
# Expected in the curl output: an "event: mcp_replaced\ndata: {...}" line
pkill -f 'bun.*'
```

- [ ] **Step C5.6: Commit**

```bash
git add packages/agent/src/mcp-bridge.ts \
        packages/agent/src/index.ts \
        apps/web/src/routes/api/events/ \
        apps/web/src/routes/+page.svelte
git commit -m "$(cat <<'EOF'
SIO-780: emit mcp_replaced SSE event on detected replacement

mcp-bridge.ts exports a per-process EventEmitter (mcpEvents). The
'replaced' branch of pollServerHealth emits an McpReplacedEvent
containing serverName, old/new instanceId, and tool-count delta.

apps/web/src/routes/api/events/+server.ts streams the event over SSE.
Frontend hooks the stream in +page.svelte's onMount; v1 only logs to
console (toast UI is out-of-scope per spec).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task C6: Five-state UI in `DataSourceSelector.svelte`

**Files:**
- Modify: `apps/web/src/lib/components/DataSourceSelector.svelte`
- Modify: `apps/web/src/routes/+page.svelte` (pass `states` prop through)
- Create: `apps/web/src/lib/components/DataSourceSelector.test.ts`

- [ ] **Step C6.1: Update the component to accept + use `states`**

Replace the existing script block in `DataSourceSelector.svelte`:

```svelte
<script lang="ts">
type ProbeState = "ready" | "unready" | "down" | "replaced" | "misidentified";

let {
    dataSources,
    connected = [],
    states = {},
    selected = $bindable([]),
}: {
    dataSources: string[];
    connected: string[];
    states: Record<string, ProbeState>;
    selected: string[];
} = $props();

const labels: Record<string, string> = {
    elastic: "Elastic",
    kafka: "Kafka",
    couchbase: "Capella",
    konnect: "Konnect",
    gitlab: "GitLab",
    atlassian: "Atlassian",
    aws: "AWS",
};

function stateFor(id: string): ProbeState {
    return states[id] ?? (connected.includes(id) ? "ready" : "down");
}

function isInteractive(id: string): boolean {
    const s = stateFor(id);
    return s === "ready" || s === "unready" || s === "replaced";
}

function classFor(id: string, isSelected: boolean): string {
    const s = stateFor(id);
    if (s === "down") {
        return "bg-red-50 text-gray-400 border border-red-300 cursor-not-allowed line-through decoration-red-300";
    }
    if (s === "misidentified") {
        return "bg-red-100 text-red-900 border border-red-700 cursor-not-allowed";
    }
    if (s === "unready") {
        return isSelected
            ? "bg-tommy-accent-blue text-white border border-yellow-500"
            : "bg-yellow-50 text-yellow-900 border border-yellow-500 hover:border-yellow-600";
    }
    if (s === "replaced") {
        return "bg-yellow-100 text-yellow-900 border border-yellow-500 animate-pulse";
    }
    // ready
    return isSelected
        ? "bg-tommy-accent-blue text-white"
        : "bg-white text-gray-600 border border-gray-300 hover:border-tommy-accent-blue";
}

function titleFor(id: string): string {
    const label = labels[id] ?? id;
    const s = stateFor(id);
    if (s === "down") return `${label} — not connected`;
    if (s === "misidentified") return `${label} — wrong server on this port. Check env config.`;
    if (s === "unready") return `${label} — upstream degraded`;
    if (s === "replaced") return `${label} — process replaced, reloading tools`;
    return label;
}

function toggle(id: string) {
    if (!isInteractive(id)) return;
    if (selected.includes(id)) {
        selected = selected.filter((s) => s !== id);
    } else {
        selected = [...selected, id];
    }
}

function selectAll() {
    selected = dataSources.filter(isInteractive);
}

function selectNone() {
    selected = [];
}
</script>

{#if dataSources.length > 0}
  <div class="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b border-gray-200">
    <span class="text-xs font-medium text-gray-500">Target:</span>
    <div class="flex gap-1.5 flex-wrap">
      {#each dataSources as ds}
        <button
          onclick={() => toggle(ds)}
          disabled={!isInteractive(ds)}
          class="px-2.5 py-1 rounded-full text-xs font-medium transition-colors {classFor(ds, selected.includes(ds))}"
          title={titleFor(ds)}
        >
          {labels[ds] ?? ds}
        </button>
      {/each}
    </div>
    <div class="flex gap-1 ml-auto">
      <button onclick={selectAll} class="text-[10px] text-gray-400 hover:text-gray-600">All</button>
      <span class="text-gray-300">|</span>
      <button onclick={selectNone} class="text-[10px] text-gray-400 hover:text-gray-600">None</button>
    </div>
  </div>
{/if}
```

- [ ] **Step C6.2: Pass `states` through from `+page.svelte`**

Edit `apps/web/src/routes/+page.svelte` (or whichever route uses the selector). Where `DataSourceSelector` is mounted, add `states`:

```svelte
<DataSourceSelector
    {dataSources}
    {connected}
    {states}
    bind:selected
/>
```

Then ensure the data load function (probably `+page.server.ts` or the route's `load`) fetches `states` from `/api/datasources`:

```ts
// +page.server.ts or +page.ts
export const load = async ({ fetch }) => {
    const res = await fetch("/api/datasources");
    const { dataSources, connected, states } = await res.json();
    return { dataSources, connected, states };
};
```

- [ ] **Step C6.3: Write a component test**

Create `apps/web/src/lib/components/DataSourceSelector.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/svelte";
import DataSourceSelector from "./DataSourceSelector.svelte";

describe("DataSourceSelector", () => {
    test("renders ready datasource as interactive", () => {
        const { getByTitle } = render(DataSourceSelector, {
            dataSources: ["elastic"],
            connected: ["elastic"],
            states: { elastic: "ready" },
            selected: [],
        });
        const btn = getByTitle("Elastic") as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
    });

    test("renders misidentified as disabled with tooltip", () => {
        const { getByTitle } = render(DataSourceSelector, {
            dataSources: ["konnect"],
            connected: [],
            states: { konnect: "misidentified" },
            selected: [],
        });
        const btn = getByTitle(/wrong server/) as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
    });

    test("renders unready as interactive with yellow border", () => {
        const { getByTitle } = render(DataSourceSelector, {
            dataSources: ["kafka"],
            connected: ["kafka"],
            states: { kafka: "unready" },
            selected: [],
        });
        const btn = getByTitle(/upstream degraded/) as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
        expect(btn.className).toContain("yellow-500");
    });

    test("renders down as disabled with strikethrough", () => {
        const { getByTitle } = render(DataSourceSelector, {
            dataSources: ["gitlab"],
            connected: [],
            states: { gitlab: "down" },
            selected: [],
        });
        const btn = getByTitle(/not connected/) as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
        expect(btn.className).toContain("line-through");
    });
});
```

If `@testing-library/svelte` isn't already installed, install it: `bun add -D @testing-library/svelte`. If component testing infra is non-trivial to set up, skip the test file in v1 and rely on manual probes — but record the gap in the PR description.

- [ ] **Step C6.4: Run tests + manual smoke**

```bash
bun test apps/web/src/lib/components/DataSourceSelector.test.ts
# (If testing-library is set up.)

bun run dev &
sleep 10
# Open http://localhost:5173 in a browser
# Verify: all 7 datasources show with state colors
# Kill konnect-mcp; refresh; konnect should now show red strikethrough within 30s
pkill -f mcp-server-konnect
sleep 35
# refresh browser — konnect now red
pkill -f 'bun.*'
```

- [ ] **Step C6.5: Commit**

```bash
git add apps/web/src/lib/components/DataSourceSelector.svelte \
        apps/web/src/lib/components/DataSourceSelector.test.ts \
        apps/web/src/routes/+page.svelte \
        apps/web/src/routes/+page.server.ts
git commit -m "$(cat <<'EOF'
SIO-780: five-state UI in DataSourceSelector

The component switches on ProbeState (from /api/datasources states field)
to render one of five visual treatments per spec table:
  ready          blue (selected) / white (unselected)
  unready        yellow border (still interactive)
  down           red strikethrough, disabled
  replaced       yellow pulse animation
  misidentified  red with warning tooltip, disabled

Per Q5 decision: misidentified shouldn't appear stable in practice
(boot-strict throws first), but if it slips through a mid-session role
swap the UI surfaces it loudly with the env-var hint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task C7: Full repo gate + Phase C acceptance

- [ ] **Step C7.1: Typecheck + lint + test**

```bash
bun run typecheck
bun run lint
bun run test
```

Expected: green except pre-existing SIO-779 failures.

- [ ] **Step C7.2: Run all three acceptance scripts together**

```bash
bun run dev &
sleep 15
scripts/sio780/check-identity.sh
scripts/sio780/check-ready.sh
# Plus a five-state UI smoke via the dashboard endpoint:
curl -s http://localhost:5173/api/datasources | jq
# Expected: { dataSources: [...], connected: [...], states: { elastic: "ready", ... } }
pkill -f 'bun.*'
```

- [ ] **Step C7.3: Replay original bug + verify fix**

```bash
# 1. Start everything
bun run dev &
sleep 15
# 2. Note konnect instanceId
OLD_ID=$(curl -s http://localhost:9083/identity | jq -r .instanceId)
echo "OLD: $OLD_ID"
# 3. Kill konnect, start replacement on same port
pkill -f mcp-server-konnect
sleep 2
bun run --filter '@devops-agent/mcp-server-konnect' dev &
# 4. Wait for poll cycle
sleep 35
# 5. Check the agent log for "MCP server replaced"
grep "MCP server replaced" /tmp/agent.log || journalctl -u devops-agent --since "1 min ago" 2>/dev/null
# 6. Verify new instanceId
NEW_ID=$(curl -s http://localhost:9083/identity | jq -r .instanceId)
echo "NEW: $NEW_ID"
[[ "$OLD_ID" != "$NEW_ID" ]] && echo "OK: instanceId rotated"
pkill -f 'bun.*'
```

- [ ] **Step C7.4: Replay boot-strict misconfiguration**

```bash
KAFKA_MCP_URL=http://localhost:9080 bun run --filter '@devops-agent/web' dev
# Expected: process exits with McpRoleMismatchError. Capture exit code:
echo "exit code: $?"
# Expected: non-zero
```

- [ ] **Step C7.5: Push + open Phase C PR**

```bash
git push
gh pr create --title "SIO-780 Phase C: agent three-tier probe + five-state UI" --body "$(cat <<'EOF'
## Summary
- `probeServer` replaces `healthCheckServer` — five-state discriminated result (ready / unready / down / replaced / misidentified)
- Boot-strict identity check refuses to start the agent when an MCP returns a role that doesn't match `MCP_SERVER_TO_ROLE`
- Auto-reconnect on `replaced` (A1 default); emits `mcp_replaced` SSE event for the frontend
- `/api/datasources` extended with `states: Record<string, ProbeState>`
- `DataSourceSelector.svelte` renders five distinct visual states

## Test plan
- [x] `bun test packages/agent/src/__tests__/mcp-bridge.probe.test.ts` — 6 state-transition tests
- [x] `bun test packages/agent/src/__tests__/mcp-bridge.boot-strict.test.ts` — 4 tests including the boot-strict throw
- [x] `bun test apps/web/src/routes/api/datasources/+server.test.ts` — endpoint smoke
- [x] `bun test apps/web/src/lib/components/DataSourceSelector.test.ts` — four visual-state component tests
- [x] Original bug replay: kill+restart konnect-mcp → "MCP server replaced" log within 30s; instanceId rotates
- [x] Boot-strict replay: `KAFKA_MCP_URL=http://localhost:9080 bun run dev` exits with `McpRoleMismatchError`

## Linear
SIO-780 — Phase C of three. Last PR. Ready for Done with explicit user approval.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Phase C complete.** Once merged, update SIO-780 to **Done** with explicit user approval (per global rule: never set Linear issues to Done without approval).

---

## Post-merge

- [ ] **Step Z1: Update Linear**

After all three PRs merge to `main`, ask the user before flipping SIO-780 to **Done**. Per CLAUDE.md and memory `feedback_never_create_linear_done`: never set issues to Done without explicit user approval.

- [ ] **Step Z2: Tear down the worktree (if applicable)**

```bash
# from the main worktree:
git worktree list
git worktree remove .claude/worktrees/modest-mclaren-43b452
```

Watch for stash residue per memory `reference_subagent_worktree_residue`.

- [ ] **Step Z3: Record in memory**

After Phase C merges, consider a memory slug like `reference_sio780_identity_card_pattern` capturing:
- `IdentityCard` interface location (`packages/shared/src/transport/identity.ts`)
- `canonicalizeUpstream` regex (`/password|secret|token|key/i` minus `publicKey`/`instanceId`)
- `MCP_SERVER_TO_ROLE` is the single source of truth for expected roles
- 8s total probe budget (2s/1s/5s) vs 35s connect budget

So future probe-pattern questions can cite the prior art.

---

## Self-Review (post-write)

Checking the plan against the spec sections:

| Spec section | Plan task(s) |
|---|---|
| Architecture — Three-Tier Probe Model | C2 (probeServer) |
| Architecture — Identity Card | A1 (identity.ts) |
| Architecture — Boot-Strict (B1) | C1, C3 |
| Architecture — Auto-Reconnect on Replaced (A1) | C2 (poll dispatch), C5 (SSE) |
| Architecture — Five-State UI (C1) | C4 (endpoint), C6 (component) |
| Phase A — files | A1–A12 |
| Phase A — IdentityCard interface verbatim | A1.3 |
| Phase A — bootstrap wiring | A2 |
| Phase A — Acceptance | A11 (probe script), A12 (PR) |
| Phase B — files | B1–B10 |
| Phase B — hoisted readiness | B1, B2 |
| Phase B — per-MCP probes (6 servers) | B3–B8 |
| Phase B — proxy readiness (3+3a) | B9 |
| Phase B — Acceptance | B10 |
| Phase C — files | C1–C7 |
| Phase C — `probeServer` verbatim code | C2.3 |
| Phase C — `MCP_SERVER_TO_ROLE` constant | C1.3 |
| Phase C — Boot-strict | C3 |
| Phase C — `getServerStates` + endpoint | C4 |
| Phase C — `mcp_replaced` SSE event | C5 |
| Phase C — DataSourceSelector | C6 |
| Phase C — Acceptance + boot-strict replay | C7 |
| Verification block | A11, B10, C7 |
| Risks (8 entries) | Mitigated across A1.3 (redaction), B1.1 (TTL+single-flight), C2.3 (timeouts), C3 (boot-strict + skip-on-unreachable), C5 (best-effort reconnect) |

All spec sections have at least one task. No placeholders. Type names consistent: `IdentityCard`, `McpRole`, `ProbeState`, `ProbeResult`, `ReadinessSnapshot` — same spellings used in every task that references them. `MCP_SERVER_TO_ROLE` and `DATASOURCE_TO_MCP_SERVER` are the two hardcoded maps in `mcp-bridge.ts` — both spelled SCREAMING_SNAKE_CASE consistently.
