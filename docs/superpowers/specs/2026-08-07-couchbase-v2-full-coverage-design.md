# Couchbase v2 full-coverage pilot deepening

Date: 2026-08-07
Origin: scoping session for [SIO-1439](https://linear.app/siobytes/issue/SIO-1439)'s "fleet-wide MCP SDK v2 migration" sub-thread. First real increment of that program, tracked as its own new ticket (created after this spec, see below) -- SIO-1439 stays the long-term fleet umbrella.

## Problem

[SIO-1424](https://linear.app/siobytes/issue/SIO-1424) (merged) piloted the MCP SDK v2 protocol on `mcp-server-couchbase`, proving the mechanism works: side-by-side v1/v2 ports, `createMcpApplicationV2`, the per-tool chokepoint/logging wrap seam (`RegisteredTool.update({ callback })`, since v2 has no public dispatch-level hook). But the pilot is deliberately minimal -- it registers exactly **one tool** (`capella_ping`) out of couchbase's real ~39-tool v1 surface, and never touches v2's resource (`registerResource`) or prompt (`registerPrompt`) registration paths at all.

This means the pattern has only been proven at 1x scale, on the simplest possible tool (no input beyond an empty object, no resources, no prompts). Before scoping any further server's v2 port, or judging whether "fleet-wide" is worth pursuing at all, this gap needs closing on the server that's already mid-migration -- not a new one.

## Goal

Readiness, not traffic. This does **not** change which port the agent talks to (`COUCHBASE_MCP_URL` stays pointed at v1, port 9082) and does **not** depend on `@langchain/mcp-adapters` shipping v2 client support (still pinned to v1 SDK as of the SIO-1437 investigation this session). The point is: when that client-side blocker clears, the fleet is ready to flip -- not scrambling, and not flipping on a pattern only ever tested at 1-tool scale.

Success = couchbase's v2 entrypoint (`server-v2.ts`) covers the same tool/resource/prompt surface as its v1 entrypoint (`server.ts`), so the next server's v2 port (whichever one is picked later) has real precedent to work from for every registration shape v2 supports -- not just the tool one.

## Non-goal: any other server

This spec is scoped to couchbase only. Picking the next server after this one, and the eventual "cover all 9" question, are separate decisions for whenever this increment's learnings are in. Do not fold aws/kafka/elastic/etc. into this ticket.

## Non-goal: closing the client-side blocker

`@langchain/mcp-adapters` v2 support is out of scope here -- that's [SIO-1437](https://linear.app/siobytes/issue/SIO-1437)'s territory (already resolved for the structuredContent-specific gap; the SDK-version blocker itself is a separate, unresolved, external dependency). This increment produces server-side readiness only.

## Design

### 1. Port the remaining tools

`packages/mcp-server-couchbase/src/__tests__/tools-list-snapshot.json` has exactly **39** entries (verified this session) -- so this is 38 more tools beyond the already-ported `capella_ping`. Note: this session's own live `bun run dev` output showed `"toolCount":36` at v1 boot, 3 fewer than the static snapshot -- some tools are conditionally registered (e.g. gated by config, per the pattern other servers use for feature-tiered tools). Confirm the exact live-registered set at implementation time rather than assuming the static snapshot count is what actually needs porting; a tool that's conditionally absent in the live v1 process doesn't need a v2 port until/unless that condition is also true for v2.

`packages/mcp-server-couchbase/src/server-v2.ts:40-83` currently registers one tool (`capella_ping`) inline inside `buildServerFactory`. V1's tool surface lives across `packages/mcp-server-couchbase/src/tools/` (config-style `registerTool` calls per the SIO-1409 readiness sweep -- confirmed all 9 servers are on `registerTool` config style, so v1's shape is already close to v2's). For each v1 tool:

- Read the v1 registration (name, description, input schema, annotations, handler).
- Register the v2 equivalent via `server.registerTool(name, config, handler)` inside `buildServerFactory`, following `capella_ping`'s existing pattern (`server-v2.ts:46-72`).
- Add the tool's `RegisteredTool` to the `tools` Map (`server-v2.ts:44`) so it picks up the chokepoint/logging wrap via the existing `installReadOnlyChokepointV2`/`installToolCallLoggingV2` calls at the bottom of `buildServerFactory` (`server-v2.ts:78-79`) -- no changes needed to `tool-call-wrappers.ts` itself, it already iterates the whole `Map`.
- v1 and v2 tool handlers should behave identically for the same input -- this is a protocol-surface port, not a rewrite. Where a v1 handler depends on shared infrastructure (e.g. `connectionManager`), reuse the same singleton `capella_ping` already reuses (`server-v2.ts:16`, confirmed safe because v1/v2 run as genuinely separate processes).

Do all live-registered tools in this one increment, not a partial subset -- the point is proving full-surface coverage, and a partial port would leave the same "how does this behave at real scale" question half-answered.

### 2. Port resources and prompt

V1's 7 resources (`packages/mcp-server-couchbase/src/resources/{document,documentation,databaseStructure,query,schema,playbook}Resource.ts`, plus `index.ts`/`resource-registry.ts` wiring) all call `server.registerResource(name, uriOrTemplate, config, callback)` -- confirmed via the installed v2 SDK's type declarations (`node_modules/.bun/@modelcontextprotocol+server@2.0.0/.../createMcpHandler-CLhGwQTn.d.mts:3264-3268`) that v2's `registerResource` signature is the same shape: a string URI for static resources, a `ResourceTemplate` for dynamic ones (couchbase's `documentResource.ts`/`queryResource.ts`/`schemaResource.ts` use templates; the rest use static URIs), config object, callback. This should be a largely mechanical port, same risk profile as the tools.

The 1 prompt (`sqlppQueryGenerator.ts`, per `CLAUDE.md`) uses `server.registerPrompt`, also confirmed same-shape in v2 (`argsSchema` instead of v1's raw shape param, if v1 used the deprecated raw-shape form -- check at port time and wrap with `z.object()` if so, per the v2 type declaration's deprecation note).

Resources and prompts are **not** currently wrapped by the chokepoint/logging pattern in v1 (that pattern is tools-only, per `read-only-chokepoint.ts`/`tool-call-logging.ts`'s scope) -- no new wrapping infrastructure needed for this step, just registration.

### 3. Test coverage

Extend `packages/mcp-server-couchbase/tests/server-v2-wire.test.ts` (currently 4 tests: initialize handshake, stateless tools/call, server/discover, v1-text-equivalence -- all `capella_ping`-only) with:

- A representative sample of the newly-ported tools (not all 38 -- pick 3-5 spanning different input shapes: a no-arg tool, a tool with required params, a tool with optional params) exercised through the same wire-level `fetch()` pattern already established.
- One resource read (static URI) and one resource read (template/dynamic URI), proving both `registerResource` overloads work end-to-end.
- One prompt invocation.
- Keep the existing `capella_ping` tests as-is; this extends coverage, doesn't replace it.

Full per-tool wire tests for every tool would be disproportionate test-maintenance cost for a readiness increment -- the sample proves the pattern, not each tool's business logic (which v1's existing test suite already covers).

### 4. What "done" looks like

- `packages/mcp-server-couchbase/src/server-v2.ts` registers the same tool/resource/prompt names as v1's `server.ts` (a simple count/name-diff check, not byte-for-byte behavioral parity testing beyond what step 3 samples).
- All new + existing v2 wire tests pass.
- `bun run --filter '@devops-agent/mcp-server-couchbase' typecheck && test` clean.
- No change to `index.ts` (v1), `COUCHBASE_MCP_URL`, or any other server package.
- A short write-up (in the PR description, not a new doc) of anything that DIDN'T port mechanically -- i.e. any tool/resource whose v1→v2 translation needed more than a signature copy, since that's exactly the kind of learning this increment exists to surface for whichever server comes next.

## Verification

```bash
bun run --filter '@devops-agent/mcp-server-couchbase' typecheck
bun run --filter '@devops-agent/mcp-server-couchbase' test
bun run lint
```

Plus the three-era curl matrix from the original SIO-1424 pilot (initialize handshake, stateless tools/call, server/discover) re-run against a couple of the newly-ported tools specifically, not just `capella_ping` -- confirms the dual-era protocol behavior (proven for 1 tool) holds for tools with real input schemas too.
