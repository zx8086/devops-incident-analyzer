# MCP Tool Audit Runbook (datasource-agnostic)

A repeatable method for auditing any of this repo's MCP servers (elastic, kafka, couchbase, konnect, gitlab, atlassian, aws): prove every tool returns proper responses, separate real bugs from environment states, and verify the agent can actually use what the server registers. Distilled from the 2026-07-23 GitLab audit (SIO-1178 / SIO-1179, PRs #441 / #442), which tested 36/36 tools and found one guaranteed-empty-results bug that had shipped silently.

Core principle: a tool that "works" in isolation can still be broken in three other places -- the query it builds, the agent's ability to select it, and the way its errors classify. Audit all four layers.

## Phase 0: Inventory and ground truth

1. Identify the tool families. Every server here has up to three: custom REST tools (implemented in-repo), proxied tools (forwarded from an upstream MCP endpoint, discovered at boot), and graph/analytics-backed tools (billed or index-dependent). Bugs cluster differently per family: custom tools break on API drift, proxied tools on upstream behavior changes, graph tools on query-grammar drift.
2. Derive the authoritative tool count by RUNNING registration (or `tools/list` against the live server), never by grepping name literals -- filter sets and conditional registration make grep counts wrong.
3. Record env prerequisites (tokens, feature flags, upstream URLs) and which tools are conditional on them.
4. Snapshot the live baseline before touching anything: server version tool if present, plus any free schema/status endpoint (e.g. `gitlab_graph_schema`, `/orbit/status`). For index-backed tools, record entity counts -- an index with `Vulnerability = 0` makes empty vulnerability results a PASS, not a failure.

```bash
curl -s -X POST http://localhost:<port>/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Phase 1: Read-tool campaign

Order matters: free and discovery tools first, billed tools later, write probes last.

1. Smoke: version/schema/status tools.
2. Discovery reads against a known anchor entity (a real project/cluster/topic you control). Capture real IDs from each response.
3. Chained detail reads: NEVER guess IDs -- list first, then feed the captured ID into the detail tool (list MRs -> get MR -> MR pipelines -> pipeline jobs -> job log). A chain of N tools verified with real data beats N isolated calls with fabricated params.
4. Batch-load tool schemas per family before calling; fire independent calls in parallel.
5. Multi-action tools (list + create/retry/cancel in one tool): inspect the schema first and exercise only the read action.

Record every call in a results matrix as you go:

| tool | family | args | outcome | error text | rationale |

Outcome taxonomy:

- PASS -- correct data, correct shape.
- PASS (behavioral) -- a clean, contract-correct error (e.g. "MR does not have conflicts" on a merged MR).
- ENV-LIMITED -- the environment cannot exercise it (no saved views exist, embeddings still indexing). Validation-layer rejection of a missing required arg counts: it proves registration and schema wiring.
- ENV-DATA-EMPTY -- legitimately empty per the Phase 0 baseline (index count is 0, no failures in window).
- FAIL / TOOL-BUG -- see rubric below.
- SKIPPED-POLICY -- write actions not exercised.

## Phase 2: Bug-vs-environment rubric

Before classifying anything as a bug or accepting anything as "just empty":

- Control probe: run a known-good neighbor tool against the SAME entity. (A project-level issue search returning [] was proven a query-term matter by a group-level search that hit.)
- Read the error phrasing: upstream-phrased errors (GitLab/AWS wording) vs locally-phrased (`Error: ...` from a catch block) point at different layers.
- Suspicious emptiness is a finding, not a result. If the baseline says the index holds 858k ImportedSymbols and a symbol search returns 0, do NOT accept it -- isolate it (Phase 3).
- A transient error deserves one retry with a changed anchor (different symbol, wider time window) before classification.

## Phase 3: Expensive/graph tools deep-dive and the 3-step isolation recipe

Budget first: know the credit guard (e.g. 20 queries/60s) and plan ~10-15 billed calls. Use free rejection paths (selectivity guards, schema endpoints) to verify error handling without spending.

When a composed query tool returns empty against a rich index, binary-search its query:

1. Single-node probe: run the most selective single-entity filter alone (via the raw escape-hatch tool). Rows? The filter grammar and data exist.
2. Join probe: add the relationship/join WITHOUT the suspect extra filters. Rows? The edge exists and resolves.
3. Differential probe: run the tool's EXACT emitted query minus one filter at a time. The filter whose removal makes rows appear is the bug.

This recipe found the GitLab blast_radius bug in three calls: a `file_path contains <groupPath>` filter could never match because the property is repo-relative. Generalization: any filter comparing a scoped/relative property against a global identifier (group path, account id, cluster name) is suspect -- verify against LIVE property values, not against what the property name implies.

Also verify grammar currency: capture the backend's `format_version` (or equivalent) and confirm op shapes/order-by forms against one raw probe. Grammar drift arrives silently.

## Phase 4: Write tools -- validation-only probes

Never send a fully-valid payload at a production target. Two tiers, both zero-mutation:

- Tier 1: call with `{}` (or missing required args). A schema-layer rejection naming the missing fields proves registration and schema conversion.
- Tier 2 (one representative tool): nonexistent target id (e.g. project `999999999999`) expecting an upstream 403/404. Proves end-to-end wiring. Some tools do this for free -- a tool whose zod passes `{}` and gets an upstream "field is missing" has proven the whole path.
- Sandbox mode (only with an explicitly designated scratch project): full round-trip create + cleanup.

## Phase 5: Consumption audit -- can the agent actually use the tool?

A registered tool is worthless if the sub-agent can never select it. Cross-reference four places:

1. Action map reachability: every tool the pipeline depends on must appear in the tool YAML's `action_tool_map` (`agents/incident-analyzer/tools/<ds>-api.yaml`). Remember the action filter only engages above `MAX_TOOLS_PER_AGENT` (25, `packages/agent/src/sub-agent.ts`) -- a server with more tools than the cap makes unmapped tools GENUINELY unreachable, not theoretically.
2. Resolution set: tools that feed typed extractors / correlation rules (`TYPED_FINDING_TOOLS`, `packages/agent/src/correlation/extractors/*`, `rules.ts`) must survive EVERY action selection -- that is `RESOLUTION_TOOLS_BY_DATASOURCE`, not the action map. GitLab's flagship correlation input (`gitlab_list_merge_requests`) was in neither.
3. Contract coherence: if `annotations.read_only: true`, no write-capable tool belongs in the map -- including multi-action tools whose list action hides create/retry/cancel/delete (`gitlab_manage_pipeline`).
4. Description honesty: `action_descriptions` must not advertise capabilities the map cannot select.

Guard the fix with a fixture-drift test that parses the REAL YAML (see `packages/agent/src/sub-agent-gitlab-resolution.test.ts`), so map and tests cannot silently diverge.

## Phase 6: Error-envelope conformance

Every failure path should emit the shared `{ _error: { kind, category, ... } }` envelope (`packages/shared/src/tool-error.ts`, SIO-1087). Prose-only `isError:true` errors classify agent-side as "unknown" and degrade confidence.

Pattern (SIO-1179): steering prose FIRST (the sub-agent LLM reads and follows it), the JSON envelope appended after (the agent's SIO-1159 brace-recovery parses mixed text; duplicate the prose into `_error.advice`). Map routine environment states (index absent, embeddings not ready) to non-degrading kinds (`no-index` -> no-data) so they stop tripping the confidence cap; map rejected queries to `bad-query` (do-not-blind-retry), budget exhaustion to `throttled`. Do not change `isError` semantics in the same pass, and leave upstream error prose passthrough unwrapped -- you cannot classify upstream prose better than the agent's fallback.

## Phase 7: Fixes and verification

Fix classes, in the order that pays off fastest: (1) guaranteed-broken queries (Phase 3 findings), (2) consumption gaps (Phase 5), (3) envelope adoption (Phase 6), (4) handler unit tests (budget guards, availability re-checks, enrichment stitching -- stub the client, capture handlers via a stub `server.tool`), (5) doc drift (compare docs against shipped constants: retry counts, delays, tool counts).

Verification checklist:

- `bun run typecheck && bun run lint && bun run test` (+ `bun run yaml:check` for YAML edits). Expect and document pre-existing failures on main.
- Restart the live server from merged main (kill the exact tracked PID; `bun --hot` does not reliably pick up pulled changes) and re-probe: the fixed tool with the Phase 3 anchor, the new tool count/schema via `tools/list`, and one free error path to see the envelope live.
- Linear issue per concern BEFORE implementation; branches from main; ready-for-review PRs; triage every CodeRabbit finding (fix or decline with evidence -- a live-proven decline can get the finding formally withdrawn).

## Case study anchors (GitLab, 2026-07-23)

- 36/36 tools tested, zero mutations. One TOOL-BUG (blast_radius dead group filter), one critical consumption gap (list_merge_requests unreachable), doc drift (retry policy), envelope absence.
- Full matrix: SIO-1178 description. Fixes: PRs #441, #442.
