# SIO-778 — ElasticFindingsSchema (design)

**Status:** Draft 2026-05-18, ready for review
**Epic:** [SIO-778](https://linear.app/siobytes/issue/SIO-778)
**Predecessor specs:**
- `docs/superpowers/specs/2026-05-07-mandatory-cross-agent-correlation-design.md` (SIO-681 correlation framework)
- `docs/superpowers/specs/2026-05-16-sio-764-structured-findings-design.md` (kafka/gitlab/couchbase findings — structural template for this spec)

**Out-of-scope follow-ups:** Phase B (`apmServices`) and Phase C (`logClusters`) implementation tickets land separately after this spec merges; correlation rules that consume `elasticFindings` are deferred under [SIO-773](https://linear.app/siobytes/issue/SIO-773); Konnect findings card explicitly deferred per SIO-785 brainstorming.

## Context

`ElasticFindingsSchema` is the structured channel by which the elastic sub-agent emits typed signal that downstream nodes (rule engine via `enforceCorrelationsAggregate`, the SSE pump's `datasource_result` event, the `ElasticFindingsCard` UI) consume without re-parsing prose. SIO-764 established the per-domain `<Domain>Findings` pattern for kafka, gitlab, and couchbase. The elastic side was not part of SIO-764.

Phase A — synthetic-monitor status — shipped 2026-05-18 inside SIO-785 Phase 2 (PR #118) and SIO-786 (PR #119) **without a design doc**. The schema is now loadbearing: it crosses three packages (`shared`, `agent`, `web`) and one streaming protocol, but no written design exists to anchor extensions. Two natural extensions — APM service summary (Phase B) and top error log clusters (Phase C) — are deferred-but-likely, and each risks landing as ad-hoc additions that:

1. Drift across extractor + schema + UI in shape;
2. Trip the eu-b2b APM plural-vs-singular naming gotcha (`reference_b2b_apm_service_naming`);
3. Bypass the structured-findings-vs-prose contract SIO-764 codified.

This spec retroactively documents Phase A as shipped, then specifies Phase B and Phase C precisely enough that subsequent tickets can execute them without re-deriving shapes from MCP responses.

## Background verified during exploration

Verified against `main@3a04d97` (2026-05-18, post-SIO-786 merge):

- `ElasticFindingsSchema` lives at `packages/shared/src/agent-state.ts:138-141`; supporting `ElasticSyntheticMonitorSchema` at `packages/shared/src/agent-state.ts:129-135`. Field is mounted on `DataSourceResult` at `packages/shared/src/agent-state.ts:202` and on the SSE `datasource_result` event at `packages/shared/src/agent-state.ts:307`.
- Extractor lives at `packages/agent/src/correlation/extractors/elastic.ts` (full file, 237 lines). Handles two input forms: parsed-JSON `SearchResponse` envelopes and SIO-786's joined text-block content (multi-`text` MCP responses joined into a single string by `normalizeToolContent` in `packages/agent/src/sub-agent.ts`).
- Registration at `packages/agent/src/extract-findings.ts:87`: one line, `elastic: (r) => ({ elasticFindings: extractElasticFindings(r.toolOutputs ?? []) })`. No focus-services filtering today (unlike kafka, which filters per `collectFocusServices`).
- Card lives at `apps/web/src/lib/components/ElasticFindingsCard.svelte` (59 lines). Renders one row per synthetic monitor with status dot + name + geo + observedAt.
- The Synthetic-Monitor Cross-Check rule (**SIO-717**) is documented in `agents/incident-analyzer/agents/kafka-agent/SOUL.md:58-68`, **not** the elastic-agent SOUL. The kafka triage flow consumes the synthetic signal even though the elastic sub-agent produces it; this asymmetry is intentional (the cross-check exists to disambiguate kafka-reported Confluent 5xx as agent-side misrouting vs real service outage).
- **Zero correlation rules read `elasticFindings` today.** `packages/agent/src/correlation/rules.ts` does not reference `elasticFindings`. The schema is consumed by the UI card and the SSE event only. Phase A's value is observability-via-card, not rule firing.
- Elastic MCP exposes **no dedicated APM tool** and **no dedicated log-cluster tool**. Both Phase B and Phase C must route through the existing `elasticsearch_search` tool with index-pattern routing (`traces-apm-*` for APM, `logs-*` for logs). This is confirmed by `packages/mcp-server-elastic/src/tools/core/search.ts:496` (the search tool's description explicitly calls out `traces-apm-*` as an example index).
- Existing real-data fixture at `packages/mcp-server-elastic/tests/dev/fixtures/real-elasticsearch-data.json` shows the canonical `logs-*` document shape (lines 23-33: `@timestamp`, `message`, `level`, `service`, `host`, `response_time`, `trace_id`, `user_id`, `request_path`). No APM fixture exists yet; Phase B implementation must capture one from a live `eu-b2b` cluster.
- `distinctiveTokens` at `packages/agent/src/correlation/rules.ts:449-458` is a stopword-filtered tokenizer (lowercase a-z, min length 6). It is a building block for similarity, not a complete similarity function — it returns a token set, not a signature hash.

## Approaches considered

**A. One flat schema, extend with optional fields per phase** (chosen). `ElasticFindingsSchema` stays a single Zod object; Phase B adds `apmServices?`, Phase C adds `logClusters?`. Matches kafka/gitlab/couchbase precedent (`KafkaFindingsSchema` has `consumerGroups?` + `dlqTopics?`; `CouchbaseFindingsSchema` has `slowQueries?`; etc.).

**B. Per-phase sub-schemas merged at extract time.** Each phase ships its own Zod object (`ElasticSyntheticFindingsSchema`, `ElasticApmFindingsSchema`, `ElasticLogFindingsSchema`) and `ElasticFindings` becomes a union or intersection. **Rejected.** More types, no real benefit, breaks parity with other domains, complicates SSE event typing.

**C. Free-form `extras: Record<string, unknown>` escape hatch.** Defeats the typed-findings contract that SIO-764 established. **Rejected.**

A is chosen because it preserves parity across the six findings types, lets each phase land as a minimal additive change, and keeps the SSE event payload trivially typed.

## Recommended approach (A in detail)

### Schema design

Target shape after Phase B + Phase C have shipped. Phase A is unchanged from what's on `main` today.

```ts
// packages/shared/src/agent-state.ts — target shape post-Phase B + C

// === Phase A (shipped 2026-05-18) ===
export const ElasticSyntheticMonitorSchema = z.object({
  name: z.string(),
  status: z.string(),              // "up" | "down" | "degraded" | ...
  url: z.string().optional(),
  observedAt: z.string().optional(),
  geo: z.string().optional(),
});
export type ElasticSyntheticMonitor = z.infer<typeof ElasticSyntheticMonitorSchema>;

// === Phase B (NEW) ===
// One row per APM service observed in the search window. Aggregated from
// `traces-apm-*` index pattern via `elasticsearch_search`. `serviceName` mirrors
// the document field `service.name` verbatim — this means eu-b2b plural form
// (`notifications-service`) on prod, NOT the Kafka group-id singular form
// (`notification-service`). See memory `reference_b2b_apm_service_naming` and
// note in the extractor: rules that cross-reference kafka findings must
// normalise both directions.
export const ElasticApmServiceSchema = z.object({
  serviceName: z.string(),
  environment: z.string().optional(),       // service.environment
  errorRate: z.number().optional(),         // failed_tx / total_tx in window, 0..1
  transactionCount: z.number().optional(),  // total transactions in window
  avgDurationMs: z.number().optional(),     // average transaction.duration.us / 1000
  observedAt: z.string().optional(),        // latest @timestamp in the aggregation
});
export type ElasticApmService = z.infer<typeof ElasticApmServiceSchema>;

// === Phase C (NEW) ===
// One row per distinct error-message cluster observed in the search window.
// Aggregated from `logs-*` index pattern via `elasticsearch_search`.
// `signature` is a deterministic hash of the message after stopword + numeric
// stripping; `sampleMessage` is one representative original message.
export const ElasticLogClusterSchema = z.object({
  signature: z.string(),                    // stable hash (sha1 of sorted token set)
  sampleMessage: z.string(),                // one representative message verbatim
  count: z.number(),                        // total docs in the cluster within the window
  level: z.string(),                        // typically "error"; surface the dominant level
  service: z.string().optional(),           // dominant service.name when one dominates the cluster
  firstSeen: z.string().optional(),         // earliest @timestamp in cluster
  lastSeen: z.string().optional(),          // latest @timestamp in cluster
});
export type ElasticLogCluster = z.infer<typeof ElasticLogClusterSchema>;

// === Composite schema ===
export const ElasticFindingsSchema = z.object({
  syntheticMonitors: z.array(ElasticSyntheticMonitorSchema).optional(),
  apmServices: z.array(ElasticApmServiceSchema).optional(),   // Phase B
  logClusters: z.array(ElasticLogClusterSchema).optional(),    // Phase C
});
export type ElasticFindings = z.infer<typeof ElasticFindingsSchema>;
```

All Phase B/C fields are `.optional()` so checkpointed state from before Phase B/C lands does not fail Zod parsing (`reference_first_deploy_to_fresh_account_bugs` — guard against schema-version skew on rollback).

The SSE event at `packages/shared/src/agent-state.ts:307` already carries `elasticFindings: ElasticFindingsSchema.optional()` — no event-schema change needed when Phase B / Phase C land. This is the structural payoff for choosing approach A.

### Pipeline change

**None for Phase B/C.** The `extractFindings` node (`packages/agent/src/extract-findings.ts:61-107`) already invokes the elastic extractor; new shape fields populate within the same call. The 14-node graph stays 14 nodes.

### Tool output capture

**No `TYPED_FINDING_TOOLS` allowlist change needed.** `elasticsearch_search` is already in the per-domain capture set (Phase A confirmed this works — synthetic monitors are extracted from `elasticsearch_search` outputs today). Adding APM and log-cluster extraction reuses the same tool's output. A future implementer must not add a duplicate entry.

### Per-domain extractor scope

All three branches live in **one file**: `packages/agent/src/correlation/extractors/elastic.ts`. Each branch is a private helper called from `extractElasticFindings`.

#### Branch 1 — synthetic monitors (Phase A, shipped)

Implemented at `packages/agent/src/correlation/extractors/elastic.ts:135-176` (`parseSyntheticMonitorsFromText` for SIO-786 text-block path) + `:190-236` (`extractElasticFindings` JSON-envelope path, with the text-block branch at `:199-209`). Soft-detects synthetic-monitor responses by `toolArgs.index` matching `/synthetics?/i` (`:178-188`) or by `monitor.status` shape detection. Dedupes by `monitor.id || monitor.name`.

#### Branch 2 — apmServices (Phase B, NEW)

Source: `elasticsearch_search` against `traces-apm-*` indices, typically with a terms-aggregation over `service.name`. Real production prompts will issue queries like:

```json
{
  "index": "traces-apm-*",
  "size": 0,
  "query": { "range": { "@timestamp": { "gte": "now-30m" } } },
  "aggs": {
    "by_service": {
      "terms": { "field": "service.name", "size": 50 },
      "aggs": {
        "errors": { "filter": { "term": { "event.outcome": "failure" } } },
        "avg_duration": { "avg": { "field": "transaction.duration.us" } },
        "latest": { "max": { "field": "@timestamp" } }
      }
    }
  }
}
```

The extractor's task is to parse the aggregation buckets from `o.rawJson.aggregations.by_service.buckets[]` and map each bucket to one `ElasticApmServiceSchema` row:

- `serviceName` ← `bucket.key`
- `transactionCount` ← `bucket.doc_count`
- `errorRate` ← `bucket.errors.doc_count / bucket.doc_count` (skip when `doc_count === 0`)
- `avgDurationMs` ← `bucket.avg_duration.value / 1000` (microseconds → ms; skip when `value === null`)
- `observedAt` ← `bucket.latest.value_as_string` (when present)
- `environment` ← deferred to Phase B refinement: requires a secondary terms-agg on `service.environment` within each service bucket; ship Phase B without it and add via follow-up if a rule needs it.

**Detection:** look at `toolArgs.index` for `/traces-apm/i`; fall back to checking whether `rawJson.aggregations?.by_service?.buckets` exists with bucket keys matching service-name shape. Soft-skip when no APM signal — Phase B must not regress Phase A by inferring APM intent from a generic search.

**eu-b2b naming gotcha.** `reference_b2b_apm_service_naming` documents that Elastic APM indexes the **plural** form (`notifications-service`) while Kafka consumer-group ids use the **singular** (`notification-service`). Any future rule that joins `apmServices[].serviceName` to `kafkaFindings.consumerGroups[].name` must apply a normalization. **The extractor stores the verbatim plural form** so the source-of-truth in the card matches the index. A `normaliseApmServiceName()` helper (Phase D, when rule integration arrives) is the right home for the join logic — not the extractor.

#### Branch 3 — logClusters (Phase C, NEW)

Source: `elasticsearch_search` against `logs-*` indices, typically with a filter on `level: "error"` and a time window. Real document shape per `packages/mcp-server-elastic/tests/dev/fixtures/real-elasticsearch-data.json:23-33`:

```json
{
  "_source": {
    "@timestamp": "2025-08-18T07:15:00Z",
    "message": "ERROR: Connection timeout to database server",
    "level": "error",
    "service": "api-gateway",
    "host": "prod-server-01",
    "response_time": 30000
  }
}
```

The extractor's task is to walk `o.rawJson.hits.hits[]`, group by message signature, and emit one row per cluster:

- **Signature.** SHA-1 (hex, 16 chars) of the sorted set of distinctive tokens from `_source.message`. Reuse `distinctiveTokens` from `packages/agent/src/correlation/rules.ts:449-458` — but note it returns a token *set*, not a signature. Phase C must add a thin `signatureFromTokens(tokens: Set<string>): string` helper (lowercase-sort + join + sha1). Place the helper in the extractor file unless a second consumer arrives. **Do not modify `distinctiveTokens` itself** — the deploy-vs-runtime rule depends on its exact behaviour.
- `sampleMessage` ← first message encountered for the cluster (insertion order; messages are typically `@timestamp desc`-sorted by the agent's query).
- `count` ← number of hits whose signature matches.
- `level` ← the modal `_source.level` across the cluster's hits (dominant value; tiebreak alphabetical).
- `service` ← the modal `_source.service` across the cluster's hits, when one value covers ≥50% of hits; otherwise omit.
- `firstSeen` ← `min(@timestamp)` across cluster hits.
- `lastSeen` ← `max(@timestamp)` across cluster hits.

**Top-K cap.** Return at most 10 clusters, sorted by `count` desc. The card row count is the constraint; an unbounded list breaks layout (see Risk register).

**Detection:** check `toolArgs.index` for `/logs-/i` or `_source.level === "error"` on a majority of hits. Soft-skip when the search isn't clearly a log search.

### Rule helper migration

No migration today — zero rules consume `elasticFindings`. Define the future helper signatures here so Phase D rule integration has a target:

```ts
// packages/agent/src/correlation/rules.ts — FUTURE (do not add now)

function getElasticSyntheticMonitor(state: AgentStateType, hostname: string): ElasticSyntheticMonitor | undefined;
function getElasticApmService(state: AgentStateType, serviceName: string): ElasticApmService | undefined;
function getElasticLogClusters(state: AgentStateType, opts?: { minCount?: number }): ElasticLogCluster[];
```

`getElasticApmService` is the natural home for the eu-b2b plural-vs-singular normalisation: accept either form, look up the verbatim plural in `apmServices`, fall back to suffix-match on singular if needed.

## Phasing

### Phase A — Synthetic monitors (SHIPPED 2026-05-18)

Already on `main`. Delivered by:
- PR #118 (SIO-785 Phase 2) — initial extractor + card
- PR #119 (SIO-786) — text-block-format regression fix for real elastic MCP responses

Live-verified against the `ap-cld` synthetic monitor (see `experiments/findings-card-verification.md`, Task 3 section, updated post-SIO-786).

### Phase B — apmServices (one PR, future ticket)

1. Capture a real `traces-apm-*` aggregation response from `eu-b2b` and commit a fixture under `packages/agent/tests/correlation/fixtures/` or inline in the test.
2. Add `ElasticApmServiceSchema` + `apmServices` field in `packages/shared/src/agent-state.ts`.
3. Add an `extractApmServicesFromHits` private helper in `packages/agent/src/correlation/extractors/elastic.ts`; call it from `extractElasticFindings` alongside the synthetic-monitor branch.
4. Add 6-8 unit tests covering: happy path with aggregation buckets, missing aggregation object, zero buckets, divide-by-zero guard for `errorRate`, `avgDurationMs` microsecond → ms conversion, eu-b2b plural service-name preservation.
5. Add an `apmServices` row group to `ElasticFindingsCard.svelte` rendering rows sorted by `errorRate` desc (highest error rate first; nulls last).
6. Update integration replay fixtures (`packages/agent/tests/integration/c72-replay.test.ts`, `packages/agent/tests/integration/styles-v3-replay.test.ts`) if they assert on shape.

**Acceptance:** `bun run typecheck && bun run lint && bun run test` green; manual probe against `eu-b2b` shows the card row populates for at least one service in the SOUL's investigation window; no regression in Phase A synthetic-monitor card rendering.

### Phase C — logClusters (one PR, future ticket)

1. Capture a real `logs-*` error-search response from `eu-b2b` and commit as fixture.
2. Add `ElasticLogClusterSchema` + `logClusters` field in `packages/shared/src/agent-state.ts`.
3. Add `signatureFromTokens` + `extractLogClustersFromHits` private helpers in `extractors/elastic.ts`. Reuse `distinctiveTokens` from `rules.ts` without modification.
4. Add 6-8 unit tests covering: happy path, top-10 cap, single-hit cluster, dominant-service tie-break, level/service modal logic, firstSeen/lastSeen monotonicity, hits-array-missing soft-skip.
5. Add a `logClusters` row group to `ElasticFindingsCard.svelte` rendering top-N rows with `count` (right-aligned, tabular-nums), `sampleMessage` (truncated), `service` (badge), and `lastSeen` (short timestamp).
6. Update integration replay fixtures if they assert on shape.

**Acceptance:** same as Phase B, with the additional check that a deliberately-crafted log query produces ≥2 distinct clusters.

### Phase D — Correlation rule integration (out of scope here)

Tracked under [SIO-773](https://linear.app/siobytes/issue/SIO-773). A new rule reading `elasticFindings` opens its own child ticket per SIO-773's deferral policy, with: the rule's structured signal requirement, required MCP tool calls, registration plan, and tests.

## Non-goals (explicit)

- **Replacing prose `result.data`.** Aggregator and validator keep consuming the prose summary. The card-only consumption of `elasticFindings` is by design (parity with `kafkaFindings` / `gitlabFindings` etc.).
- **LLM-emitted JSON.** Extractors are deterministic TypeScript over raw `elasticsearch_search` output. No SOUL prompt changes.
- **Strict-schema validation rejection.** Extractors continue to parse defensively (try/catch + `safeParse`); they never throw on unexpected shapes. A broken extractor leaves `elasticFindings` empty, not the run failed.
- **Per-deployment blob structure.** Today's flat shape with name-dedupe (synthetic monitors dedupe by `monitor.id || monitor.name`) is the chosen default. Multi-deployment APM aggregation across `eu-b2b` + `ap-cld` is deferred until a real correlation rule needs the disambiguation.
- **New dedicated APM or log-cluster MCP tools.** Index-pattern routing through `elasticsearch_search` is the contract (confirmed by elastic MCP search-tool description at `packages/mcp-server-elastic/src/tools/core/search.ts:496`).
- **Focus-services filtering.** Unlike `extractKafkaFindings`, the elastic extractor does not filter by `state.investigationFocus.services`. Phase A ships unfiltered; Phase B/C can adopt the same `collectFocusServices` helper if cardinality becomes a card-render problem.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Elastic MCP response shape drift (e.g. aggregation envelope renames) breaks Phase B/C extractor | Medium | Soft-fail per branch — broken extractor leaves only that field empty; per-branch fixture pinned. `feedback_extractor_fixtures_must_mirror_real_mcp` mandates capturing real MCP shapes, not invented ones. |
| Phase B extractor confuses generic `elasticsearch_search` outputs for APM | Medium | Strict detection: `toolArgs.index` regex match against `/traces-apm/i` OR `rawJson.aggregations.by_service.buckets` presence. Don't infer APM from message shape. |
| eu-b2b APM plural-vs-singular naming trips a future Phase D rule | High (when Phase D lands) | Document the rule explicitly in the schema comment (above). Provide `getElasticApmService` future-helper signature with normalization responsibility. `reference_b2b_apm_service_naming` captures it. |
| `logClusters` card-render width with N >> 10 rows | Medium | Top-K cap of 10 in the extractor; card sorts by count desc. |
| Schema-version skew on checkpointed state across deploy | Low | All Phase B/C fields are `.optional()`; checkpoint reload tolerates missing fields. |
| Phase C signature collision (two unrelated messages with overlapping distinctive tokens) | Low | Acceptable for an observability card; not a correctness signal. If Phase D rule integration requires stricter clustering, add fuzzy similarity then. |

## Critical files to modify (Phase B + Phase C, when their tickets open)

| File | Phase B change | Phase C change |
|---|---|---|
| `packages/shared/src/agent-state.ts` | Add `ElasticApmServiceSchema`, extend `ElasticFindingsSchema` with optional `apmServices` | Add `ElasticLogClusterSchema`, extend with optional `logClusters` |
| `packages/shared/src/index.ts` | Re-export `ElasticApmServiceSchema` + `ElasticApmService` | Re-export `ElasticLogClusterSchema` + `ElasticLogCluster` |
| `packages/agent/src/correlation/extractors/elastic.ts` | Add `extractApmServicesFromHits` private helper; call from `extractElasticFindings` | Add `signatureFromTokens` + `extractLogClustersFromHits` private helpers; call from `extractElasticFindings` (reuse `distinctiveTokens` from rules.ts) |
| `packages/agent/src/correlation/rules.ts` | No change (no consumers yet; future helpers deferred to Phase D) | No change |
| `apps/web/src/lib/components/ElasticFindingsCard.svelte` | Add `apmServices` row group below the synthetic monitors group | Add `logClusters` row group below `apmServices` |
| `packages/agent/tests/correlation/extractors/elastic.test.ts` | Add 6-8 unit tests | Add 6-8 unit tests |
| `packages/agent/tests/integration/c72-replay.test.ts` + `styles-v3-replay.test.ts` | Update expected `elasticFindings` shape only if assertions narrow on absent fields | Same |

## Verification end-to-end (for Phase B and Phase C implementation tickets, not for this spec)

1. **Unit:** `bun run --filter @devops-agent/agent test` covers the new extractor branches.
2. **Type/lint:** `bun run typecheck && bun run lint` green across all packages.
3. **Integration replay:** start `bun run dev`, fire an elastic-touching query against `eu-b2b`, then inspect the LangSmith trace for:
   - `extractFindings` node appears with `elasticFindings.apmServices[]` (Phase B) or `.logClusters[]` (Phase C) populated.
   - Aggregator output and validator output unchanged in shape.
4. **Live UI check:** card row appears in the browser for a non-trivial input (`bun run --filter @devops-agent/web dev`, port 5173).
5. **No-regression:** rerun the Phase A live-verify query against `ap-cld` (per `experiments/findings-card-verification.md`) and confirm the synthetic-monitors row is unchanged.

## Memory considerations

Memories to read while implementing:

- `reference_b2b_apm_service_naming` — critical for Phase B field-shape decision.
- `reference_elastic_mcp_text_block_response` — Phase A response-form lesson; carries forward to Phase B (different agg envelope but same multi-block possibility).
- `reference_normalize_tool_content` — invariant about what extractors see at the boundary.
- `reference_confluent_synthetic_monitors` — Phase A signal already-stable lesson.
- `feedback_extractor_fixtures_must_mirror_real_mcp` — reinforced by SIO-786; capture real fixtures for Phase B + Phase C, never invent shapes.

Memories to write on Phase B merge:

- `reference_elastic_apm_finding_shape` — the shipped Phase B fields + the eu-b2b plural-form decision, so future rule authors don't re-derive.

Memories to write on Phase C merge:

- `reference_elastic_log_cluster_signature` — the `signatureFromTokens` algorithm + top-K cap decision, so future fuzzy-similarity work knows what it's replacing.
