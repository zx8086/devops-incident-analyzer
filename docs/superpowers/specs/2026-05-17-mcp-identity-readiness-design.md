# MCP Identity + Three-Tier Readiness — Design

**Date:** 2026-05-17
**Status:** Proposed
**Linear ticket:** SIO-780 (single ticket, three PRs — one per phase)
**Parent epic:** SIO-779 follow-up (lifecycle unification landed at PR #106, merged to `main` at `7e7f57b`)
**Originating handover:** `experiments/HANDOFF-2026-05-17-mcp-identity-readiness.md` (gitignored, local-only)

---

## TL;DR

The agent's health poller (`packages/agent/src/mcp-bridge.ts:247-258`) checks only `GET /health` → 200. On 2026-05-17 the dashboard reported `konnect-mcp` as connected while port 9083 was held by an **orphan bun process from a previous session**. The orphan served `/health` 200 happily; the agent had been calling it for hours. Its upstream Kong token had likely expired, so every `tools/call` would have 401'd.

Single-tier liveness conflates three distinct questions. This design splits them into three endpoints and teaches the agent to distinguish five states:

| Question | Endpoint | Already exists? |
|---|---|---|
| Is this socket alive? | `GET /health` | yes (all 7 MCP servers + 2 proxies) |
| Is this the same process+role+upstream-config I bound to at boot? | `GET /identity` | NEW |
| Is the upstream healthy right now? | `GET /ready` | only on kafka-mcp |

Ships in three independently-shippable phases under one Linear ticket:

- **Phase A** — `IdentityCard` type + `/identity` route + bootstrap wiring. Server-side only; agent ignores it.
- **Phase B** — Hoist `createReadinessProbe` from kafka to shared; wire per-MCP upstream probes (including SigV4-signed `tools/list` for both proxies).
- **Phase C** — Agent-side three-tier probe + UI five-state surfacing.

**Defaults (confirmed with user 2026-05-17):**
- **A1**: auto-reconnect on `replaced` state (instanceId changed but role still matches)
- **B1**: strict `misidentified` at boot — agent refuses to start if any configured MCP returns a `role` that doesn't match the expected mapping. No `MCP_BOOT_LENIENT` escape hatch in v1.
- **C1**: surface `unready` and `misidentified` as distinct UI states (yellow + red-with-tooltip), not collapsed into a single "disconnected" red

---

## Goals

1. The agent can detect when an MCP server has been replaced by a different process (different `instanceId`) on the same port and react to it.
2. The agent can detect when an MCP server's upstream is unhealthy (expired token, network partition, broker down) and surface it to the user.
3. The dashboard shows five distinct states (`ready`, `unready`, `down`, `replaced`, `misidentified`) with clear visual treatment for each.
4. Misconfigured MCP routing (`KAFKA_MCP_URL` pointed at an elastic-mcp port) is caught at agent boot with a clear error, not silently misrouted.
5. No new daemons, no new ports, no new dependencies. All new endpoints register inside the existing per-MCP HTTP transport.

## Non-Goals

- Cryptographic identity attestation (no mTLS, no signed `instanceId`, no JWT). Dev-tool scope, not zero-trust.
- Multi-replica MCPs behind a load balancer. Today's architecture is one process per role per host.
- Detecting tampered-but-cooperative servers that lie on `/identity`.
- Cross-process boot-token persistence (the `expectedIdentity` map lives in the agent process — a fresh agent has no expectations to violate).
- WebSocket/SSE liveness for the SvelteKit dev server itself.

## Constraints

- **Per-server timeouts must fit inside the AgentCore connect budget.** kafka-mcp + aws-mcp inherit a 35s connect timeout (memory: `reference_sio774_per_server_connect_timeouts`). The new three-tier probe sums to 8s in the worst case (2s health + 1s identity + 5s ready), well under that budget.
- **No credential leakage via `upstreamFingerprint`.** Pure SHA256 over a canonicalized + credential-redacted view of the upstream config. The fingerprint is hex; raw values never appear.
- **TTL-cached upstream probes.** `/ready` caches snapshots for 30s with a single-flight guard. The agent's 30s poller must not poll faster than the server-side TTL.
- **Identity wiring lives in the unified bootstrap.** SIO-779 collapsed all 7 MCP servers + 2 proxies into `createMcpApplication`. The new `role` + `identityFingerprint` parameters are added once to `McpApplicationOptions<T>` and inherited everywhere.

---

## Architecture

### Three-Tier Probe Model

```
agent (poll cycle, every 30s)
  │
  ├─ Tier 1: GET <baseUrl>/health    (2s budget) ──► is socket alive?
  ├─ Tier 2: GET <baseUrl>/identity  (1s budget) ──► same process+role+upstream as boot?
  └─ Tier 3: GET <baseUrl>/ready     (5s budget) ──► upstream healthy right now?

  Discriminated result → ProbeState:
    ready          all three pass, identity matches expected
    unready        health OK, identity OK, /ready returned 503
    down           /health unreachable or non-2xx
    replaced       /health OK, but instanceId or upstreamFingerprint changed
    misidentified  /health OK, but role doesn't match expected (boot-time → throw)
```

Each tier answers a question the lower tiers can't. `/health` catches "process died"; `/identity` catches "different process on the same port" (the bug that prompted this work); `/ready` catches "process is fine but its upstream is broken."

### Identity Card

```ts
// packages/shared/src/transport/identity.ts

export type McpRole =
    | "elastic-mcp" | "kafka-mcp" | "couchbase-mcp" | "konnect-mcp"
    | "gitlab-mcp" | "atlassian-mcp" | "aws-mcp"
    | "aws-proxy" | "kafka-proxy";

export type McpTransportMode = "stdio" | "http" | "agentcore-proxy";

export interface IdentityCard {
    instanceId: string;       // crypto.randomUUID() at boot; rotates on restart
    role: McpRole;            // discriminated union of server roles
    version: string;          // from package.json
    bootedAt: string;         // ISO-8601
    pid: number;              // process.pid
    mode: McpTransportMode;
    upstreamFingerprint: string;  // sha256(canonical+redacted upstream config), 16 hex chars
}
```

The `upstreamFingerprint` is the hash of the per-MCP upstream config object (e.g. `{ deployments: [...] }` for elastic, `{ hostname, bucket } ` for couchbase) with credentials redacted by a key regex (`/password|secret|token|key/i`, excluding `publicKey`/`instanceId`) and keys sorted before serialization. Same env config → same fingerprint across reboots; changed config → different fingerprint, triggering `replaced`.

### Boot-Strict Identity Check (B1)

After the initial MCP connection succeeds at `initMcpClient` (`mcp-bridge.ts:154-218`), the agent fetches `/identity` for each connected server and compares `card.role` against a hardcoded map:

```ts
// packages/agent/src/mcp-bridge.ts — alongside DATASOURCE_TO_MCP_SERVER
const MCP_SERVER_TO_ROLE: Record<string, McpRole> = {
    "elastic-mcp": "elastic-mcp",
    "kafka-mcp": "kafka-proxy",        // kafka is routed via AgentCore proxy in current deployments
    "couchbase-mcp": "couchbase-mcp",
    "konnect-mcp": "konnect-mcp",
    "gitlab-mcp": "gitlab-mcp",
    "atlassian-mcp": "atlassian-mcp",
    "aws-mcp": "aws-proxy",
};
```

Mismatch → throw `McpRoleMismatchError` with a message naming the offending env var:

```
kafka-mcp at http://localhost:9080/mcp returned identity card with role="elastic-mcp",
expected "kafka-proxy". Check KAFKA_MCP_URL.
```

The handover's example at line 117 confirms the proxy vs. direct distinction is recorded in `MCP_SERVER_TO_ROLE`: configuring `AWS_MCP_URL=http://localhost:3001/mcp` (the SigV4 proxy port) expects `role: "aws-proxy"`.

No `MCP_BOOT_LENIENT` escape hatch in v1 — if a dev hits the error, the message names exactly what to fix. We can add an escape hatch in a follow-up if real friction emerges.

### Auto-Reconnect on `replaced` (A1)

When `pollServerHealth` detects `replaced` (instanceId or upstreamFingerprint changed, role still matches), it calls the existing `reconnectServer(name, url)` at `mcp-bridge.ts:261` to refresh the tool list. After successful reconnect, `expectedIdentity` is updated to the new card.

**In-flight tool calls are not hard-aborted.** Reasoning:
- When `instanceId` changes, the old process is already dead — any in-flight call on its socket fails with a connection error via the existing error path
- Plumbing `AbortController` through `MultiServerMCPClient.invoke()` + LangGraph `Send` is material new surface
- The supervisor's existing retry logic absorbs the connection error

Instead, on detected `replaced`, the agent emits an SSE event:

```json
{
    "type": "mcp_replaced",
    "server": "konnect-mcp",
    "oldInstanceId": "abc-...",
    "newInstanceId": "xyz-...",
    "toolCountDelta": 0
}
```

The frontend logs it to console in v1. Surfacing as a toast notification is a stretch goal, out-of-scope for this ticket.

### Five-State UI (C1)

`apps/web/src/routes/api/datasources/+server.ts` extends its response with a `states` field:

```ts
{
    dataSources,
    connected,  // kept for back-compat: equivalent to states[id] === "ready"
    states: { elastic: "ready", kafka: "unready", konnect: "misidentified", ... }
}
```

`DataSourceSelector.svelte` switches on the state:

| State | Color | Disabled | Tooltip |
|---|---|---|---|
| `ready` | blue (selected) / white (unselected) | no | `<label>` |
| `unready` | yellow border | no | `<label> — upstream degraded (<components>)` |
| `down` | red strikethrough | yes | `<label> — not connected` |
| `replaced` | yellow → blue once reconnect finishes | no during transition | `<label> — process replaced, reloading tools` |
| `misidentified` | red with warning icon | yes | `<label> — wrong server on this port (got role=<x>, expected=<y>). Check env config.` |

(In practice `misidentified` only appears as a stable state if it slips past the boot-strict check — e.g. a server replaced mid-session with a different role. Today's B1 default throws at boot, so first-hit misidentified blocks startup entirely.)

---

## Phase A — `IdentityCard` + `/identity` route + bootstrap wiring

**Goal:** every MCP server and both proxies expose `GET /identity`. Agent ignores the endpoint; nothing in `mcp-bridge.ts` changes yet.

### Files

| File | Status | Change |
|---|---|---|
| `packages/shared/src/transport/identity.ts` | NEW | `IdentityCard` interface, `McpRole` union, `buildIdentityCard()`, `canonicalizeUpstream()` |
| `packages/shared/src/transport/__tests__/identity.test.ts` | NEW | 6 unit tests (fingerprint stability, redaction, instanceId rotation) |
| `packages/shared/src/bootstrap.ts` | MODIFY | Extend `McpApplicationOptions<T>` with `role` + `identityFingerprint`; thread `IdentityCard` into `createTransport` |
| `packages/shared/src/agentcore-proxy.ts` | MODIFY | Add `/identity` route (sibling to `/health` and `/ping`) |
| `packages/shared/src/transport/agentcore-proxy.ts` | MODIFY | Accept identity card and register route |
| `packages/mcp-server-kafka/src/transport/http.ts` | MODIFY | Add `/identity` route alongside `/ready` and `/health` |
| `packages/mcp-server-{elastic,couchbase,konnect,gitlab,atlassian,aws}/src/transport/*.ts` | MODIFY | Add `/identity` route |
| `packages/mcp-server-*/src/index.ts` (×7) | MODIFY | Pass `role` and `identityFingerprint` to `createMcpApplication` |

### `identity.ts` interface (verbatim)

```ts
// packages/shared/src/transport/identity.ts
import { createHash, randomUUID } from "node:crypto";

export type McpRole =
    | "elastic-mcp" | "kafka-mcp" | "couchbase-mcp" | "konnect-mcp"
    | "gitlab-mcp" | "atlassian-mcp" | "aws-mcp"
    | "aws-proxy" | "kafka-proxy";

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

export function canonicalizeUpstream(config: Record<string, unknown>): string {
    const redacted = redactCredentials(config);
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

### Bootstrap wiring

`McpApplicationOptions<T>` gains two required fields:

```ts
export interface McpApplicationOptions<T> {
    // ...existing 8 fields
    role: McpRole;                                      // NEW (required)
    version: string;                                    // NEW (required) — caller's package.json version
    identityFingerprint: (datasource: T) => string;     // NEW (required)
}
```

`createMcpApplication` builds the card once between step 4 (datasource init) and step 5 (createTransport):

```ts
// inside createMcpApplication, after datasource init:
const identityCard = buildIdentityCard({
    role: options.role,
    version: options.version,  // caller passes their package.json version (new field on McpApplicationOptions)
    mode: mode === "proxy" ? "agentcore-proxy" : "http",
    upstreamFingerprint: options.identityFingerprint(datasource),
});

// createTransport signature extends to accept the card:
const transport = await options.createTransport(serverFactory, datasource, identityCard);
```

The per-package `createTransport` implementations thread the card through and register the `/identity` route inside `Bun.serve()`:

```ts
"/identity": {
    GET: () => Response.json(identityCard),
},
```

The route is unauthenticated by design — it returns no secrets, only the identity card (hash, no raw config), and the agent must be able to call it without owning per-MCP API keys.

### Test gates

```bash
bun test packages/shared/src/transport/__tests__/identity.test.ts  # 6 tests
```

Test cases:
1. Same input → same `upstreamFingerprint`
2. Field-order independence (keys reordered → same hash)
3. Credential redaction (key matching `/password|secret|token|key/i` is dropped)
4. `publicKey` and `instanceId` are NOT redacted (allow-list)
5. Nested arrays of objects redact correctly
6. `buildIdentityCard()` returns rotating `instanceId` across two calls

Manual probe (per port):

```bash
for port in 9080 9081 9082 9083 9084 9085 3001; do
    curl -s "http://localhost:$port/identity" | jq '.role, .instanceId, .upstreamFingerprint'
done
```

Expected: each port returns its expected role, a UUID `instanceId`, and a stable 16-char `upstreamFingerprint` across two consecutive boots with identical env vars.

### Acceptance

- All 7 MCP servers + 2 proxies serve `GET /identity` with their card
- `curl /identity` for any server returns 200 with the JSON card
- `curl /health` and `curl /ready` (where it exists) are unchanged
- Agent typechecks; nothing in `mcp-bridge.ts` consumes the card yet

**Phase A ships independently as its own PR.**

---

## Phase B — Hoist `createReadinessProbe` + wire per-MCP upstream probes

**Goal:** every MCP server has a working `GET /ready` that actually pings its upstream. Today only kafka-mcp has this; the other 6 + both proxies get it now.

### Files

| File | Status | Change |
|---|---|---|
| `packages/shared/src/transport/readiness.ts` | NEW | Hoisted from kafka; generalize `components` to `Record<string, () => Promise<void>>` |
| `packages/shared/src/transport/__tests__/readiness.test.ts` | NEW | Hoisted tests; parameterized over generic component map |
| `packages/shared/src/transport/proxy-readiness.ts` | NEW | `createProxyReadinessProbe(opts)` — SigV4-signed `tools/list` against upstream + role-sentinel check |
| `packages/mcp-server-kafka/src/transport/readiness.ts` | DELETE | now in shared |
| `packages/mcp-server-kafka/src/index.ts` | MODIFY | update import path |
| `packages/mcp-server-{elastic,couchbase,konnect,gitlab,atlassian,aws}/src/index.ts` | MODIFY | wire `createReadinessProbe` with per-MCP upstream probe functions |
| `packages/mcp-server-{elastic,couchbase,konnect,gitlab,atlassian,aws}/src/transport/*.ts` | MODIFY | register `/ready` route (copy kafka's pattern from `http.ts:220-267`) |
| `packages/shared/src/agentcore-proxy.ts` | MODIFY | register `/ready` route using `createProxyReadinessProbe` |

### Per-MCP upstream probe map

| Server | Component probe |
|---|---|
| `elastic-mcp` | per-deployment `client.cluster.health()` (one component per `ELASTIC_DEPLOYMENTS` entry) |
| `couchbase-mcp` | `cluster.ping()` or `cluster.diagnostics()` |
| `konnect-mcp` | `kongApi.listControlPlanes({ pageSize: 1 })` — catches expired token, the original bug |
| `gitlab-mcp` | GraphQL `query { currentUser { id } }` |
| `atlassian-mcp` | `proxy.resolveCloudId()` re-call (cached) or `proxy.discoverRemoteTools()` count check |
| `aws-mcp` (server mode) | STS `GetCallerIdentity` |
| `kafka-mcp` (already wired) | existing kafka admin + per-service `probeReachability` |

### Proxy readiness (aws-proxy / kafka-proxy)

Per Q3 decision (3+3a): proxy `/ready` is the full check.

```ts
// packages/shared/src/transport/proxy-readiness.ts

const ROLE_SENTINEL_TOOLS: Record<"aws-proxy" | "kafka-proxy", string> = {
    "aws-proxy": "aws___call_aws",
    "kafka-proxy": "kafka_list_topics",
};

export function createProxyReadinessProbe(opts: {
    role: "aws-proxy" | "kafka-proxy";
    getCredentials: () => Promise<unknown>;
    upstreamUrl: string;
    sigv4Fetch: (req: Request) => Promise<Response>;  // shared SigV4 signing already in agentcore-proxy.ts
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
}): () => Promise<ReadinessSnapshot>;
```

Steps inside the probe (single-flight + TTL cached at 30s, same shape as kafka's):

1. **`getCredentials()`** — fails fast if AWS creds are missing/expired
2. **SigV4-signed `tools/list` JSON-RPC POST** to `<upstreamUrl>` with `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`
3. **Role sentinel check** — response's `result.tools[]` must include the sentinel tool name for the configured role (`aws___call_aws` for `aws-proxy`, `kafka_list_topics` for `kafka-proxy`). Mismatch → `unready` with `{ agentcoreUpstream: "expected kafka-mcp tools, got aws-mcp tools" }`

Component map for the proxy:

| Component name | Outcome |
|---|---|
| `credentials` | `ok` when `getCredentials()` resolves; `unreachable` otherwise |
| `agentcoreUpstream` | `ok` when `tools/list` returns 2xx AND sentinel tool present; `unreachable` otherwise |

A 503 from upstream, a network error, OR a sentinel-tool mismatch all render as `ready: false` with the appropriate per-component error.

### Hoisted `readiness.ts` shape

The kafka file at `packages/mcp-server-kafka/src/transport/readiness.ts:99-172` becomes the shared implementation. Two changes:

1. `ComponentName` ceases to be a union literal — generic over caller-supplied component names: `createReadinessProbe<T extends string>(opts)` where `components: Record<T, () => Promise<void>>`.
2. The kafka-specific `clientManager` + `toolOptions` fields move out of the shared signature; each MCP supplies its own component map.

```ts
// packages/shared/src/transport/readiness.ts (hoisted shape)
export interface ReadinessSnapshot {
    ready: boolean;
    components: Record<string, "ok" | "unreachable" | "disabled">;
    errors?: Record<string, string>;
    cachedAt: string;
}

export interface CreateReadinessProbeOptions {
    components: Record<string, () => Promise<void>>;
    ttlMs?: number;     // default 30_000
    timeoutMs?: number; // default 5_000
    now?: () => number;
}

export function createReadinessProbe(opts: CreateReadinessProbeOptions): () => Promise<ReadinessSnapshot>;
```

The TTL cache + single-flight guard at kafka's `readiness.ts:159-171` is preserved unchanged.

### Test gates

```bash
bun test packages/shared/src/transport/__tests__/readiness.test.ts  # 7 tests
bun test packages/shared/src/transport/__tests__/proxy-readiness.test.ts  # 5 tests
```

Per-package integration: probe success → 200; simulated upstream failure → 503 with per-component error.

Manual probes:

```bash
# Konnect token expiry replay (original bug)
curl -s http://localhost:9083/ready | jq  # ready: true when token valid
# expire the token, wait 30s for TTL...
curl -s http://localhost:9083/ready | jq
# expected: { "ready": false, "components": { "konnectControlPlane": "unreachable" },
#            "errors": { "konnectControlPlane": "401 Unauthorized" } }

# Proxy sentinel check
curl -s http://localhost:3001/ready | jq  # SigV4 proxy for aws-mcp
# ready: true when AgentCore returns tools/list with aws___call_aws present
```

### Acceptance

- Every MCP server (and both proxies) has a working `/ready` endpoint
- `/ready` reflects upstream health within 30s of upstream changes (TTL window)
- Probe internal exceptions render as 503, never 500
- Proxy `/ready` returns 503 when `getCredentials()` fails OR when the upstream `tools/list` returns the wrong sentinel tool

**Phase B ships independently as its own PR after Phase A merges.**

---

## Phase C — Agent-side three-tier probe + UI five-state surfacing

**Goal:** dashboard distinguishes ready / unready / down / replaced / misidentified. Agent auto-reconnects on `replaced`, hard-fails at boot on `misidentified`.

### Files

| File | Status | Change |
|---|---|---|
| `packages/agent/src/mcp-bridge.ts` | MODIFY | Replace `healthCheckServer` with `probeServer`; add `expectedIdentity` map, `MCP_SERVER_TO_ROLE` constant, boot-strict identity check, auto-reconnect on `replaced`, `getServerStates()` export |
| `packages/agent/src/__tests__/mcp-bridge.probe.test.ts` | NEW | Probe state transition tests (mocks for each tier) |
| `packages/agent/src/__tests__/mcp-bridge.boot-strict.test.ts` | NEW | Boot refuses on role mismatch |
| `packages/agent/src/errors.ts` | MODIFY (or NEW) | Add `McpRoleMismatchError` |
| `apps/web/src/routes/api/datasources/+server.ts` | MODIFY | Extend response with `states: Record<string, ProbeState>` |
| `apps/web/src/routes/api/datasources/+server.test.ts` | MODIFY | Cover new `states` field |
| `apps/web/src/lib/components/DataSourceSelector.svelte` | MODIFY | Five-state color switch |
| `apps/web/src/lib/components/DataSourceSelector.test.ts` | MODIFY (or NEW) | Component tests for each state |
| `apps/web/src/routes/api/chat/+server.ts` (or `apps/web/src/lib/server/sse-bus.ts` if introduced) | MODIFY/NEW | Emit `mcp_replaced` event on detected replacement. If no general-purpose SSE channel exists today, introduce a minimal one (`emitMcpReplacedEvent` writes to a per-process EventEmitter; a `GET /api/events` route streams it as SSE). Decision finalized in plan phase. |

### `probeServer` (replaces `healthCheckServer`)

```ts
type ProbeState = "ready" | "unready" | "down" | "replaced" | "misidentified";

type ProbeResult =
    | { state: "ready"; card: IdentityCard }
    | { state: "unready"; card: IdentityCard; snapshot: ReadinessSnapshot }
    | { state: "down"; reason: string }
    | { state: "replaced"; reason: string; card: IdentityCard }
    | { state: "misidentified"; reason: string; card: IdentityCard };

const expectedIdentity = new Map<string, IdentityCard>();
const lastProbeState = new Map<string, ProbeState>();

async function probeServer(name: string, url: string): Promise<ProbeResult> {
    const baseUrl = url.replace(/\/mcp$/, "");

    // Tier 1: alive (2s budget)
    try {
        const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
        if (!r.ok) return { state: "down", reason: `health returned ${r.status}` };
    } catch (err) {
        return { state: "down", reason: `health unreachable: ${errorMessage(err)}` };
    }

    // Tier 2: identity (1s budget; pure in-memory on the server side)
    let card: IdentityCard;
    try {
        const r = await fetch(`${baseUrl}/identity`, { signal: AbortSignal.timeout(1_000) });
        if (!r.ok) return { state: "down", reason: `identity returned ${r.status}` };
        card = await r.json();
    } catch (err) {
        return { state: "down", reason: `identity unreachable: ${errorMessage(err)}` };
    }

    const expected = expectedIdentity.get(name);
    if (!expected) {
        // first-ever probe for this server (post-boot edge case)
        expectedIdentity.set(name, card);
        return { state: "ready", card };
    }
    if (card.role !== expected.role) {
        return { state: "misidentified", reason: `role mismatch: expected ${expected.role}, got ${card.role}`, card };
    }
    if (card.instanceId !== expected.instanceId) {
        return { state: "replaced", reason: "instanceId changed", card };
    }
    if (card.upstreamFingerprint !== expected.upstreamFingerprint) {
        return { state: "replaced", reason: "upstream config fingerprint changed", card };
    }

    // Tier 3: readiness (5s budget; calls upstream)
    try {
        const r = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(5_000) });
        if (r.status === 404) return { state: "ready", card };  // no /ready endpoint — alive + same identity is enough
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
```

The 404-handling in Tier 3 keeps Phase C shippable even if Phase B's per-MCP `/ready` rollout is incomplete — servers without `/ready` are treated as "alive + same identity is enough."

### `MCP_SERVER_TO_ROLE` (Q2 decision: hardcoded)

Lives next to the existing `DATASOURCE_TO_MCP_SERVER` constant in `mcp-bridge.ts`:

```ts
const MCP_SERVER_TO_ROLE: Record<string, McpRole> = {
    "elastic-mcp": "elastic-mcp",
    "kafka-mcp": "kafka-proxy",         // routed via AgentCore proxy in production
    "couchbase-mcp": "couchbase-mcp",
    "konnect-mcp": "konnect-mcp",
    "gitlab-mcp": "gitlab-mcp",
    "atlassian-mcp": "atlassian-mcp",
    "aws-mcp": "aws-proxy",             // routed via AgentCore proxy in production
};
```

The proxy vs. direct distinction is encoded by which logical name maps to which role. A developer running aws-mcp **directly** locally (not via the proxy) would need to either (a) not configure `AWS_MCP_URL` at all, or (b) wait for the follow-up that adds direct-mode support — out-of-scope for this ticket.

### Boot-Strict check (B1)

After the initial connection succeeds in `initMcpClient` (`mcp-bridge.ts:154-218`), before `startHealthPolling()`:

```ts
for (const { name, url } of serverEntries) {
    if (!connectedServers.has(name)) continue;
    const card = await fetchIdentity(url);
    const expectedRole = MCP_SERVER_TO_ROLE[name];
    if (!expectedRole) continue;  // unknown server name — defensive, shouldn't happen
    if (card.role !== expectedRole) {
        throw new McpRoleMismatchError(
            `${name} (${url}) returned identity card with role="${card.role}", expected "${expectedRole}". Check ${name.toUpperCase().replace(/-/g, "_")}_URL env var.`
        );
    }
    expectedIdentity.set(name, card);
}
```

`McpRoleMismatchError` is a typed `Error` subclass so callers can catch + log + exit cleanly. The agent process exits with non-zero status; the SvelteKit dev server logs the message and refuses chat requests.

### Auto-reconnect on `replaced` (A1) + SSE event

Inside the expanded `pollServerHealth`:

```ts
case "replaced": {
    logger.info({ serverName: name, reason: result.reason, oldInstanceId: expectedIdentity.get(name)?.instanceId, newInstanceId: result.card.instanceId }, "MCP server replaced, reconnecting");
    await reconnectServer(name, url);
    const oldCard = expectedIdentity.get(name);
    expectedIdentity.set(name, result.card);
    // Emit SSE event (Q4 decision: no hard-abort, just notify)
    emitMcpReplacedEvent({
        server: name,
        oldInstanceId: oldCard?.instanceId ?? null,
        newInstanceId: result.card.instanceId,
        toolCountDelta: (toolsByServer.get(name)?.length ?? 0) - (oldToolCount ?? 0),
    });
    break;
}
case "misidentified": {
    // post-boot misidentified — log loudly, mark disconnected, await operator action
    logger.error({ serverName: name, reason: result.reason }, "MCP server misidentified mid-session");
    connectedServers.delete(name);
    break;
}
```

`emitMcpReplacedEvent` pushes to whatever SSE channel the chat route already uses. If no general-purpose SSE channel exists (only per-conversation streams), the event is logged only and surfaced through the dashboard polling cycle.

### Dashboard endpoint extension

```ts
// apps/web/src/routes/api/datasources/+server.ts
import { getServerStates } from "@devops-agent/agent/mcp-bridge";

export const GET = async () => {
    return json({
        dataSources,
        connected,                  // kept for back-compat
        states: getServerStates(),  // NEW: Record<string, ProbeState>
    });
};
```

`getServerStates()` is a new export from `mcp-bridge.ts` returning a snapshot of `lastProbeState`.

### `DataSourceSelector.svelte` five-state switch

Existing boolean `isConnected(id)` becomes a state lookup. Tailwind class table per state (drives the table at the top of the architecture section above):

```svelte
<script lang="ts">
    let { dataSources, states }: Props = $props();
    const stateClasses = (state: ProbeState | undefined) => {
        switch (state) {
            case "ready": return "border-blue-500 text-white";
            case "unready": return "border-yellow-500 text-yellow-100";
            case "down": return "border-red-500 text-gray-500 line-through cursor-not-allowed";
            case "replaced": return "border-yellow-500 text-white animate-pulse";
            case "misidentified": return "border-red-700 text-red-100 cursor-not-allowed";
            default: return "border-gray-700 text-gray-500";
        }
    };
</script>
```

Disabled states (`down`, `misidentified`) set `disabled` on the button and skip click handlers. Tooltips use Tailwind's `title` attribute initially; richer hover-card is a stretch goal.

### Test gates

```bash
bun test packages/agent/src/__tests__/mcp-bridge.probe.test.ts
bun test packages/agent/src/__tests__/mcp-bridge.boot-strict.test.ts
bun test apps/web/src/routes/api/datasources/
```

Unit tests for each `probeServer` state transition. Boot-strict test asserts the agent throws when a configured server returns the wrong role. Frontend tests verify the color/disabled state for each `ProbeState`.

Integration replay (the original bug):

```bash
# 1. bun run dev (all MCPs)
# 2. curl http://localhost:9083/identity | jq .instanceId  →  capture as $OLD_ID
# 3. pkill -f mcp-server-konnect && bun run --filter '@devops-agent/mcp-server-konnect' dev &
# 4. wait 30s for poll cycle
# 5. grep "MCP server replaced" agent.log  →  must show oldInstanceId=$OLD_ID, newInstanceId=<new>
# 6. open dashboard  →  konnect briefly yellow, then blue
```

Boot-strict replay:

```bash
KAFKA_MCP_URL=http://localhost:9080 bun run --filter '@devops-agent/web' dev
# expected: process exits with McpRoleMismatchError naming KAFKA_MCP_URL
```

### Acceptance

- Dashboard shows 5 distinct states with the colors above
- Killing an MCP server mid-session: dashboard turns red within 30s
- Replacing an MCP server (kill + restart): dashboard turns yellow briefly, agent reconnects, tools refresh, dashboard returns to blue
- Misconfiguring `KAFKA_MCP_URL` to point at an elastic-mcp port: agent refuses to boot with `McpRoleMismatchError` naming the wrong role and the env var to check
- `mcp_replaced` SSE events appear in the dev console for the right server when a replacement is detected

**Phase C ships independently as its own PR after Phase B merges.**

---

## Component Boundaries

Each unit has one clear purpose, well-defined interface, testable in isolation:

| Unit | Purpose | Interface | Depends on |
|---|---|---|---|
| `shared/transport/identity.ts` | Build + serialize identity cards | `buildIdentityCard()`, `canonicalizeUpstream()`, `IdentityCard`, `McpRole` | `node:crypto` only |
| `shared/transport/readiness.ts` | TTL-cached single-flight readiness probe | `createReadinessProbe(opts)` returning `() => Promise<ReadinessSnapshot>` | nothing (pure) |
| `shared/transport/proxy-readiness.ts` | Proxy-specific readiness with SigV4 + sentinel | `createProxyReadinessProbe(opts)` | `shared/agentcore-proxy.ts` for SigV4 signer |
| `shared/bootstrap.ts` | Hoist identity card creation into the unified entry point | `McpApplicationOptions<T>.role`, `.identityFingerprint` (new required fields) | identity.ts |
| per-MCP `transport/*.ts` | Register `/identity` + `/ready` routes | `createTransport(serverFactory, datasource, identityCard)` | bootstrap |
| `agent/src/mcp-bridge.ts` | Three-tier probe + boot-strict + auto-reconnect + state export | `probeServer()`, `getServerStates()`, `MCP_SERVER_TO_ROLE`, `McpRoleMismatchError` | identity.ts (type only) |
| `web/api/datasources` | Surface states to the frontend | `GET /api/datasources` returns `{ dataSources, connected, states }` | mcp-bridge |
| `web/components/DataSourceSelector` | Render five-state UI | `states` prop + Tailwind class table | nothing (pure view) |

The shared modules have zero per-MCP knowledge. The per-MCP knowledge (role mapping, sentinel tools, upstream probe functions) lives in the MCP server's own `index.ts` or in `mcp-bridge.ts` (for the agent-side role map).

---

## Verification

```bash
bun install
bun run typecheck
bun run lint     # only pre-existing SIO-779 failures should remain
bun run test

# Phase A acceptance
for port in 9080 9081 9082 9083 9084 9085 3001; do
    echo "=== port $port ==="
    curl -s http://localhost:$port/identity | jq '.role, .instanceId, .upstreamFingerprint'
done

# Phase B acceptance — Konnect token expiry replay (the original bug)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9083/ready
# expected: 200 when token valid; 503 once expired and 30s TTL elapses

# Phase B proxy sentinel check
curl -s http://localhost:3001/ready | jq '.components.agentcoreUpstream, .components.credentials'
# expected: "ok" "ok"; flip AWS_AGENTCORE_RUNTIME_ARN to wrong runtime → "unreachable"

# Phase C acceptance — replaced replay
# kill + restart konnect-mcp; within 30s, agent log shows "MCP server replaced"
# dashboard shows konnect yellow then blue

# Phase C acceptance — boot-strict
KAFKA_MCP_URL=http://localhost:9080 bun run --filter '@devops-agent/web' dev
# expected: McpRoleMismatchError on stderr; process exits non-zero
```

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Identity card leaks credentials via `upstreamFingerprint` | Low | SHA256 over redacted config; `redactCredentials` regex `/password\|secret\|token\|key/i` with allow-list for `publicKey`/`instanceId`. Test coverage for nested arrays + edge keys. |
| `/ready` probes fan out to upstreams too often (DoS) | Medium | 30s TTL cache + single-flight guard (preserved from kafka). Agent poller runs at 30s — never faster than server TTL. |
| Boot-strict misidentified check breaks lazy dev setups | High (intentional) | Error message names exactly what to fix (env var + actual vs. expected role). No escape hatch in v1 per Q5 decision. Add `MCP_BOOT_LENIENT` in a follow-up only if real friction emerges. |
| Auto-reconnect on `replaced` mid-conversation confuses the model | Medium | Best-effort + SSE event per Q4 decision. The supervisor's existing connection-error retry path absorbs the failed in-flight call. Hard-abort plumbing is out-of-scope; revisit if real-world cases surface. |
| Hung `/ready` probe blocks the poller | Low | 2s/1s/5s per-tier timeouts at the agent + 5s per-component timeout at the server + single-flight cache. Three layers of bounded fan-out. Total worst-case probe time: 8s, well under the 30s poll interval. |
| Two `instanceId`s in 30s due to k8s pod restart during poll | Low | Poller treats it as `replaced` → reconnect → success. Idempotent. Worst case: one cycle of yellow in the UI. |
| Konnect `/ready` adds load to Kong API (token validation = real call) | Medium | Cheapest possible call (`listControlPlanes` with `pageSize: 1`). With 30s TTL, that's 2 calls/min — negligible vs. tool-call traffic. |
| SigV4 `tools/list` round-trip on proxy `/ready` doubles AgentCore traffic | Medium | TTL cached at 30s. Two extra AgentCore calls per minute per proxy. AgentCore's billable surface is `tools/call`, not `tools/list`. |
| `crypto.randomUUID` collision in worker forks | Low | Same `instanceId` across forks would falsely pass identity check. Mitigation: stick to single-process MCPs (current architecture); document the constraint. |
| Phase A landing without Phase B leaves `/ready` un-probed except on kafka | Low (intentional) | Phase C's `probeServer` treats 404 on `/ready` as "alive + identity matches is enough." Order of merge can be A → B → C or A → C → B without breaking. |

---

## Out of Scope

- **Cryptographic identity attestation** (mTLS, signed `instanceId`, JWT). Dev observability, not zero-trust.
- **Multi-replica MCPs behind a load balancer.** Current architecture is one process per role per host.
- **Detecting tampered-but-cooperative servers** that lie on `/identity`.
- **Cross-process boot-token persistence.** `expectedIdentity` is per-agent-process memory.
- **Hard-abort of in-flight tool calls on `replaced`.** Best-effort + SSE event per Q4 decision.
- **`MCP_BOOT_LENIENT` escape hatch.** Strict-only in v1 per Q5 decision.
- **Direct-mode aws-mcp / kafka-mcp** (not via AgentCore proxy). The `MCP_SERVER_TO_ROLE` map hard-codes the proxy role for these two; supporting both proxy and direct modes requires a follow-up.
- **SSE event UI surfacing as a toast.** The `mcp_replaced` event is emitted; frontend only logs to console in v1.
- **WebSocket / SSE liveness for the SvelteKit dev server itself.** The user sees that directly.

---

## Workflow

1. **Branch off `main` at `7e7f57b`** — do NOT branch off any `claude/zealous-bartik-*` worktree.
2. **Create Linear ticket** in team Siobytes, project [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a), status **In Progress** (per CLAUDE.md: never create directly in Done; per memory `feedback_never_create_linear_done`).
3. **Spec** — this file at `docs/superpowers/specs/2026-05-17-mcp-identity-readiness-design.md`. Commit to feature branch.
4. **Plan** at `docs/superpowers/plans/2026-05-17-mcp-identity-readiness.md` — three phase blocks with TDD task structure mirroring SIO-779's plan style.
5. **Implementation**: subagent-driven (Sonnet for most tasks, Opus for the agent-side three-tier probe in Phase C).
6. **PRs**: one per phase, all referencing the same SIO-780. Sequence: A → B → C.
7. **Linear transitions**: In Progress → In Review (when first PR opens) → Done (only with explicit user approval after all three PRs merge).
8. **Commit format**: `SIO-780: <change>` HEREDOC pattern with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.
9. **Test gating per commit**: `bun run typecheck && bun run lint && bun run test`. Pre-existing SIO-779 lint failures are acceptable.

---

## Related Code References

- `packages/agent/src/mcp-bridge.ts:64-340` — connection map, polling, reconnect logic. Existing patterns preserved: `Promise.allSettled` for fan-out, `serializeMcpConnectError` for log shape, `withTimeout` for bounded waits.
- `packages/shared/src/bootstrap.ts:52-161` — SIO-779's unified bootstrap. Identity wiring lives here.
- `packages/shared/src/transport/agentcore-proxy.ts` — SIO-779's proxy transport helper. Identity routing for the proxy variants mirrors the same pattern.
- `packages/shared/src/agentcore-proxy.ts:396-639` — SigV4 proxy core. `/health` and `/ping` routes at lines 622-635; `/identity` and `/ready` register here as sibling routes.
- `packages/mcp-server-kafka/src/transport/readiness.ts` — reference implementation. Hoist verbatim with the components-map generalization.
- `packages/mcp-server-kafka/src/transport/http.ts:220-267` — route wiring pattern.
- `packages/mcp-server-kafka/src/index.ts:157-170` — how kafka builds the readiness probe + threads into `createTransport`. Other servers copy this shape.
- `apps/web/src/routes/api/datasources/+server.ts` — dashboard endpoint. State surfacing extends here.
- `apps/web/src/lib/components/DataSourceSelector.svelte` — UI; five-state switch lives here.
- PR #106 — SIO-779 lifecycle unification (merged 2026-05-17 as `7e7f57b`). Read its spec at `docs/superpowers/specs/2026-05-17-mcp-lifecycle-and-chat-observability-design.md` for bootstrap context.

## Memory References

- `reference_sio779_request_context_envelope` — chat correlation envelope. Identity probe logs ride the same pino mixin (`threadId`/`runId`/`requestId` auto-stamped).
- `reference_sio779_proxy_mode_bootstrap` — `createMcpApplication({ mode: "proxy" })`. Identity wiring in the proxy transport mirrors this pattern.
- `reference_sio774_per_server_connect_timeouts` — kafka/aws need 35s connect timeouts. The 8s worst-case probe budget (2s + 1s + 5s) fits comfortably.
- `feedback_verbatim_plan_code_has_bugs` — always run biome on plan-listing code before committing.
- `reference_experiments_dir_gitignored` — handover doc stays local-only.
- `reference_subagent_worktree_residue` — start fresh from main, not from `claude/zealous-*` worktrees.
- `feedback_plan_authority_over_pattern` — Phase A makes `createServerFactory` more central; if a reviewer flags divergence from sibling proxy patterns, point to this spec which deliberately specifies the divergence.
