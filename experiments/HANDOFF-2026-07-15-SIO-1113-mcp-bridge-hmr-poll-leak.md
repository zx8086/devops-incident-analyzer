# HANDOFF: MCP bridge health poll leaks across Vite HMR (reconnect loop + "Vite module runner has been closed")

- **Date**: 2026-07-15
- **Ticket**: [SIO-1113](https://linear.app/siobytes/issue/SIO-1113/mcp-bridge-health-poll-leaks-across-vite-hmr-reconnect-loop-vite)
- **Parent/related**: SIO-780/SIO-782 (identity + readiness probing), SIO-906 (`mcp_replaced` SSE), SIO-1111 (atlassian readiness -- merged PR #379, unrelated mechanism but same log neighborhood)
- **Repo state**: `main` @ `418bbca` (SIO-1110/SIO-1111 squash merge)
- **Suggested branch**: `simonowusupvh/sio-1113-mcp-bridge-health-poll-leaks-across-vite-hmr-reconnect-loop`

## TL;DR

The server-side MCP health-poll `setInterval` is never cleared when Vite disposes a module graph (HMR). After a reload, the OLD module instance's poll loop keeps firing: its dynamic `import("@langchain/mcp-adapters")` rejects with "Vite module runner has been closed", and its module-scope `expectedIdentity` map stays stale, so the same server replacement is re-detected every 30s cycle. Observed 2026-07-15 16:07 after restarting atlassian-mcp: the same old->new instanceId pair logged "replaced" twice 26s apart, second reconnect failing. Success = one replace/reconnect per real server restart, zero "module runner has been closed" errors, no stacked poll loops across HMR reloads. Dev-only (AgentCore has no HMR), but it spams reconnects and `mcp_replaced` SSE events and can race a live poller.

## Context -- how this ticket came to be

Surfaced while restarting MCP servers to pick up the merged PR #379 fixes (SIO-1110/SIO-1111). The atlassian server restart produced a correct replace+reconnect, then a duplicate replace 26s later that failed with the Vite runner error. Investigation confirmed a general lifecycle gap, not an atlassian-specific issue.

## Where the bodies are buried

All in `packages/agent/src/mcp-bridge.ts` unless noted.

**Poll start, never stopped** -- `startHealthPolling()` at `mcp-bridge.ts:686-694` sets the module-scope `healthPollTimer = setInterval(pollServerHealth, HEALTH_POLL_INTERVAL_MS)` (30s, `:95`); kicked off once from `createMcpClient` at `:330`. `stopHealthPolling()` exists at `:696-702` and is re-exported from `packages/agent/src/index.ts:58` but **has zero server-side callers** (grep confirms: definition + re-export only). There is **no `import.meta.hot` usage anywhere in the repo**.

**The stale identity map** -- `mcp-bridge.ts:413`:

```ts
const expectedIdentity = new Map<string, IdentityCard>();
```

Writes: boot (`:326`), first-probe seed (`:464-465`), and after a successful replaced-reconnect (`:653`, inside `pollServerHealth`). Replace detection in `probeServer` at `:461-480` compares `card.instanceId !== expected.instanceId` -> `{ state: "replaced", reason: "instanceId changed" }` -- exactly the observed log.

**The reconnect path that hits the Vite runner** -- `reconnectServer` at `:524-569` does:

```ts
const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");
```

at `:526` (same lazy import exists in `createMcpClient` at `:186`). When invoked from an HMR-orphaned module instance, the closed Vite SSR module runner rejects this import; the catch at `:564-568` logs the observed `Failed to reconnect MCP server ... "Vite module runner has been closed."` and swallows.

**Why the same replacement fires repeatedly**: each HMR reload creates a fresh module instance (fresh `expectedIdentity`, fresh interval) while the old instance's interval survives. The orphaned instance can neither reconnect (dead runner) nor converge its identity map reliably, so it keeps re-detecting `ca6b3d4f -> 89b1aeea` and re-emitting `mcp_replaced` (`:654-672`, consumed by `apps/web/src/routes/api/events/+server.ts` and `apps/web/src/routes/+page.svelte:99-102`).

**Prior art for the guard pattern** -- both cron modules already guard against HMR double-registration (but do not dispose):

```ts
// apps/web/src/lib/server/kg-topology-cron.ts:54
if (started) return; // module load can run more than once under HMR; register the job once
```

(same at `apps/web/src/lib/server/iac-reconcile-cron.ts:48`).

**Do not conflate**: `apps/web/src/lib/stores/agent.svelte.ts:408-449` has a same-named *browser-side* `startHealthPolling`/`stopHealthPolling` (pill UI polling `/api/datasources`, cleaned up via `onDestroy`). Unrelated.

## The fix (step-by-step)

1. **`packages/agent/src/mcp-bridge.ts`** -- make the poll loop a process-wide singleton so stacked module instances cannot each own a timer. Key the guard on `globalThis` (module-scope state does not survive as a singleton across Vite module graphs):

```ts
const HEALTH_POLL_KEY = Symbol.for("devops-agent.mcp-bridge.healthPollTimer");
export function startHealthPolling(): void {
	const g = globalThis as Record<symbol, unknown>;
	if (g[HEALTH_POLL_KEY]) return; // SIO-1113: HMR reload must not stack poll loops
	const timer = setInterval(pollServerHealth, HEALTH_POLL_INTERVAL_MS);
	g[HEALTH_POLL_KEY] = timer;
	...
}
export function stopHealthPolling(): void {
	const g = globalThis as Record<symbol, unknown>;
	const timer = g[HEALTH_POLL_KEY];
	if (timer) clearInterval(timer as ReturnType<typeof setInterval>);
	g[HEALTH_POLL_KEY] = undefined;
	...
}
```

   Preserve the existing logging. NOTE: `pollServerHealth` captured by the *old* instance's closure still references old-module state; the singleton guard prevents the *new* instance from stacking a second timer, and step 2 kills the old one.

2. **`apps/web/src/lib/server/agent.ts`** -- add HMR dispose where the bridge lifecycle is owned (near the `mcpReady` declaration at `:161`):

```ts
// SIO-1113: Vite HMR disposes this module graph; the bridge's poll interval and
// the memoized connection promise must not outlive it (orphaned loops fail with
// "Vite module runner has been closed" and re-detect replacements forever).
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		stopHealthPolling();
		mcpReady = null;
	});
}
```

   Import `stopHealthPolling` from `@devops-agent/agent` (already exported). Verify `import.meta.hot` types are available under SvelteKit server TS config (`vite/client` types); if not, guard with `typeof import.meta.hot !== "undefined"`.

3. **Optional hardening (same ticket if cheap)**: in `pollServerHealth`'s replaced branch (`:639-673`), update `expectedIdentity` even when `reconnectServer` failed (e.g. set it from the probe's `result.card` before attempting reconnect) so a transient reconnect failure cannot re-fire the same replacement forever on a live instance. Weigh against: a failed reconnect leaves stale tools under a new id -- decide and document.

4. **Tests** (`packages/agent/src/mcp-bridge.test.ts` -- currently NO coverage of poll/replace/reconnect):
   - `startHealthPolling` twice -> one timer (assert via the `globalThis` key; save/restore in beforeEach).
   - `stopHealthPolling` clears the key and the interval.
   - If feasible with the existing `_resetExpectedIdentityForTest` seam (`:513-516`): replaced-path updates `expectedIdentity` after successful reconnect (mock `reconnectServer` dependencies or extract the update for unit testing).

## Verification

```bash
cd <repo> && bun run typecheck && bun run lint && bun test packages/agent/src/mcp-bridge.test.ts
```

Manual (the real proof):
1. `bun run --filter @devops-agent/web dev`; open the app so the bridge connects.
2. Touch a server-side file to force an HMR reload of the module graph (e.g. edit a comment in `apps/web/src/lib/server/agent.ts`), twice.
3. Restart the atlassian MCP server (new instanceId).
4. Expected: exactly ONE `MCP server replaced, reconnecting` + `MCP server reconnected with tools` pair; no repeat with the same old->new ids on later cycles; zero `Vite module runner has been closed` errors.

## Files to modify

| File | Change |
|---|---|
| `packages/agent/src/mcp-bridge.ts` | globalThis-keyed singleton in start/stopHealthPolling; optional expectedIdentity hardening |
| `apps/web/src/lib/server/agent.ts` | `import.meta.hot.dispose` -> `stopHealthPolling()` + `mcpReady = null` |
| `packages/agent/src/mcp-bridge.test.ts` | new coverage (singleton, stop, replaced-path id update) |

## Workflow

Branch off `main`; Linear SIO-1113 Todo -> In Progress -> In Review (PR, ready not draft) -> Done only with user approval. Commit format `SIO-1113: message` via HEREDOC.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| `import.meta.hot` undefined in prod build path | High (expected) | Optional-chain guard; prod is unaffected either way |
| globalThis singleton hides a legitimate second poller in tests | Low | Test seam: reset the symbol key in beforeEach |
| Old instance's timer fires once more between dispose and clear | Low | clearInterval in dispose is synchronous; acceptable |
| Step 3 (identity update on failed reconnect) changes replace semantics | Medium | Keep optional; document decision in code comment |

## Out of scope

- The `mcpEvents` SSE listener leak across HMR in `apps/web/src/routes/api/events/+server.ts` (same class, different surface -- ticket separately if observed).
- kafka/aws AgentCore reconnect behavior; atlassian readiness (SIO-1111, merged).

## Related code references

- Replace detection: `packages/agent/src/mcp-bridge.ts:461-480`; replaced branch `:639-673`; reconnect `:524-569`.
- Existing HMR guards to mirror: `apps/web/src/lib/server/kg-topology-cron.ts:54`, `apps/web/src/lib/server/iac-reconcile-cron.ts:48`.
- Browser-side same-named poller (do not touch): `apps/web/src/lib/stores/agent.svelte.ts:408-449`.

## Memory references

- `reference_web_lost_logging_is_orphaned_dev_server` (orphaned dev-server class)
- `reference_bun_hot_does_not_reresolve_modules`
- `reference_kg_inprocess_vite_ssr_bootstrap` (Vite SSR lifecycle gotchas)
- `reference_sio1110_1111_budget_gate_and_atlassian_freshness` (adjacent, merged work)
