# HANDOFF: kg-topology collector gaps -- APM truncation, kafka timeout without cancellation, ECS one-shot pagination

- **Date**: 2026-07-15
- **Ticket**: [SIO-1115](https://linear.app/siobytes/issue/SIO-1115/kg-topology-collectors-apm-agg-truncation-kafka-timeout-wo)
- **Parent**: [SIO-1104](https://linear.app/siobytes/issue/SIO-1104) (5a: scheduled topology writer, commit `300365c`)
- **Repo state**: `main` @ `418bbca`
- **Suggested branch**: `simonowusupvh/sio-1115-kg-topology-collectors-apm-agg-truncation-kafka-timeout-wo`

## TL;DR

The 2026-07-15 16:10 topology cron sweep left 3 of 4 sources with `sweepSkipped:true` (elastic truncated, kafka timed out at 60s, aws hit `nextToken`). The `complete`-flag gate is working as designed -- never run the K-miss invalidation sweep on partial data, or valid edges accrue false misses -- but if these conditions are chronic (they will be at this estate size), stale topology edges are NEVER invalidated and blast-radius reads keep treating dead edges as live. Three independent fixes: composite-agg pagination for elastic, bounded-concurrency + per-call timeout for kafka, bounded `nextToken` loop for ECS. Success = a routine cron sweep completes all connected sources with `sweepSkipped` absent.

## Context -- how this ticket came to be

SIO-1104 (5a) landed the topology cron on 2026-07-15 (`packages/agent/src/kg-topology.ts`, cron wrapper `apps/web/src/lib/server/kg-topology-cron.ts`). Its first observed production-style sweep (16:10-16:13) surfaced all three gaps at once. Konnect's `server-not-connected` in the same summary was benign (server intentionally down).

## Shared substrate (read first)

- Collector contract `kg-topology.ts:129-135`: `CollectorResult { kind, edges, complete }`; `complete` true only if every sub-call succeeded and nothing was truncated/capped/paginated.
- Sweep gate `kg-topology.ts:401-408`: `recordTopologyEdges` ALWAYS runs (edges written/revalidated); `sweepStaleTopology` runs only when `complete` -- otherwise `sweepSkipped:true` (also set on the failure paths `:394` and `:410`).
- K-miss lifecycle: `packages/knowledge-graph/src/writer.ts:586-616` (`recordTopologyEdges` -- re-observation resets `consecutiveMisses`, clears `tInvalid`) and `:631-662` (`sweepStaleTopology` -- TS set-diff, `misses >= maxMisses` (default 3, `KG_TOPOLOGY_MISS_THRESHOLD`) sets `tInvalid`; invalidate-not-delete).
- The risk of chronic skips is documented intent (`writer.ts:628-630`, `kg-topology.ts:13-16`) -- the fix is to make sources complete, not to weaken the gate.

## Where the bodies are buried

### Gap 1 -- elastic: `apm service_destination agg truncated; sweep skipped` (eu-cld and us-cld)

Fixed-size nested terms agg at `kg-topology.ts:159-169`: outer `by_service` `terms { field: "service.name", size: 500 }`, inner `by_dest` `terms { field: "span.destination.service.resource", size: 100 }`. Truncation detection in `parseApmServiceDestinationAgg` (`packages/agent/src/resolve-identifiers-parsers.ts:341-379`) via `sum_other_doc_count > 0` on outer (`:359`) and inner (`:370`) nodes. Warn at `kg-topology.ts:196`. `complete` at `:212`.

### Gap 2 -- kafka: `topology collector timed out after 60000ms` + detached `-32001` describes

- `SOURCE_TIMEOUT_MS = 60_000` hardcoded at `kg-topology.ts:71`, applied `:398`.
- `withTimeout` at `kg-topology.ts:118-127` is a bare `Promise.race` -- the losing collector keeps executing (comment at `:68-70` acknowledges it; same limitation documented at `mcp-bridge.ts:150-155`: the adapter SDK accepts no AbortSignal). That is why `kafka consumer-group describe failed ... -32001` for `schema-registry` and `aws-connect-group` logged AFTER `topology sweep complete` -- detached work.
- `collectKafkaConsumption` (`kg-topology.ts:273-303`): list groups (`:281`), `KAFKA_GROUP_CAP = 100` (`:77`, cap => `complete=false` `:285-289`), then a SEQUENTIAL `for` loop (`:291-301`) awaiting one `kafka_describe_consumer_group` at a time. kafka-mcp is AgentCore-backed (`mcp-bridge.ts:103-106`, 35s connect timeout) and gets NO `defaultToolTimeout` from `toolTimeoutFor` (`mcp-bridge.ts:133-144` -- only atlassian-mcp and elastic-iac-mcp), so each describe rides the adapter's 60s default (-32001).

### Gap 3 -- aws: `ecs listing returned nextToken (one-shot read incomplete); sweep skipped`

`collectAwsRunsOn` (`kg-topology.ts:308-360`): one-shot `clustersTool.invoke({})` at `:325` and per-cluster `servicesTool.invoke({ cluster })` at `:330-333`; `hasNextToken` helper `:110-112`; any `nextToken` sets `paginated=true` (`:326`, `:334`) -- there is no loop passing the token back. Warn `:357`, `complete` `:359`.

## The fix (step-by-step)

1. **Elastic -> composite aggregation** (`kg-topology.ts:154-215` + `resolve-identifiers-parsers.ts:341-379`): replace the nested terms agg with a `composite` source on `[service.name, span.destination.service.resource]`, looping on `after_key` with a page-count cap (e.g. `KG_TOPOLOGY_MAX_AGG_PAGES`, default ~10 x size 500 pairs). Composite has no `sum_other_doc_count`; `complete = true` when the loop exhausts, `false` when the page cap binds. Rework the parser to consume composite buckets (drop the `truncated` boolean or repurpose it for the page-cap case). Keep per-deployment fan-out.
2. **Kafka -> bounded concurrency + per-describe timeout** (`kg-topology.ts:273-303`): run describes via `Promise.allSettled` over a small pool (concurrency ~4); wrap each describe in `withTimeout(describe, PER_DESCRIBE_TIMEOUT_MS)` with a value well under the source budget (e.g. 15s) so one stuck group cannot eat the wall clock; any failure/timeout keeps `complete=false` (existing semantics). Detached work shrinks to at most pool-width calls.
3. **kafka-mcp `defaultToolTimeout`** (`packages/agent/src/mcp-bridge.ts:133-144`): add a kafka-mcp branch (env `KAFKA_TOOL_TIMEOUT_MS`, default ~30s -- match `KAFKA_TOOL_TIMEOUT_MS` server-side admin-RPC default of 30s) so per-call failures are deterministic instead of the 60s adapter default. Mirror the SIO-1111 atlassian branch + tests (`mcp-bridge.test.ts` `toolTimeoutFor` describe; own the env var in beforeEach -- .env leak gotcha).
4. **`SOURCE_TIMEOUT_MS` env-tunable** (`kg-topology.ts:71`): `KG_TOPOLOGY_SOURCE_TIMEOUT_MS`, default 60000, lazy-read per the `getSubAgentTimeoutMs(env)` pattern (no module-scope env in packages/agent).
5. **ECS -> bounded pagination loop** (`kg-topology.ts:325`, `:330-333`): loop passing `nextToken` back into the tool args until absent or page cap (e.g. 10 pages); hitting the cap keeps `complete=false` (mirrors `KAFKA_GROUP_CAP`). Parsers (`resolve-identifiers-parsers.ts:426-448`) already extract ARN arrays; the loop lives in the collector.
6. **Docs**: add the new env knobs to `docs/configuration/environment-variables.md` (+ changelog row); update `docs/architecture/knowledge-graph.md` if it describes collector behavior.

## Verification

```bash
cd <repo> && bun run typecheck && bun run lint
bun test packages/agent/src/kg-topology.test.ts packages/agent/src/resolve-identifiers-parsers.test.ts packages/agent/src/mcp-bridge.test.ts
```

New tests to add (mirror existing patterns in `kg-topology.test.ts` -- real-bridge spread + `toolRegistry` stubs `:13-17`, `InMemoryGraphStore` + Cypher-fragment assertions, `apmPayload` helper `:43-52`):
- composite agg: multi-page exhaustion => swept; page-cap bind => `sweepSkipped`.
- kafka: slow describe stub exceeding the per-describe timeout => source completes within budget, `complete=false`, other groups still described (pool isolation).
- ECS: two-page `nextToken` exhaustion => swept; page-cap => `sweepSkipped`.
- `toolTimeoutFor("kafka-mcp")` default + env override.

Manual: `KG_TOPOLOGY_CRON_ENABLED=true KNOWLEDGE_GRAPH_ENABLED=true`, trigger a sweep (or wait for the cron), and expect the summary line to show all connected sources WITHOUT `sweepSkipped` and nonzero invalidation capability (`sweepStaleTopology` read marker `... AS misses` visible in KG store calls under test). Existing sweep summary for comparison: elastic 5 edges / aws 13 edges, all skipped.

## Files to modify

| File | Change |
|---|---|
| `packages/agent/src/kg-topology.ts` | composite agg loop; kafka pool + per-describe timeout; ECS pagination; env-tunable source timeout |
| `packages/agent/src/resolve-identifiers-parsers.ts` | composite bucket parser (rework `:341-379`) |
| `packages/agent/src/mcp-bridge.ts` | kafka-mcp branch in `toolTimeoutFor` |
| `packages/agent/src/kg-topology.test.ts`, `resolve-identifiers-parsers.test.ts`, `mcp-bridge.test.ts` | new coverage |
| `docs/configuration/environment-variables.md` | new knobs + changelog |

## Workflow

Branch off `main`; SIO-1115 Todo -> In Progress -> In Review (ready PR) -> Done only with user approval. Commits `SIO-1115: message` via HEREDOC. The three gaps are separable commits if the diff grows.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Composite agg changes edge set vs terms agg (ordering/pairing) | Medium | Assert identical edges on a fixture that both paths handle |
| Kafka pool worsens AgentCore throttling | Low | Concurrency 4 is modest; per-describe timeout bounds damage |
| Page caps silently bind at larger estates | Medium | Caps keep `complete=false` (sweep skipped, safe) + warn logs |
| Detached work remains (no SDK AbortSignal) | -- | Accepted upstream limitation; bounded by per-call timeouts |

## Out of scope

- The `aws_list_estates` scope-guard false alarm in the same sweep window (SIO-1114).
- `PRODUCES_TO` edges (deliberately absent -- no system of record, SIO-1104 P6).
- Konnect collector (`server-not-connected` is correct when the server is down).
- Weakening the `complete` gate itself.

## Related code references

- Sweep gate + summary: `kg-topology.ts:394-412`; env gates `:46-66`; cron wrapper `apps/web/src/lib/server/kg-topology-cron.ts:19-107` (start callsite `apps/web/src/lib/server/agent.ts:58`).
- K-miss writer: `packages/knowledge-graph/src/writer.ts:586-662`; schema/relations `packages/knowledge-graph/src/schema.ts:112-146`, DDL/ALTER `:279-354`.
- SIO-1111 `toolTimeoutFor` precedent (atlassian 120s): `mcp-bridge.ts:133-144` + `mcp-bridge.test.ts` env save/restore pattern.

## Memory references

- `reference_sio1110_1111_budget_gate_and_atlassian_freshness` (toolTimeoutFor precedent, -32001 semantics)
- `reference_kafka_mcp_tool_count_canaries`, `reference_confluent_prd_ecs_topology` (kafka/AWS estate shape)
- `reference_no_module_scope_bun_env_in_agent` (env knob pattern)
- `reference_time_bomb_correlation_tests` (avoid wall-clock tests)
- `reference_lbug_cypher_and_teardown_gotchas` (KG store test patterns)
