# Knowledge Graph MCP Server (SIO-967)

- Date: 2026-06-19
- Project: [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)
- Linear: [SIO-967](https://linear.app/siobytes/issue/SIO-967) (builds on [SIO-965](https://linear.app/siobytes/issue/SIO-965), [SIO-966](https://linear.app/siobytes/issue/SIO-966); foundation [SIO-850](https://linear.app/siobytes/issue/SIO-850), [SIO-954](https://linear.app/siobytes/issue/SIO-954))
- Status: Design (built + wired as a prototype; scope widened from investigation per owner decision)

## Context

[SIO-965](https://linear.app/siobytes/issue/SIO-965) made the knowledge graph and Agent Memory data joinable; [SIO-966](https://linear.app/siobytes/issue/SIO-966) made the graph agent-callable — but via **bespoke in-process LangChain tools** (`packages/agent/src/iac/local-tools.ts`, appended to `infoTools()`), not the standard MCP surface every other datasource uses through `MultiServerMCPClient`. SIO-967 asked whether to replace that with a real MCP server, whether to adopt upstream `LadybugDB/mcp-server-ladybug`, and whether to expose raw Cypher.

The ticket was scoped investigation-only; the owner widened it to a **working prototype, built and wired**, while keeping the gating concurrency spike. This doc records the spike verdict, the build-vs-adopt decision, the transport architecture, the tool surface, and the SIO-966 retirement — all of which are now implemented on branch `sio-967-kg-mcp`.

## Decisions (locked)

1. **Build our own, not adopt.** Upstream `mcp-server-ladybug` is Python, exposes a single `query` tool of **arbitrary Cypher with no read-only enforcement**, and is nascent (v0.1.0, 8 commits, MIT). It cannot reuse our tested TypeScript `reader.ts` curated functions and offers no guardrails. We built `packages/mcp-server-knowledge-graph` on the shared `createMcpApplication` bootstrap, wrapping our readers.

2. **In-process transport (the gating verdict).** A spike proved embedded lbug takes an **exclusive OS file lock**: a second process opening the same `.data/knowledge-graph` path fails with `Could not set lock on file` — for a reader *or* a writer. The web/agent process already opens the graph in ~6 pipeline nodes (`recordIacEntities`/`recordIacOutcome`/`graphEnrichIac` + incident-side `recordGraphEntities`/`graphEnrich`) plus a session warmer, across both agents. So a **standalone KG MCP process is impossible** while the agent runs. The server therefore runs **in-process** in the web app (a `Bun.serve` on `127.0.0.1:9087`), and its tools reuse the **same-process `getGraphStore()` singleton** — the one lock holder. It is still reached over localhost HTTP, so `MultiServerMCPClient`, boot-strict `/identity`, and health polling are unchanged from every other server. (memory: `reference_lbug_exclusive_file_lock`)

3. **Curated surface ships; raw Cypher is env-gated and read-only.** Four curated `kg_*` tools (one per reader) are always registered — injection-safe, all values bound as params. A `kg_run_cypher` tool is registered **only when `KG_MCP_ALLOW_CYPHER=true`** (default off); it runs a pure read-only guard that rejects any write/DDL keyword (`CREATE/MERGE/SET/DELETE/DETACH/REMOVE/DROP/ALTER/COPY/CALL/...`) after stripping comments and string literals, rejects multi-statement payloads, and binds `$params`. **Open go/no-go: whether to default `KG_MCP_ALLOW_CYPHER` on.** Recommendation: keep it off in production; the curated tools cover the known questions and avoid the lbug binder footguns (vars don't cross two MATCH clauses; ORDER BY after RETURN DISTINCT must use the projected alias).

4. **Memory stays REST, not MCP.** Agent Memory (`packages/shared/src/agent-memory.ts`) is already non-LLM infrastructure; the agent-memory backend spec explicitly says "no new MCP server." The SIO-966 `search_memory` tool stays **local**. Only the graph is MCP-ified.

5. **SIO-966 KG local tool retired.** `infoTools()` now sources the `kg_*` tools from the MCP surface (`getToolsForDataSource("knowledge-graph")`) and keeps `search_memory` local. `createQueryKnowledgeGraphTool` and its handler were deleted from `local-tools.ts`; its unit coverage moved to the new package against the curated tools.

## Architecture

```
apps/web (single process)
  agent.ts (module load)
    if KNOWLEDGE_GRAPH_ENABLED:
      startKnowledgeGraphServer()  -> Bun.serve on 127.0.0.1:9087  (createMcpApplication, role "knowledge-graph-mcp")
        tools -> getGraphStore()  ── the ONE lbug lock holder, shared with the pipeline's record* nodes
    getMcpConfig().knowledgeGraphUrl = http://127.0.0.1:9087

  ensureMcpConnected() -> createMcpClient()
    MultiServerMCPClient { "knowledge-graph-mcp": http://127.0.0.1:9087/mcp }  (same path as every datasource)
       -> boot-strict /identity check (role "knowledge-graph-mcp")  -> health polling

  elastic-iac read path:
    infoTools() = [elastic reads] + getToolsForDataSource("knowledge-graph") [kg_*] + search_memory (local)
```

Why a loopback HTTP hop instead of a direct function call: it keeps the KG on the **identical** rails as the other seven datasources (one `MultiServerMCPClient` registration, identity/health/role machinery, action-driven selection) with zero special-casing in the bridge. The in-process constraint is satisfied purely by *where* the `Bun.serve` runs.

## Components

### `packages/mcp-server-knowledge-graph` (new)
- `config.ts` — Zod config (no `.default()`): `KNOWLEDGE_GRAPH_MCP_{TRANSPORT,PORT=9087,HOST,PATH}`, `KNOWLEDGE_GRAPH_PATH`, `KNOWLEDGE_GRAPH_ENABLED`, `KG_MCP_ALLOW_CYPHER`.
- `tools/curated.ts` — `registerCuratedTools(server)`: `kg_deployments_running_stack`, `kg_stacks_using_module`, `kg_stack_instance_history`, `kg_deployment_history`. Each resolves the in-process store and soft-fails to a friendly string when KG is disabled/unavailable.
- `tools/cypher.ts` — `registerCypherTool(server)` + the pure, exported `validateReadOnlyCypher(cypher)` guard. Registered only when `allowCypher`.
- `server.ts` — `createServer(config)`: curated always; cypher when `config.allowCypher`.
- `transport.ts` — copied from `mcp-server-elastic-iac`: stateless streamable-HTTP `/mcp` + `/health` + `/identity` + `/ready`, or stdio.
- `index.ts` — `startKnowledgeGraphServer()` (exported for in-process mount) wrapping `createMcpApplication<Config>({ role: "knowledge-graph-mcp", ... })`, plus an `import.meta.main` standalone entry (only safe when no agent holds the graph). **Never calls native `db.close()`** — reuses `LadybugStore.close()`'s deliberate no-op.

### Wiring (existing packages)
- `packages/shared/src/transport/identity.ts` — new `McpRole` member `"knowledge-graph-mcp"`.
- `packages/agent/src/mcp-bridge.ts` — `McpClientConfig.knowledgeGraphUrl`; serverEntries registration; `DATASOURCE_TO_MCP_SERVER["knowledge-graph"]`; `MCP_SERVER_TO_ROLE["knowledge-graph-mcp"]`.
- `packages/agent/src/iac/nodes.ts` — `infoTools()` swaps the local KG tool for `getToolsForDataSource("knowledge-graph")`.
- `packages/agent/src/iac/local-tools.ts` — KG tool + handler + schema deleted; `search_memory` kept.
- `apps/web/src/lib/server/agent.ts` — in-process `startKnowledgeGraphServer()` at module load (gated on `KNOWLEDGE_GRAPH_ENABLED`, best-effort), `getMcpConfig().knowledgeGraphUrl`. New `@devops-agent/mcp-server-knowledge-graph` workspace dep.
- `agents/elastic-iac/tools/elastic-iac.yaml` — `kg_*` pattern + a `query_context` action.
- `CLAUDE.md` — port 9087.

## Verification (all run, green on this branch)

```bash
bun run typecheck                                          # 0 errors
bun run lint                                               # clean
bun run --filter @devops-agent/mcp-server-knowledge-graph test   # 23 pass / 0 fail (curated round-trip + cypher guard)
bun run --filter @devops-agent/agent test                 # 1235 pass / 0 fail / 25 skip
bun run --filter @devops-agent/shared test                # 347 pass / 0 fail
```

Live HTTP round-trip against the real lbug engine (seeded scratch graph, server on :9087, MCP client over Streamable HTTP):
- `tools/list` -> 5 tools (4 curated + `kg_run_cypher` with `KG_MCP_ALLOW_CYPHER=true`)
- `kg_deployments_running_stack {stack:"slos"}` -> "Deployments running the slos stack: eu-cld, us-cld."
- `kg_stacks_using_module {module:"slo"}` -> "Stacks using the slo module: slos."
- `kg_run_cypher` read -> rows; `kg_run_cypher` with `CREATE` -> **rejected** by the read-only guard.

**lbug test gotcha:** `bun run --filter @devops-agent/knowledge-graph test` exits 133 (SIGTRAP, no summary) on a machine where lbug is installed — the `ladybug.integration.test.ts` real-engine suite hits the SIO-954 teardown finalizer crash. The tests PASS (confirm with `bun test <file> -t "<name>"`); CI stays green because lbug is absent there. (memory: `reference_lbug_exclusive_file_lock`, `reference_lbug_cypher_and_teardown_gotchas`)

## Files

| File | Change |
|---|---|
| `packages/mcp-server-knowledge-graph/**` | NEW package (config/server/transport/index + curated & cypher tools + tests) |
| `packages/shared/src/transport/identity.ts` | `McpRole += "knowledge-graph-mcp"` |
| `packages/agent/src/mcp-bridge.ts` | config field + serverEntries + datasource/role maps |
| `packages/agent/src/iac/nodes.ts` | `infoTools()` sources kg_* from MCP |
| `packages/agent/src/iac/local-tools.ts` | retire `createQueryKnowledgeGraphTool` |
| `packages/agent/src/iac/{local-tools,info-local-tools}.test.ts`, `__tests__/mcp-bridge.boot-strict.test.ts` | updated for the swap + role map |
| `apps/web/{package.json, src/lib/server/agent.ts}` | dep + in-process mount + config |
| `agents/elastic-iac/tools/elastic-iac.yaml` | kg_* pattern + query_context action |
| `CLAUDE.md` | port 9087 |

## Go / no-go + effort

**Go.** The prototype is built, wired, tested, and proven end-to-end against the real engine. Remaining hardening before treating it as production (est. ~0.5–1 day): (a) decide the `KG_MCP_ALLOW_CYPHER` production default (recommend off); (b) optionally extend the same surface to incident-analyzer's incident-side graph; (c) add a readiness gate so the bridge's first connect waits for the in-process `Bun.serve` to bind (today a transient miss self-heals via health-poll reconnect); (d) confirm the AgentCore deployment path mounts the in-process server the same way the local web app does.

## Out of scope

- MCP-ifying agent memory (stays REST).
- incident-analyzer's incident-side graph-enrich (elastic-iac only this pass).
- The Neo4j store port ([SIO-850](https://linear.app/siobytes/issue/SIO-850) future) — note that a Neo4j backend would *remove* the exclusive-lock constraint and re-open the standalone-process option.

## Memory references

- `reference_lbug_exclusive_file_lock` — the gating spike verdict (exclusive lock) + the integration-test SIGTRAP nuance.
- `reference_lbug_cypher_and_teardown_gotchas` — binder quirks + teardown segfault + how to run the tests.
- `reference_elastic_iac_repo_three_layer_structure` — seed expectations.
- `reference_mock_pollution_own_in_beforeeach` — why `info-local-tools.test.ts` spreads the real mcp-bridge module.
- `project_deployment_target_agentcore` — hosting target (relevant to go/no-go item d).
