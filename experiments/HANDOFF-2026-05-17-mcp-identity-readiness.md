# Handover — MCP Identity + Three-Tier Readiness

**Date:** 2026-05-17
**Linear ticket:** TBD (create as part of spec phase — see Workflow)
**Parent epic:** SIO-779 follow-up (lifecycle unification landed at PR [#106](https://github.com/zx8086/devops-incident-analyzer/pull/106), merged to `main` at `7e7f57b`)
**Repo state:** branch `main` at `7e7f57b` (SIO-779 merged via squash). Start the new ticket's branch from `main`, NOT from `claude/zealous-bartik-130f0e`.
**Suggested branch name:** `claude/<harness-supplied>` (let the worktree harness pick it). Inside, use `simonowusupvh/sio-XXX-mcp-identity-readiness-probes` when pushing if you need a manual ref.

---

## TL;DR

A user-observed misdiagnosis on 2026-05-17 — the DataSourceSelector showed Konnect "active" while the user's current `bun run dev` had not started a Konnect MCP. Port 9083 was held by an **orphaned bun process** from a previous session. The agent's health poller (`packages/agent/src/mcp-bridge.ts:247`) only checks `GET /health` → 200, which the orphan happily served. The agent was unknowingly calling a stale process whose upstream Kong API token had likely expired (every `tools/call` would have 401'd).

**Ship a three-tier probe model** that answers three different questions with three different endpoints:

1. **`/health`** (existing) — "is this socket alive?" — 200/non-200 binary, no upstream — k8s liveness contract preserved
2. **`/identity`** (NEW) — "is this the same process+role+upstream-config I bound to at boot?" — returns an `IdentityCard`, never touches upstream
3. **`/ready`** (existing on kafka only — hoist to shared) — "is the upstream healthy right now?" — 200/503 + snapshot, TTL-cached + thundering-herd-guarded

**Defaults agreed with user (2026-05-17):**
- **A1**: auto-reconnect on `replaced` state (instanceId changed but role still matches)
- **B1**: strict `misidentified` at boot (refuse to start the agent if any configured MCP returns a `role` that doesn't match the expected mapping)
- **C1**: surface `unready` and `misidentified` as distinct UI states (yellow + red-with-tooltip respectively), not collapsed into a single "disconnected" red

Ship as one Linear ticket, executed in three phases. Phase A is safe to ship alone (server-side `/identity` route, agent does nothing with it yet). Phase B hoists `createReadinessProbe` to shared and wires per-MCP upstream probes. Phase C lights up the agent + UI consumption.

---

## Context — how this came to be

- **PR [#106](https://github.com/zx8086/devops-incident-analyzer/pull/106) / SIO-779** unified MCP lifecycle so every server (and both proxies) routes through `createMcpApplication`. That unification is the precondition for this work: identity wiring goes in the bootstrap layer once and applies to all 9 entries (7 MCP servers + 2 proxies).
- **SIO-726** introduced `/ready` for kafka-mcp only, with a TTL-cached single-flight probe. The shape is good — hoist as-is to `packages/shared/src/transport/readiness.ts` so the other 6 MCP servers can adopt it.
- **SIO-608** added the 30s health poller in `packages/agent/src/mcp-bridge.ts:339`. It's a single-tier probe (`/health` 200 = alive) — the proximate cause of the misdiagnosis bug. The poller is the right hook for the three-tier upgrade; don't add a parallel polling system.
- **Memory `reference_sio774_per_server_connect_timeouts`** sets the precedent that kafka and aws (proxy-routed servers) need 35s connect timeouts. The new probes inherit this concern — each tier needs explicit timeout budgets so a hung upstream doesn't starve the poller.

The user's session that surfaced the bug: lsof showed port 9083 held by PID 56225 (orphan bun, prior session), while their current `bun run dev` was running PIDs 88399/88421/88443/88461 for the *other* MCPs. Curl to `http://localhost:9083/health` returned 200; curl to `http://localhost:9083/mcp tools/list` returned real Kong tool definitions. Both signals said "Konnect is fine" — neither said "this is a different process than the one your agent connected to two hours ago."

---

## Where the bodies are buried

### The single-tier probe (root cause)

`packages/agent/src/mcp-bridge.ts:247-258` — current `healthCheckServer`:

```ts
async function healthCheckServer(mcpUrl: string): Promise<boolean> {
    const healthUrl = mcpUrl.replace(/\/mcp$/, "/health");
    try {
        const response = await fetch(healthUrl, {
            method: "GET",
            signal: AbortSignal.timeout(5_000),
        });
        return response.ok;
    } catch {
        return false;
    }
}
```

Called by `pollServerHealth` at `packages/agent/src/mcp-bridge.ts:302-337`. Returns boolean. There is no identity check, no instance pinning, no upstream probe. This is the function the bug bypassed.

### The existing kafka readiness probe (reference implementation to hoist)

`packages/mcp-server-kafka/src/transport/readiness.ts:1-172` — full file. Key shape:

```ts
// Lines 17-22
export interface ReadinessSnapshot {
    ready: boolean;
    components: Record<ComponentName, ComponentStatus>;
    errors?: Partial<Record<ComponentName, string>>;
    cachedAt: string;
}

// Lines 99-172 — createReadinessProbe with TTL + single-flight
export function createReadinessProbe(opts: CreateReadinessProbeOptions): () => Promise<ReadinessSnapshot>
```

`packages/mcp-server-kafka/src/transport/http.ts:220-267` shows the route wiring — `/ready` returns 200 with snapshot body when ready, 503 with snapshot when not, 503-with-error when the probe itself throws. Tests at `packages/mcp-server-kafka/src/transport/__tests__/http.test.ts:161-256` enforce all four state transitions.

### The unified bootstrap (where identity wiring lands)

`packages/shared/src/bootstrap.ts:30-46` — `McpApplicationOptions<T>` interface. Add two required fields:

```ts
export interface McpApplicationOptions<T> {
    // ...existing 8 fields
    role: McpRole;                                      // NEW (required) — discriminated union of server roles
    identityFingerprint: (datasource: T) => string;     // NEW (required) — sha256 hex of upstream config
}
```

`packages/shared/src/bootstrap.ts:52-161` — `createMcpApplication`. Around step 4 (after `initDatasource`, before `createServerFactory`), generate the identity card once and stash it where the transport can read it. The transport-layer routes (`/identity`, `/health`, `/ready`) are registered by the per-package `createTransport` calls today — extend those signatures to accept the card.

### The AgentCore SigV4 proxy (also needs `/identity`)

`packages/shared/src/agentcore-proxy.ts:622-635` — current proxy `/health` and `/ping` routes:

```ts
"/health": {
    GET: async () => {
        try {
            await getCredentials();
            return Response.json({ status: "ok", target: "agentcore", region: config.region });
        } catch {
            return Response.json({ status: "error", message: "credentials unavailable" }, { status: 503 });
        }
    },
},
"/ping": {
    GET: () => Response.json({ status: "ok", proxy: true, target: fullUrl }),
},
```

The proxy is a distinct identity from the upstream MCP server it forwards to. Its `role` is `"aws-proxy"` or `"kafka-proxy"` — NOT the role of the upstream MCP. The agent's `expectedIdentity[name]` for an MCP configured via `AWS_MCP_URL=http://localhost:3001/mcp` records `role: "aws-proxy"`, so swapping in a local aws-mcp on that same port would be `misidentified` (correct).

### The dashboard endpoint

`apps/web/src/routes/api/datasources/+server.ts:1-37` — returns `{ dataSources, connected }`. Needs a third field `states: Record<string, "ready" | "unready" | "down" | "replaced" | "misidentified">` so the UI can render five colors instead of two.

`apps/web/src/lib/components/DataSourceSelector.svelte:22-69` — currently has `isConnected(id)` boolean. Extend to a switch on the state. Existing red+strikethrough styling for `"down"`; add yellow for `"unready"` and red-with-tooltip for `"misidentified"`.

---

## The fix (step-by-step phases)

### Phase A — `IdentityCard` type + `/identity` route + bootstrap wiring

**Goal:** every MCP server and both proxies expose `/identity`. Agent ignores it.

**Files to create:**
- `packages/shared/src/transport/identity.ts` — `IdentityCard` interface, `McpRole` union, `buildIdentityCard(opts)` constructor, `canonicalizeUpstream(obj)` for fingerprint computation
- `packages/shared/src/transport/__tests__/identity.test.ts` — unit tests for fingerprint stability (same input → same hash; field-order independence; credential redaction)

**Files to modify:**
- `packages/shared/src/bootstrap.ts` — extend `McpApplicationOptions<T>`, generate `IdentityCard` once per process, thread it into `createTransport(serverFactory, datasource, identityCard)` signature
- `packages/shared/src/transport/agentcore-proxy.ts` — `createAgentCoreProxyTransport(prefix, logger, identityCard)` registers `/identity` route returning the card; existing `/health` and `/ping` stay
- `packages/mcp-server-kafka/src/transport/http.ts` — add `/identity` route alongside `/ready` and `/health`
- The other 6 MCP servers' transport files (`packages/mcp-server-{elastic,couchbase,konnect,gitlab,atlassian,aws}/src/transport/*.ts`) — same `/identity` route addition
- Each of the 7 MCP server `index.ts` files — pass `role: "<service>-mcp"` and a per-package `identityFingerprint` function that hashes the upstream config (e.g. `sha256(canonicalUpstream({ deployments: config.elastic.deployments }))`)

**Identity card shape (verbatim — copy into `identity.ts`):**

```ts
// shared/src/transport/identity.ts
import { createHash } from "node:crypto";

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
        instanceId: crypto.randomUUID(),
        role: opts.role,
        version: opts.version,
        bootedAt: new Date().toISOString(),
        pid: process.pid,
        mode: opts.mode,
        upstreamFingerprint: opts.upstreamFingerprint,
    };
}

// Compute a deterministic 16-hex-char fingerprint from a config object.
// Canonical JSON serialization with sorted keys so identical configs always
// produce identical fingerprints. Credential fields (any key matching
// /password|secret|token|key/i except "instanceId" / "publicKey") are dropped
// before hashing so we never leak creds into health-poll logs.
export function canonicalizeUpstream(config: Record<string, unknown>): string {
    const redacted = redactCredentials(config);
    const sorted = JSON.stringify(redacted, Object.keys(redacted).sort());
    return createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

function redactCredentials(obj: Record<string, unknown>): Record<string, unknown> {
    // implementation: deep-clone, drop keys matching the regex above
    // (full code in the spec — tests cover edge cases like nested arrays,
    // keys named "publicKey" that should NOT be redacted, etc.)
}
```

**Test gates:**
- `bun test packages/shared/src/transport/__tests__/identity.test.ts` — 6 tests
- Per-package: `curl http://localhost:<port>/identity` returns the card with the expected `role` and a stable `upstreamFingerprint` across two consecutive boots with identical env vars
- `instanceId` rotates on restart (different on second boot)

**Acceptance:**
- All 7 MCP servers + 2 proxies serve `GET /identity` with their card
- `curl /identity` for any server returns 200 with the JSON card; `curl /health` and `curl /ready` (where it exists) are unchanged
- Agent typechecks; nothing in `mcp-bridge.ts` consumes the card yet

**Phase A is independently shippable.** Stop here if you want to merge a small PR; Phase B+C continue in a follow-up branch.

### Phase B — hoist `createReadinessProbe` + wire per-MCP upstream probes

**Goal:** every MCP server has a working `/ready` endpoint that actually pings its upstream. Today only kafka does.

**Files to create:**
- `packages/shared/src/transport/readiness.ts` — hoisted from `packages/mcp-server-kafka/src/transport/readiness.ts`. Generalize: instead of hard-coded `ComponentName` union, accept `components: Record<string, () => Promise<void>>` from the caller. Keep TTL + single-flight guard. Move `ReadinessSnapshot` interface alongside.
- `packages/shared/src/transport/__tests__/readiness.test.ts` — hoisted tests (TTL cache, thundering-herd guard, timeout per component, partial-failure produces `ready: false` with per-component errors)

**Files to modify:**
- `packages/mcp-server-kafka/src/transport/readiness.ts` — delete (now in shared)
- `packages/mcp-server-kafka/src/index.ts` — update import path
- Each of the other 6 MCP server `index.ts` files — wire `createReadinessProbe` with their upstream-specific probe functions:

  | Server | Component probes |
  |---|---|
  | elastic-mcp | per-deployment `client.cluster.health()` (one component per `ELASTIC_DEPLOYMENTS` entry) |
  | couchbase-mcp | `cluster.ping()` or `cluster.diagnostics()` |
  | konnect-mcp | `kongApi.listControlPlanes({ pageSize: 1 })` — catches expired token (your bug) |
  | gitlab-mcp | GraphQL `query { currentUser { id } }` |
  | atlassian-mcp | `proxy.resolveCloudId()` re-call (cached) or `proxy.discoverRemoteTools()` count check |
  | aws-mcp (server mode, when running locally) | STS `GetCallerIdentity` |
  | aws-proxy / kafka-proxy | `proxy.fetch("/ping")` on the AgentCore-side endpoint (the proxy's job is forwarding; "ready" means "can reach AgentCore + creds valid") |

- The HTTP transport in each MCP package — wire `readinessProbe` parameter through `createTransport(...)` to the route registration (kafka's `http.ts:224-267` is the pattern to copy)

**Test gates:**
- `bun test packages/shared/src/transport/__tests__/readiness.test.ts` — 7 tests (hoisted from kafka, parameterized)
- Per-package integration test: probe success → 200, simulated upstream failure → 503 with per-component error
- Manual probe: `curl http://localhost:9083/ready` returns `{ "ready": true, "components": { "konnectControlPlane": "ok" } }` when token valid; expire the token, wait 30s for cache, recurl → 503 with `{ "ready": false, "components": { "konnectControlPlane": "unreachable" }, "errors": { "konnectControlPlane": "401 Unauthorized" } }`

**Acceptance:**
- Every MCP server (and both proxies) has a working `/ready` endpoint
- `/ready` reflects upstream health within 30s of upstream changes
- Probe internal exceptions render as 503, never 500

### Phase C — agent-side three-tier probe + UI state surfacing

**Goal:** the dashboard distinguishes ready / unready / down / replaced / misidentified. The agent auto-reconnects on `replaced`, hard-fails at boot on `misidentified`.

**Files to modify:**
- `packages/agent/src/mcp-bridge.ts` — replace `healthCheckServer` (single-tier) with `probeServer` (three-tier). Add `expectedIdentity` map. Expand `pollServerHealth` to call the three tiers and update `connectedServers` based on the discriminated state.

  **New types** (add at top of `mcp-bridge.ts`):

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
  ```

  **New `probeServer` function** (replaces `healthCheckServer`):

  ```ts
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
          return { state: "unready", card, snapshot: { ready: false, components: {}, cachedAt: new Date().toISOString(), errors: { _probe: errorMessage(err) } } };
      }
  }
  ```

  **Boot-time strict check (B1 default):**

  In `initMcpClient` at `packages/agent/src/mcp-bridge.ts:154-218`, after the initial connection succeeds and tools load, fetch `/identity` for each connected server and record into `expectedIdentity`. If any server's `card.role` doesn't match the expected role from `DATASOURCE_TO_MCP_SERVER`, **throw** — refuse to finish boot. The agent should not start with misconfigured MCP routing.

  ```ts
  for (const { name, url } of serverEntries) {
      if (!connectedServers.has(name)) continue;
      const card = await fetchIdentity(url);
      const expectedRole = MCP_SERVER_TO_ROLE[name];
      if (card.role !== expectedRole) {
          throw new McpRoleMismatchError(
              `${name} (${url}) returned identity card with role="${card.role}", expected "${expectedRole}". Check ${name.toUpperCase().replace("-", "_")}_URL env var.`
          );
      }
      expectedIdentity.set(name, card);
  }
  ```

  **Auto-reconnect on `replaced` (A1 default):**

  In the expanded `pollServerHealth`, when a result is `replaced`, call the existing `reconnectServer(name, url)` (already at `mcp-bridge.ts:261`) — which refreshes the tool list. After successful reconnect, update `expectedIdentity` to the new card.

- `apps/web/src/routes/api/datasources/+server.ts` — extend the response with `states`:

  ```ts
  return json({
      dataSources,
      connected,  // kept for back-compat
      states: getServerStates(),  // NEW
  });
  ```

  Where `getServerStates()` is a new export from `mcp-bridge.ts` returning `Record<string, ProbeState>` derived from `lastProbeState`.

- `apps/web/src/lib/components/DataSourceSelector.svelte` — accept `states` prop, switch on the state for color:

  | State | Color | Disabled | Tooltip |
  |---|---|---|---|
  | `ready` | blue (selected) / white (unselected) | no | `<label>` |
  | `unready` | yellow border | no | `<label> — upstream degraded (<components>)` |
  | `down` | red strikethrough | yes | `<label> — not connected` |
  | `replaced` | yellow → blue once reconnect finishes | no during transition | `<label> — process replaced, reloading tools` |
  | `misidentified` | red with warning icon | yes | `<label> — wrong server on this port (got role=<x>, expected=<y>). Check env config.` |

- `apps/web/src/routes/+page.svelte` or wherever DataSourceSelector is mounted — pass the new `states` through

**Test gates:**
- New unit tests for `probeServer` state transitions (mocks for each tier)
- Integration test: agent connects to a server, server restarts (new `instanceId`), poll cycle detects `replaced`, reconnect fires, `expectedIdentity` updates
- Boot-strict test: agent refuses to start when an MCP returns wrong role
- Frontend Playwright (if test-orchestrator exists) or component test for each color state

**Acceptance:**
- Dashboard shows 5 distinct states with the colors above
- Killing an MCP server mid-session: dashboard turns red within 30s
- Replacing an MCP server (kill + restart): dashboard turns yellow briefly, agent reconnects, tools refresh, dashboard returns to blue
- Misconfiguring `KAFKA_MCP_URL` to point at `http://localhost:9080` (elastic): agent refuses to boot with a clear error message naming the wrong role

---

## Files to modify (summary)

| File | Phase | Change |
|---|---|---|
| `packages/shared/src/transport/identity.ts` | A | NEW |
| `packages/shared/src/transport/__tests__/identity.test.ts` | A | NEW |
| `packages/shared/src/bootstrap.ts` | A | Extend `McpApplicationOptions<T>`, thread `IdentityCard` |
| `packages/shared/src/agentcore-proxy.ts` | A | Add `/identity` route |
| `packages/shared/src/transport/agentcore-proxy.ts` | A | Accept + register identity card |
| `packages/mcp-server-{kafka,elastic,couchbase,konnect,gitlab,atlassian,aws}/src/transport/*.ts` | A | Add `/identity` route registration |
| `packages/mcp-server-{kafka,elastic,couchbase,konnect,gitlab,atlassian,aws}/src/index.ts` | A | Pass `role` + `identityFingerprint` to `createMcpApplication` |
| `packages/shared/src/transport/readiness.ts` | B | NEW (hoisted from kafka) |
| `packages/shared/src/transport/__tests__/readiness.test.ts` | B | NEW (hoisted) |
| `packages/mcp-server-kafka/src/transport/readiness.ts` | B | DELETE |
| `packages/mcp-server-{kafka,elastic,couchbase,konnect,gitlab,atlassian,aws}/src/index.ts` | B | Wire `createReadinessProbe` with upstream probes |
| `packages/mcp-server-{kafka,elastic,couchbase,konnect,gitlab,atlassian,aws}/src/transport/*.ts` | B | Register `/ready` route (kafka already done; copy pattern) |
| `packages/agent/src/mcp-bridge.ts` | C | Replace `healthCheckServer` with `probeServer`, add `expectedIdentity` map, boot-strict identity check, auto-reconnect on `replaced` |
| `packages/agent/src/__tests__/mcp-bridge.probe.test.ts` | C | NEW |
| `apps/web/src/routes/api/datasources/+server.ts` | C | Extend response with `states` |
| `apps/web/src/lib/components/DataSourceSelector.svelte` | C | 5-state color switch |
| `apps/web/src/routes/api/datasources/+server.test.ts` | C | Test new `states` field |

---

## Verification

```bash
# After each phase
bun install
bun run typecheck
bun run lint  # only pre-existing failures (the 8 from SIO-779's final check) should remain
bun run test

# Phase A acceptance
for port in 9080 9081 9082 9083 9084 9085 3001; do
  echo "=== port $port ==="
  curl -s http://localhost:$port/identity | jq '.role, .instanceId, .upstreamFingerprint'
done
# Each MUST return a distinct role matching the port (elastic-mcp, kafka-mcp or kafka-proxy, etc.)

# Phase B acceptance — expire a Kong token, wait 30s, recurl
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9083/ready  # 200 when valid, 503 after token expiry

# Phase C acceptance — replay the bug
# 1. Start bun run dev with all MCPs
# 2. Note konnect instanceId via curl /identity
# 3. Kill the konnect bun process, immediately start another on the same port
# 4. Within 30s, agent log should show "MCP server replaced (instanceId changed), reloading tools"
# 5. Dashboard briefly shows konnect yellow, then blue again

# Misconfiguration test (boot-strict)
KAFKA_MCP_URL=http://localhost:9080 bun run --filter '@devops-agent/web' dev
# Expected: agent refuses to boot with McpRoleMismatchError naming kafka_mcp pointed at an elastic-mcp instance
```

---

## Workflow

1. **Branch off `main` at `7e7f57b`** — do NOT branch off `claude/zealous-bartik-130f0e` (that branch held SIO-779 work and the worktree is being torn down by the harness)
2. **Create Linear ticket** in team Siobytes, project DevOps Incident Analyzer, status **In Progress** (per CLAUDE.md: never create issues directly in Done)
3. **Spec** at `docs/superpowers/specs/2026-05-17-mcp-identity-readiness-design.md` — follow the brainstorming skill, present 3 phases as a single coherent design with explicit defaults (A1/B1/C1)
4. **Plan** at `docs/superpowers/plans/2026-05-17-mcp-identity-readiness.md` — 3 phase blocks with TDD task structure mirroring SIO-779's plan style
5. **Implementation**: subagent-driven (Sonnet for most tasks, Opus for the spec writing and the agent-side three-tier probe in Phase C)
6. **Linear transitions**: In Progress → In Review (when PR opens) → Done (only with explicit user approval, per global rules)
7. **Commit format**: `SIO-XXX: <change>` HEREDOC pattern with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer
8. **Test gating**: `bun run typecheck && bun run lint && bun run test` before each commit; pre-existing lint errors enumerated below are acceptable

---

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Phase A identity card leaks credentials via `upstreamFingerprint` | Low | Pure SHA256; never include raw values. `redactCredentials` test must cover keys matching `/password\|secret\|token\|key/i` |
| Phase B probes fan out to upstream too often (DoS) | Medium | 30s TTL cache (already in kafka probe). Agent poller MUST NOT poll faster than the server-side TTL |
| Boot-strict misidentified check breaks lazy dev setups | High (intentional) | Document clearly in the error message. Add `MCP_BOOT_LENIENT=true` escape hatch ONLY if the user pushes back; default strict per B1 |
| Auto-reconnect on `replaced` mid-conversation confuses the model | Medium | Reconnect refreshes the tool list — if tool IDs change, the in-flight LangGraph state may reference stale IDs. Mitigation: emit a `tool_set_changed` event to the SSE stream so the UI can warn the user; abort in-flight tool calls when a `replaced` is detected |
| Hung `/ready` probe blocks the poller | Low | 5s per-probe timeout at agent layer + 5s per-component timeout at server layer + single-flight cache. Three layers of bounded fan-out |
| Two `instanceId`s in 30s due to k8s pod restart during poll | Low | The poller treats it as `replaced` → reconnect → success. Idempotent. Worst case: one cycle of yellow in the UI |
| Konnect `/ready` adds load to Kong API (token validation = real call) | Medium | The probe should be the cheapest possible Kong call (`listControlPlanes` with `pageSize: 1`). With 30s TTL, that's 2 calls/min — negligible vs. tool-call traffic |
| `crypto.randomUUID` in workers / multiple process forks | Low | Same `instanceId` across forks would falsely pass identity check. Mitigation: stick to single-process MCPs (current architecture); document the constraint |

---

## Out of scope

- **Cryptographic identity attestation.** No mTLS, no signed `instanceId`, no JWT — anyone with shell access can spawn a fake server with the right role. This is dev observability, not zero-trust. If/when the agent runs in a multi-tenant setting, mTLS at the transport layer is the right place.
- **Multi-replica MCPs behind a load balancer.** Today's architecture is one process per role per host. An LB rotating between two backends would alternate `instanceId` and trigger `replaced` every poll. Document the constraint; address when actually needed.
- **Detecting a tampered-but-cooperative server.** A server that lies on `/identity` to impersonate another role cannot be detected. Same answer as above — dev-tool scope.
- **Cross-process boot-token persistence.** The current `expectedIdentity` map lives in the agent process memory. If the agent restarts mid-session, the next boot's poll cycle will accept whatever identities the MCPs report (no comparison to "what the previous agent saw"). Acceptable: a fresh agent has no expectations to violate.
- **WebSocket / SSE liveness for the agent process itself.** The dashboard cares about MCP backends, not whether the SvelteKit dev server itself is up — the user sees that directly.

---

## Related code references

- `packages/agent/src/mcp-bridge.ts:64-340` — the connection map, polling, reconnect logic. Existing patterns to preserve: `Promise.allSettled` for fan-out, `serializeMcpConnectError` for log shape, `withTimeout` for bounded waits
- `packages/shared/src/bootstrap.ts:52-161` — SIO-779's unified bootstrap. Identity wiring lives here so all servers + proxies inherit it
- `packages/shared/src/transport/agentcore-proxy.ts` — SIO-779's proxy transport helper. Add identity routing here for the proxy variants
- `packages/shared/src/agentcore-proxy.ts:396-639` — SigV4 proxy core. The `/health` and `/ping` routes are at lines 622-635; `/identity` is the third sibling
- `packages/mcp-server-kafka/src/transport/readiness.ts` — the reference implementation. Hoist verbatim
- `packages/mcp-server-kafka/src/transport/http.ts:220-267` — route wiring pattern. The other 6 MCP transports get the same shape
- `packages/mcp-server-kafka/src/index.ts:157-170` — how kafka builds the readiness probe + threads into `createTransport`. Other servers copy this shape
- `apps/web/src/routes/api/datasources/+server.ts` — the dashboard endpoint. State surfacing happens here
- `apps/web/src/lib/components/DataSourceSelector.svelte` — the UI. 5-state switch lives here
- PR [#106](https://github.com/zx8086/devops-incident-analyzer/pull/106) — SIO-779 (lifecycle unification, merged 2026-05-17 as `7e7f57b`). Read the spec at `docs/superpowers/specs/2026-05-17-mcp-lifecycle-and-chat-observability-design.md` (on `main` at the SIO-779 commit) for the bootstrap/transport-helper context

---

## Memory references

Relevant slugs in `/Users/Simon.Owusu@Tommy.com/.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/`:

- `reference_sio779_request_context_envelope` — the chat correlation envelope SIO-779 added. Identity probe logs should ride the same pino mixin (`threadId`/`runId`/`requestId` auto-stamped); no extra wiring needed
- `reference_sio779_proxy_mode_bootstrap` — how the AgentCore proxy collapsed into `createMcpApplication({ mode: "proxy" })`. Identity wiring in the proxy transport mirrors that pattern
- `reference_sio774_per_server_connect_timeouts` — kafka/aws need 35s connect timeouts to outlast AgentCore's 30s cold-start budget. The new 3-tier probe must respect this; per-tier timeouts (2s health, 1s identity, 5s ready) sum to 8s — well under the 35s connect budget
- `reference_kafka_mcp_tool_count_canaries` — adding read tools requires bumping hardcoded counts in tests. Identity work probably won't add tools, but if you add an `mcp_identity` tool (NOT recommended — keep identity at the HTTP transport layer), this rule applies
- `feedback_verbatim_plan_code_has_bugs` — always run biome on plan-listing code before committing; plan listings predate biome formatting
- `reference_experiments_dir_gitignored` — this handover doc stays local-only; never commit
- `feedback_handoff_docs_main_branch` — handoff docs commit to main directly if they ARE committed (they're not, per the rule above)
- `reference_subagent_worktree_residue` — when the worktree is torn down, watch for stash residue. Start fresh in a clean worktree from main, not from `claude/zealous-bartik-130f0e`
- `feedback_plan_authority_over_pattern` — Phase A makes `createServerFactory` even more central to the bootstrap. If a reviewer flags "this diverges from sibling proxy patterns", point to the plan which deliberately specifies the divergence
- `feedback_handover_doc_structure` — full structure required for handovers (TL;DR, file:line refs, verification, risks, memory refs). This doc follows it
