# Handover — SIO-780 Phase B & C (MCP Identity + Three-Tier Readiness)

**Date:** 2026-05-17
**Linear ticket:** [SIO-780](https://linear.app/siobytes/issue/SIO-780) — In Review
**Parent epic:** SIO-779 follow-up (lifecycle unification, PR [#106](https://github.com/zx8086/devops-incident-analyzer/pull/106))
**Phase A PR:** [#107 — SIO-780 Phase A: IdentityCard + /identity route across all MCPs](https://github.com/zx8086/devops-incident-analyzer/pull/107)
**Repo state at handover:** `main` at `7e7f57b` (Phase A awaiting merge). Resume work AFTER PR #107 merges.
**Suggested branch name:** `simonowusupvh/sio-780-phase-b-readiness-probes` (off post-#107 main)

---

## TL;DR

Phase A is done and merged-ready on PR #107: `IdentityCard` type, `/identity` route on all 7 MCP servers + AgentCore SigV4 proxy, bootstrap wiring. The agent does NOT yet consume the route. Phase B hoists kafka-mcp's `createReadinessProbe` to `@devops-agent/shared` and wires per-MCP upstream probes (including SigV4-signed `tools/list` for the proxies). Phase C lights up the agent-side three-tier `probeServer`, boot-strict role checking, auto-reconnect on `replaced`, and a five-state `DataSourceSelector` UI.

Ship Phase B as PR #2 after #107 merges, Phase C as PR #3 after #2 merges. All three PRs reference the same SIO-780 ticket.

**Defaults locked from brainstorming (do not re-litigate):**
- **A1**: auto-reconnect on `replaced` state
- **B1**: strict `misidentified` at boot — no `MCP_BOOT_LENIENT` escape hatch in v1
- **C1**: five-state UI (ready / unready / down / replaced / misidentified)

**Other design decisions locked in spec:**
- Hardcoded `MCP_SERVER_TO_ROLE` constant in `mcp-bridge.ts` next to `DATASOURCE_TO_MCP_SERVER`
- Proxy `/ready` = `getCredentials()` + SigV4-signed `tools/list` + role-sentinel-tool check
- Best-effort reconnect on `replaced` + emit `mcp_replaced` SSE event (no hard-abort of in-flight tool calls)

---

## Context — how Phase A shipped

PR #107 contains 17 commits. Key landmarks:

| Commit | What it added |
|---|---|
| `f3d4cdf` | `packages/shared/src/transport/identity.ts` — `IdentityCard`, `McpRole`, `canonicalizeUpstream`, `buildIdentityCard` |
| `65aada9` | **Bug fix**: `canonicalizeUpstream`'s `JSON.stringify(value, topKeys.sort())` form was using keys as a whitelist at every nesting depth, silently dropping nested fields. Replaced with recursive `sortKeysDeep` + plain `JSON.stringify`. **The fix is permanent and Phase B/C inherit the corrected behavior.** |
| `5cf19d7` | `createMcpApplication` builds the card and threads to `createTransport` |
| `dc9b40b` | AgentCore SigV4 proxy `/identity` route |
| `2123db0` | **Bug fix**: moved `agentcore-proxy.identity.test.ts` from `transport/__tests__/` to `__tests__/` to escape `mock.module(...)` pollution from sibling `agentcore-proxy.test.ts`. **Pattern for Phase B**: never co-locate tests that need real `startAgentCoreProxy` with tests that mock it. |
| `2497170` → `a3c84c0` | 7 per-MCP server commits adding `/identity` route + bootstrap wiring |
| `520727b` + `da5ab40` | Biome auto-format passes (import order + indentation) |
| `ec5df65` | `scripts/sio780/check-identity.sh` Phase A acceptance probe |

**Phase A final state:**
- `bun run typecheck` → 0 errors across 13 packages
- `bun run lint` → 0 errors, 1 pre-existing `guides/` symlink warning
- `bun test packages/shared` → 254 pass, 0 fail
- Pre-existing konnect-mcp test failures (19 network-dependent, 401 from real Kong API) unchanged

---

## Where the bodies are buried

### Phase B starting point: kafka's reference `createReadinessProbe`

`packages/mcp-server-kafka/src/transport/readiness.ts:1-172` is the source-of-truth reference. Hoist verbatim with one generalization: the kafka-specific `ComponentName` union (`"kafka" | "schemaRegistry" | "ksql" | "connect" | "restproxy"`) becomes a generic `Record<string, () => Promise<void> | null>` from the caller.

Key shapes already in place:

```ts
// kafka's current readiness.ts (lines 17-22)
export interface ReadinessSnapshot {
    ready: boolean;
    components: Record<ComponentName, ComponentStatus>;
    errors?: Partial<Record<ComponentName, string>>;
    cachedAt: string;
}

// lines 99-172 — createReadinessProbe with TTL + single-flight guard
export function createReadinessProbe(opts: CreateReadinessProbeOptions): () => Promise<ReadinessSnapshot>
```

Route wiring pattern (kafka `http.ts:220-267`):

```ts
const readinessHandler = config.readinessProbe
    ? async (): Promise<Response> => {
        try {
            const probe = config.readinessProbe;
            if (!probe) return Response.json({ error: "readiness probe not configured" }, { status: 503 });
            const snapshot = await probe();
            return Response.json(snapshot, { status: snapshot.ready ? 200 : 503 });
        } catch (err) {
            return Response.json({ ready: false, error: errorMessage(err) }, { status: 503 });
        }
    }
    : null;
const readyHandler = readinessHandler ?? (() => Response.json({ error: "Not found" }, { status: 404 }));

// in routes:
"/ready": { GET: readyHandler },
```

The 6 other MCP servers don't yet register `/ready` — Phase B adds it to all of them following kafka's pattern.

### Phase C starting point: the agent's single-tier `healthCheckServer`

`packages/agent/src/mcp-bridge.ts:247-258` — the function Phase C replaces:

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

Called by `pollServerHealth` at `packages/agent/src/mcp-bridge.ts:302-337`. Phase C replaces with three-tier `probeServer` returning a discriminated `ProbeResult` (5 states).

### Boot-strict check location

`packages/agent/src/mcp-bridge.ts:154-218` is `createMcpClient`. The boot-strict check goes AFTER the existing connection loop succeeds (around line 211, after `logger.info({ toolCount: ..., servers: [...] }, "MCP tools loaded")`) and BEFORE `startHealthPolling()`. Throw `McpRoleMismatchError` if any connected server's `/identity` role doesn't match `MCP_SERVER_TO_ROLE`.

### Dashboard endpoint

`apps/web/src/routes/api/datasources/+server.ts:1-37` — current shape returns `{ dataSources, connected }`. Phase C extends with `states: Record<string, ProbeState>`.

### Five-state UI

`apps/web/src/lib/components/DataSourceSelector.svelte:1-71` — currently has a boolean `isConnected(id)` switch. Phase C replaces with a state-keyed switch (ready/unready/down/replaced/misidentified) and Tailwind class table.

---

## The plan (already written, ready to execute)

The implementation plan is at `docs/superpowers/plans/2026-05-17-mcp-identity-readiness.md` (3283 lines, ~30 TDD tasks). Phase A's tasks (A1–A12) are done; Phase B (B1–B10) and Phase C (C1–C7) are next.

**Phase B task summary (10 tasks):**

| Task | Output | Files |
|---|---|---|
| B1 | Hoist `createReadinessProbe` to shared, generalized component map | `packages/shared/src/transport/readiness.ts` (new), tests |
| B2 | Migrate kafka-mcp to shared probe (delete local copy) | `packages/mcp-server-kafka/src/*` |
| B3 | `/ready` on elastic-mcp (per-deployment `cluster.health()`) | `packages/mcp-server-elastic/src/*` |
| B4 | `/ready` on couchbase-mcp (`cluster.ping()`) | `packages/mcp-server-couchbase/src/*` |
| B5 | `/ready` on konnect-mcp (`listControlPlanes({ pageSize: 1 })`) — **the original bug's primary fix** | `packages/mcp-server-konnect/src/*` |
| B6 | `/ready` on gitlab-mcp (`currentUser` GraphQL) | `packages/mcp-server-gitlab/src/*` |
| B7 | `/ready` on atlassian-mcp (`resolveCloudId`) | `packages/mcp-server-atlassian/src/*` |
| B8 | `/ready` on aws-mcp direct mode (STS `GetCallerIdentity`) | `packages/mcp-server-aws/src/*` |
| B9 | Proxy readiness — SigV4 `tools/list` + role-sentinel check | `packages/shared/src/transport/proxy-readiness.ts` (new), proxy route |
| B10 | Phase B acceptance + PR | `scripts/sio780/check-ready.sh` |

**Phase C task summary (7 tasks):**

| Task | Output | Files |
|---|---|---|
| C1 | `McpRoleMismatchError` + `MCP_SERVER_TO_ROLE` map | `packages/agent/src/mcp-bridge.ts` |
| C2 | Replace `healthCheckServer` with five-state `probeServer` | `packages/agent/src/mcp-bridge.ts` |
| C3 | Boot-strict identity check (B1 default) | `packages/agent/src/mcp-bridge.ts:154-218` |
| C4 | `states` field in `/api/datasources` | `apps/web/src/routes/api/datasources/+server.ts` |
| C5 | `mcp_replaced` SSE event (best-effort reconnect per Q4) | `packages/agent/src/mcp-bridge.ts`, `apps/web/src/routes/api/events/+server.ts` (new) |
| C6 | Five-state `DataSourceSelector` UI | `apps/web/src/lib/components/DataSourceSelector.svelte` |
| C7 | Phase C acceptance + boot-strict replay + PR | acceptance scripts |

**Each task in the plan has TDD-shaped steps with actual code in every step. Read the plan task-by-task; don't try to hold all 17 tasks in your head at once.**

---

## Execution workflow

1. **Verify Phase A has merged:**
   ```bash
   git fetch origin
   git log origin/main -1 --oneline
   # Should show da5ab40 or later — Phase A commits
   ```

2. **Branch off post-#107 main:**
   ```bash
   git checkout main && git pull
   git checkout -b simonowusupvh/sio-780-phase-b-readiness-probes
   ```

3. **Invoke the `subagent-driven-development` skill** and execute the plan task-by-task. The plan is at `docs/superpowers/plans/2026-05-17-mcp-identity-readiness.md`. Start at Task B1.

4. **Sequence: A (done) → B → C.** Each phase opens its own PR referencing SIO-780.

5. **Linear stays In Review through B and C.** Only move to Done after all three PRs merge AND with explicit user approval. Per CLAUDE.md and memory `feedback_never_create_linear_done`.

6. **Commit format:** `SIO-780: <change>` HEREDOC pattern with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.

---

## Verification (per phase)

```bash
bun run typecheck && bun run lint && bun run test
```

Baseline going into Phase B (post-#107 merge):
- typecheck: 0 errors across 13 packages
- lint: 0 errors, 1 pre-existing `guides/` symlink warning
- test: pre-existing konnect-mcp network-dependent failures (19) persist — out of scope

**Manual probes:**

Phase B acceptance — script at `scripts/sio780/check-ready.sh` (created in B10):
```bash
bun run dev &
sleep 15
scripts/sio780/check-ready.sh
# Every port returns ready: true OR a typed errors object (not 500)
```

Phase B konnect bug replay (the original bug):
```bash
# 1. Start konnect-mcp with valid token, confirm /ready = 200
curl -s http://localhost:9083/ready | jq
# 2. Restart with KONNECT_ACCESS_TOKEN=invalid-token
# 3. Wait 30s for TTL window
# 4. /ready should now return 503 with components.konnectControlPlane = "unreachable"
```

Phase C acceptance — replay the original bug end-to-end:
```bash
bun run dev &
sleep 15
OLD_ID=$(curl -s http://localhost:9083/identity | jq -r .instanceId)
pkill -f mcp-server-konnect && sleep 2 && bun run --filter '@devops-agent/mcp-server-konnect' dev &
sleep 35  # one poll cycle
grep "MCP server replaced" agent.log
# Should show oldInstanceId=$OLD_ID, newInstanceId=<new>
```

Phase C boot-strict replay:
```bash
KAFKA_MCP_URL=http://localhost:9080 bun run --filter '@devops-agent/web' dev
# Should exit non-zero with McpRoleMismatchError naming KAFKA_MCP_URL
```

---

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Phase A merge introduces conflicts in Phase B's intended files | Low | All Phase B work targets per-MCP `index.ts` + transport files OR `packages/shared/src/transport/*`. Phase A also touched these but only added; Phase B will modify additively. Conflicts unlikely unless a reviewer asks for restructuring on #107. |
| Hoisting kafka's `readiness.ts` while leaving kafka's old behavior intact | Medium | Task B2 deletes `packages/mcp-server-kafka/src/transport/readiness.ts` in the SAME commit that imports from shared. Don't ship the migration in two commits. |
| `mock.module(...)` pollution like Task A3 hit | Medium | If you add new tests that need real `startAgentCoreProxy` or `createReadinessProbe`, put them in `packages/shared/src/__tests__/` (not `transport/__tests__/`) to escape the existing mock-using siblings. |
| Phase C agent changes break LangGraph type-checking | Medium | `mcp-bridge.ts` exports `getConnectedServers`, `getToolsForDataSource`, `DATASOURCE_TO_MCP_SERVER` consumed by `apps/web` and `packages/agent`. New exports (`getServerStates`, `MCP_SERVER_TO_ROLE`, `McpRoleMismatchError`, `mcpEvents`) are additive — should be safe. Re-export from `packages/agent/src/index.ts` if downstream needs them. |
| Boot-strict throw breaks lazy dev startup | High (intentional) | Per spec Q5: no escape hatch in v1. Error message must name the env var to fix. Document loudly in the Phase C PR description. |
| SSE event channel for `mcp_replaced` requires new endpoint | Low | Task C5's plan covers introducing `/api/events` if no general-purpose SSE bus exists. Frontend only logs to console in v1 — toast UI is out-of-scope. |
| Proxy `/ready` doubles AgentCore traffic | Medium | TTL cached at 30s; 2 extra `tools/list` calls/min per proxy. AgentCore's billable surface is `tools/call`, not `tools/list`. |

---

## Out of scope (do not expand)

- Cryptographic identity attestation (mTLS, signed `instanceId`, JWT)
- Multi-replica MCPs behind a load balancer
- Detecting tampered-but-cooperative servers that lie on `/identity`
- Cross-process boot-token persistence
- Hard-abort of in-flight tool calls on `replaced` — best-effort + SSE only
- `MCP_BOOT_LENIENT` escape hatch — v1 is strict-only
- Direct-mode aws-mcp / kafka-mcp variants — proxy roles hardcoded
- `mcp_replaced` toast UI — console-log only in v1
- WebSocket / SSE liveness for the SvelteKit dev server

---

## Files to modify (summary)

| File | Phase | Change |
|---|---|---|
| `packages/shared/src/transport/readiness.ts` | B1 | NEW (hoisted from kafka) |
| `packages/shared/src/transport/__tests__/readiness.test.ts` | B1 | NEW |
| `packages/mcp-server-kafka/src/transport/readiness.ts` | B2 | DELETE |
| `packages/mcp-server-kafka/src/index.ts` | B2 | Update import |
| `packages/mcp-server-{elastic,couchbase,konnect,gitlab,atlassian,aws}/src/index.ts` | B3-B8 | Wire `createReadinessProbe` per upstream |
| `packages/mcp-server-{elastic,couchbase,konnect,gitlab,atlassian,aws}/src/transport/http.ts` | B3-B8 | Register `/ready` route |
| `packages/shared/src/transport/proxy-readiness.ts` | B9 | NEW (SigV4 `tools/list` + sentinel) |
| `packages/shared/src/agentcore-proxy.ts` | B9 | Add `/ready` route |
| `packages/shared/src/transport/agentcore-proxy.ts` | B9 | Wire `createProxyReadinessProbe` |
| `scripts/sio780/check-ready.sh` | B10 | NEW |
| `packages/agent/src/mcp-bridge.ts` | C1-C5 | `McpRoleMismatchError`, `MCP_SERVER_TO_ROLE`, `probeServer`, boot-strict, `getServerStates`, `mcpEvents` |
| `packages/agent/src/__tests__/mcp-bridge.probe.test.ts` | C2 | NEW |
| `packages/agent/src/__tests__/mcp-bridge.boot-strict.test.ts` | C1, C3 | NEW |
| `apps/web/src/routes/api/datasources/+server.ts` | C4 | Add `states` field |
| `apps/web/src/routes/api/datasources/+server.test.ts` | C4 | NEW (or extend) |
| `apps/web/src/routes/api/events/+server.ts` | C5 | NEW (SSE channel) |
| `apps/web/src/routes/+page.svelte` (or layout) | C5 | EventSource subscriber |
| `apps/web/src/lib/components/DataSourceSelector.svelte` | C6 | Five-state switch |
| `apps/web/src/lib/components/DataSourceSelector.test.ts` | C6 | NEW |

---

## Related code references

- `packages/agent/src/mcp-bridge.ts:64-340` — connection map, polling, reconnect logic
- `packages/shared/src/bootstrap.ts:52-161` — SIO-779's unified bootstrap (Phase A extended this)
- `packages/shared/src/transport/agentcore-proxy.ts` — proxy transport helper (Phase A extended)
- `packages/shared/src/agentcore-proxy.ts:396-639` — SigV4 proxy core (Phase A added `/identity`; Phase B adds `/ready`)
- `packages/mcp-server-kafka/src/transport/readiness.ts` — reference implementation to hoist
- `packages/mcp-server-kafka/src/transport/http.ts:220-267` — `/ready` route wiring pattern
- `apps/web/src/routes/api/datasources/+server.ts` — dashboard endpoint
- `apps/web/src/lib/components/DataSourceSelector.svelte` — UI component

PR [#107](https://github.com/zx8086/devops-incident-analyzer/pull/107) — Phase A. Read the PR description for the design decisions captured during review.

---

## Memory references

Slugs in `/Users/Simon.Owusu@Tommy.com/.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/`:

- `reference_sio779_request_context_envelope` — pino mixin auto-stamps probe logs; no extra wiring needed
- `reference_sio779_proxy_mode_bootstrap` — `createMcpApplication({ mode: "proxy" })` precedent; identity wiring in proxy mirrors this pattern
- `reference_sio774_per_server_connect_timeouts` — kafka/aws need 35s connect timeouts; 8s probe budget (2s + 1s + 5s) fits comfortably
- `feedback_verbatim_plan_code_has_bugs` — always run biome before committing; Phase A caught two bugs this way
- `feedback_handoff_docs_main_branch` — handover docs commit to main directly (this rule is now in CLAUDE.md as of 2026-05-17)
- `reference_subagent_worktree_residue` — when the worktree is torn down, watch for stash residue
- `feedback_plan_authority_over_pattern` — when reviewer flags divergence from sibling patterns, point to the spec which deliberately specifies the divergence
- `feedback_never_create_linear_done` — never set SIO-780 to Done without explicit user approval after all three PRs merge
