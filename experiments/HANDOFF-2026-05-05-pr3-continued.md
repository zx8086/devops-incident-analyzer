# SIO-669 PR3 Handoff (continued) -- 2026-05-05

## Goal

Finish the elastic-MCP `any` migration started in [SIO-669](https://linear.app/siobytes/issue/SIO-669) PR3. The structural change (`ToolRegistrationFunction` tightening) and 8 of 17 categories are now done in this branch. Remaining: 9 categories, ~62 files, all mechanical handler retyping with the canonical 4-step pattern from `HANDOFF-2026-05-05-pr3.md`.

## Branch

`simonowusupvh/sio-669-pr3-tool-registration-function`

## Progress

**Categories complete (this session, 23 files, +20 over the prior handoff):**

1. diagnostics (1 file): `elasticsearch_diagnostics.ts`
2. advanced (1 file): `translate_sql_query.ts` (cited site from SIO-669)
3. autoscaling (2 files): `index.ts`, `put_policy.ts`
4. mapping (2 files): `get_field_mapping.ts`, `index.ts`
5. ingest (3 files): `get_pipeline.ts`, `processor_grok.ts`, `simulate_pipeline.ts`
6. enrich (5 files): `delete_policy.ts`, `execute_policy.ts`, `stats.ts`, `put_policy.ts`, `get_policy_improved.ts`
7. alias (4 files): `delete_alias.ts`, `put_alias.ts`, `update_aliases.ts`, `get_aliases_improved.ts`
8. document (5 files): `get_document.ts`, `document_exists.ts`, `delete_document.ts`, `index_document.ts`, `update_document.ts`

**Categories complete (prior session):** cluster (4), tasks (4 incl. index.ts), analytics (`timestamp_analysis.ts`)

## Metrics

| Check | Baseline (post-PR2) | After session 1 | After session 2 (now) | Target |
|-------|---------------------|-----------------|-----------------------|--------|
| `bun run --filter '@devops-agent/mcp-server-elastic' typecheck` | clean | clean | clean | clean |
| noExplicitAny in `mcp-server-elastic` | 547 | 533 | **490** | <50 |
| `: any` / `as any` in `src/tools/` | 286 | 269 | **227** | <20 |

## Real schema bugs surfaced (not new `as any`)

The handoff guidance "If typecheck surfaces a real schema mismatch: fix the schema, do **not** add a new `as any`" caught 3 latent bugs this session:

1. **`elasticsearch_diagnostics.ts:106`** -- `Number.parseInt(string.split(".")[0], 10)` was unsafe under `noUncheckedIndexedAccess`. Fixed: extract version into local + `?? "0"` fallback.
2. **`document/{get,delete,document_exists,update}_document.ts`** -- `versionType` enum included `"force"` but SDK's `VersionType = 'internal' | 'external' | 'external_gte'`. The `as any` cast on `esClient.{get,delete,exists,update}({ version_type })` was hiding it. Removed `"force"` from all 4 schemas; removed all 4 `as any` casts.
3. **`autoscaling/{put_policy,index}.ts`** -- `policy: z.any()` was permissive but SDK's `AutoscalingAutoscalingPolicy` requires `{ roles: string[]; deciders: Record<string, any> }`. Tightened to a structured z.object matching SDK shape.

## Remaining categories (in suggested order)

| # | Category | Path | Files (approx) | Notes |
|---|----------|------|----------------|-------|
| 9 | core | `src/tools/core/` | 5 | `search.ts`, `list_indices.ts`, `get_mappings.ts`, `indices_summary.ts`, `get_shards.ts` |
| 10 | bulk | `src/tools/bulk/` | 4 | `bulk_operations.ts`, `bulk_index_with_progress.ts`, `multi_get.ts`, `index.ts` |
| 11 | analytics | `src/tools/analytics/` | 3 | `get_term_vectors.ts`, `get_multi_term_vectors.ts` (both `as any` on request body), `index.ts` |
| 12 | search | `src/tools/search/` | 6 | `count_documents.ts`, `clear_scroll.ts`, `scroll_search.ts`, `execute_sql_query.ts`, `multi_search.ts`, `update_by_query.ts` (partially touched in PR1) |
| 13 | template | `src/tools/template/` | 5 | `multi_search_template.ts:61` legacy `body: searches` wrapper |
| 14 | ilm | `src/tools/ilm/` | 6 | `put_lifecycle.ts:233` legacy `body:` wrapper |
| 15 | index_management | `src/tools/index_management/` | 12 | `update_index_settings.ts:143` legacy `body:` wrapper |
| 16 | indices | `src/tools/indices/` | 13 | Standard pattern across all |
| 17 | watcher | `src/tools/watcher/` | 14 | Largest, all standard pattern |

**Total remaining: ~68 files** (some have multiple `any` per file but each is one canonical edit pass).

## Established patterns from this session (additions to the original handoff)

### `versionType` enum is wrong everywhere

Search for `z.enum(["internal", "external", "external_gte", "force"])` -- it appears in many files (likely `update_by_query.ts`, `bulk_operations.ts`, etc.). Always strip `"force"`. SDK's `VersionType` only has 3 members.

### `as any` casts on standard SDK calls are usually unnecessary

When you see `esClient.X({...} as any)` in document/mapping handlers, just delete the cast and run typecheck -- in this session every such cast was removable without other changes. If typecheck reveals a real mismatch, fix the schema (e.g. the `versionType` case above) instead of restoring the cast.

### `description` and the `inputSchema` collapse

The original handoff said collapse `inputSchema: { ... }` to `inputSchema: validator.shape`. Watch for the inputSchema fields containing `.describe()` strings or trailing-comment descriptions that the validator lacks. Move all those describes onto the validator before collapsing -- they're load-bearing for the MCP tool catalog. CLAUDE.md guidance ("ALWAYS KEEP: Zod `.describe()` calls") makes this non-optional.

### `server.tool()` (older API) vs `server.registerTool()` (newer)

`alias/get_aliases_improved.ts` uses `server.tool(name, description, schemaShape, handler)` -- positional args, not the object form. Migration is the same (collapse the schema arg to `validator.shape`), just keep the call shape.

### `estypes` namespace import

For SDK type imports, use the namespace export rather than deep paths:
```typescript
import type { estypes } from "@elastic/elasticsearch";
const x = params.something as estypes.SomeType;
```
The path `@elastic/elasticsearch/lib/api/types.js` is not in the package's `exports` map.

### `z.any()` Zod schemas vs TypeScript `any`

`z.any()` in a validator is intentional and *not* what biome's `noExplicitAny` flags. But:
- If the SDK has a structured type (like `AutoscalingAutoscalingPolicy`), prefer a structured `z.object({...})` matching it.
- If the SDK type is itself open (like `IngestPipeline` which accepts arbitrary processors), `z.record(z.string(), z.unknown())` plus a cast at the call site is honest.

## Workflow per file (unchanged from prior handoff)

1. `Read` the file (or just relevant lines: validator decl, handler signature, `inputSchema:`, any `as any`)
2. Apply the 4-step edit (promote `_FooParams` -> `FooParams`, tighten `details?: any` -> `details?: unknown`, type `args: FooParams`, collapse `inputSchema` to `validator.shape`)
3. After every 4-5 files: `bun run --filter '@devops-agent/mcp-server-elastic' typecheck`
4. If typecheck fails: fix the schema, do **not** add a new `as any`

### Commit cadence

Per CLAUDE.md, no commits without explicit user authorization. Suggest: commit per category with messages like `SIO-669: PR3 - <category> handlers (N files)`. Wait for "commit" or "execute" between categories.

## Out of scope (SIO-672, do not touch in this PR)

- `src/tools/types.ts` `ToolParams[key: string]: unknown` pattern
- `result: any` / `node as any` / `Record<string, any>` in helper/format functions (response-shape problems, not handler args). Examples already left in:
  - `ingest/get_pipeline.ts:22` (`summarizePipelines(pipelines: Record<string, any>)`)
  - `enrich/get_policy_improved.ts` (`policies: any[]`, `policy: any`, `policyConfig: any` in the map/find loops)
  - `alias/get_aliases_improved.ts` (`detailedResults: any[]`, `aliasDetail: any`)
- `src/tools/index.ts:254` enhancedHandler -- annotate with `biome-ignore lint/suspicious/noExplicitAny: <reason>` only

## Verification (final)

After all categories:
```bash
bun run typecheck                                                                  # all 12 packages clean
bunx --bun biome check --max-diagnostics=10000 packages/mcp-server-elastic/ 2>&1 \
  | grep -c "lint/suspicious/noExplicitAny"                                        # target <50
grep -rE "as any|: any" packages/mcp-server-elastic/src/tools/ | wc -l             # target <20
bun run --filter '@devops-agent/mcp-server-elastic' test
bun run lint                                                                       # workspace-wide
```

Final: update PR description with final numbers (`533 -> X`, `269 -> Y`).

## Why this stopped at 8 categories

CLAUDE.md project guidance: pre-empt context degradation rather than react to it. After 8 categories the Read-Edit-Verify rhythm was still accurate but the larger upcoming categories (`indices` 13 files, `index_management` 12 files, `watcher` 14 files) deserve a fresh session's edit quality. User explicitly chose option B ("commit + write handoff") at this checkpoint.

## Fresh-session bootstrap

```bash
cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer
git checkout simonowusupvh/sio-669-pr3-tool-registration-function && git pull
git log --oneline -5
bun install
cat experiments/HANDOFF-2026-05-05-pr3-continued.md
bun run --filter '@devops-agent/mcp-server-elastic' typecheck   # confirm clean baseline
```

Then start with category 9 (core, 5 files). Pattern reference: `cluster/get_cluster_health.ts` or any of the document/ files committed this session.
