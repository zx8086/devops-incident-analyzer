# HANDOFF 2026-08-07: SIO-1409 follow-on work (epic complete, four deferred threads)

- **Date**: 2026-08-07
- **Tracking ticket**: https://linear.app/siobytes/issue/SIO-1435 (planning/handover ticket -- Backlog; split each thread below into its own ticket before implementing)
- **Parent epic (COMPLETE)**: https://linear.app/siobytes/issue/SIO-1409 -- all child tickets SIO-1410 through SIO-1424 are Done. Nothing in this doc blocks the epic; this is entirely optional forward work.
- **Repo state**: `main` @ `b155a3f2`
- **Suggested branch**: pick per-thread once scoped (e.g. `simonowusupvh/sio-XXXX-<thread-name>`) -- do not use one branch for all four threads.

## TL;DR

The SIO-1409 "MCP 2026-07-28 adoption program" epic shipped end-to-end this session (5 PRs: #622, #623, #624, #625 unrelated/#626, plus #623's SIO-1431 sibling fix). Four pieces of real, discovered-but-unactioned work came out of it, each independent of the others:

1. Agent-side consumption of `structuredContent` -- blocked on an external dependency.
2. A live, reproducible `server/discover` routing bug in the v2 SDK pilot -- unresolved, not yet root-caused.
3. A known ergonomic regression in the v2 chokepoint/logging pattern (N wraps instead of 1) -- a design decision to make, not a bug.
4. Two deliberately out-of-scope future pilots (konnect MRTR, fleet-wide v2 migration) -- pure planning, no discovery done yet.

None of these are urgent. Pick up whichever is highest-value next; they do not depend on each other.

## Context -- how this ticket came to be

Session traced back through three original handovers (`HANDOFF-2026-08-07-SIO-1422.md`, `-SIO-1423.md`, `-SIO-1424.md`, all still in `experiments/` on `main`) written at the end of a prior session's "readiness phase." All three were executed this session, plus an incidental fifth ticket (SIO-1431) discovered mid-flight when CI broke on an unrelated pre-existing bug. The SIO-1424 v2 pilot (PR #626) is the most consequential source of new findings here -- it was explicitly scoped as a discovery-first pilot ("first executable step: inspect the installed v2 API surface... chokepoint/logging design is contingent on it"), and it surfaced real, live-verified gaps that the original plan doc (`~/.claude/plans/can-we-look-at-structured-crown.md`) could not have anticipated because it predates the v2 SDK's stable release.

## Where the bodies are buried

### Thread 1: agent-side structuredContent consumption (BLOCKED)

- `packages/agent/src/` -- the LangGraph agent that would need to read `ToolMessage.artifact`. Not investigated this session beyond confirming the blocker.
- Blocker: `@langchain/mcp-adapters` pins `@modelcontextprotocol/sdk@^1.26.0` (v1 only) in its own `package.json`. Verified via the SIO-1422 plan's own research (`dist/tools.js:311-341` routes `structuredContent` -> `ToolMessage.artifact`, `:454-460` routes `annotations` -> metadata never prompt) -- the plumbing exists, nothing reads the artifact field today.
- SIO-1422 (PR #622, merged, `structuredContent`/`outputSchema` wave 1 on 4 tools) is a prerequisite that's now satisfied -- the server side already emits `structuredContent`. This thread is purely about the client/agent side.
- **First step when picked up**: re-check `@langchain/mcp-adapters`'s npm changelog/`package.json` for v2 support before writing any code -- this may have shipped in the time since this handover was written.

### Thread 2: `server/discover` routing gap (UNRESOLVED, live-reproduced)

- `packages/mcp-server-couchbase/tests/server-v2-wire.test.ts:127` -- the `test.skip(...)` with the full investigation trail in its leading comment block. Read this first; it documents every combination tried.
- Live-reproduced findings (from this session, not hypothetical):
  ```
  $ curl ... server/discover (no headers, matching the initialize pattern)
  {"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"Method not found"}}
  ```
  Same result with `Mcp-Method: server/discover` header added. Both attempts against a running `packages/mcp-server-couchbase/src/index-v2.ts` server on port 9182.
- But: `McpServer`'s own `Protocol` class DOES have a working handler --
  ```
  $ bun -e 'import { McpServer } from "@modelcontextprotocol/server";
    const server = new McpServer({ name: "probe", version: "0" });
    console.log("has _ondiscover:", typeof server.server["_ondiscover"]);       // "function"
    server.server["assertCapabilityForMethod"]?.("server/discover");            // does NOT throw
  '
  ```
- Conclusion reached this session: the gap is in `createMcpHandler`'s HTTP routing layer (`@modelcontextprotocol/server`'s compiled `dist/createMcpHandler-*.mjs`), not in `McpServer`/`Protocol`'s method dispatch. Type declarations were read exhaustively (`node_modules/.bun/@modelcontextprotocol+server@2.0.0/.../dist/createMcpHandler-CLhGwQTn.d.mts`) but the actual routing PREDICATE (why `server/discover` specifically gets rejected before reaching `_ondiscover`) was never traced through the runtime `.mjs` bundle -- that's the next step, not repeated type-reading.
- The doc comment at `.d.mts:2438` is a live clue not yet followed up: *"lifecycle messages are bootstrap-pinned BY METHOD -- they self-identify their era (`initialize` IS the legacy handshake, `server/discover` IS the modern probe)"* -- suggests `server/discover` should route correctly by method name alone, which contradicts the observed 400/-32601. Worth minified-bundle tracing (`rg -n "discover" node_modules/.bun/@modelcontextprotocol+server@2.0.0/.../dist/createMcpHandler-*.mjs`) or, more reliably, filing a minimal repro issue against `modelcontextprotocol/typescript-sdk` upstream and asking directly.

### Thread 3: chokepoint/logging ergonomics (design decision, not a bug)

- `packages/mcp-server-couchbase/src/v2/tool-call-wrappers.ts` -- the full v2 rebuild, with an extensive header comment documenting the discovery-spike findings (no public dispatch-level hook in v2; `RegisteredTool.update({ callback })` is the only clean public seam, wraps once PER TOOL).
- `packages/shared/src/read-only-chokepoint.ts` / `packages/shared/src/tool-call-logging.ts` -- the v1 originals, both monkey-patching the still-private `_requestHandlers` Map, for comparison.
- The discovery-spike agent's full findings (not just the summary in the header comment) are worth re-reading if this thread is picked up -- they include the exact `RegisteredTool`/`ToolCallback` type signatures and the specific reasoning for ruling out the `_requestHandlers`-reach-in route for v2 (same private-API risk as v1, no improvement).
- **Decision needed**: (a) accept N-wraps-per-tool as the v2 idiom for any future fleet-wide migration (Thread 4), since 8 more servers migrating would each need this same pattern, or (b) file the gap upstream (`modelcontextprotocol/typescript-sdk`) requesting a `ServerOptions.middleware` or `registerTool(..., { middleware })` option before committing to (a) at scale.

### Thread 4: konnect MRTR pilot + fleet-wide v2 migration (pure planning)

- Original plan reference: `~/.claude/plans/can-we-look-at-structured-crown.md` (F2 section) -- this is a LOCAL Claude Code plan file, not committed to the repo; may not exist in a fresh environment. If missing, this thread has to be re-planned from scratch using this doc + the SIO-1424 PR as the only surviving context.
- konnect was rejected as the SIO-1424 pilot's server specifically because it's disabled today (no live verification path) -- re-confirm this is still true (`packages/mcp-server-konnect/` boot config, `KONNECT_ACCESS_TOKEN` etc.) before scoping a pilot there; if it's been re-enabled since, the original rejection reasoning may no longer apply.
- No code exists for either sub-thread. This is scoping/planning work, not implementation-ready.

## The fix (step-by-step)

There is no single fix here -- this is a scoping doc for four independent pieces of future work. When picking up ANY thread:

1. Re-read this doc's "Where the bodies are buried" section for that thread.
2. Verify the cited file:line references and live findings are still accurate (things may have changed since 2026-08-07).
3. File a dedicated Linear ticket for that thread alone (per SIO-1435's explicit instruction not to implement against the umbrella ticket directly).
4. Follow the project's standard branch-off-main / Linear-In-Progress / PR-ready-for-review / CodeRabbit-loop workflow.

## Verification

No verification block applies to this doc itself (no code changes). Per-thread verification commands will depend on what's implemented; at minimum, whichever package is touched should pass:

```bash
bun run typecheck && bun run lint && bun run test
```

For Thread 2 specifically, the existing skipped test is the reproduction harness -- un-skip it once a fix is found:

```bash
bun test packages/mcp-server-couchbase/tests/server-v2-wire.test.ts
```

## Files to modify

Not applicable -- no changes are proposed by this handover itself. Per-thread files are listed under "Where the bodies are buried" above.

## Workflow

Each thread, once picked up: branch off `main` -> Linear ticket In Progress -> implement -> PR ready-for-review citing SIO-1435 (or the thread's own dedicated ticket once created) -> CodeRabbit SHA-scoped loop per CLAUDE.md -> merge -> Done via GitHub integration (never set Done manually without user approval).

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| `@langchain/mcp-adapters` may have shipped v2 support since this was written | Medium (time-dependent) | Check its changelog/package.json FIRST, before assuming Thread 1 is still blocked |
| Thread 2's routing gap may be a known, already-fixed upstream bug in a newer v2 patch release | Medium | Check `@modelcontextprotocol/server`'s npm version history for anything newer than 2.0.0 before re-deriving a fix |
| Thread 3's decision affects Thread 4's cost estimate -- deciding (a) vs (b) first changes how expensive fleet-wide migration looks | Low-Med | Resolve Thread 3 before scoping Thread 4's fleet-wide migration sub-piece |
| konnect's disabled state (Thread 4) may have changed | Low | Re-verify live before assuming the SIO-1424 pilot's rejection reasoning still holds |
| The local plan file (`~/.claude/plans/can-we-look-at-structured-crown.md`) referenced by prior tickets is NOT in the repo | Certain if working from a fresh clone/environment | Treat this handover + the three merged PRs (#622, #624, #626) as the sole surviving source of truth; do not assume the plan file is recoverable |

## Out of scope

- Re-litigating any of the SIO-1409 epic's already-Done tickets (SIO-1410 through SIO-1424) -- that epic is closed.
- Implementing any of the four threads directly against SIO-1435 -- split first, per that ticket's own explicit instruction.
- Touching v1 code paths in any of the 9 MCP servers as part of these threads unless a specific thread's scope explicitly requires it (none currently do).

## Related code references

- `packages/shared/src/bootstrap-lifecycle.ts` -- the SIO-1423 extraction that Thread 3/4 work would continue building on (`bootstrap-v2.ts` already consumes it).
- `packages/shared/src/bootstrap-v2.ts` -- the v2 lifecycle wrapper (`createMcpApplicationV2`), reachable via `@devops-agent/shared/src/bootstrap-v2.ts` (the package's `./src/*` wildcard export, added this session -- see `packages/shared/package.json`'s `exports` field for the pattern any future v2 work should reuse rather than re-inventing).
- `packages/mcp-server-couchbase/src/index-v2.ts` -- the only existing live example of a v2 entrypoint; the template any Thread 4 fleet-wide migration would replicate per-server.
- `packages/mcp-server-couchbase/src/server-v2.ts` -- the only existing live example of v2 tool registration + the chokepoint/logging composition call site.

## Memory references

`project_mcp_2026_spec_adoption_sio1409` (now describes a COMPLETE epic, not in-progress), `reference_sio1410_sdk130_zod_error_format_regression`, `reference_bun_install_rewrites_root_catalog` (relevant if any future thread adds more npm dependencies).
