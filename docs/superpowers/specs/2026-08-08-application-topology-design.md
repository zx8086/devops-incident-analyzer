# Application Topology (Application Map) Design -- SIO-1457

Date: 2026-08-08
Ticket: https://linear.app/siobytes/issue/SIO-1457
Sibling feature: SIO-1204 network map (`docs/superpowers/specs/2026-07-25-network-topology-kg-design.md`) -- this design mirrors it deliberately, seam for seam.

## Context

The incident analyzer renders a per-incident network map (VPCs, subnets, load balancers, IP bindings) but nothing at the layer users reason about first: which services call which, what datastores and external systems they depend on, and which Kafka topics connect them asynchronously. The application map fills that layer -- "who talks to whom" -- as a second ECharts card, with the same per-turn build + KG persistence lifecycle the network map established.

Decisions made with the user:

- Edge sources: Elastic APM runtime call graph + Kafka consumer topology + KG prior-knowledge overlay. No Konnect (server disabled by design, SIO-1439).
- Datastore/external APM destinations (postgresql, redis, external hosts) render as `dependency` nodes -- the full dependency surface is wanted, not just service-to-service.
- Lifecycle mirrors SIO-1204 exactly; no new pipeline nodes (31-node invariant unchanged).
- `PRODUCES_TO` stays unpopulated: no available tool is a system of record for producers, and an APM span destination naming a broker is not producer evidence either (kafka-shaped destinations are skipped entirely to avoid conflicting with consumer-side edges).

## Data model (`packages/shared/src/agent-state.ts`)

- `ApplicationTopologyNodeSchema`: kinds `service | kafkaTopic | consumerGroup | awsResource | dependency`; APM health tint fields (`errorRate`, `avgDurationMs`, `transactionCount`) on service nodes; `service` = focus-matched KG-write anchor.
- `ApplicationTopologyEdgeSchema`: kinds `calls | consumes | runs-on`; `detail` (latency/error/lag text); `priorKnowledge` flag for KG-overlay edges (rendered dashed, never written back).
- Stable natural-key node ids shared across builder, overlay producer, and KG derive: `svc:<name>`, `topic:<name>`, `cg:<groupId>`, `aws:<arn>`, `dep:<resource>`, `route:<path>` (ApiRoute froms render as service-kind nodes until Konnect is in scope). Focus matching normalizes for comparison only, never for the id.
- New SSE union member `{ type: "application_topology", topology }`.

## Builder (`packages/agent/src/application-topology.ts`)

Pure, sync, total (safeParse everywhere), called twice per turn (aggregate prompt summary + extractFindings state slot -- the SIO-1204 double-build convention). Caps `MAX_NODES=150` / `MAX_EDGES=300`.

Parses raw toolOutputs (never the typed-findings extractors, whose schemas are file-private and rule-engine-scoped):

- `elasticsearch_search` / `elasticsearch_multi_search` (elastic): detection is structural on the response shape -- `ToolOutput` carries no args. Handles both string-shaped rawJson (the elastic MCP's prefixed-text aggregation payload, via a brace-balanced JSON walk) and object envelopes (`aggregations.<agg>` or root). Two shapes:
  - destination aggregation `by_source.buckets[].by_destination.buckets[]` -> `calls` edges. Destination classification: names another source bucket or (non-empty) focus -> service; kafka-shaped (`/^kafka(\/|$)/i`) -> skipped; else -> `dependency` node. The focus check is gated on a NON-EMPTY focus list (`matchesFocus([])` matches everything -- the SIO-1030 empty-collapse contract would misclassify every datastore as a service).
  - `by_service` health aggregation (the existing apmByName shape) -> service-node health tint only, no edges.
- `kafka_describe_consumer_group` (offsets[].topic), `kafka_get_consumer_group_lag` (topics[].topic + totalLag detail), `kafka_list_consumer_groups` (state enrichment only, bare-array or `{groups}` wrapped) -> `consumerGroup`/`kafkaTopic` nodes + `consumes` edges. `KafkaFindingsSchema` is deliberately untouched (zero risk to the SIO-764 rule engine).

`mergeApplicationTopologyOverlay(built, overlay, turn)`: unions KG overlay edges (tagging `priorKnowledge: true`, minting nodes from the id-prefix contract). Overlay-only turns still render. An observed edge wins over its overlay duplicate.

`summarizeApplicationTopologyForPrompt`: max 20 lines; renders calls/consumes/error-rate lines; skips priorKnowledge (aggregate prompt excludes KG content per SIO-1026/1027).

## APM acquisition (`packages/agent/src/app-map-baseline.ts`)

Deterministic post-ReAct baseline, mirroring SIO-1208's rationale: the LLM does not reliably run a destination-service aggregation organically. One direct `elasticsearch_search` call (no LLM round-trip) in sub-agent.ts's elastic branch, skipped when the loop already ran a `by_destination` aggregation. Gates: `APP_MAP_BASELINE_ENABLED` (default ON), `APP_MAP_BASELINE_TIMEOUT_MS` (default 8000), `APP_MAP_BASELINE_LOOKBACK` (default `now-1h` -- a fixed recent window, not the incident window: the map answers "what does the topology look like NOW"). Aggregation: exit spans (`processor.event: span` + `exists span.destination.service.resource`), `by_source` terms on `service.name` (100) -> `by_destination` terms (50) -> avg `span.duration.us` + `event.outcome: failure` filter. Elastic-agent SOUL gains matching discovery guidance as the secondary organic path.

## KG integration

Read (overlay): `appMapForServices(store, services, asOf?)` in `packages/knowledge-graph/src/reader.ts` -- bi-temporal `validityClause` reads of `DEPENDS_ON` (both directions), `RUNS_ON`, `ROUTES_TO` per service, plus one capped `CONSUMES_FROM` fetch filtered by consumer-group name affinity (no Service anchor exists in the schema; 3-char floor). Read in `graphEnrich` (which runs before fan-out -- verified `recordEntities -> graphEnrich -> awsEstateRouter`), timeout-guarded, bounded at 100 edges, into the `applicationTopologyOverlay` replace-reducer slot (cleared in the outer catch, same stale-value hazard as `knownServiceNames`).

Write: `recordAppMapTopologyEdges(store, kind, edges)` in `writer.ts` -- third writer on `DEPENDS_ON`/`CONSUMES_FROM` (after the topology sweep and Orbit), duplicating `recordOrbitDependsOnEdges`'s never-demote policy verbatim: sweep-owned valid edges are no-ops; only unowned or `app-map`-owned edges are claimed; keep-first `tValid` via `backfillEdgeTValid`. Stamp `APP_MAP_DISCOVERED_BY = "app-map"`. Excluded from `TOPOLOGY_KINDS` sweep lifecycle (per-incident partial slices must not feed K-miss invalidation). `deriveApplicationTopology` (`packages/agent/src/application-topology-kg.ts`) maps only observed (non-priorKnowledge) svc->svc calls and cg->topic consumes, capped 50/kind; dependency/route nodes never become DEPENDS_ON rows. Rides `recordConfirmedBindings` behind `KG_APP_MAP_WRITE_ENABLED` (default ON) in its own try/catch with partialFailure reason `app-map-write-failed`.

## SSE + frontend

One-for-one SIO-1204 mirror: sse-pump guarded-parse emit (nodes-only), `agent-reducer` case, `agent.svelte.ts` slot + four teardown resets + message attach, `ChatMessage` render after the network card. `ApplicationTopologyCard.svelte` copies `NetworkTopologyCard` (SSR-safe dynamic echarts import behind `$effect`, zoom/expand toolbar, focus trap); `app-chart.ts` is the pure option transform -- five categories on hues disjoint from the network map's eight, dashed `priorKnowledge` links, red ring at `errorRate >= 0.05` (the ElasticFindingsCard threshold).

## Error handling

Every layer soft-fails independently: builder try/catch in extractFindings and aggregate (belt-and-braces over a pure/total function); baseline timeout/absence/throw contributes nothing; overlay read failure logs and yields `[]`; KG write failure surfaces only as a partialFailure. Nothing in this feature can change an investigation's answer.

## Testing

- `application-topology.test.ts`: real MCP-shaped fixtures (prefixed-text APM payloads, exact kafka envelopes); classification incl. kafka-skip and empty-focus; caps; merge-not-clobber; overlay merge semantics; prompt-summary line cap.
- `app-map-baseline.test.ts`: env tunables; skip/soft-fail/timeout paths; recorded output shape.
- `application-topology-kg.test.ts`: derive excludes priorKnowledge, dep/route froms, self-edges; caps.
- `knowledge-graph.test.ts`: app-map writer provenance stamp; never-demote (sweep-owned edge survives untouched); kind-mismatch skip.
- `graph-knowledge.test.ts`: overlay population + outer-catch clearing.
- `app-chart.test.ts`: categories/symbols, red ring threshold, dashed prior edges, HTML escaping.

## Out of scope (follow-ups)

- Konnect Route->Service edges (blocked on re-enabling the konnect MCP server, SIO-1439).
- A real `apiRoute` node kind (deferred with Konnect).
- Producer-side Kafka edges (`PRODUCES_TO` -- no system of record, deliberate non-goal).
- A standing estate-wide application map surface outside the chat (the KG accretes the data; a viewer is a separate ticket).
- Threading the incident window into the baseline aggregation lookback.
