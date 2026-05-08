# Agent Pipeline

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-05-08

The agent pipeline is a LangGraph StateGraph that processes user queries through classification, normalization, optional runbook selection, entity extraction, parallel datasource querying, cross-datasource alignment, aggregation, mandatory cross-agent correlation enforcement (SIO-681), confidence gating, validation, mitigation proposal, and follow-up generation. The graph is defined in `packages/agent/src/graph.ts` and compiled with a checkpointer for conversation persistence.

---

## Pipeline Overview

```
+-------+
| START |
+---+---+
    |
    v
+----------+
| classify |-------> queryComplexity === "simple"
+----+-----+                    |
     |                          v
     | (complex)          +-----------+     +----------+
     v                    | responder |---->| followUp |---> END
+-----------+             +-----------+     +----------+
| normalize |
+-----+-----+
      |
      v (if runbook_selection enabled)
+----------------+
| selectRunbooks |
+-------+--------+
        |
        v
+----------------+
| entityExtractor|
+-------+--------+
        |
        v
+------------+
| supervisor |
| (fan-out)  |
+-+--+--+--+-+--+--+
  |  |  |  |  |  |
  v  v  v  v  v  v
elastic kafka capella konnect gitlab atlassian  (one per datasource, parallel)
-agent  -agent -agent  -agent  -agent -agent
  |  |  |  |  |  |
  +--+--+--+--+--+
        |
        v
+-------+------+
|    align     | <--------+
+-------+------+          |
        |                 |
        | aligned         | retryTargets.length > 0
        |                 | && alignmentRetries < 2
        v                 |
+-------+------+          |
|  aggregate   | ---------+  (via routeAfterAlignment)
+-------+------+
        |
        v
+----------------------+
| enforceCorrelations  |--> rule satisfied OR
| Router (SIO-681)     |    no rules to dispatch
+---+----+-------------+              |
    |                                 |
    | Send[] per                      |
    | unsatisfied rule                |
    v                                 |
+-----------------+                   |
| correlationFetch|--+                |
| (sub-agent run) |  |  re-fan-out    |
+-----------------+  |                |
                     v                |
+----------------------+              |
| enforceCorrelations  | <------------+
| Aggregator           |
| (degradedRules,      |
|  confidenceCap=0.6)  |
+-----------+----------+
            |
            v
+-----------+------+
| checkConfidence  |
+-------+----------+
        |
        v
+-------+------+
|   validate   | <--------+
+-------+------+          |
        |                 |
        | pass            | fail && retryCount < 2
        v                 |
+------------------+      |
| proposeMitigation| -----+  (retries go back to aggregate)
+-------+----------+
        |
        v
+-------+------+
|   followUp   |
+-------+------+
        |
        v
    +-------+
    |  END  |
    +-------+
```

All nodes are wrapped with `traceNode()`, which creates an OpenTelemetry span under `agent.node.<name>` with the request ID and current datasource as span attributes.

---

## State Annotation

The `AgentState` is defined in `packages/agent/src/state.ts` using LangGraph's `Annotation.Root`. It extends `MessagesAnnotation` to inherit the standard `messages` channel.

| Field | Type | Reducer | Purpose |
|-------|------|---------|---------|
| `messages` | `BaseMessage[]` | Append (from MessagesAnnotation) | Full conversation history including AI responses |
| `attachmentMeta` | `AttachmentMeta[]` | Append | Lightweight metadata for attached files (images, PDFs, text) used in routing decisions |
| `queryComplexity` | `"simple" \| "complex"` | Replace | Classification result determining which path the query takes |
| `targetDataSources` | `string[]` | Replace | Datasource IDs to query -- set by UI selection or entity extraction |
| `dataSourceResults` | `DataSourceResult[]` | Append (empty array resets) | Accumulated results from sub-agent queries. The reducer appends new results but an empty array clears all prior results |
| `currentDataSource` | `string` | Replace | Active datasource ID for the current sub-agent execution (set per Send) |
| `extractedEntities` | `ExtractedEntities` | Replace | Services, time windows, severity, and datasource mappings extracted from the query |
| `previousEntities` | `ExtractedEntities` | Replace | Entities from the prior turn, preserved for follow-up context |
| `toolPlanMode` | `"planned" \| "autonomous"` | Replace | Whether sub-agents follow a pre-generated tool plan or act autonomously |
| `toolPlan` | `ToolPlanStep[]` | Replace | Ordered tool execution plan when in planned mode |
| `validationResult` | `"pass" \| "fail" \| "pass_with_warnings"` | Replace | Outcome of the anti-hallucination validation check |
| `retryCount` | `number` | Replace | Number of validation retry attempts (max 2) |
| `alignmentRetries` | `number` | Replace | Number of alignment retry cycles (max 2) |
| `alignmentHints` | `string[]` | Replace | Diagnostic hints from alignment failures (e.g., "elastic: no response received") |
| `isFollowUp` | `boolean` | Replace | Whether the current query is a follow-up to a previous investigation |
| `finalAnswer` | `string` | Replace | The aggregated incident report text, used by validate and followUp nodes |
| `dataSourceContext` | `DataSourceContext \| undefined` | Replace | Optional context metadata for datasource routing |
| `requestId` | `string` | Replace | UUID generated per request for trace correlation across nodes and MCP servers |
| `suggestions` | `string[]` | Replace | Follow-up question suggestions generated by the followUp node |
| `selectedRunbooks` | `string[] \| null` | Replace | SIO-640 tri-state: `null` = selector did not run, `[]` = selector chose no runbooks, `[names]` = selected runbook filenames |
| `degradedRules` | `DegradedRule[]` | Replace | SIO-681. Populated by the `enforceCorrelations` aggregator when a required cross-agent correlation could not complete (sub-agent unreachable, no findings covering the triggered service). Each entry is `{ ruleId, agent, services, reason }`. Empty array on the satisfied path. |
| `confidenceCap` | `number \| undefined` | Replace | SIO-681. Set to `0.6` by `enforceCorrelations` when one or more correlation rules are degraded; the aggregator then writes `confidenceScore = min(currentScore, confidenceCap)`. `undefined` on the satisfied / no-rules path. |
| `pendingCorrelations` | `PendingCorrelation[]` | Replace | SIO-681. Tracks (rule, agent, service) tuples being fetched in the current re-fan-out so the aggregator can detect which sub-agent calls succeeded. |

---

## Node Reference

### classify

**Source:** `packages/agent/src/classifier.ts`

**Purpose:** Routes queries as simple (conversational) or complex (requires datasource investigation). Resets per-turn accumulation state (`dataSourceResults`, `alignmentRetries`, `alignmentHints`) at the start of each turn to prevent prior results from bleeding into new queries.

**Classification strategy (ordered by priority):**

1. Follow-up detection: regex patterns like "try again", "retry", "more details" -> complex with `isFollowUp: true`
2. Pattern matching: simple patterns (greetings, thanks, help) vs complex patterns (infrastructure keywords like "cluster", "health", "lag", "latency")
3. Cache lookup: 10-minute TTL cache of previous LLM classifications (max 500 entries)
4. Conversation context: for short/ambiguous messages (<=15 words) with conversation history, includes recent messages as context
5. LLM classification: Claude Haiku with a zero-temperature system prompt returning exactly "SIMPLE" or "COMPLEX"
6. Fallback: defaults to "complex" on any failure

**Inputs consumed:** `messages` (last human message)

**Outputs produced:** `queryComplexity`, `isFollowUp`, `dataSourceResults` (reset), `alignmentRetries` (reset), `alignmentHints` (reset)

**LLM model:** Claude Haiku 4.5 (via `createLlm("classifier")`, temperature 0)

---

### selectRunbooks (optional; SIO-640)

**Source:** `packages/agent/src/runbook-selector.ts`

**Purpose:** Lazy runbook selection. Asks the orchestrator LLM to pick 0-2 runbooks from the agent's runbook catalog that best match the current incident. The aggregator consumes the selection to filter which runbooks appear in its system prompt -- a large context-budget saving when the catalog grows beyond a handful of entries.

**Position in pipeline:** Runs between `normalize` and `entityExtractor` when enabled. When disabled, the graph wires `normalize -> entityExtractor` directly and `selectRunbooks` is never reached.

**Config gate:** Presence of `runbook_selection` in `knowledge/index.yaml` enables the node. The config is an all-or-nothing opt-in; omitting it disables the feature entirely with zero behavioral change.

```yaml
# agents/incident-analyzer/knowledge/index.yaml
runbook_selection:
  fallback_by_severity:
    critical: [kafka-consumer-lag.md, high-error-rate.md]
    high:     [high-error-rate.md]
    medium:   []
    low:      []
```

All four severity keys are required; the schema rejects partial configs. Filenames are validated against the runbooks directory at load time and a missing file is a hard error naming the missing file.

**Inputs consumed:**
- `messages` (last user message, truncated to 500 chars)
- `normalizedIncident` (severity, time window, affected services, extracted metrics)
- Runbook catalog from `getRunbookCatalog()` -- parses each runbook's first H1 as title and first paragraph as summary

**Outputs produced:** `selectedRunbooks: string[] | null`
- `null` is the default tri-state value; means the node never ran or the catalog was empty
- `[]` means the selector ran and chose no runbooks (empty LLM pick or fallback tier is empty)
- `[names]` means the selector picked up to 2 runbook filenames from the catalog

**LLM model:** Claude Sonnet via `createLlm("runbookSelector")` with `temperature: 0`, `maxTokens: 512`. Automatic model-level fallback to Haiku via `.withFallbacks()` if the primary model errors.

**Failure modes and fallback chain (in order):**
1. LLM primary model succeeds -> returns validated `[names]`
2. LLM primary model fails -> automatic fallback to Haiku via `.withFallbacks()` (transparent)
3. Both models fail OR response is unparseable OR all picks are invalid -> severity-tier fallback from `fallback_by_severity[severity]`
4. Severity-tier fallback requires `state.normalizedIncident.severity` to be set; if missing, throws `RunbookSelectionFallbackError` (deliberate hard-fail -- silent "use all runbooks" would mask normalize bugs)
5. Empty catalog is a special case: the node skips the LLM entirely and returns `{}` (leaves state unchanged, no fallback attempted)

**Selection modes (emitted in logs):**
- `llm` -- clean LLM pick, all valid
- `llm.partial` -- LLM returned some valid and some invalid filenames; kept the valid ones
- `llm.empty` -- LLM returned zero filenames
- `llm.truncated` -- LLM returned more than 2; kept first 2
- `fallback.parse_error` -- response wasn't valid JSON
- `fallback.timeout` -- LLM threw `TimeoutError`
- `fallback.api_error` -- LLM threw any other error
- `fallback.invalid_filenames` -- all LLM picks were not in the catalog
- `skip.empty_catalog` -- the catalog had zero entries
- `error.missing_severity` -- fallback required but severity unset (throws)

**Observability:** Every execution emits a `logger.info` (or `logger.error` for the missing-severity case) with `mode`, `count`, `filenames`, `reasoning`, `latencyMs`, and `catalogSize` fields. The surrounding `traceNode("selectRunbooks", ...)` wrapper produces an OpenTelemetry span at `agent.node.selectRunbooks` with the standard `agent.node.name` and `request.id` attributes.

**Aggregator interaction:** The `aggregate` node reads `state.selectedRunbooks` and passes it through `buildOrchestratorPrompt({ runbookFilter })`:
- `null` -> `runbookFilter: undefined` -> no filter, today's behavior
- `[]` -> `runbookFilter: []` -> all runbooks suppressed from the prompt (systems-map and slo-policies are never affected)
- `[names]` -> `runbookFilter: [names]` -> prompt contains only the named runbooks

**Design spec:** `docs/superpowers/specs/2026-04-10-lazy-runbook-selection-design.md`

---

### entityExtractor

**Source:** `packages/agent/src/entity-extractor.ts`

**Purpose:** Extracts structured entities from the user's query to determine which datasources to query and with what parameters.

**Extraction targets:**
- `dataSources` -- array of `{id, mentionedAs}` mappings (e.g., "logs" -> elastic, "consumer lag" -> kafka)
- `timeFrom` / `timeTo` -- ISO 8601 time window boundaries
- `services` -- service names mentioned in the query
- `severity` -- critical, high, medium, or low

**Datasource targeting priority:**
1. UI-selected datasources from the frontend (if any)
2. LLM-extracted datasources from the query
3. On follow-ups with a narrowed extraction, prefer extracted over UI selection
4. Fallback: all six datasources

**Inputs consumed:** `messages` (last human message), `targetDataSources` (UI selection), `isFollowUp`, `attachmentMeta`

**Outputs produced:** `extractedEntities`, `previousEntities`, `targetDataSources`

**LLM model:** Claude Haiku 4.5 (via `createLlm("entityExtractor")`, temperature 0)

---

### supervisor (conditional edge function)

**Source:** `packages/agent/src/supervisor.ts`

**Purpose:** Creates `Send` messages to dispatch parallel sub-agent executions. Not a node itself -- it is the conditional edge function called after `entityExtractor`.

**Datasource selection (priority order):**
1. UI-selected datasources (`targetDataSources` from state, source method: `ui-selected`)
2. Entity-extracted datasources (source method: `entity-extracted`)
3. Fallback to all six datasources (source method: `fallback-all`)

**Validation checks before dispatch:**
- Deduplicates datasource IDs
- Verifies agent name exists in `AGENT_NAMES` mapping
- Checks `getToolsForDataSource()` returns tools > 0
- Skips datasources with no valid agent name or no connected MCP tools

**Output:** Array of `Send("queryDataSource", { ...state, currentDataSource, dataSourceResults: [] })` -- one per valid datasource

---

### queryDataSource

**Source:** `packages/agent/src/sub-agent.ts`

**Purpose:** Executes a ReAct agent with MCP tools scoped to a single datasource. Each parallel instance receives its own `currentDataSource` via the Send payload.

**Execution flow:**
1. Retrieve tools for the datasource via `getToolsForDataSource()`
2. Build the system prompt from the sub-agent's SOUL.md and RULES.md via the gitagent bridge
3. Create a `ChatBedrockConverse` LLM instance (Claude Haiku, temperature 0.1)
4. Create a `createReactAgent` with the scoped tools and system prompt
5. Invoke with only the last user message (not full history) to prevent cross-datasource pollution
6. Extract tool errors from response messages, classify by category (auth, session, transient, unknown)
7. Return a `DataSourceResult` with status, data, duration, and any tool errors

**Error classification categories:**
- `auth` -- 401, 403, security_exception, unauthorized (not retryable)
- `session` -- session not found, token expired (not retryable)
- `transient` -- timeout, ECONNREFUSED, 429, 503, circuit_breaking_exception (retryable)
- `unknown` -- unrecognized errors (retryable by default)

**Inputs consumed:** `currentDataSource`, `messages`, `requestId`, `alignmentHints`

**Outputs produced:** `dataSourceResults` (single result appended)

**LLM model:** Claude Haiku 4.5 (via `createLlm("subAgent")`, temperature 0.1)

---

### align

**Source:** `packages/agent/src/alignment.ts`

**Purpose:** Checks that all targeted datasources returned results. Identifies missing responses and errors, determines which datasources should be retried.

**Alignment check logic:**
- Compares `targetDataSources` against received `dataSourceResults` IDs
- Identifies missing datasources (targeted but no result) and errored datasources
- If all results present and no errors: alignment passes, proceeds to aggregate
- If gaps exist and retries remain: increments `alignmentRetries`, triggers fan-out retry via `routeAfterAlignment`
- If max retries reached (2) or no retryable targets: proceeds with partial results

**Retry filtering:**
- Auth and session errors are non-retryable (retrying will not fix credentials)
- Transient and unknown errors are retryable
- Hard cap: 16 total retry results (4 datasources x 4 attempts) regardless of counter state

**Inputs consumed:** `dataSourceResults`, `targetDataSources`, `alignmentRetries`

**Outputs produced:** `alignmentRetries` (incremented), `alignmentHints`

**LLM model:** None (deterministic logic)

---

### aggregate

**Source:** `packages/agent/src/aggregator.ts`

**Purpose:** Correlates all datasource findings into a unified incident report. Produces a markdown report with summary, correlated timeline table, per-datasource findings, confidence score, and gap analysis.

**Prompt construction:**
- System prompt loaded from the orchestrator's SOUL.md + RULES.md + active skills + knowledge base (runbooks, systems-map, slo-policies) via the gitagent bridge -- see [Gitagent Bridge > knowledge/ (Reference Knowledge)](gitagent-bridge.md#knowledge-reference-knowledge) for how runbooks inform the aggregator's correlation logic
- On follow-ups with a prior answer, includes condensed prior context (not full conversation history)
- Results block formatted as markdown sections per datasource with status, duration, and data
- Explicit instruction to only reference data present in results -- no fabrication

**Inputs consumed:** `dataSourceResults`, `messages`, `finalAnswer` (prior, for follow-ups)

**Outputs produced:** `messages` (AIMessage with report), `finalAnswer`

**LLM model:** Claude Sonnet 4.6 (via `createLlm("aggregator")`, temperature 0.1)

---

### enforceCorrelations (SIO-681)

**Source:** `packages/agent/src/correlation/{rules,engine,enforce-node}.ts`

**Purpose:** Forces required cross-agent hand-offs based on specialist findings. Promotes the c72-style "Empty/Dead Kafka groups -> elastic-agent" obligation from runbook markdown into supervisor-pipeline code, with bounded retry semantics and graceful degradation when the required correlation can't complete.

**Position in pipeline:** Sits between `aggregate` and `checkConfidence`. The router decides whether to dispatch any sub-agent re-fan-outs; the aggregator runs after re-fan-out (or directly when no rules require dispatch) and writes `degradedRules` + `confidenceCap`.

**Initial rule set (4 rules, all targeting elastic-agent):**

| Rule ID | Trigger condition (over `state.dataSourceResults`) | Required agent |
|---|---|---|
| `kafka-empty-or-dead-groups` | At least one consumer group in Empty/Dead state | elastic-agent |
| `kafka-significant-lag` | Stable group with `totalLag > 10_000` | elastic-agent |
| `kafka-dlq-growth` | DLQ topic with positive `recentDelta` (live, not historical noise) | elastic-agent |
| `kafka-tool-failures` | kafka-agent tool calls failed | elastic-agent |

**Idempotency:** A rule is satisfied if existing findings already cover the triggered (agent, service) pair. The router only dispatches sub-agent calls for unsatisfied rules. Re-running the router after a re-fan-out re-evaluates idempotency cleanly — no infinite loops.

**Predicate-error fail-open:** If a rule's trigger predicate throws, the rule is marked satisfied and logged. One bad rule cannot break the pipeline.

**Confidence cap mechanism:** When the aggregator detects unsatisfied rules after re-fan-out, it writes `degradedRules` entries with `{ ruleId, agent, services, reason }` and sets `confidenceCap = 0.6`. The aggregator then writes `confidenceScore = min(currentScore, 0.6)` so the report ships with capped confidence and an explicit reason line — distinguishing "we tried, infra failed" (acceptable, surfaced) from "we didn't try" (forbidden).

**Inputs consumed:** `dataSourceResults`, `pendingCorrelations`, current `confidenceScore` (from prior aggregate output)

**Outputs produced:** `degradedRules`, `confidenceCap`, `pendingCorrelations`, on re-fan-out path additional `dataSourceResults` (appended via reducer)

**LLM model:** None (deterministic rule engine)

**DLQ inventory dependency:** The `kafka-dlq-growth` rule reads `recentDelta` from `KafkaService.listDlqTopics()`, which performs suffix-based DLQ detection (5 patterns) and a two-sample 30-second delta check via batched `admin.listOffsets`. Topics that fail the first sample are omitted entirely (not phantom-zero entries). See `packages/mcp-server-kafka/src/services/kafka-service.ts:listDlqTopics`.

**Design spec / plan:**
- Spec: `docs/superpowers/specs/2026-05-07-mandatory-cross-agent-correlation-design.md`
- Plan: `docs/superpowers/plans/2026-05-08-mandatory-cross-agent-correlation.md`
- Linear: SIO-681

---

### validate

**Source:** `packages/agent/src/validator.ts`

**Purpose:** Anti-hallucination check that verifies the aggregated report against source data.

**Validation checks:**
1. **Answer presence:** fails if `finalAnswer` is empty
2. **Minimum length:** fails if answer is shorter than 50 characters
3. **Datasource reference:** warns if any successfully-queried datasource is not mentioned in the answer
4. **Timestamp authenticity:** warns if answer contains ISO 8601 timestamps not found in the source data (potential fabrication)

**Validation outcomes:**
- `pass` -- all checks clean
- `pass_with_warnings` -- warnings detected but answer is usable
- `fail` -- answer missing, too short, or fundamentally broken

**Inputs consumed:** `finalAnswer`, `dataSourceResults`, `retryCount`

**Outputs produced:** `validationResult`, `retryCount` (incremented on failure)

**LLM model:** None (deterministic logic)

---

### followUp

**Source:** `packages/agent/src/follow-up-generator.ts`

**Purpose:** Generates 3-4 follow-up question suggestions based on the response context. Displayed in the UI to help users drill deeper.

**Generation strategy:**
1. If response is short (<50 chars) or missing: use template-based fallback suggestions keyed by datasource
2. Otherwise: invoke Claude with the first 1000 characters of the response, requesting a JSON array of suggestions
3. Validate each suggestion: minimum 10 characters, maximum 100 characters
4. If LLM suggestions fail validation: fall back to templates

**Fallback templates by datasource:**
- elastic: "Check cluster health across deployments", "Show recent error log patterns"
- kafka: "List consumer group lag", "Show topic partition details"
- couchbase: "Check bucket memory usage", "Show slow query analysis"
- konnect: "List API gateway routes", "Show plugin configuration"
- gitlab: "Show recent pipeline failures", "Check merge request activity"
- generic: "Compare across all datasources", "Show a timeline of recent changes"

**Inputs consumed:** `finalAnswer`, `dataSourceResults`

**Outputs produced:** `suggestions`

**LLM model:** Claude Sonnet 4.6 (via `createLlm("followUp")`, temperature 0.5, max tokens 256)

---

### responder

**Source:** `packages/agent/src/responder.ts`

**Purpose:** Handles simple queries (greetings, help, capability questions) without querying any datasource. Responds from general knowledge only.

**Inputs consumed:** `messages` (full conversation)

**Outputs produced:** `messages` (AIMessage), `finalAnswer`

**LLM model:** Claude Sonnet 4.6 (via `createLlm("responder")`, temperature 0.3)

---

## Routing Logic

### Simple vs Complex Path

The graph branches at the `classify` node via a conditional edge:

```
classify --> queryComplexity === "simple" --> responder --> followUp --> END
classify --> queryComplexity === "complex" --> normalize --> [selectRunbooks] --> entityExtractor --> supervisor (fan-out)
```

The classifier defaults to "complex" when uncertain. This is intentional: it is better to query datasources unnecessarily than to miss a user's infrastructure question.

### Alignment Retry Loop

After sub-agent results arrive at the `align` node, the `routeAfterAlignment` conditional edge decides the next step:

```
align --> all results present, no errors --> "aggregate"
align --> retryable gaps, retries < 2     --> Send[] to "queryDataSource" (retry fan-out)
align --> retries >= 2 OR no retryable    --> "aggregate" (with partial results)
align --> retryResultCount >= 16          --> "aggregate" (hard cap safety valve)
```

The alignment retry mechanism uses two safeguards:
- **Counter-based:** `alignmentRetries` incremented by `checkAlignment`, checked by `routeAfterAlignment` (max 2)
- **Result-based:** hard cap of 16 total retry results (`isAlignmentRetry: true`) regardless of counter state

Non-retryable errors (auth, session) skip retry entirely. The alignment hints are logged so the aggregator can note which datasources had issues.

### Validation Retry Loop

After aggregation, the `validate` node checks the report quality:

```
validate --> validationResult === "fail" && retryCount < 2 --> "aggregate" (re-aggregate)
validate --> validationResult !== "fail" OR retryCount >= 2 --> "followUp"
```

The validation retry sends the pipeline back to `aggregate` with the same datasource results, giving the LLM another attempt to produce a valid report. After 2 retries, the pipeline proceeds regardless. On the validate-retry path, `enforceCorrelations` re-runs after the re-aggregate; the rule engine's idempotency check produces a clean second pass (rules already covered stay covered, new gaps get re-dispatched).

### Correlation Enforcement Routing (SIO-681)

After `aggregate`, the `enforceCorrelations` router decides whether any cross-agent hand-offs are required:

```
enforceCorrelations Router --> 0 unsatisfied rules --> enforceCorrelations Aggregator (no-op pass-through)
enforceCorrelations Router --> >=1 unsatisfied rule --> Send[] to "correlationFetch" -> enforceCorrelations Aggregator
enforceCorrelations Aggregator --> all rules satisfied --> "checkConfidence" (no degradedRules, confidenceCap=undefined)
enforceCorrelations Aggregator --> any rule still unsatisfied --> "checkConfidence" with degradedRules populated, confidenceScore capped at 0.6
```

The router returns `Send` objects (one per unsatisfied rule + triggered service) targeting a thin `correlationFetch` wrapper around `queryDataSource`. The wrapper output routes back to the aggregator (not back through `align` / `aggregate`), preventing pipeline loops. The aggregator re-evaluates rules after the re-fan-out and decides degradation status.

---

## Sub-Agent Dispatch

The supervisor function creates `Send` messages that target the `queryDataSource` node. Each Send carries a copy of the current state with two overrides:

```typescript
new Send("queryDataSource", {
    ...state,
    currentDataSource: dataSourceId,   // scopes MCP tools
    dataSourceResults: [],              // prevents cross-pollution
})
```

The `AGENT_NAMES` constant maps datasource IDs to agent names:

| Datasource ID | Agent Name | MCP Server Name |
|---------------|------------|-----------------|
| `elastic` | `elastic-agent` | `elastic-mcp` |
| `kafka` | `kafka-agent` | `kafka-mcp` |
| `couchbase` | `capella-agent` | `couchbase-mcp` |
| `konnect` | `konnect-agent` | `konnect-mcp` |
| `gitlab` | `gitlab-agent` | `gitlab-mcp` |

Tool scoping is handled by `getToolsForDataSource()` in `mcp-bridge.ts`, which returns only the tools registered by the corresponding MCP server. If a datasource ID is not in the server map, the function returns all tools as a fallback (defensive behavior).

---

## Tool Selection

Sub-agents can receive 30-67 MCP tools from their connected server. Passing all tools to a ReAct agent in a single prompt risks exceeding context window limits and degrades tool selection accuracy. The action-driven tool selection system reduces each sub-agent's tool set to 5-25 tools based on what the user's query actually needs.

### Selection Flow

```
Tool YAML (action_tool_map)
    |
    v
Entity Extractor (buildActionCatalog -> LLM -> toolActions)
    |
    v
Sub-Agent (selectToolsByAction -> resolveActionTools -> filtered tools)
    |
    v
ReAct Agent (LLM with 5-25 tools instead of 30-67)
```

### How It Works

**1. Action catalog construction** (`buildActionCatalog()` in `entity-extractor.ts`): At extraction time, the entity extractor reads all tool YAMLs from the loaded agent and builds a catalog of available actions per datasource. This catalog is injected into the extraction prompt so the LLM knows which action categories exist.

**2. Entity extraction**: The LLM returns a `toolActions` field as part of the extracted entities -- a record mapping datasource IDs to arrays of action category names. For example: `{ "elastic": ["search", "cluster_health"], "kafka": ["consumer_lag"] }`.

**3. Action-to-tool resolution** (`selectToolsByAction()` in `sub-agent.ts`): When the sub-agent starts, it calls `selectToolsByAction()` with the full MCP tool set, the datasource ID, the extracted `toolActions`, and the tool definition from the gitagent YAML. The function resolves action names to concrete MCP tool names via `resolveActionTools()` from the gitagent bridge.

### The `action_tool_map` in Tool YAMLs

Each tool YAML in `agents/incident-analyzer/tools/` contains a `tool_mapping.action_tool_map` section that groups MCP tool names by action category:

```yaml
tool_mapping:
  mcp_server: elastic
  mcp_patterns:
    - "elasticsearch_*"
  action_tool_map:
    search:
      - elasticsearch_search
      - elasticsearch_multi_search
      - elasticsearch_scroll_search
    cluster_health:
      - elasticsearch_get_cluster_health
      - elasticsearch_get_cluster_stats
      - elasticsearch_diagnostics
```

The `input_schema.properties.action.enum` array in the same YAML lists all valid action categories. The entity extractor uses this enum to constrain its output.

### Tool Counts per Datasource

| Datasource | Total MCP Tools | Action Categories | Typical Filtered Set |
|------------|----------------|-------------------|---------------------|
| elastic | 63 | 11 (search, cluster_health, node_info, index_management, shard_analysis, ingest_pipeline, template_management, alias_management, document_ops, snapshot, diagnostics) | 3-15 |
| kafka | 30 | 8 (consumer_lag, topic_throughput, dlq_messages, cluster_info, describe_topic, schema_registry, ksql, write_ops) | 3-10 |
| couchbase | 24 | 8 (system_vitals, fatal_requests, slow_queries, expensive_queries, index_analysis, node_status, document_ops, query_execution) | 3-8 |
| konnect | 67 | 9 (api_requests, service_config, route_config, plugin_chain, data_plane_health, certificate_status, control_plane_management, consumer_management, portal_management) | 3-12 |
| gitlab | 21+ | 5 (issues, merge_requests, pipelines, search, code_analysis) | 3-12 |

### Fallback Chain

`selectToolsByAction()` implements a 3-tier fallback to ensure every sub-agent receives a usable tool set:

**Tier 1 -- Extracted actions:** If the entity extractor produced `toolActions` for this datasource and the resolved tool names match at least `MIN_FILTERED_TOOLS` (5) from the available MCP tools, use that filtered set (capped at `MAX_TOOLS_PER_AGENT` = 25).

**Tier 2 -- All curated tools:** If tier 1 fails (no extracted actions, unresolvable actions, or fewer than 5 matches), fall back to all tool names listed across every action category in the YAML via `getAllActionToolNames()`. This provides the full curated set without action-based filtering, still excluding any MCP tools not mentioned in the YAML.

**Tier 3 -- Hard cap:** If tier 2 also fails (no `action_tool_map` defined, or fewer than 5 curated tools match), take the first 25 tools from the full MCP tool set. This is a last resort to prevent the sub-agent from running with zero tools.

**Short-circuit:** If the datasource has 25 or fewer total MCP tools, no filtering is applied -- the full set is passed directly.

### Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `selectToolsByAction()` | `packages/agent/src/sub-agent.ts` | Orchestrates the 3-tier fallback, returns filtered tools |
| `getToolDefinitionForDataSource()` | `packages/agent/src/prompt-context.ts` | Finds the tool YAML whose `mcp_server` matches the datasource ID |
| `buildActionCatalog()` | `packages/agent/src/entity-extractor.ts` | Builds the action catalog string for the extraction prompt |
| `resolveActionTools()` | `packages/gitagent-bridge/src/tool-mapping.ts` | Maps action names to MCP tool names from the YAML |
| `getAllActionToolNames()` | `packages/gitagent-bridge/src/tool-mapping.ts` | Returns all MCP tool names across all action categories |

---

## Model Selection

| Role | Model | Temperature | Max Tokens | Rationale |
|------|-------|-------------|------------|-----------|
| Orchestrator (aggregate) | Claude Sonnet 4.6 | 0.1 | 4096 | Reasoning-heavy: correlating findings, building timelines, assessing confidence |
| Classifier | Claude Haiku 4.5 | 0 | 2048 | Fast binary decision, deterministic output preferred |
| Entity Extractor | Claude Haiku 4.5 | 0 | 2048 | Structured extraction, deterministic JSON output |
| Sub-Agents (queryDataSource) | Claude Haiku 4.5 | 0.1 | 2048 | Speed-critical: many parallel tool calls per investigation |
| Responder | Claude Sonnet 4.6 | 0.3 | 4096 | Quality matters for user-facing conversational responses |
| Follow-Up Generator | Claude Sonnet 4.6 | 0.5 | 256 | Creative suggestions benefit from higher temperature, short output |
| Runbook Selector | Claude Sonnet 4.6 | 0 | 512 | Picks 0-2 runbooks from catalog; deterministic output preferred |
| Normalizer | Claude Haiku 4.5 | 0 | 2048 | Structured incident extraction, deterministic JSON output |
| Mitigation Proposer | Claude Sonnet 4.6 | 0.1 | 4096 | Reasoning-heavy: generating actionable remediation steps |
| Confidence Gate | None (deterministic) | N/A | N/A | HITL escalation check, no LLM needed |
| Validator | None (deterministic) | N/A | N/A | Rule-based checks, no LLM needed |
| Alignment | None (deterministic) | N/A | N/A | Gap detection and retry routing, no LLM needed |

Model selection is driven by the gitagent bridge. The `llm.ts` module resolves model IDs from `agent.yaml` via `resolveBedrockConfig()`. The orchestrator (incident-analyzer) uses the root agent's model config (Sonnet), while lightweight roles (classifier, entityExtractor) use the sub-agent's model config (Haiku). Per-role temperature and max token overrides are applied on top of the base config.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial document created from codebase analysis |
| 2026-04-09 | Added Tool Selection section documenting action-driven filtering |
| 2026-04-13 | Updated pipeline from 8 to 12 nodes (normalize, selectRunbooks, checkConfidence, proposeMitigation), added GitLab sub-agent, updated diagrams and tables |
| 2026-04-23 | Added Atlassian sub-agent (6th datasource) to fan-out diagram and targeting fallback references |
| 2026-05-08 | SIO-681: documented the `enforceCorrelations` router/aggregator pair between `aggregate` and `checkConfidence`, the 4 initial correlation rules (kafka-empty-or-dead-groups, kafka-significant-lag, kafka-dlq-growth, kafka-tool-failures), the `degradedRules` / `confidenceCap` / `pendingCorrelations` AgentState fields, and the confidence-cap routing semantics. |
