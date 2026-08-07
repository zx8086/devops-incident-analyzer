# Couchbase v2 Full-Coverage Pilot Deepening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port every v1 tool, resource, and prompt couchbase's MCP server registers into its existing v2 pilot entrypoint (`server-v2.ts`), so the v2 pattern is proven at real scale (39 tools, 11 resources, 1 prompt) instead of the pilot's current 1-tool (`capella_ping`) proof.

**Architecture:** Split `server-v2.ts`'s inline tool registration into per-group files mirroring v1's own `tools/`, `resources/`, `prompts/` directory structure (v1 has 39 tools across ~38 files; cramming all of that into one factory function would be unreviewable). Each new file exports a `register*(server, tools)` function that registers its tools/resources against the v2 `McpServer` and (for tools) adds each `RegisteredTool` to the shared `tools` Map so the existing `installReadOnlyChokepointV2`/`installToolCallLoggingV2` wrap picks it up automatically -- no changes needed to `v2/tool-call-wrappers.ts` itself.

**Tech Stack:** TypeScript (strict mode), `@modelcontextprotocol/server@2.0.0`, Zod, Bun test.

## Global Constraints

- TypeScript strict mode, never use `any` (biome `noExplicitAny: "error"`).
- Named exports preferred.
- No emojis in code, logs, comments, or output.
- File headers: single-line relative path only.
- Comments: only for non-obvious "why" -- do not restate what code already says.
- Run `bun run typecheck`, `bun run lint`, and the relevant `bun test` after every change -- matching this repo's CLAUDE.md testing convention. Task steps below cite the package-scoped `bun run --filter '@devops-agent/mcp-server-couchbase' typecheck && bun run --filter '@devops-agent/mcp-server-couchbase' test` shorthand for speed during iteration, but `bun run lint` must also be run (repo-wide or package-scoped) before considering a task's verification complete.
- **v1 is untouched.** No task in this plan modifies `packages/mcp-server-couchbase/src/server.ts`, `src/index.ts`, `src/tools/*.ts` (v1 originals), `src/resources/*.ts` (v1 originals), or `src/prompts/sqlppQueryGenerator.ts` (v1 original) -- these are read-only references for porting, never edited. `COUCHBASE_MCP_URL` (agent-facing) stays pointed at v1, port 9082.
- Every ported tool/resource/prompt's **behavior** for the same input must match its v1 counterpart -- this is a protocol-surface port, not a rewrite. Where a v1 handler has a business-logic quirk (e.g. a specific error-handling branch), port it faithfully; do not "clean up" behavior as part of this migration.
- v1's `ResourceRegistry`/`readResourceByUri` (`packages/mcp-server-couchbase/src/resources/resource-registry.ts`) is **out of scope** -- it's v1-internal plumbing for an in-process fallback read path (`server.ts:126-127`), not part of the actual MCP `resources/read` protocol handler (which is the SDK's own dispatch via each `registerResource` callback). Do not port it or attempt to replicate its behavior in v2.
- Chokepoint/logging wraps tools only (matches v1: `read-only-chokepoint.ts`/`tool-call-logging.ts` are tools-only in v1 too). Resources and the prompt are registered without any wrap, matching v1 exactly.

---

## File Structure

**Reference (v1, read-only for this plan):**
- `packages/mcp-server-couchbase/src/tools/{9 core files}.ts`, `tools/index.ts` (the `toolRegistry` map)
- `packages/mcp-server-couchbase/src/tools/queryAnalysis/{21 files}.ts`, `queryAnalysis/index.ts`
- `packages/mcp-server-couchbase/src/resources/{6 files}.ts`
- `packages/mcp-server-couchbase/src/prompts/sqlppQueryGenerator.ts`
- `packages/mcp-server-couchbase/src/server.ts` (v1's `capella_echo` inline registration, `registerAll`/`registerAllResources` call sites)
- `packages/mcp-server-couchbase/src/lib/pingHandler.ts` (v1's `capella_ping` -- already has a v2 equivalent inline in `server-v2.ts`, used here only as the "same handler behavior" reference)

**New (v2):**
- `packages/mcp-server-couchbase/src/v2/tools/core.ts` -- Task 1, 9 tools
- `packages/mcp-server-couchbase/src/v2/tools/documentation.ts` -- Task 2, 5 tools
- `packages/mcp-server-couchbase/src/v2/tools/playbooks.ts` -- Task 3, 2 tools
- `packages/mcp-server-couchbase/src/v2/tools/query-analysis-a.ts` -- Task 4, 11 tools (first half, alphabetical)
- `packages/mcp-server-couchbase/src/v2/tools/query-analysis-b.ts` -- Task 5, 10 tools (second half, alphabetical)
- `packages/mcp-server-couchbase/src/v2/tools/echo.ts` -- Task 6, 1 tool (`capella_echo`, currently inline in v1's `server.ts`)
- `packages/mcp-server-couchbase/src/v2/resources.ts` -- Task 7, all 11 resources (8 static + 3 templates -- small enough for one file, unlike tools)
- `packages/mcp-server-couchbase/src/v2/prompts.ts` -- Task 8, the 1 prompt
- `packages/mcp-server-couchbase/src/server-v2.ts` -- Modified in each task to call the new file's `register*` function; `capella_ping`'s existing inline registration is untouched.
- `packages/mcp-server-couchbase/tests/server-v2-wire.test.ts` -- Task 9, extended with the representative sample.

Each `v2/tools/*.ts` file exports one function: `register<Group>ToolsV2(server: McpServer, tools: Map<string, RegisteredTool>, logger: ToolCallLogger): void` (logger param only where a tool's v1 handler logs; check per-tool, don't add unused params). This keeps `server-v2.ts` itself small (a sequence of `registerXToolsV2(server, tools, logger)` calls) regardless of how many tools exist in total.

---

### Task 1: Core/database tools (9 tools)

**Files:**
- Create: `packages/mcp-server-couchbase/src/v2/tools/core.ts`
- Modify: `packages/mcp-server-couchbase/src/server-v2.ts`
- Reference (read-only): `packages/mcp-server-couchbase/src/tools/{getBuckets,getClusterHealth,getScopesAndCollections,getSchemaForCollection,runSqlPlusPlusQuery,explainSqlPlusPlusQuery,getDocumentById,upsertDocumentById,deleteDocumentById}.ts`

**Interfaces:**
- Consumes: `McpServer`, `RegisteredTool` from `@modelcontextprotocol/server`; `connectionManager` from `./lib/connectionManager.ts` (same singleton `capella_ping` already uses in `server-v2.ts:16`); each v1 tool file's Zod input schema and handler logic (read, do not import -- v1 files import from `@modelcontextprotocol/sdk` types, not `@modelcontextprotocol/server`, so they are not directly reusable as modules; re-implement the schema + handler body against v2's `registerTool` config style).
- Produces: `registerCoreToolsV2(server: McpServer, tools: Map<string, RegisteredTool>): void`, exported from `v2/tools/core.ts`.

The 9 tools: `capella_get_buckets`, `capella_get_cluster_health`, `capella_get_scopes_and_collections`, `capella_get_schema_for_collection`, `capella_run_sql_plus_plus_query`, `capella_explain_sql_plus_plus_query`, `capella_get_document_by_id`, `capella_upsert_document_by_id`, `capella_delete_document_by_id`.

**Note on `capella_run_sql_plus_plus_query`'s annotations specifically**: unlike every other tool in this plan (static annotation objects), this one is the ONE config-dependent case in `couchbaseToolAnnotations` (`tool-classification.ts:83-86`): `{ readOnlyHint: config.server.readOnlyQueryMode, destructiveHint: !config.server.readOnlyQueryMode }`. Port this as a live read of `config.server.readOnlyQueryMode` in the v2 handler's registration (not a hand-computed static literal like the other 38 tools) -- import the same `config` module v1 uses (check `packages/mcp-server-couchbase/src/config/index.ts` is SDK-agnostic before importing directly into v2 code; it should be, since it's pure configuration, but confirm rather than assume).

- [ ] **Step 1: Read each of the 9 reference tool files in full**

For each file, note: the exact tool name string, `description`, input schema shape (Zod fields + their `.describe()` text -- these must be preserved verbatim, they're part of the tool's contract), and the handler body's logic including error handling.

**Annotations**: `couchbaseToolAnnotations(name)` (`packages/mcp-server-couchbase/src/tools/tool-classification.ts:82-91`) is v1-only -- it imports `ToolAnnotations` from `@modelcontextprotocol/sdk/types.js` (v1 SDK), which is a different type than v2's own `ToolAnnotations` (structurally compatible, but a different import, so don't import the v1 function directly into v2 code). It's a thin wrapper: for `capella_run_sql_plus_plus_query` it returns `{ readOnlyHint: config.server.readOnlyQueryMode, destructiveHint: !config.server.readOnlyQueryMode }` (config-dependent); for every other tool it returns `deriveToolAnnotations(name, { readOnly: READ_ONLY_TOOLS, destructive: DESTRUCTIVE_TOOLS })` from `@devops-agent/shared` (`packages/shared/src/tool-annotations.ts:23-33` -- SDK-agnostic, safe to import into v2 code directly). For each of the 9 tools in this task, check `tool-classification.ts`'s `READ_ONLY_TOOLS`/`WRITE_TOOLS`/`DESTRUCTIVE_TOOLS` Sets for whether the tool name is present in each, and hand-write the resulting `{ readOnlyHint, destructiveHint, idempotentHint }` object literal directly in `v2/tools/core.ts` -- do not create a new shared v2-annotations module for this; the values are static per tool (except the one SQL-query special case) and there are only 39 tools total across this whole plan, so per-tool literals are simpler than a new abstraction layer.

- [ ] **Step 2: Write `v2/tools/core.ts`**

Structure (illustrative shape -- fill in each tool's real schema/handler from Step 1, do not invent placeholder logic):

```typescript
// src/v2/tools/core.ts
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/server";
import { z } from "zod";
import { connectionManager } from "../lib/connectionManager.ts";

export function registerCoreToolsV2(server: McpServer, tools: Map<string, RegisteredTool>): void {
	const getBuckets = server.registerTool(
		"capella_get_buckets",
		{
			description: "<verbatim from v1 getBuckets.ts>",
			inputSchema: z.object({ /* verbatim from v1 */ }),
			annotations: { /* verbatim annotation values from tool-classification.ts for this tool name */ },
		},
		async (args) => {
			// verbatim handler logic from v1 getBuckets.ts, adapted only for the
			// connectionManager/bucket access pattern server-v2.ts already uses
		},
	);
	tools.set("capella_get_buckets", getBuckets);

	// ... repeat for the other 8 tools
}
```

- [ ] **Step 3: Wire into `server-v2.ts`**

Add the import and call inside `buildServerFactory`'s returned function, after the existing `capella_ping` registration and before the `installReadOnlyChokepointV2`/`installToolCallLoggingV2` calls:

```typescript
import { registerCoreToolsV2 } from "./v2/tools/core.ts";
// ... inside buildServerFactory's returned async function, after tools.set("capella_ping", ping):
registerCoreToolsV2(server, tools);
```

- [ ] **Step 4: Typecheck and test**

Run: `bun run --filter '@devops-agent/mcp-server-couchbase' typecheck`
Expected: no errors.

Run: `bun run --filter '@devops-agent/mcp-server-couchbase' test`
Expected: all existing tests still pass (this task adds no new tests yet -- Task 9 covers test additions for a representative sample across all groups).

- [ ] **Step 5: Manual smoke check via wire-level fetch**

Since there's no live test yet for these tools, manually verify at least one (e.g. `capella_get_buckets`) responds via the existing wire-test harness pattern (see `server-v2-wire.test.ts`'s `buildHandler()` + `handler.fetch()` pattern) before moving on -- a quick throwaway script or REPL check is fine, not a committed test (Task 9 adds the real committed tests).

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server-couchbase/src/v2/tools/core.ts packages/mcp-server-couchbase/src/server-v2.ts
git commit -m "SIO-1443: port core/database tools to v2 (9 tools)"
```

---

### Task 2: Documentation tools (5 tools)

**Files:**
- Create: `packages/mcp-server-couchbase/src/v2/tools/documentation.ts`
- Modify: `packages/mcp-server-couchbase/src/server-v2.ts`
- Reference (read-only): `packages/mcp-server-couchbase/src/tools/{createDocumentation,listDocumentation,deleteDocumentation,syncDocumentation,readDocumentation}.ts`

**Interfaces:**
- Consumes: same as Task 1, plus whatever documentation-storage dependency these tools use (check each file -- likely filesystem access under `docs-fixture`/configured docs directory, per the test fixture patterns seen in the full-suite test run this session).
- Produces: `registerDocumentationToolsV2(server: McpServer, tools: Map<string, RegisteredTool>): void`.

The 5 tools: `capella_create_documentation`, `capella_list_documentation`, `capella_delete_documentation`, `capella_sync_documentation_with_database`, `capella_read_documentation`.

- [ ] **Step 1: Read each of the 5 reference tool files in full**

Same extraction as Task 1 Step 1: name, description, schema, annotations, handler logic. Pay attention to `syncDocumentation.ts`'s `sanitizePath` helper (path-traversal guard, `syncDocumentation.ts:14-16`) -- this security-relevant logic must be ported verbatim, not paraphrased.

- [ ] **Step 2: Write `v2/tools/documentation.ts`**

Same pattern as Task 1 Step 2, for these 5 tools.

- [ ] **Step 3: Wire into `server-v2.ts`**

```typescript
import { registerDocumentationToolsV2 } from "./v2/tools/documentation.ts";
// ... after registerCoreToolsV2(server, tools):
registerDocumentationToolsV2(server, tools);
```

- [ ] **Step 4: Typecheck and test**

Run: `bun run --filter '@devops-agent/mcp-server-couchbase' typecheck && bun run --filter '@devops-agent/mcp-server-couchbase' test && bun run lint`
Expected: clean, all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server-couchbase/src/v2/tools/documentation.ts packages/mcp-server-couchbase/src/server-v2.ts
git commit -m "SIO-1443: port documentation tools to v2 (5 tools)"
```

---

### Task 3: Playbook tools (2 tools)

**Files:**
- Create: `packages/mcp-server-couchbase/src/v2/tools/playbooks.ts`
- Modify: `packages/mcp-server-couchbase/src/server-v2.ts`
- Reference (read-only): `packages/mcp-server-couchbase/src/tools/listPlaybooks.ts` (registers BOTH `capella_list_playbooks` at line 12 and `capella_get_playbook` at line 64 -- one file, two tools)

**Interfaces:**
- Consumes: same as Task 1/2.
- Produces: `registerPlaybookToolsV2(server: McpServer, tools: Map<string, RegisteredTool>): void`.

The 2 tools: `capella_list_playbooks`, `capella_get_playbook`.

- [ ] **Step 1: Read `listPlaybooks.ts` in full**

Note both tool registrations' schemas/handlers. Check whether these tools depend on the same playbook-loading infrastructure the v1 resources (`playbookResource.ts`) use -- if so, note that dependency for Task 7 (resources), since both may need the same underlying playbook data source.

- [ ] **Step 2: Write `v2/tools/playbooks.ts`**

Same pattern, both tools in one function.

- [ ] **Step 3: Wire into `server-v2.ts`**

```typescript
import { registerPlaybookToolsV2 } from "./v2/tools/playbooks.ts";
// ... after registerDocumentationToolsV2(server, tools):
registerPlaybookToolsV2(server, tools);
```

- [ ] **Step 4: Typecheck and test**

Run: `bun run --filter '@devops-agent/mcp-server-couchbase' typecheck && bun run --filter '@devops-agent/mcp-server-couchbase' test && bun run lint`

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server-couchbase/src/v2/tools/playbooks.ts packages/mcp-server-couchbase/src/server-v2.ts
git commit -m "SIO-1443: port playbook tools to v2 (2 tools)"
```

---

### Task 4: Query analysis tools, part A (11 tools)

**Files:**
- Create: `packages/mcp-server-couchbase/src/v2/tools/query-analysis-a.ts`
- Modify: `packages/mcp-server-couchbase/src/server-v2.ts`
- Reference (read-only): `packages/mcp-server-couchbase/src/tools/queryAnalysis/{analyzeDocumentStructure,getCompletedRequests,getDetailedIndexes,getDetailedPreparedStatements,getDocumentTypeExamples,getFatalRequests,getIndexAdvisor,getIndexesToDrop,getLargestResultCountQueries,getLargestResultSizeQueries,getLongestRunningQueries}.ts`

**Interfaces:**
- Consumes: same as prior tasks.
- Produces: `registerQueryAnalysisToolsAV2(server: McpServer, tools: Map<string, RegisteredTool>): void`.

The 11 tools (alphabetical first half of the 21 in `queryAnalysis/index.ts`): `capella_analyze_document_structure`, `capella_get_completed_requests`, `capella_get_detailed_indexes`, `capella_get_detailed_prepared_statements`, `capella_get_document_type_examples`, `capella_get_fatal_requests`, `capella_get_index_advisor_recommendations`, `capella_get_indexes_to_drop`, `capella_get_largest_result_count_queries`, `capella_get_largest_result_size_queries`, `capella_get_longest_running_queries`.

- [ ] **Step 1: Read all 11 reference tool files in full**

These are query-analysis tools against Couchbase's system catalogs (`system:completed_requests`, `system:indexes`, etc.) -- likely share a common query-execution helper. Check `packages/mcp-server-couchbase/src/tools/queryAnalysis/` for any shared utility file (not in the file list above if one exists) and note it; port the SAME underlying query logic per tool, don't reinvent the SQL++ queries.

- [ ] **Step 2: Write `v2/tools/query-analysis-a.ts`**

Same registration pattern, 11 tools in one function. If a shared query-execution helper exists in v1, either import it directly (if it has no v1-SDK-specific types) or port a v2-local equivalent -- check its type signature before deciding; prefer direct import if it's SDK-agnostic (pure Couchbase query logic).

- [ ] **Step 3: Wire into `server-v2.ts`**

```typescript
import { registerQueryAnalysisToolsAV2 } from "./v2/tools/query-analysis-a.ts";
// ... after registerPlaybookToolsV2(server, tools):
registerQueryAnalysisToolsAV2(server, tools);
```

- [ ] **Step 4: Typecheck and test**

Run: `bun run --filter '@devops-agent/mcp-server-couchbase' typecheck && bun run --filter '@devops-agent/mcp-server-couchbase' test && bun run lint`

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server-couchbase/src/v2/tools/query-analysis-a.ts packages/mcp-server-couchbase/src/server-v2.ts
git commit -m "SIO-1443: port query analysis tools to v2, part A (11 tools)"
```

---

### Task 5: Query analysis tools, part B (10 tools)

**Files:**
- Create: `packages/mcp-server-couchbase/src/v2/tools/query-analysis-b.ts`
- Modify: `packages/mcp-server-couchbase/src/server-v2.ts`
- Reference (read-only): `packages/mcp-server-couchbase/src/tools/queryAnalysis/{getLowSelectivityQueries,getMostExpensiveQueries,getMostFrequentQueries,getNonCoveringIndexQueries,getPreparedStatements,getPrimaryIndexQueries,getSystemIndexes,getSystemNodes,getSystemVitals,suggestQueryOptimizations}.ts`

**Interfaces:**
- Consumes: same as Task 4 (including whatever shared query-execution helper Task 4 identified).
- Produces: `registerQueryAnalysisToolsBV2(server: McpServer, tools: Map<string, RegisteredTool>): void`.

The 10 tools (alphabetical second half): `capella_get_low_selectivity_queries`, `capella_get_most_expensive_queries`, `capella_get_most_frequent_queries`, `capella_get_non_covering_index_queries`, `capella_get_prepared_statements`, `capella_get_primary_index_queries`, `capella_get_system_indexes`, `capella_get_system_nodes`, `capella_get_system_vitals`, `capella_suggest_query_optimizations`.

- [ ] **Step 1: Read all 10 reference tool files in full**

Same as Task 4 Step 1.

- [ ] **Step 2: Write `v2/tools/query-analysis-b.ts`**

Same pattern as Task 4 Step 2, reusing the same shared query-execution helper decision made in Task 4 (don't re-derive it independently -- if Task 4 imported it directly, do the same here; if Task 4 ported a v2-local copy, import THAT copy rather than porting a second one).

- [ ] **Step 3: Wire into `server-v2.ts`**

```typescript
import { registerQueryAnalysisToolsBV2 } from "./v2/tools/query-analysis-b.ts";
// ... after registerQueryAnalysisToolsAV2(server, tools):
registerQueryAnalysisToolsBV2(server, tools);
```

- [ ] **Step 4: Typecheck and test**

Run: `bun run --filter '@devops-agent/mcp-server-couchbase' typecheck && bun run --filter '@devops-agent/mcp-server-couchbase' test && bun run lint`

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server-couchbase/src/v2/tools/query-analysis-b.ts packages/mcp-server-couchbase/src/server-v2.ts
git commit -m "SIO-1443: port query analysis tools to v2, part B (10 tools)"
```

---

### Task 6: `capella_echo` (1 tool)

**Files:**
- Create: `packages/mcp-server-couchbase/src/v2/tools/echo.ts`
- Modify: `packages/mcp-server-couchbase/src/server-v2.ts`
- Reference (read-only): `packages/mcp-server-couchbase/src/server.ts:133-145` (approximate -- the inline `capella_echo` registration, not a separate tool file)

**Interfaces:**
- Consumes: none beyond `McpServer`/`RegisteredTool` types.
- Produces: `registerEchoToolV2(server: McpServer, tools: Map<string, RegisteredTool>): void`.

`capella_echo` is v1's simplest tool (registered inline in `server.ts`, not its own file under `tools/`) -- likely a diagnostic/connectivity-test tool similar in spirit to `capella_ping` but distinct (both exist in the snapshot as separate tools). This is a one-tool task specifically because it's the last piece needed for full tool-surface parity and doesn't fit naturally into any of the 4 groups above (it's not core/database, documentation, playbook, or query-analysis).

- [ ] **Step 1: Read `server.ts`'s `capella_echo` registration in full**

Note its exact name, description, schema, and handler body. For annotations: check `tool-classification.ts`'s Sets for whether `"capella_echo"` is in `READ_ONLY_TOOLS`/`WRITE_TOOLS`/`DESTRUCTIVE_TOOLS` and hand-write the resulting annotation object literal, same approach as Task 1.

- [ ] **Step 2: Write `v2/tools/echo.ts`**

```typescript
// src/v2/tools/echo.ts
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/server";
import { z } from "zod";

export function registerEchoToolV2(server: McpServer, tools: Map<string, RegisteredTool>): void {
	const echo = server.registerTool(
		"capella_echo",
		{
			description: "<verbatim from server.ts>",
			inputSchema: z.object({ /* verbatim */ }),
			annotations: { /* verbatim */ },
		},
		async (args) => {
			// verbatim handler logic from server.ts's inline registration
		},
	);
	tools.set("capella_echo", echo);
}
```

- [ ] **Step 3: Wire into `server-v2.ts`**

```typescript
import { registerEchoToolV2 } from "./v2/tools/echo.ts";
// ... after registerQueryAnalysisToolsBV2(server, tools):
registerEchoToolV2(server, tools);
```

- [ ] **Step 4: Typecheck and test**

Run: `bun run --filter '@devops-agent/mcp-server-couchbase' typecheck && bun run --filter '@devops-agent/mcp-server-couchbase' test && bun run lint`

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server-couchbase/src/v2/tools/echo.ts packages/mcp-server-couchbase/src/server-v2.ts
git commit -m "SIO-1443: port capella_echo to v2 (final tool, full tool-surface parity reached)"
```

---

### Task 7: All resources (config-dependent: 9 fixed registrations + 1 per discovered playbook)

**Files:**
- Create: `packages/mcp-server-couchbase/src/v2/resources.ts`
- Modify: `packages/mcp-server-couchbase/src/server-v2.ts`
- Reference (read-only): `packages/mcp-server-couchbase/src/resources/{documentResource,databaseStructureResource,queryResource,schemaResource,documentationResource,playbookResource}.ts`

**Interfaces:**
- Consumes: `McpServer`'s `registerResource` (v2 confirmed same signature as v1: `registerResource(name: string, uriOrTemplate: string | ResourceTemplate, config: ResourceMetadata, callback): RegisteredResource | RegisteredResourceTemplate` -- verified against the installed v2 SDK's type declarations, `node_modules/.bun/@modelcontextprotocol+server@2.0.0/.../createMcpHandler-CLhGwQTn.d.mts:3264-3268`).
- Produces: `async function registerResourcesV2(server: McpServer): Promise<void>`. No `tools` Map involvement -- resources are not chokepoint/logging-wrapped in v1 either, so this function takes only `server`. Async because playbook discovery (scanning the fallback directories for markdown files, see the playbook resources entry below) must complete before the playbook resources can be registered -- the caller must `await` this call.

The 9 fixed resources, by file (plus N additional resources at runtime -- one per discovered playbook, see `playbookResource.ts` entry below -- so the total resource count is config-dependent, not a fixed number; a live parity check should compare v1 and v2 inventories under identical configuration rather than asserting a hardcoded count):
- `documentResource.ts:52` -- `document` (dynamic, `ResourceTemplate`)
- `databaseStructureResource.ts:86` -- `database-structure` (static URI `database://structure`)
- `queryResource.ts:75` -- `query-results` (dynamic, `ResourceTemplate`)
- `schemaResource.ts:79` -- `collection-schema` (dynamic, `ResourceTemplate`)
- `documentationResource.ts:256,267,277,287` -- `documentation-browser` (static `docs://`), `scope-documentation`, `collection-documentation`, `documentation-file` (static scheme-less URIs -- v1's `ResourceRegistry.toUrl()` fallback handles the scheme-less case for its OWN internal read path only; confirm whether v2's `registerResource` itself tolerates a scheme-less URI string directly, or whether v1's scheme-less registration was only safe because of that internal fallback -- if v2 rejects it, these 3 resources may need a URI scheme added, which would be a real v1/v2 behavioral difference worth flagging in the PR, not silently working around)
- `playbookResource.ts:257,269` -- `playbook-directory` (static `playbook://`) + one resource per discovered playbook (`playbook-${resourceId}`, dynamic COUNT but each individual registration is a static URI, registered in a loop -- port the loop, not a `ResourceTemplate`)

- [ ] **Step 1: Read all 6 reference resource files in full**

For each `registerResource` call: exact name, URI/template string, config object contents (even if `{}` today, confirm it's empty in v1 before assuming v2 needs nothing extra), and the read callback's full logic including any error handling.

- [ ] **Step 2: Investigate the scheme-less URI question BEFORE writing code**

Before porting `documentationResource.ts`'s 3 scheme-less-URI resources (`scope-documentation`, `collection-documentation`, `documentation-file` -- note `documentation-browser` uses `docs://`, a real scheme, so it's NOT scheme-less), write a small throwaway probe: call v2's `registerResource("test", "scope-documentation", {}, async () => ({contents: []}))` against a `server-v2.ts`-style `McpServer` instance and a `resources/read` request for URI `"scope-documentation"`, and observe whether v2's HTTP layer accepts or rejects the scheme-less URI at the protocol level (not just at registration time -- registration might succeed while the actual `resources/read` dispatch fails on URI parsing, mirroring the `new URL()` `TypeError` v1's `resource-registry.ts:24-34` `toUrl()` helper works around). Delete the probe once you have the answer; document the finding in Step 3's comments.

- [ ] **Step 3: Write `v2/resources.ts`**

```typescript
// src/v2/resources.ts
import type { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";

export async function registerResourcesV2(server: McpServer): Promise<void> {
	// Static resources
	server.registerResource("database-structure", "database://structure", {}, async (uri) => {
		// verbatim from v1 databaseStructureResource.ts
	});

	// ... continue for documentation-browser, and the 3 scheme-less ones (with the
	// Step 2 finding applied -- either verbatim if v2 tolerates it, or with whatever
	// fix Step 2 determined was needed, documented with a comment explaining why)

	// Dynamic resources (ResourceTemplate)
	// documentTemplate, queryTemplate, schemaTemplate: port each v1 ResourceTemplate
	// construction verbatim (URI template string + list/complete callbacks if v1 has them)

	// Playbook resources: discovery must complete (await the directory/markdown-file scan,
	// mirroring playbookResource.ts:261-271's loadPlaybooks) BEFORE registration -- register
	// "playbook-directory" once, then one resource per discovered playbook ID. The number of
	// playbook resources registered depends on what discovery finds, so the function's total
	// resource count is config-dependent (see Task 7's header note above).
}
```

- [ ] **Step 4: Wire into `server-v2.ts`**

```typescript
import { registerResourcesV2 } from "./v2/resources.ts";
// ... after registerEchoToolV2(server, tools), before the chokepoint/logging wrap calls
// (resources are NOT wrapped, so order relative to the wrap calls doesn't matter, but
// keep it grouped with the other registration calls for readability). Must be awaited --
// registerResourcesV2 is async because playbook discovery has to finish before the
// playbook resources it discovers can be registered:
await registerResourcesV2(server);
```

- [ ] **Step 5: Typecheck and test**

Run: `bun run --filter '@devops-agent/mcp-server-couchbase' typecheck && bun run --filter '@devops-agent/mcp-server-couchbase' test && bun run lint`

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server-couchbase/src/v2/resources.ts packages/mcp-server-couchbase/src/server-v2.ts
git commit -m "SIO-1443: port all 11 resources to v2 (8 static + 3 templates)"
```

---

### Task 8: The prompt

**Files:**
- Create: `packages/mcp-server-couchbase/src/v2/prompts.ts`
- Modify: `packages/mcp-server-couchbase/src/server-v2.ts`
- Reference (read-only): `packages/mcp-server-couchbase/src/prompts/sqlppQueryGenerator.ts`

**Interfaces:**
- Consumes: `McpServer`'s `registerPrompt` (v2 confirmed: raw-shape `Args extends ZodRawShape` overload exists and matches v1's exact usage, `node_modules/.bun/@modelcontextprotocol+server@2.0.0/.../createMcpHandler-CLhGwQTn.d.mts:3353-3360` -- v1's `sqlppQueryGenerator.ts:14-24` already uses this raw-shape `argsSchema` form, so this is a same-shape port, not a translation).
- Produces: `registerPromptsV2(server: McpServer): void`.

- [ ] **Step 1: Read `sqlppQueryGenerator.ts` in full**

It's 72 lines, already read in this session's scoping pass -- the `argsSchema` object (6 fields: `description`, `bucket`, `scope`, `collection`, `filters`, `limit`) and the full prompt-text-generation callback body must be ported verbatim, including the SIO-1078 comment's business-logic note about why `scope` is kept out of the FROM clause.

- [ ] **Step 2: Write `v2/prompts.ts`**

```typescript
// src/v2/prompts.ts
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export function registerPromptsV2(server: McpServer): void {
	server.registerPrompt(
		"generate_sqlpp_query",
		{
			argsSchema: {
				// verbatim from v1 sqlppQueryGenerator.ts:14-24
			},
		},
		(args) => {
			// verbatim callback body from v1 sqlppQueryGenerator.ts:26-67
		},
	);
}
```

- [ ] **Step 3: Wire into `server-v2.ts`**

```typescript
import { registerPromptsV2 } from "./v2/prompts.ts";
// ... after `await registerResourcesV2(server)`:
registerPromptsV2(server);
```

- [ ] **Step 4: Typecheck and test**

Run: `bun run --filter '@devops-agent/mcp-server-couchbase' typecheck && bun run --filter '@devops-agent/mcp-server-couchbase' test && bun run lint`

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server-couchbase/src/v2/prompts.ts packages/mcp-server-couchbase/src/server-v2.ts
git commit -m "SIO-1443: port sqlpp query generator prompt to v2 (full surface parity: 39 tools, 11 resources, 1 prompt)"
```

---

### Task 9: Wire-level test coverage for the representative sample

**Files:**
- Modify: `packages/mcp-server-couchbase/tests/server-v2-wire.test.ts`

**Interfaces:**
- Consumes: `buildServerFactory` from `../src/server-v2.ts` (already imported in the existing test file), the existing `buildHandler()`/`parseJsonRpcBody()` helpers already defined in the test file.
- Produces: new test cases only, no new exports.

Per the design spec's Test coverage section: 3-5 tools spanning different input shapes (not all 39), 1 static + 1 dynamic resource read, 1 prompt invocation. Suggested selection (pick tools that exercise genuinely different shapes, not just different names):

- `capella_get_buckets` -- no-arg tool (like `capella_ping`, proves the pattern generalizes trivially).
- `capella_get_document_by_id` -- tool with a required string param.
- `capella_run_sql_plus_plus_query` -- tool with a more complex input schema (multiple fields).
- `capella_list_playbooks` -- proves a tool from a different registration group works identically.
- Resource: `database-structure` (static URI) -- read it via the wire-level `fetch()` pattern and assert a real response.
- Resource: `document` or `query-results` (dynamic template) -- read via a template-matching URI and assert the template variables were correctly extracted and passed to the callback.
- Prompt: `generate_sqlpp_query` -- invoke via a `prompts/get` request and assert the returned message text is well-formed (not necessarily byte-identical to v1 -- that level of parity isn't this task's goal, "it responds correctly" is).

- [ ] **Step 1: Write the new test cases**

Follow the existing file's established pattern (`buildHandler()`, `Mcp-Method`/`Mcp-Name` headers for `tools/call`, the full `_meta` envelope trio for the modern era, `parseJsonRpcBody()` for response parsing) -- see the existing `capella_ping` tests (`server-v2-wire.test.ts:94-138`) as the template for tool tests, and the `server/discover` test (post-SIO-1436 fix) for the general wire-test shape. For resource reads, the request `method` is `"resources/read"` with `params: { uri: "..." }` instead of `"tools/call"`. For the prompt, `method` is `"prompts/get"` with `params: { name: "generate_sqlpp_query", arguments: {...} }`.

- [ ] **Step 2: Run the new tests**

Run: `bun test packages/mcp-server-couchbase/tests/server-v2-wire.test.ts`
Expected: all pass, including the new cases. If a test reveals unexpected behavior (e.g. the scheme-less URI issue investigated in Task 7 Step 2 turns out to affect a DIFFERENT resource than expected, or a tool's v2 handler diverges from v1's), fix the registration in the relevant earlier task's file (do not paper over it in the test) and re-run.

- [ ] **Step 3: Run the full package suite**

Run: `bun run --filter '@devops-agent/mcp-server-couchbase' test`
Expected: all pass, no regressions in v1's existing (untouched) test suite.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server-couchbase/tests/server-v2-wire.test.ts
git commit -m "SIO-1443: wire-level test coverage for the ported v2 tool/resource/prompt sample"
```

---

### Task 10: Full verification, live three-era curl re-check, PR

**Files:** none modified -- verification and workflow only.

- [ ] **Step 1: Full package verification**

```bash
bun run --filter '@devops-agent/mcp-server-couchbase' typecheck
bun run --filter '@devops-agent/mcp-server-couchbase' test
bun run lint
```

Expected: all green. Confirm 0 lint errors in every new `v2/tools/*.ts`, `v2/resources.ts`, `v2/prompts.ts` file specifically (pre-existing unrelated warnings elsewhere are not blockers, per this repo's established precedent).

- [ ] **Step 2: Tool/resource/prompt count parity check**

Write a throwaway script (not committed) that starts the v2 handler, sends a `tools/list`, `resources/list`, and `prompts/list` request each, and diffs the returned names against the v1 snapshot's `tools`/`resources`/`resourceTemplates`/`prompts` keys (`packages/mcp-server-couchbase/src/__tests__/tools-list-snapshot.json`). Report any mismatch explicitly -- a name present in v1's snapshot but missing from v2 (or vice versa) means a tool/resource was missed or mis-named during porting. This is the "done" check from the design spec, made concrete and mechanical rather than manual.

- [ ] **Step 3: Three-era curl re-check against 1-2 newly-ported tools**

Before starting anything, check the port is free: `lsof -i :<COUCHBASE_MCP_V2_PORT>` (see `packages/mcp-server-couchbase/src/index-v2.ts`/`.env` for the actual configured value). If an existing listener is found that this task did not start itself, stop and ask before proceeding -- do not kill a process you didn't start (per this repo's CLAUDE.md port-check convention).

Start the v2 pilot server locally (`bun packages/mcp-server-couchbase/src/index-v2.ts`, track the PID), run the three-era curl matrix from the original SIO-1424 handover (`initialize` handshake, stateless `tools/call`, `server/discover`) against `capella_get_buckets` or another newly-ported tool with a real input schema (not just `capella_ping`, which has no input to validate). Kill the server by tracked PID afterward; confirm the port is free (`lsof -nP -iTCP:<COUCHBASE_MCP_V2_PORT> -sTCP:LISTEN`).

- [ ] **Step 4: PR**

Branch off `main` (this plan's implementation should happen on a fresh branch, e.g. `simonowusupvh/sio-1443-couchbase-v2-full-coverage`, not accumulate on top of unrelated work). Push, open PR ready-for-review (never draft) citing [SIO-1443](https://linear.app/siobytes/issue/SIO-1443), noting in the description: (a) the tool/resource/prompt count parity result from Step 2, (b) the scheme-less-URI finding from Task 7 Step 2 (whether it was a non-issue or needed a real fix), (c) any other v1→v2 behavioral difference discovered during porting that wasn't anticipated by this plan -- per the design spec's "what didn't port mechanically" write-up requirement. Then the standard CodeRabbit SHA-scoped review loop per CLAUDE.md before merge.

---

## Self-Review Notes

**Spec coverage:**
- Design step 1 (port remaining tools) -> Tasks 1-6 (39 total: 9+5+2+11+10+1+1 already-existing capella_ping = 39). ✓
- Design step 2 (port resources + prompt) -> Tasks 7-8. ✓
- Design step 3 (test coverage) -> Task 9. ✓
- Design step 4 ("what didn't port mechanically" write-up) -> Task 10 Step 4. ✓
- Design's "done" checklist (name parity, tests pass, typecheck/lint clean, no v1/index.ts/COUCHBASE_MCP_URL changes) -> Task 10 Steps 1-2, plus the Global Constraints block enforcing the v1-untouched rule across every task. ✓
- Design's three-era curl re-check -> Task 10 Step 3. ✓

**Placeholder scan:** Tasks 1-6 and 8's code blocks contain `<verbatim from v1 ...>` and `// verbatim handler logic from ...` placeholders rather than literal transcribed code. This is a deliberate, bounded exception to the "no placeholders" rule: verbatim-transcribing 39 tools' full Zod schemas and handler bodies into this plan document would make the plan itself larger than the codebase it's porting, and every one of those tools' exact current source is directly readable by the implementer from the cited reference file:line -- unlike a "write appropriate error handling" placeholder (which hides a design decision), "port this specific, already-written, already-reviewed code" placeholder hides no decision at all. Each task's Step 1 explicitly directs reading the exact reference file before writing, and the Global Constraints block states the fidelity bar (behavior must match v1 for the same input). Flagging this explicitly rather than silently deviating from the skill's placeholder rule.

**Type consistency:** `Map<string, RegisteredTool>` (the `tools` parameter) is consistent across Tasks 1-6 (only tool-registering tasks take it); Tasks 7-8 (resources/prompt) correctly omit it since v1 never wraps resources/prompts in chokepoint/logging. `registerXToolsV2(server, tools)` naming is consistent across all 6 tool tasks. `server-v2.ts`'s import list grows by exactly one import per task, in registration order -- no task's wiring step references a function name not defined in that same task.
