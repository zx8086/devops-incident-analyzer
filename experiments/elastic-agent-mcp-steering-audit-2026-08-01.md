# Elastic-Agent MCP Steering Audit (2026-08-01)

Ran `docs/runbooks/mcp-steering-audit-runbook.md` against elastic-agent, per its Phase 0-5 structure. Ground-truth incident supplied by the user: a Couchbase KV `GetRequest` timeout (`UnambiguousTimeoutException`) on `pvh-services-styles-v3`, `@timestamp: 2026-07-30T20:11:03.920Z`, bucket `default`/scope `styles`/collection `article`.

## Phase 0: Scope

Steering inventory for elastic-agent:
- `agents/incident-analyzer/agents/elastic-agent/SOUL.md` -- dense, load-bearing PHASE 1->2->3 discovery procedure (mandatory deployment scoping, anti-wildcard rule, service classification, one-hop failure-chain follow, ML anomaly guidance).
- No `RULES.md` for this sub-agent (unlike gitlab-agent).
- `agents/incident-analyzer/agents/elastic-agent/skills/ml-anomaly-investigation/SKILL.md` -- ML skill.
- `agents/incident-analyzer/tools/elastic-logs.yaml` -- action map. Its own `search` action description cites `styles-v3` -> `pvh-services-styles-v3` as the WORKED EXAMPLE for name-form resolution, making this incident the canary case the steering was literally written for.
- No styles/couchbase-specific runbook exists under `agents/incident-analyzer/knowledge/runbooks/`.

`bun run --filter '@devops-agent/gitagent-bridge' test`: 341 pass, 0 fail -- clean baseline, budget/citation contracts intact.

## Phase 1: Pass criteria

| # | Behavior | Source | Verify via |
|---|---|---|---|
| 1 | PHASE 1 discovery: deployment-scoped `service.name` terms agg, `size:0`, no filter | SOUL.md | trace args |
| 2 | Name-form resolution `styles-v3` -> `pvh-services-styles-v3` | SOUL.md + action-map | reassembled answer |
| 3 | PHASE 2 broad search across `logs-*,logs-apm.*`, 3 text fields, `now-30d` | SOUL.md | trace args |
| 4 | APM error stream checked for DB/connection-class error | SOUL.md + action-map | trace args + answer |
| 5 | `@timestamp` echoed byte-for-byte UTC | SOUL.md | answer text |
| 6 | One-hop failure-chain: correctly attribute Couchbase as downstream, not fabricate Couchbase findings | SOUL.md | answer text |

Scoring rule: one soft miss earns one re-run (fresh threadId) before calling a genuine defect.

## Phase 2: Replay setup

Fresh process on `:5174` (`KNOWLEDGE_GRAPH_ENABLED=false LIVE_MEMORY_ENABLED=false AGENT_MEMORY_ENABLED=false`), booted from this worktree's checkout (`36a5f23c`, branch `claude/mcp-steering-audit-runbook-900c00`). User's own `:5173` and elastic MCP (`:9080`) were already running -- confirmed via `lsof` before starting, matching the runbook's collision-avoidance guidance. `.env` copied from main's repo root (not `apps/web/.env` -- that path doesn't exist in this repo; root `.env` is what `bun run dev` actually loads). Port bound cleanly at `:5174`, tracked PID 75361 (child vite process 75362), no port-fallback collision.

**Note on `deployment` targeting**: initially misread the tool call args as missing a mandatory `deployment` field per SOUL.md PHASE 1 ("`deployment` is MANDATORY"). User corrected: deployment selection is a UI-level concern. Verified in code (`packages/agent/src/mcp-bridge.ts`): deployment routing for the elastic sub-agent's own tool calls is via `AsyncLocalStorage` + an `X-Elastic-Deployment` header injected by `withElasticDeployment()`, never a literal `deployment` key in the LLM's tool-call JSON -- the schema's `deployment` param is not the mechanism the sub-agent fan-out uses. This was a wrong initial read on my part, corrected before it became a false finding in this report.

## Phase 3: Replay and evidence

Two independent replays, fresh threadId each (curl `--max-time` exceeded on both -- `queryDataSource` alone took 144-163s):

- Replay 1: `queryDataSource` 163,441ms, 63 tool calls, `datasource_result.elasticFindings: {}`, final answer: "zero hits... service is not observable in this cluster."
- Replay 2: `queryDataSource` 144,490ms, 56 tool calls, `datasource_result.elasticFindings.apmServices` lists 6 unrelated services (`CaptureService_*`, `WpnUserService_*`, `ck-services-live`, `ck-services-staging`) -- `pvh-services-styles-v3` never appears. Final answer again concludes absence.

Both runs: `low_confidence` gate fired ("Report confidence is below the review threshold").

**Ground truth, verified independently via direct `elasticsearch_search` against `eu-b2b`** (bypassing the agent entirely):
- `pvh-services-styles-v3`: 58.2M docs in `eu-b2b` (`logs-apm.app.*`), `agent.name` + `service.environment` present -> genuine APM application per SOUL.md's own classification rules, NOT a gateway alias.
- 1,431 hits for `onErrorDropped` on this exact service in `eu-b2b`, `now-30d`.
- Both replays' "service absent / zero hits" conclusion is a **confirmed false negative**, reproduced 2/2 across independent fresh threads -- a genuine defect per the runbook's scoring rule, not noise.

**Tool-call pattern in both replays** (near-identical shape):
- ~20x identical `match_all`/`terminate_after:1` connectivity probes (this is `warmElasticDeployments()`'s intentional SIO-1086 warm-up, one per configured deployment -- benign, not a steering violation, just previously unfamiliar in isolation).
- ~20x identical wildcard discovery agg (`*service*`/`*style*`) -- this IS a SOUL.md violation surface (SOUL.md explicitly prohibits `wildcard` on `service.name` in the sub-agent's own PHASE 1, citing SIO-1277) but turned out to be `resolveIdentifiers`' OWN probe (`anchorWildcards`), a different code path than the sub-agent's SOUL.md-governed tool loop -- not a steering-prose violation, a pre-fan-out infra step with its own (undocumented-to-SOUL.md) wildcard-based discovery contract.
- `elasticsearch_ml_get_anomaly_records` fired mid-sequence, once per replay -- consistent with SOUL.md's "call this tool ONCE per turn" rule; not a violation.
- Sub-agent's own late-stage calls (indices 41-62ish) show repeated, slightly-varied discovery/search attempts against the WRONG (default/unheadered) deployment -- consistent with `deployments.length === 0` fan-out fallback.

## Phase 4: Root cause

Traced via LangSmith child-run archaeology (`entityExtractor` -> `resolveIdentifiers` -> `queryDataSource` -> `checkConfidence`), cross-checked against the actual pipeline code run live with `bun -e` against the real captured MCP payload:

1. `entityExtractor` correctly extracted `investigationFocus.services: ["pvh-services-styles-v3"]` -- entity extraction is NOT the bug.
2. `resolveIdentifiers.probeElastic()` fanned out `elasticsearch_search` discovery-agg calls across all 10 `ELASTIC_DEPLOYMENTS` entries in parallel via `Promise.allSettled`. The `eu-b2b` branch (index 2, confirmed via per-call start-time ordering) correctly found `pvh-services-styles-v3` with 70M docs and full environment breakdown -- verified by replaying `normalizeToolContent` -> `parseElasticServiceEnvAgg` -> `pickServiceCandidates` against the EXACT captured LangSmith payload via `bun -e`: the pipeline logic produces the correct candidate. Parsing and fuzzy-matching are NOT the bug.
3. **`eu-b2b`'s discovery-agg call took 9,422ms** (per its own LangSmith run duration/text). `safeProbe()` in `resolve-identifiers.ts` wraps the ENTIRE `probeElastic()` call -- all 10 deployments together, via one `Promise.allSettled` -- in `withTimeout(fn(), probeTimeoutMs())`, where `DEFAULT_PROBE_TIMEOUT_MS = 8000` and `RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS` is unset in `.env`. Because `Promise.allSettled` only resolves once ALL branches settle, one slow deployment (9.4s > 8s budget) causes the WHOLE probe -- including the other 9 deployments' already-correct results -- to time out and be silently discarded by `safeProbe`'s catch block (`logger.warn` only, no user-visible signal).
4. Confirmed via LangSmith: `resolvedIdentifiers` was `null` in every downstream node's captured inputs (`queryDataSource`, `checkConfidence`) in both replays -- the probe's result never reached graph state.
5. `queryDataSource` -> `selectElasticDeployments` then sees empty `placements`, falls through to the `deployments.length === 0` path (`sub-agent.ts:2009-2012`) with NO `withElasticDeployment` wrapper at all -- the sub-agent's own tool calls carry no deployment header and hit whatever the MCP's default/unheadered deployment is, which does not hold this service's data. The sub-agent then thrashes for 40-60+ calls trying to find a service that was never going to be found under an unscoped/wrong-deployment search, and reports a false absence.

**This is a structural, non-prompt-following defect** -- not "the model ignored steering," but a timeout-budget architecture gap that defeats the SIO-1279 multi-deployment design (which was itself built specifically to fix an earlier version of this same class of bug -- see the code comment at `sub-agent.ts:134-143`) whenever any single deployment among N is even moderately slow. `eu-b2b` at 9.4s is not a pathological outlier; it is a large production cluster (58-70M+ docs for one service alone) that will predictably exceed an 8s shared budget under normal load.

No code fix applied in this session -- root cause diagnosis only, per user's audit request. Candidate fix directions (not evaluated for side effects, flagging for a follow-up ticket):
- Time each per-deployment branch inside `probeElastic`'s `Promise.allSettled` individually instead of wrapping the whole call, so one slow deployment degrades to "missing that one deployment's candidates" rather than discarding all 10.
- Raise `RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS` for estates with known-large deployments.
- Have `safeProbe`'s timeout path return whatever `Promise.allSettled` results are already available (a partial/best-effort read) rather than an all-or-nothing discard.

## Phase 5: Disposition

| Behavior | Verdict | Evidence |
|---|---|---|
| 1. PHASE 1 discovery (deployment-scoped, no filter) | N/A -- superseded by root-cause finding below; the sub-agent's own PHASE 1 never got a chance to run against the right deployment | -- |
| 2. Name-form resolution | PASS (mechanism works; `resolveIdentifiers` itself correctly resolved `pvh-services-styles-v3` before being discarded) | `bun -e` replay of captured payload |
| 3. PHASE 2 broad search | Not reached in a meaningful form -- sub-agent searched the wrong/default deployment | tool-call trace |
| 4. APM error-stream check | Not reached | -- |
| 5. `@timestamp` UTC echo | PASS | reassembled answer text, byte-for-byte match confirmed in both replays |
| 6. One-hop failure-chain (Couchbase attribution) | PASS -- both reports correctly framed the Couchbase exception as the incident's own content, did not fabricate Couchbase-side findings | reassembled answer text |
| **NEW: multi-deployment probe resilience** | **NOT FIXED / OPEN** -- confirmed root cause (8s all-or-nothing `safeProbe` timeout around a 10-way parallel fan-out), reproduced 2/2, no fix applied this session | LangSmith trace IDs below |

**Self-correction note** (per runbook Phase 5.3 discipline): my first-pass read flagged a missing `deployment` field in the sub-agent's raw tool-call JSON as a SOUL.md violation. The user correctly pointed out deployment selection is a UI-level concern; verified in code that deployment routing uses `AsyncLocalStorage`/HTTP-header injection (`withElasticDeployment`), not an LLM-supplied tool argument -- the initial finding was based on an incomplete mental model of the architecture and was corrected before being reported as a defect, in favor of the actual root cause found via trace archaeology.

**Evidence IDs** (project `devops-incident-analyzer`, thread `8c9884e7-3b8f-4169-ace2-847fe77068a5`, replay 2):
- `entityExtractor`: run `019fba36-254b-7246-b043-576b22614d4b`
- `resolveIdentifiers`: run `019fba36-73da-76fb-8db4-d55b243cb43a` (9,827ms total)
- `eu-b2b` discovery-agg probe (the slow one): run `019fba36-7af4-71e5-93ea-3ca6f11f32d7` (9,422ms)
- `queryDataSource`: run `019fba36-9a49-717d-b22f-9e4c1301a764` (`resolvedIdentifiers: null` in inputs)
- `checkConfidence`: run `019fba39-eb68-71c8-aee0-6855365fc879` (`resolvedIdentifiers: null` in inputs)

Replay 1 thread/trace: `019fba30-296a-7143-867b-4c41fc776eef` (same shape, independently reproduced).

## Linear

Not yet filed -- this was a diagnostic audit run at the user's request ("run this for elastic"), not an approved implementation plan. Per this repo's workflow, a Linear issue is required before any code fix begins; this report is the input to that ticket, not a substitute for it.
