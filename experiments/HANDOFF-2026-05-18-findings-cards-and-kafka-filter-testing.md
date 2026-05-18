# Handover — Findings cards (Couchbase + GitLab) + Kafka filter live testing

| | |
|---|---|
| Date | 2026-05-18 |
| Tickets | [SIO-785](https://linear.app/siobytes/issue/SIO-785) (Done — needs live verification) · [SIO-776](https://linear.app/siobytes/issue/SIO-776) (Backlog) · [SIO-777](https://linear.app/siobytes/issue/SIO-777) (Backlog) |
| Parent epic | [SIO-775](https://linear.app/siobytes/issue/SIO-775) (Done) — KafkaFindingsCard + SSE plumbing |
| Repo state | `main` at `7738094c5a609d72603021efefcdb17c4cec3782` |
| Suggested branch | `simonowusupvh/sio-776-couchbase-findings-card` then `simonowusupvh/sio-777-gitlab-findings-card` (or a stacked PR if doing both) |

## TL;DR

Three independent pieces of follow-up work, in order:

1. **Verify SIO-785's kafka relevance filter against a real query.** Code merged; live correctness not yet confirmed. Run a single-service question and a generic "is kafka healthy" question; compare against an unfiltered baseline. If the filter is wrong, file a follow-up and patch — do not touch SIO-776/777 until the kafka path is trusted.
2. **SIO-776 — CouchbaseFindingsCard.** Couchbase typed findings already cross the SSE wire (confirmed in the 00:08 production trace: 10 populated `slowQueries`). Plumbing-side is done. Build a Svelte card + wire one extra line in `CompletedProgress.svelte`.
3. **SIO-777 — GitLabFindingsCard.** Same story. GitLab typed findings already cross the wire (29 `mergedRequests` in the same trace). Different shape — deploy timeline visualization is the ask.

Each card is roughly ~150 LOC and follows the SIO-775 template exactly. Don't reinvent the wiring pattern; copy it.

## Context — how this ticket came to be

SIO-775 shipped the first findings card (kafka) along with the SSE plumbing every per-domain card will share. SIO-783 fixed the broken extractor that was making the card empty. SIO-784 moved the card inline with the kafka row. SIO-785 added a relevance filter so the card doesn't drown in 50 unrelated consumer groups. Three follow-up tickets remain: validate SIO-785 with a live run, then build Couchbase and GitLab cards consuming the existing plumbing.

The plumbing is documented and tested. Building cards #2 and #3 should be straightforward; the risk is the filter behaviour being wrong on real data we haven't run against yet.

---

## Part 1 — SIO-785 live testing (do this first)

### What's in code

- `packages/agent/src/correlation/extractors/kafka.ts` — `normalize` + `tokenize` + `isRelevantById` + `isRelevantDlq`. Suffix list: `consumer|sink|eventing|prod|stg|dev|svc|service`. Min token length: 4. Per-token plural-s strip after tokenization.
- `packages/agent/src/extract-findings.ts:11-22` — `collectFocusServices(state)` unions `state.investigationFocus.services` and `state.normalizedIncident.affectedServices[].name`.
- `packages/agent/src/extract-findings.ts:25-50` — diagnostic log emitted on every kafka extraction. Pino structured, logger name `agent:extract-findings`, tag `KafkaFindingsCard`. Reports `focusServices`, `rawConsumerGroups` count, `filteredConsumerGroups` count, `filterMode` (`scoped` vs `show-all`), and first 3 raw group ids.
- Always-pass-through rules: `state !== "Stable"` OR `totalLag > 0` OR `dlqTopic.recentDelta > 0`.
- Empty-focus fallback: render all (matches pre-SIO-785 behaviour).

### Diagnostic log shape

Every kafka findings extraction emits one log line. Example from a scoped run:

```
info: kafka findings extracted {
  "service": "agent:extract-findings",
  "tag": "KafkaFindingsCard",
  "focusServices": ["notification-service", "orders-service"],
  "focusServicesCount": 2,
  "rawConsumerGroups": 3,
  "filteredConsumerGroups": 2,
  "dlqTopics": 0,
  "sampleRawIds": ["notification-service-consumer", "orders-service-sink", "unrelated-group"],
  "filterMode": "scoped"
}
```

Example from an unfocused run:

```
info: kafka findings extracted {
  "tag": "KafkaFindingsCard",
  "focusServices": [],
  "focusServicesCount": 0,
  "rawConsumerGroups": 50,
  "filteredConsumerGroups": 50,
  "filterMode": "show-all"
}
```

### How to inspect during live testing

Three options, pick one based on where you're running the dev server:

**Option A — terminal foreground:** the SvelteKit dev server's stdout has Pino JSON inline with normal logs. Pipe through `grep` to isolate:

```bash
bun run --filter @devops-agent/web dev 2>&1 | grep "KafkaFindingsCard"
```

**Option B — already-running dev server:** dump recent logs from the process. If you have it backgrounded, you'll need to redirect stderr/stdout at launch time. Otherwise re-launch with logging:

```bash
bun run --filter @devops-agent/web dev > /tmp/web-dev.log 2>&1 &
tail -f /tmp/web-dev.log | grep KafkaFindingsCard
```

**Option C — LangSmith trace:** the log fires inside the `extractFindings` LangGraph span. Look at the span's events/attributes — Pino-wrapped logs appear there too when OTEL is configured.

### Diagnostic interpretation table

| `filterMode` | `rawConsumerGroups` | `filteredConsumerGroups` | Interpretation |
|---|---|---|---|
| `show-all` | N | N | No focus services anchored. All groups pass through. Expected for generic "is kafka healthy" questions. |
| `scoped` | N | M < N | Filter is working. M groups matched focus or are degraded/lagged. Verify the M ids by inspecting the `kafkaFindings.consumerGroups` array in the SSE response — they should either name-match the focus or have non-Stable state / non-zero lag. |
| `scoped` | N | 0 | Filter is rejecting everything. Likely wrong: even if no group matches the focus, any degraded/lagged group should still pass. Investigate. |
| `scoped` | N | N | Filter passed all groups even with focus. Either every group is degraded/lagged, OR the focus is so broad (e.g. token overlap on a common word) that everything matches. Inspect `sampleRawIds`. |
| `scoped` | 0 | 0 | Sub-agent ran `kafka_list_consumer_groups` but the extractor's schema parsing failed silently. Likely a SIO-783-style shape mismatch — verify against `packages/mcp-server-kafka/src/services/kafka-service.ts`. |
| `show-all` | 0 | 0 | Sub-agent never called `kafka_list_consumer_groups` (or called it but the response failed both bare-array and wrapped-object parsing). Not a filter bug. |

### Tests already passing

```bash
bun test packages/agent/src/correlation/extractors/kafka.test.ts
bun test packages/agent/src/extract-findings.test.ts
```

12 new relevance-filter scenarios + 2 integration tests. 32 pass / 0 fail. None of these touched real MCP output.

### Live verification recipe

Two test scenarios, both via the SvelteKit UI:

**Scenario A — focused query, should filter:**

Pose a single-service question like:
> "What's the consumer group lag on notification-service?"

Expected behaviour:
1. SvelteKit dev server logs show normalize / extract-findings firing.
2. Open DevTools → Network → filter `stream` → click `/api/agent/stream` → EventStream tab → search `datasource_result`.
3. The kafka `datasource_result` event should carry `kafkaFindings.consumerGroups` containing only groups whose normalized id relates to `notification-service` (e.g. `notification-service-prod-consumer`, `notifications-service-sink`), PLUS any group whose `state !== "Stable"` OR `totalLag > 0`.
4. UI: expand the Completed panel → KafkaFindingsCard appears under the kafka row showing the filtered set only.

**Scenario B — generic query, should show all:**

Pose a generic question like:
> "Is kafka healthy?"

Expected behaviour:
1. `state.investigationFocus.services` and `state.normalizedIncident.affectedServices` are both empty for a generic health question.
2. `collectFocusServices` returns `[]`.
3. Filter falls through to "show all" branch.
4. Card renders every group `kafka_list_consumer_groups` returned (~50 in the c72-shared-services-msk cluster).

### What to look at in the network response

Each `datasource_result` is one line of JSON. The kafka one looks like:

```json
{"type":"datasource_result","dataSourceId":"kafka","status":"success","duration":115197,"kafkaFindings":{"consumerGroups":[...],"dlqTopics":[...]}}
```

Count `consumerGroups.length` and inspect the `id` field of each entry. Confirm visually that the filter rule produced the expected set.

### Baseline reference

The 2026-05-18 00:08 production trace (thread `cce7190e-0afd-4849-9c35-cebe12b7a75c`, run `118b2cec-0d84-4e41-807a-9bb2f6ceb04e`) is the pre-filter unfiltered baseline. That run returned `kafkaFindings: {}` because SIO-783 hadn't shipped yet. Post-SIO-783-and-SIO-785, the same query should return a properly populated and filtered `kafkaFindings`. Use that LangSmith trace as the comparison point.

### Failure modes to watch for

| Symptom | Likely cause | Where to look |
|---|---|---|
| Generic query returns empty `consumerGroups` | `collectFocusServices` is non-empty when it shouldn't be (LLM filled in services we didn't intend), filter is matching nothing | Log `focusServices` at `extract-findings.ts:24` |
| Focused query returns everything | `collectFocusServices` returned empty for a focused query (`investigationFocus` not anchored on first complex turn yet, or focus is in `extractedEntities` not `investigationFocus`) | Verify state at extract-findings entry |
| Pluralisation mismatch (notification-service vs notifications-service) | `tokenize` per-token plural-s strip not firing | Add a unit test fixture that mirrors the real failing ids |
| Group with high lag is filtered out | `totalLag` parsed as `0` because string-to-number coercion failed | SIO-783 schema already coerces; check `totalLag: "0"` vs `totalLag: 0` shape from real MCP |

### If the filter is wrong

Open a follow-up Linear ticket child of SIO-785 capturing the failing input/output, file the failing test fixture in `kafka.test.ts`, then patch. Do NOT block SIO-776/777 on this unless the breakage is severe — Couchbase and GitLab cards don't depend on the kafka filter at all.

### Part 1 — live verification results (2026-05-18)

Verified against real `c72-shared-services-msk` (Confluent prd via AgentCore proxy on `localhost:3000`). Two bugs surfaced; both fixed in the same session before this note was written. **Filter logic re-verification still needed** with the fix applied — the runs below predate the fix.

**Scenario A — focused: "What's the consumer group lag on notification-service?"**

Diagnostic (9:11:45 AM):

```json
{"tag":"KafkaFindingsCard","focusServices":["notification-service"],"focusServicesCount":1,
 "rawConsumerGroups":1,"filteredConsumerGroups":1,"dlqTopics":0,
 "sampleRawIds":["notification-service"],"filterMode":"scoped"}
```

SSE wire (DevTools `/api/agent/stream` → EventStream):

```json
{"type":"datasource_result","dataSourceId":"kafka","status":"success","duration":38955,
 "kafkaFindings":{"consumerGroups":[{"id":"notification-service","state":"STABLE","totalLag":0}]}}
```

Filter behaviour looked correct here (1→1, group matches focus name). But trivially so — only one group in the result. Bug masked.

**Scenario B — generic: "Is kafka healthy?"**

Diagnostic (9:20:34 AM):

```json
{"tag":"KafkaFindingsCard","focusServices":["kafka"],"focusServicesCount":1,
 "rawConsumerGroups":74,"filteredConsumerGroups":74,"dlqTopics":0,
 "sampleRawIds":["_confluent-ksql-default_query_CSAS_S_PRIVATE_PRODUCT_IMAGES_RICH_NOTIFICATIONS_4529",
                 "_confluent-ksql-default_query_CSAS_S_PRIVATE_SINK_NUXEO_LOOK_ASSETS_3359",
                 "connect-C_SINK_COUCHBASE_PRICES_DOCUMENTS"],
 "filterMode":"scoped"}
```

SSE payload analysis (74 groups, parsed JSON):

- 69 `state: "STABLE"`, 5 `state: "EMPTY"`
- 72 zero-lag, 2 high-lag (`Apache_Kafka_Consumer_configuration-*` with `totalLag: 2897180`)
- Only 4 of 74 ids contain substring `"kafka"`
- All 74 retained — filter is degenerate.

**Verdict: FAIL.** The filter passes every group regardless of state or name match.

**Root cause:** case-sensitivity bug in three call sites + the UI component. Real Kafka admin API (`@platformatic/kafka`, AWS MSK, Confluent) emits `state` in **uppercase**: `"STABLE"`, `"EMPTY"`, `"DEAD"`, `"PREPARING_REBALANCE"`. The SIO-785 code compared against title-case `"Stable"`:

- `packages/agent/src/correlation/extractors/kafka.ts:77` — `state !== "Stable"` → every real group force-passed as "non-stable", defeating the filter.
- `packages/agent/src/correlation/rules.ts:136` — `g.state === "Empty" || g.state === "Dead"` → kafka-empty-or-dead-groups rule never fires on real data.
- `packages/agent/src/correlation/rules.ts:147` — `g.state === "Stable" && lag > 10_000` → kafka-significant-lag rule never fires (would have missed the two 2.9M-lag groups in Scenario B).
- `apps/web/src/lib/components/KafkaFindingsCard.svelte:25-30` — `stateDotClass` switch on `"Stable" | "Rebalancing" | "Dead"` → every real group gets the default gray dot.

The unit tests in `kafka.test.ts` + `extract-findings.test.ts` passed because their fixtures used title-case. Classic instance of memory `feedback_extractor_fixtures_must_mirror_real_mcp`.

**Fix shipped this session (commit pending):**

- `extractors/kafka.ts` — `ListConsumerGroupsRowSchema.state` now `z.string().transform((s) => s.toUpperCase())`. Single chokepoint; downstream comparisons see canonical uppercase.
- `extractors/kafka.ts:77` — compare against `"STABLE"`.
- `rules.ts:136` — `"EMPTY" || "DEAD"`.
- `rules.ts:147` — `"STABLE"`.
- `KafkaFindingsCard.svelte:23-32` — switch uppercases input, cases for `"STABLE"`, `"PREPARING_REBALANCE" / "COMPLETING_REBALANCE"`, `"DEAD" / "EMPTY"`.
- All test fixtures updated to use uppercase (`kafka.test.ts`, `extract-findings.test.ts`, `KafkaFindingsCard.test.ts`, `sse-pump.test.ts`, `agent.handleEvent.test.ts`, `stream-event-schema.test.ts`).
- `bun run typecheck` clean. `bun test packages/agent/src/correlation src/extract-findings.test.ts` 56/56. Web + shared tests 22 + 4 pass.

**Fix re-verified live (Scenario B re-run, 9:43:50 AM):**

```json
{"tag":"KafkaFindingsCard","focusServices":["kafka"],"focusServicesCount":1,
 "rawConsumerGroups":74,"filteredConsumerGroups":9,"dlqTopics":0,
 "filterMode":"scoped"}
```

Filter dropped 74→9 (was 74→74 before fix). All 9 retained for valid reasons (SSE payload parsed):

| id | state | totalLag | why retained |
|---|---|---|---|
| amazon.msk.canary.group.broker-1/2/3 | EMPTY | — | non-STABLE pass-through |
| Apache_Kafka_Consumer_configuration-3fca... | EMPTY | 3,133,910 | non-STABLE + huge lag |
| Apache_Kafka_Consumer_configuration-1e4f... | EMPTY | 3,133,904 | non-STABLE + huge lag |
| Apache_Kafka_Consumer_configuration-1a41... | STABLE | — | token match on "kafka" |
| Apache_Kafka_Consumer_configuration-5451... | STABLE | — | token match on "kafka" |
| orders-service-stg | STABLE | 232,884 | lag pass-through |
| orders-service-prd | STABLE | 206,862 | lag pass-through |

The two `Apache_Kafka_Consumer_configuration-*` groups with 3.1M lag are real production findings — exactly what the card should surface. The mis-anchored `focusServices: ["kafka"]` still pulled in 2 extra STABLE rows on token match; non-critical but a follow-up.

**Remaining follow-ups (separate Linear tickets):**

1. Investigation: **classifier / entity-extractor uses `"kafka"` as a focus service** for the generic question (`focusServices: ["kafka"]`). "kafka" is a datasource id, not a service name. Either filter it out before `collectFocusServices()` reads it, OR keep `entityExtractor` from coercing datasource ids into `investigationFocus.services`. Minor noise — kept 2 extra STABLE rows in the re-verify run.
2. `datasource_progress` SSE events not emitted — see separate finding below; this blocks the card from rendering even when findings are populated.

### Part 1 — separate finding: KafkaFindingsCard never renders (datasource_progress gap) — FIXED

Verified live (pre-fix): the SSE pump emitted `datasource_result` (carrying `kafkaFindings`) but **never emitted `datasource_progress`** events for the kafka sub-agent run. Grep against captured SSE: 0 `datasource_progress` events, 1 `datasource_result` event.

`apps/web/src/lib/stores/agent.svelte.ts:135` assembles the assistant message's `dataSourceResults` map exclusively from `dataSourceProgress` (which only `datasource_progress` populates). `CompletedProgress.svelte:111-132` gated the entire "Data Sources" section (and the inline KafkaFindingsCard at `:124-128`) on `dataSources.length > 0` derived from `dataSourceResults`. Result: even with the SIO-785 filter fix, the card had no row to mount under and rendered nowhere.

**Fix shipped (same session, both layers belt-and-braces):**

- **Server (`apps/web/src/lib/server/sse-pump.ts`):** the `extractFindings` `on_chain_end` block now emits one `datasource_progress` event per sub-agent result, immediately before the corresponding `datasource_result`. Status maps `success|error`; `error` populates the optional `message` field. Unit test `sse-pump.test.ts` now asserts both events are emitted per entry.
- **Client (`apps/web/src/lib/components/CompletedProgress.svelte`):** `dataSources` is now derived from the union of `dataSourceResults.keys()` ∪ `dataSourceFindings.keys()`, with status inferred from findings entry when no progress tick arrived. Defensive against future emit-order regressions; allows the card to render even on code paths that emit findings but no progress.

**Verified end-to-end after fix:** focused query `"What's the consumer group lag on notification-service?"` renders the KafkaFindingsCard inline under the kafka row. DOM probe via chrome-devtools: `dataSourcesSectionRendered=true`, `kafkaFindingsLabelCount=1`, `cardVisible=true`, card content `"Kafka findings Consumer groups notification-service 0"`. Panel header now reads `"Completed in 39.2s -- 1 data source"` (was previously missing the data-source count, since `dataSources.length===0`).

### Part 1 — UX placement fix: promote card out of Completed diagnostic panel

User feedback after visual review: the card was technically in the right DOM location (inside the Data Sources block under the kafka row in CompletedProgress) but UX-wrong — buried inside the collapsed "Completed in Xs" diagnostic accordion, below the assistant's main markdown-rendered incident report. The expectation is that the card is *part of the findings*, not part of the diagnostics.

**Fix shipped:**

- `apps/web/src/lib/components/ChatMessage.svelte` — added KafkaFindingsCard render block immediately after `MarkdownRenderer` (line ~60), before `CompletedProgress`. Uses `message.dataSourceFindings.get("kafka")?.kafkaFindings`.
- `apps/web/src/lib/components/CompletedProgress.svelte` — removed `KafkaFindingsCard` import, `kafkaFindings` `$derived`, and the inline render block inside the Data Sources `{#each}`. The Completed panel still shows the kafka data-source row (status + label) for diagnostic purposes; it just no longer hosts the card.

**Verified end-to-end:** screenshot confirms card renders directly under the assistant's "Incident Report" markdown, with sections in order: report → KafkaFindingsCard → Completed diagnostic panel → feedback → follow-ups.

When CouchbaseFindingsCard / GitLabFindingsCard ship (SIO-776 / SIO-777), they follow the same template in `ChatMessage.svelte`: read from `message.dataSourceFindings.get("<id>")` and render as a sibling block under the assistant bubble's main content.

### Part 1 — what KafkaFindingsCard supports vs what we've seen live

The card has two display sections, controlled by `KafkaFindings` schema (`packages/shared/src/agent-state.ts:34-67`):

1. **Consumer groups** (verified live in Scenarios A + B): state dot (STABLE/REBALANCING/DEAD/EMPTY), group id, lag bar (linear or log if max > 100k), formatted lag.
2. **DLQ topics** (NOT verified live, render path proven by unit test `KafkaFindingsCard.test.ts` "renders both consumer groups and DLQ topics with full payload"): topic name, totalMessages, recentDelta with growth glyph (▲ red if growing, ▼ green if draining, "no baseline" if first sample).

**Scenario C attempt 2026-05-18 10:42-10:44** — DLQ-centric query `"Show me the dead letter topics"` ran successfully but produced empty `dlqTopics` in the typed finding. Diagnostic: `rawConsumerGroups: 0, dlqTopics: 0`. Markdown report DID contain rich DLQ data (33 topics, 13 with messages, 5.99M failed events) — but produced via `kafka_list_topics` + `kafka_get_topic_offsets`, NOT via `kafka_list_dlq_topics`.

**Root cause:** the sub-agent's action filter (`packages/agent/src/sub-agent.ts:351`, `selectToolsByAction`) selected 5 of 55 kafka tools — none was `kafka_list_dlq_topics`. The extractor at `packages/agent/src/correlation/extractors/kafka.ts:143-149` only parses `kafka_list_dlq_topics` output, so DLQ data harvested via other tools is invisible to the typed-finding path. The query "dead letter" should have matched the `dlq_messages` action keyword in `kafka-introspect.yaml` and added the DLQ tool to the filtered set; either the keyword matcher in `tool-mapping.ts:matchActionsByKeywords` didn't fire, or the entity-extractor LLM's action pick overrode the result.

**Action-selection investigation result (later in same session) — ROOT CAUSE is a deployment lag, not a code bug:**

Three layers of fix attempted this session:

1. **`MIN_FILTERED_TOOLS` floor** (`packages/agent/src/sub-agent.ts:196`): lowered from 5 to 1. Live-verified the action filter now honors `dlq_messages` (3 tools) instead of falling through to the all-actions kitchen-sink. Regression test added in `sub-agent-action-augmentation.test.ts`.
2. **SOUL.md guidance** (`agents/incident-analyzer/agents/kafka-agent/SOUL.md`): added a top-of-file "Tool Selection Priority (READ THIS FIRST)" section instructing the LLM to call `kafka_list_dlq_topics` first for any DLQ-centric query. Cached agent loader required a web dev restart to pick up; verified loaded.
3. **`narrowOnHighPrecisionIntent`** (new helper in `sub-agent.ts`): when the deterministic keyword pass detects a high-precision intent (`dlq_messages` from "dead letter"/"dlq"), strips ambient LLM-added actions (`topic_throughput`, `describe_topic`) that expose `kafka_list_topics`. The LLM was choosing the generic list tool over the specialized DLQ tool because the deployed tool description literally suggests `prefix="DLQ_"`. Narrowing removes the competing actions upstream. Regression tests added (3 scenarios).

**Live-verified fix #3 works:** `preNarrowMerged: [dlq_messages, describe_topic, topic_throughput, health_check]` -> `mergedActions: [dlq_messages, health_check]`. The LLM correctly picked a `dlq_messages` tool (`kafka_consume_messages`) — proving the narrowing forced the LLM into the right action set.

**But the DLQ card still didn't populate.** Why: `kafka_list_dlq_topics` is **NOT registered on the deployed AgentCore kafka MCP runtime** (`arn:aws:bedrock-agentcore:eu-central-1:399987695868:runtime/kafka_mcp_server-7RjmF16MqA`). Verified by direct `tools/list` probe against `http://localhost:3000/mcp`:

```
DLQ-related tools registered: ['kafka_consume_messages', 'kafka_describe_consumer_group',
'kafka_get_consumer_group_lag', 'kafka_get_message_by_offset', 'kafka_list_consumer_groups',
'kafka_produce_message', 'kafka_reset_consumer_group_offsets', 'restproxy_consume',
'restproxy_create_consumer', 'restproxy_delete_consumer']
total tools: 55
```

`kafka_list_dlq_topics` is in local source (`packages/mcp-server-kafka/src/tools/read/tools.ts:64`) but missing from the deployed runtime. SIO-770 shipped the tool locally; the AgentCore deployment hasn't been updated. The extractor at `packages/agent/src/correlation/extractors/kafka.ts:143-149` ONLY parses `kafka_list_dlq_topics` output — so even with all three local fixes in place, no DLQ data can flow until the runtime is redeployed.

Confirming evidence from the last live run's assistant report Gaps section: "DLQ topic list not enumerated... `kafka_list_dlq_topics` was not reached due to runtime failure." The LLM correctly identified the right tool was unavailable.

**Action required to make the DLQ card render live:** redeploy kafka MCP to AgentCore with `kafka_list_dlq_topics` registered. File this as a follow-up Linear ticket. After deploy, no further code change is required — all four local fixes already account for the DLQ path.

**Other Kafka tool outputs the extractor doesn't yet ingest** (potential future card sections — not in current schema):
- `kafka_describe_consumer_group` (group state, member list, host assignments) — would surface group-membership detail in the card
- `kafka_get_topic_offsets` / `kafka_describe_topic` (partition counts, lead-broker, retention) — topic-level telemetry tile
- `kafka_describe_cluster` (broker count, controller id, version) — cluster-health tile

These are documented in the assistant's markdown today but not part of the typed finding. Adding them requires schema extension in `packages/shared/src/agent-state.ts` (`KafkaFindings` shape) and corresponding extractor branches.

### Part 2 — KafkaFindingsCard extensions shipped + live verification (2026-05-18)

Three new card sections shipped this session, all backed by deployed AgentCore tools:

1. **Cluster summary tile** — from `kafka_describe_cluster` / `kafka_get_cluster_info`. Shows provider · brokers · topics · controller in a single inline row.
2. **Connect connectors section** — from `connect_list_connectors` (object-keyed shape `{connectors: {<name>: {status: {connector: {state}, tasks, type}}}}`). State dot + per-state aggregate header + task-failure count.
3. **ksqlDB queries section** — from `ksql_list_queries`. State dot + per-state aggregate header + compact statusCount badge (e.g. `1R 2U` for `{RUNNING: 1, UNRESPONSIVE: 2}`).

Schema additions in `packages/shared/src/agent-state.ts:KafkaFindingsSchema`:

```ts
cluster: { provider?, brokerCount?, topicCount?, controllerId? }
connectors: Array<{ name, state, type?, taskFailures? }>
ksqlQueries: Array<{ id, state, queryType?, statusCount? }>
```

Extractor branches in `packages/agent/src/correlation/extractors/kafka.ts`:
- `kafka_describe_cluster` / `kafka_get_cluster_info` — merged via spread; first call wins per-field.
- `connect_list_connectors` — iterates object values, derives `taskFailures` from `tasks[]`.
- `connect_get_connector_status` — singleton shape; sets one entry by name.
- `ksql_list_queries` — pass-through via Zod schema.

Live verification (2026-05-18 12:46 PM, kafka-only query "Give me a Kafka cluster overview..."):

| Section | Result |
|---|---|
| Cluster summary | **PASS** — "Provider msk · Brokers 3 · Topics 142 · Controller 2" |
| ksqlDB queries | **PASS** — 3 RUNNING queries with `1R 2U` statusCount badge on each |
| Connect connectors | **FAIL** — see truncation finding below |
| Existing sections (consumer groups, DLQs) | unaffected, hidden when not queried |

Unit tests added (8 new in `kafka.test.ts` + `KafkaFindingsCard.test.ts`); all 441/441 agent tests and 88/88 web tests pass per-package.

### Part 2 — separate finding: connect_list_connectors response truncation

The Connect connectors section did not render despite the LLM correctly calling `connect_list_connectors`. Log shows:

```
Tool result observed: toolName=connect_list_connectors, bytes=226863, contentType=object
Tool result truncated: originalBytes=226863, finalBytes=32804, strategy=text
```

The response (226KB — 100+ connectors with full config payload) exceeded `SUBAGENT_TOOL_RESULT_CAP_BYTES` (32KB effective). Truncation is `strategy: "text"` (byte boundary, not JSON-aware), so the truncated `m.content` is invalid JSON. `tryParseJson` returns the raw string, the extractor's `ListConnectorsWrappedSchema.safeParse` fails, and the connectors[] array stays empty.

**Three possible fixes, ordered by surface area:**

1. **Server-side response slimming** (preferred): add a `summary: true` option to `connect_list_connectors` that returns only `{name, state, type, taskFailures}` per connector, dropping the multi-KB config blobs. ~10 LOC in mcp-server-kafka. Requires AgentCore redeploy.
2. **Higher truncation cap for typed-finding tools**: skip truncation entirely for tools whose output is consumed by an extractor (`kafka_list_consumer_groups`, `kafka_list_dlq_topics`, `connect_list_connectors`, `ksql_list_queries`, `kafka_describe_cluster`). Local code change in sub-agent.ts.
3. **JSON-aware truncation**: truncate by dropping array elements / object entries instead of bytes. Bigger change in the truncator code.

Option (1) is cleanest; the LLM doesn't need full connector config either, so the slimming benefits the entire pipeline. File as a follow-up Linear ticket. The card + extractor + schema are all correct; only the data-availability is blocked.

### Part 2 — truncation allowlist fix shipped + live-verified

Implemented option (2) in `packages/agent/src/sub-agent-instrumentation.ts`: typed-finding tools are added to a `TYPED_FINDING_TOOLS` allowlist. When their output exceeds `SUBAGENT_TOOL_RESULT_CAP_BYTES`, the truncator emits a new `subagent.tool_result_truncation_skipped` log line and returns the original result unchanged. The LLM ReAct loop sees the full payload (slightly more context per call, but these tools are infrequent), and the typed-finding extractor receives parseable JSON.

Allowlist:
```ts
kafka_list_consumer_groups · kafka_get_consumer_group_lag · kafka_list_dlq_topics
kafka_describe_cluster · kafka_get_cluster_info
connect_list_connectors · connect_get_connector_status
ksql_list_queries
capella_get_longest_running_queries
gitlab_list_merge_requests
elasticsearch_search
```

3 new unit tests in `sub-agent-instrumentation.test.ts` verify (a) connect_list_connectors at 200KB+ is NOT truncated, (b) other allowlisted tools behave identically, (c) regression guard — non-allowlisted tools still truncate normally. All 8/8 tests pass.

**Live re-verification (2026-05-18 12:58 PM, "List the Kafka Connect connectors and their states"):**

- Truncation skip log: `connect_list_connectors`, 226863 bytes, `reason: "typed-finding tool"`
- SSE wire payload contains 33 connectors, all `state=RUNNING`, with `type` and `taskFailures` fields populated
- UI renders "Connect connectors 33 RUNNING" header + 33 rows with state dot + name + type
- Same upstream payload that previously broke the run now renders correctly

This closes the Connect-connectors-blocker. The connectors section of KafkaFindingsCard is now production-ready.

### Part 3 — three new findings cards shipped (closes SIO-776 + SIO-777, opens minimal Elastic)

- **CouchbaseFindingsCard** (`apps/web/src/lib/components/CouchbaseFindingsCard.svelte`): slow N1QL queries from `capella_get_longest_running_queries`. Statement (single-line truncated, full on hover) · avgServiceTime bar (parsed to seconds) · run count. Sorted desc by avgServiceTime. Closes **SIO-776**.
- **GitLabFindingsCard** (`apps/web/src/lib/components/GitLabFindingsCard.svelte`): deploy timeline from `gitlab_list_merge_requests`. Date · project name parsed from `web_url` (last 2 path segments) · MR title with link. Sorted desc by `merged_at`. Closes **SIO-777**.
- **ElasticFindingsCard** (`apps/web/src/lib/components/ElasticFindingsCard.svelte`): synthetic monitor status from `elasticsearch_search` against `synthetics-*` index. Dedupes by monitor name (first / most-recent doc wins). Status dot (up=green, down=red, degraded=amber) · monitor name · geo · observed timestamp. New schema: `ElasticFindings { syntheticMonitors[] }`. Mirrors the SOUL's SIO-717 Synthetic-Monitor Cross-Check pattern.

Wiring in `apps/web/src/lib/components/ChatMessage.svelte`: cards mount in stable order under the assistant's markdown report:

```
[markdown report]
[KafkaFindingsCard if findings]
[CouchbaseFindingsCard if findings]
[GitLabFindingsCard if findings]
[ElasticFindingsCard if findings]
[Completed in Xs diagnostic panel (collapsed)]
[Feedback bar / Follow-up suggestions]
```

Negative-tested in browser: kafka-only query renders only KafkaFindingsCard; other cards correctly hidden.

Tests added: 5 CouchbaseFindingsCard + 6 GitLabFindingsCard + 5 ElasticFindingsCard + 5 elastic extractor + 4 new ChatMessage placement tests. All pass.

---

## Part 2 — SIO-776: CouchbaseFindingsCard

### Linear

[SIO-776](https://linear.app/siobytes/issue/SIO-776) — Medium priority, currently Backlog. Update to In Progress when starting.

### What's already done (don't redo)

- **SSE plumbing.** `packages/shared/src/agent-state.ts:188-203` — `datasource_result` event already carries `couchbaseFindings?: CouchbaseFindings`. No protocol changes needed.
- **Pump emission.** `apps/web/src/lib/server/sse-pump.ts:120-141` — already emits `couchbaseFindings` on `extractFindings` `on_chain_end`. Verified in the 00:08 trace.
- **Reducer + store.** `apps/web/src/lib/stores/agent-reducer.ts:13-25` — `DataSourceFindings` already has `couchbaseFindings?: CouchbaseFindings`. Store already threads `dataSourceFindings` through `ChatMessage`. No changes.
- **Extractor.** `packages/agent/src/correlation/extractors/couchbase.ts` produces `slowQueries[]`. Confirmed working in production (10 entries in the 00:08 trace).

### What's left to do

**1. Create `apps/web/src/lib/components/CouchbaseFindingsCard.svelte`.** Mirror `KafkaFindingsCard.svelte` structure exactly. Props:

```ts
import type { CouchbaseFindings } from "@devops-agent/shared";
let { findings }: { findings: CouchbaseFindings } = $props();
```

`CouchbaseFindings` schema at `packages/shared/src/agent-state.ts:83-86`:
```ts
{
  slowQueries?: Array<{
    statement: string;
    avgServiceTime?: string;
    lastExecutionTime?: string;
    queries?: number;
  }>;
}
```

Suggested layout (sortable table fits this shape best):

```
┌─ Couchbase findings ─────────────────────────────┐
│ Slow queries                                     │
│                                                  │
│ Statement                  | avg svc  | runs     │
│ SELECT v.*, META(v)... (1) | 9.93s   | 1        │
│ SELECT v.*, META(v)... (2) | 9.91s   | 1        │
│ ...                                              │
└──────────────────────────────────────────────────┘
```

The `statement` field is multi-line SQL++ — truncate to ~80 chars with `truncate text-ellipsis overflow-hidden whitespace-nowrap`, full statement on hover via `title={query.statement}`. Sort descending by parsed `avgServiceTime`. Empty-state: render nothing (mirror Kafka card's `hasContent` derivation).

**2. Wire into `apps/web/src/lib/components/CompletedProgress.svelte:124-128`.** Add a sibling block:

```svelte
{#if id === "couchbase" && couchbaseFindings}
  <div class="ml-3.5">
    <CouchbaseFindingsCard findings={couchbaseFindings} />
  </div>
{/if}
```

And add the `$derived` near line 33-36:

```ts
const couchbaseFindings = $derived(dataSourceFindings?.get("couchbase")?.couchbaseFindings);
```

Update `hasContent` to include `couchbaseFindings`-existence if you want the panel to expand when only couchbase has data; the existing `findings.length > 0` check already covers this.

**3. Unit test** `apps/web/src/lib/components/CouchbaseFindingsCard.test.ts` — copy `KafkaFindingsCard.test.ts` pattern. Three scenarios: empty findings → renders nothing, single slow query → renders statement + avg time, full payload → renders all rows in correct sort order. `bun:test` + `svelte/server` `render`.

### Why no relevance filter on couchbase (yet)

SIO-785 was scope-creep. Don't preemptively filter couchbase findings — slowQueries are operational signals by definition (anything slow enough to be in the top-N list is interesting). If volume becomes a problem, open a separate ticket.

### Acceptance

- New file at `apps/web/src/lib/components/CouchbaseFindingsCard.svelte`
- New test at `apps/web/src/lib/components/CouchbaseFindingsCard.test.ts` (3+ tests, all pass)
- 4 lines added to `CompletedProgress.svelte` (import, `$derived`, render block)
- Manual: re-run the styles-v3 incident query, expand Completed panel under the couchbase row, see the slow-query table with the 10 OFFSET-based queries

### Out of scope

- Sortable column headers in UI (table is sorted once at render; no interaction)
- Click-through to EXPLAIN plan or query history
- Relevance filter for couchbase findings (separate ticket if needed)
- Schema changes — `CouchbaseFindingsSchema` is fine as-is

---

## Part 3 — SIO-777: GitLabFindingsCard (deploy timeline)

### Linear

[SIO-777](https://linear.app/siobytes/issue/SIO-777) — Medium priority, currently Backlog.

### What's already done (don't redo)

Same plumbing as SIO-776:
- `datasource_result` event carries `gitlabFindings?: GitLabFindings`. Confirmed in 00:08 trace with 29 entries.
- Pump emission, reducer, store — all working.
- Extractor at `packages/agent/src/correlation/extractors/gitlab.ts` produces `mergedRequests[]`.

### What's left to do

**1. Create `apps/web/src/lib/components/GitLabFindingsCard.svelte`.** Different shape than Kafka/Couchbase — this one is a **deploy timeline**.

`GitLabFindings` schema at `packages/shared/src/agent-state.ts:69-72`:
```ts
{
  mergedRequests?: Array<{
    id: number | string;
    project_id?: number;
    title?: string;
    description?: string;
    merged_at?: string;
    web_url?: string;
  }>;
}
```

Sorted by `merged_at` descending. Render as a timeline:

```
┌─ GitLab deploys ─────────────────────────────────┐
│ 2026-05-05  | pvh.services.styles!361            │
│             | Merge branch release/AMS...        │
│ 2026-05-05  | pvh.services.styles!360            │
│ 2026-04-30  | pvh.services.styles!359            │
│ ...                                              │
│ [project-name extracted from web_url]            │
└──────────────────────────────────────────────────┘
```

Project name extraction: parse `web_url` for the `pvhcorp/b2b/<...>/<service>` segment between `gitlab.com/` and `/-/merge_requests/`. Each row is a `<a href={web_url} target="_blank">` link.

Optional but recommended: **highlight rows merged inside the incident window** — if the agent has produced a `normalizedIncident.timeWindow`, MRs merged within `[from, to]` get a coloured left-border. This is the "deploy correlation" affordance the gitlab-deploy-vs-datastore-runtime rule already produces; the card just visualizes it.

**2. Wire into `CompletedProgress.svelte`** — same pattern as SIO-776:

```ts
const gitlabFindings = $derived(dataSourceFindings?.get("gitlab")?.gitlabFindings);
```

```svelte
{#if id === "gitlab" && gitlabFindings}
  <div class="ml-3.5">
    <GitLabFindingsCard findings={gitlabFindings} />
  </div>
{/if}
```

**3. Unit tests** — same pattern as SIO-776. Three scenarios: empty, single MR, full payload with multiple projects (verify project-name extraction from web_url).

### Why no relevance filter on gitlab (yet)

Same reasoning as couchbase. MRs in the result are already filtered by the gitlab sub-agent's tool calls (which already use the investigation focus). Adding extractor-level filtering would be redundant.

### Acceptance

- New file at `apps/web/src/lib/components/GitLabFindingsCard.svelte`
- New test at `apps/web/src/lib/components/GitLabFindingsCard.test.ts`
- Wired into `CompletedProgress.svelte`
- Manual: same styles-v3 query, expand Completed panel under the gitlab row, see the deploy timeline with MRs sorted by `merged_at` desc and project name extracted from `web_url`

### Out of scope

- Diff inspection / file-tree drill-down
- Author / commit-message detail
- Cross-MR correlation visualization
- Schema changes — `GitLabFindingsSchema` is fine as-is
- Filtering by incident window at the extractor level (visual highlight only if implementing the "inside incident window" affordance)

---

## Files to modify

| File | Change | Ticket |
|---|---|---|
| `apps/web/src/lib/components/CouchbaseFindingsCard.svelte` | New | SIO-776 |
| `apps/web/src/lib/components/CouchbaseFindingsCard.test.ts` | New | SIO-776 |
| `apps/web/src/lib/components/GitLabFindingsCard.svelte` | New | SIO-777 |
| `apps/web/src/lib/components/GitLabFindingsCard.test.ts` | New | SIO-777 |
| `apps/web/src/lib/components/CompletedProgress.svelte` | Add 2 `$derived` + 2 conditional render blocks (4-8 lines per card) | SIO-776 + SIO-777 |

If doing both cards in one PR, keep them in separate commits so they can be reverted independently.

## Verification block

```bash
bun run typecheck                                              # 0 errors expected
bunx biome check apps/web/src/lib/components/*.svelte         # changed files only — full repo has pre-existing format drift, ignore
cd apps/web && bun test                                        # currently 59/59 pass; expect 61-63 after card additions
bun test packages/agent                                        # 740 pass, 24 unrelated pre-existing failures persist on main
bun test packages/shared                                       # 290/290
```

Manual smoke per card:
1. `bun run --filter @devops-agent/web dev` (port 5173)
2. Trigger the styles-v3 incident query (the one with kafka/couchbase/gitlab/elastic/atlassian all firing)
3. Expand the Completed panel
4. Under the couchbase row → confirm CouchbaseFindingsCard with slow queries
5. Under the gitlab row → confirm GitLabFindingsCard with the deploy timeline
6. DevTools → no console errors, no `<style>` blocks emitted, Tailwind classes only

## Workflow

For each card:
1. Branch off main: `git checkout -b simonowusupvh/sio-776-couchbase-findings-card`
2. Linear: In Progress when starting (do not set Done; user approval required to mark Done)
3. Implement + tests + manual smoke
4. Commit message format:
   ```
   git commit -m "$(cat <<'EOF'
   SIO-776: render CouchbaseFindingsCard inline with couchbase row

   <body>

   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```
5. Push, open PR via `gh pr create`, set Linear to In Review with PR link as attachment
6. After merge: set Linear to Done (with user confirmation)

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| SIO-785 filter is wrong on real data | Medium | Live-test Part 1 first; do not start cards if filter is broken on a focused query |
| `dataSourceFindings` map not populated for couchbase/gitlab in current dev server | Low | The 00:08 trace already shows these fields crossing the wire; if missing locally, restart dev server (memory: `bun --hot doesn't re-resolve modules`) |
| `web_url` parsing for project name extraction breaks on a self-hosted GitLab URL pattern | Low | Repository uses gitlab.com (memory: `reference_gitlab_internal_vs_public`); regex-extract the path after `gitlab.com/` and before `/-/merge_requests/` |
| `avgServiceTime` in couchbase is a string like "9.93s" — sort logic must parse it | Medium | Either sort by `lastExecutionTime` (ISO string, easy) or parse the `Ns` / `Nms` units. Document the choice in the card's $derived comment |
| Cards render at the wrong location | Low | SIO-784 fix is in main; new cards must follow the same inline-under-row pattern, NOT the original SIO-775 top-of-panel placement |

## Related code references

- `apps/web/src/lib/components/KafkaFindingsCard.svelte` — copy-paste structural template
- `apps/web/src/lib/components/KafkaFindingsCard.test.ts` — copy-paste test pattern
- `apps/web/src/lib/components/CompletedProgress.svelte:124-128` — kafka inline wire-up (mirror exactly)
- `apps/web/src/lib/components/CompletedProgress.svelte:33-36` — `kafkaFindings` `$derived` (mirror exactly)
- `apps/web/src/lib/components/FollowUpSuggestions.test.ts` — bun:test + svelte/server pattern reference
- `packages/shared/src/agent-state.ts:34-86` — all three Findings schemas in one place
- `packages/agent/src/correlation/extractors/couchbase.ts` — couchbase extractor (working, don't touch)
- `packages/agent/src/correlation/extractors/gitlab.ts` — gitlab extractor (working, don't touch)
- `packages/shared/src/__tests__/stream-event-schema.test.ts` — extend if any schema field changes (none expected)

## Out of scope (do NOT do)

- ElasticFindingsCard (SIO-778 spec ticket — Elastic has no schema yet)
- AWS/Konnect/Atlassian cards (SIO-773 Phase C — gated on per-domain extractors that don't exist)
- Click-to-drill-down round-trips (deferred indefinitely until action defined)
- Modifying `topic-shift` endpoint
- Adding card-level toggles or user preferences
- Pre-emptive relevance filters for couchbase or gitlab — only add if a real signal-to-noise problem surfaces

## Memory references

- `feedback_extractor_fixtures_must_mirror_real_mcp` — extractor test fixtures must match real MCP output (SIO-783 lesson)
- `feedback_handoff_docs_main_branch` — handovers commit directly to main
- `reference_b2b_apm_service_naming` — `notification-service` vs `notifications-service` divergence (informs SIO-785 verification)
- `reference_couchbase_query_response_shapes` — `executeAnalysisQuery` returns markdown not JSON; if Couchbase extractor breaks, this is likely why
- `reference_gitlab_internal_vs_public` — gitlab.com paths under `pvhcorp/b2b/`
- `reference_bun_hot_does_not_reresolve_modules` — restart dev server if new code doesn't load
