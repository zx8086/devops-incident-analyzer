# Lazy Runbook Selection - Design Spec

> **Status:** Draft for review
> **Date:** 2026-04-10
> **Author:** Simon Owusu (with Claude Opus 4.6)
> **Related:** SIO-639 (Phase 1 documentation, committed to SIO-621 branch as `74e5b32`, pending merge); this is Phase 2 brainstorm A
> **Supersedes:** none

## Context

The incident-analyzer orchestrator currently loads every runbook into the system prompt for every request via `buildKnowledgeSection()` in `packages/gitagent-bridge/src/skill-loader.ts:4-25`. With three runbooks today this works fine. The concern is forward-looking: at roughly 8-12 runbooks, LLM routers tend to lose precision, blend guidance, or hedge across patterns. This spec introduces a selection step that positions for that scale threshold without regressing current behavior.

This is **pre-emptive, not reactive.** No specific failure has been observed. The goal is an architectural improvement that scales gracefully and surfaces failures via observability rather than a silent quality cliff at ~10 runbooks.

## Goals

1. Introduce a selection step between `normalize` and `entityExtractor` that narrows runbooks from "all" to "0-2 relevant" based on the normalized incident.
2. Keep current quality on the 3-runbook set. No regression on existing end-to-end smoke tests.
3. Fail loudly on configuration or data problems that could silently degrade selection quality. No "fall back to all runbooks because we don't know what else to do."
4. Emit rich observability so router failures are diagnosable in LangSmith without reading graph internals.
5. Leave sub-agents, validate, proposeMitigation, responder, and follow-up untouched. The change surface is the aggregator plus one new node plus load-time config.

## Non-Goals

- Runbook frontmatter with trigger grammar (tracked as Phase 2 brainstorm E; orthogonal).
- Load-time runbook tool-name binding validation (tracked as Phase 2 brainstorm B; orthogonal).
- Scoped runbooks per sub-agent (tracked as Phase 2 brainstorm C; different architecture).
- Token-cost optimization as a primary goal. Token savings are a side effect of a cleaner architecture, not the justification.
- Semantic search, embeddings, or vector stores. Overkill for ~10 runbooks.
- Retry logic in the selector. Failures go to observability, not retry loops.

## Architecture

### Pipeline change

```
classify
  -> normalize
  -> selectRunbooks           [NEW]
  -> entityExtractor
  -> supervise (Send[])
  -> queryDataSource
  -> align
  -> aggregate                 [reads state.selectedRunbooks, filters knowledge base]
  -> checkConfidence
  -> validate
  -> proposeMitigation
  -> followUp
  -> END
```

One new node, one state field, one config block, one small loader extension. The aggregator is the only downstream consumer of the selection.

### New node: `selectRunbooks`

Location: `packages/agent/src/runbook-selector.ts` (new file).

Signature:

```typescript
export async function selectRunbooks(
    state: AgentStateType,
    config?: RunnableConfig,
): Promise<Partial<AgentStateType>>;
```

Behavior:

1. Read `state.normalizedIncident` (severity, timeWindow, affectedServices, extractedMetrics, rawInput) and the last user message from `state.messages`.
2. Load the runbook catalog from the agent (cached at load time - see below).
3. If the catalog is empty, skip the router entirely and return `{ selectedRunbooks: null }` (no-op update, preserving the default) with observability mode `skip.empty_catalog`. The aggregator will see `null` and fall through to "no filter," which is the correct behavior for "there are no runbooks to select from" — it is semantically different from "selector ran and chose none."
4. Call the orchestrator's Sonnet model (same model used by `normalize` and `aggregate`) with a structured router prompt. Timeout: 10s.
5. Parse the response with `RunbookSelectionResponseSchema`. Validate each filename against the catalog.
6. On success, write `{ selectedRunbooks: [...] }` with observability mode `llm`, `llm.partial`, `llm.empty`, or `llm.truncated`.
7. On router failure (parse error, timeout, API error, all-invalid filenames), enter the fallback path. Require `state.normalizedIncident.severity` to be set. If severity is missing, throw `RunbookSelectionFallbackError` - the run fails at this node. If severity is present, read `runbook_selection.fallback_by_severity[severity]` from the loaded agent and write that to state. Observability mode is `fallback.<reason>`.
8. On missing `runbook_selection` config when this node is reached, throw `RunbookSelectionConfigError` at load time, not at request time. The agent refuses to start if `selectRunbooks` is wired in without fallback config. Observability mode for this case is N/A - it never runs.

### New state field: `selectedRunbooks`

Added to `packages/agent/src/state.ts`:

```typescript
selectedRunbooks: Annotation<string[] | null>({
    reducer: (_, next) => next,
    default: () => null,
}),
```

The field is a **tri-state nullable array**, which is the cleanest way to distinguish three distinct conditions that the aggregator must handle differently:

| State | Meaning | Aggregator behavior |
|---|---|---|
| `null` | Selector has not run yet (or was not wired into the graph) | No filter applied. All runbooks present. Preserves today's behavior. |
| `[]` | Selector ran and deliberately chose no runbooks (LLM empty, or severity fallback of `[]`) | Filter to zero. Aggregator sees no runbooks. |
| `["a.md", ...]` | Selector ran and picked these | Filter to the named set. |

The reducer is `(_, next) => next` — writes replace prior value. The default `null` means a freshly-initialized request (or one where `selectRunbooks` was not wired in) reads as "no filter applied," which is the backwards-compatible behavior.

Using `null` rather than `undefined` because LangGraph's `Annotation.default` must return a concrete value; `null` is idiomatic for "explicit absence" in TypeScript and plays well with JSON serialization for checkpointing.

### Aggregator change

Current signature: `buildOrchestratorPrompt(): string` in `packages/agent/src/prompt-context.ts:44-46`.

New signature:

```typescript
interface OrchestratorPromptOptions {
    runbookFilter?: string[];    // undefined = no filter (current behavior)
                                 // []        = filter to zero runbooks (suppress all)
                                 // [names]   = filter to just these
}

export function buildOrchestratorPrompt(
    options?: OrchestratorPromptOptions,
): string;
```

The three-state distinction matters: `undefined` preserves today's behavior for every caller that doesn't pass options (`proposeMitigation`, `validate`). An empty array explicitly suppresses all runbooks. A populated array filters to the named set.

The filter flows through `buildSystemPrompt` (no signature change - it receives an already-filtered `KnowledgeEntry[]` view) to `buildKnowledgeSection()`. The filter applies **only to the `runbooks` category**. `systems-map` and `slo-policies` entries are never filtered.

The aggregator node becomes:

```typescript
// packages/agent/src/aggregator.ts
// state.selectedRunbooks: string[] | null
//   null      -> selector did not run; no filter (current behavior)
//   []        -> selector ran and chose none; filter to zero runbooks
//   [names]   -> filter to the named set
const runbookFilter = state.selectedRunbooks ?? undefined;
const systemPrompt = buildOrchestratorPrompt({ runbookFilter });
```

The `??` coalesces `null` to `undefined`, which the prompt builder treats as "no filter." An empty or populated array passes through directly and is handled as a filter. No helper function is needed; the tri-state field carries the distinction on its own.

### New `LoadedAgent` field: `runbookCatalog`

Added to `packages/gitagent-bridge/src/manifest-loader.ts`:

```typescript
export interface RunbookCatalogEntry {
    filename: string;    // e.g. "kafka-consumer-lag.md"
    title: string;       // first H1 heading from the file
    summary: string;     // first non-empty paragraph after H1, truncated to 200 chars
}

export interface LoadedAgent {
    // ... existing fields ...
    knowledge: KnowledgeEntry[];
    runbookCatalog: RunbookCatalogEntry[];   // NEW
}
```

Population: inside `loadKnowledge()`, after reading each file in the `runbooks` category, parse the content once to extract `title` (first `#` heading) and `summary` (first paragraph). No YAML frontmatter requirement. Existing runbooks work as-is. If a runbook has no H1, use the filename stem as the title. If no summary paragraph, use the empty string.

Catalog is built at agent load time and held in memory for the agent's lifetime. Not per-request. ~3ms cost at 10 runbooks.

### New config: `runbook_selection`

Extension to `KnowledgeIndexSchema` in `packages/gitagent-bridge/src/types.ts`:

```typescript
export const RunbookSelectionConfigSchema = z.object({
    fallback_by_severity: z.object({
        critical: z.array(z.string()),
        high: z.array(z.string()),
        medium: z.array(z.string()),
        low: z.array(z.string()),
    }),
});

export const KnowledgeIndexSchema = z.object({
    name: z.string(),
    description: z.string(),
    version: z.string(),
    categories: z.record(z.string(), KnowledgeCategorySchema),
    runbook_selection: RunbookSelectionConfigSchema.optional(),
});
```

All four severity keys required when `runbook_selection` is present. Partial configs rejected at load time. Each filename validated to exist under `categories.runbooks.path`. Missing files rejected at load time with a clear error naming the missing file.

`knowledge/index.yaml` gains:

```yaml
runbook_selection:
  fallback_by_severity:
    critical: ["kafka-consumer-lag.md", "high-error-rate.md", "database-slow-queries.md"]
    high:     ["kafka-consumer-lag.md", "high-error-rate.md", "database-slow-queries.md"]
    medium:   []
    low:      []
```

The defaults above encode a deliberate editorial choice: `critical` and `high` fall back to all runbooks (broad safety net); `medium` and `low` fall back to none (clean slate, rely on findings and skills). This can be tuned per deployment without code changes.

### Router prompt construction

Constructed in `runbook-selector.ts`:

```text
SYSTEM:
You are selecting operational runbooks for a DevOps incident investigation.
Pick 0 to 2 runbooks from the catalog that best match the incident. If no
runbook clearly applies, return an empty list. Do not guess.

USER:
Incident summary:
  severity: {normalizedIncident.severity or "unspecified"}
  time window: {timeWindow.from} to {timeWindow.to}
  affected services: {affectedServices.join(", ")}
  extracted metrics: {formatted metrics list}
  raw input: {last user message, truncated to 500 chars}

Available runbooks:
  - kafka-consumer-lag.md: {title} -- {summary}
  - high-error-rate.md: {title} -- {summary}
  - database-slow-queries.md: {title} -- {summary}

Return a JSON object matching this exact shape:
{"filenames": ["name1.md", "name2.md"], "reasoning": "one sentence"}

Rules:
- Pick 0 to 2 filenames. Prefer 1 if a single runbook clearly applies.
- Return empty filenames if no runbook clearly applies.
- filenames must exactly match the list above. Do not invent new names.
```

Response schema:

```typescript
export const RunbookSelectionResponseSchema = z.object({
    filenames: z.array(z.string()).max(10),    // cap at 10, truncate to 2 in post-processing
    reasoning: z.string(),
});
```

### Observability

Span name: `agent.node.selectRunbooks` (inherited from `traceNode()` wrapper in `graph.ts:27-37`).

Attributes written by the selector:

| Attribute | Values |
|---|---|
| `runbook.selection.mode` | `llm` / `llm.partial` / `llm.empty` / `llm.truncated` / `fallback.parse_error` / `fallback.timeout` / `fallback.api_error` / `fallback.invalid_filenames` / `skip.empty_catalog` / `error.missing_severity` |
| `runbook.selection.count` | 0..2 |
| `runbook.selection.filenames` | comma-joined |
| `runbook.selection.severity` | severity that drove the fallback, or empty |
| `runbook.selection.latency_ms` | LLM call duration, 0 if no LLM call |
| `runbook.catalog.size` | number of runbooks the router could have chosen from |
| `runbook.selection.reasoning` | the LLM's one-sentence reason (only on `llm*` modes) |

These enable LangSmith queries like "every request in the last 24h where the router fell back with reason X" and "aggregator runs where `runbook.selection.mode = llm.empty`." The reasoning field in particular helps spot systematic bad calls post-hoc.

## Data Flow

```
user query
  -> classify
       (writes queryComplexity)
  -> normalize
       (writes normalizedIncident: severity, timeWindow, services, metrics)
  -> selectRunbooks
       reads: normalizedIncident, last user message, runbookCatalog
       writes: selectedRunbooks
       emits: agent.node.selectRunbooks span with attributes above
  -> entityExtractor
       (unchanged)
  -> supervise / queryDataSource / align
       (unchanged; do not read selectedRunbooks)
  -> aggregate
       reads: state.selectedRunbooks (string[] | null)
       calls: buildOrchestratorPrompt({ runbookFilter: state.selectedRunbooks ?? undefined })
       produces: final report using only the filtered runbooks
  -> checkConfidence / validate / proposeMitigation / followUp
       (unchanged; each calls buildOrchestratorPrompt() without options,
        preserving today's "all runbooks" behavior for those nodes)
```

The design deliberately leaves validate and proposeMitigation unchanged. Those nodes still see all runbooks because they benefit from having the full reference library when deciding retry/mitigation strategy. Only the aggregator's correlation step is narrowed.

## Error Handling

| Situation | Behavior | Observability mode |
|---|---|---|
| LLM returns valid JSON with 0-2 valid filenames | Write `state.selectedRunbooks`, continue | `llm` |
| LLM returns valid JSON with 1 valid + 1 invalid filename | Keep the valid one, drop the invalid one, continue | `llm.partial` |
| LLM returns valid JSON with all invalid filenames | Treat as router-failed, enter fallback path | `fallback.invalid_filenames` |
| LLM returns valid JSON with empty filenames | Respected. `state.selectedRunbooks = []`. Aggregator filters to zero runbooks. | `llm.empty` |
| LLM returns malformed JSON | Enter fallback path | `fallback.parse_error` |
| LLM returns >2 filenames (but <=10) | Truncate to first 2, continue | `llm.truncated` |
| LLM API timeout (10s) | Enter fallback path | `fallback.timeout` |
| LLM API 4xx/5xx error | Enter fallback path | `fallback.api_error` |
| Fallback needed AND severity is set | Read `fallback_by_severity[severity]`, write to state, continue | `fallback.<reason>` |
| Fallback needed AND severity is missing | **Throw `RunbookSelectionFallbackError`**. Pipeline fails at this node. | `error.missing_severity` |
| Zero runbooks in the catalog | Skip the router. `state.selectedRunbooks` stays `null` (aggregator sees "no filter"). Continue. | `skip.empty_catalog` |
| `runbook_selection` config missing at load time | Throw `RunbookSelectionConfigError` at startup. Agent refuses to start. | N/A (never runs) |

**No retries.** Router failures are surfaced via observability, not hidden by automatic retry. The severity fallback is the single retry mechanism.

**Hard-fail disciplines:**

1. **Missing severity + router failed = throw.** Forces `normalize` to be a reliable severity producer. Silent use of wrong defaults would hide normalize bugs.
2. **Missing config + selector enabled = refuse to start.** You opt into this feature fully or not at all. No half-configured runs.

## Testing

### Unit tests: runbook selector

File: `packages/agent/test/runbook-selector.test.ts` (new)

Mocked LLM client, synthetic 5-entry catalog fixture, fixed fallback config. The selector resolves its model via the same `resolveBedrockConfig()` path as `normalize` and `aggregate`, so tests inject a mock by overriding the resolver in the test's module setup — no production code change required for testability.

| # | Test | Mock LLM | Severity | Expected `selectedRunbooks` | Expected mode |
|---|---|---|---|---|---|
| 1 | valid single pick | `{"filenames":["a.md"],...}` | critical | `["a.md"]` | `llm` |
| 2 | valid two picks | `{"filenames":["a.md","b.md"],...}` | critical | `["a.md","b.md"]` | `llm` |
| 3 | valid empty | `{"filenames":[],...}` | critical | `[]` (not `null`) | `llm.empty` |
| 4 | partial validity | `{"filenames":["a.md","bogus.md"],...}` | critical | `["a.md"]` | `llm.partial` |
| 5 | all invalid | `{"filenames":["bogus.md"],...}` | critical | fallback for critical | `fallback.invalid_filenames` |
| 6 | malformed JSON | `"not json"` | critical | fallback for critical | `fallback.parse_error` |
| 7 | three returned | `{"filenames":["a","b","c"],...}` | critical | `["a","b"]` | `llm.truncated` |
| 8 | timeout | throws TimeoutError | medium | `[]` (medium fallback) | `fallback.timeout` |
| 9 | api error | throws Error | low | `[]` (low fallback) | `fallback.api_error` |
| 10 | missing severity + router fails | throws | undefined | throws `RunbookSelectionFallbackError` | `error.missing_severity` |
| 11 | missing severity + router succeeds | `{"filenames":["a.md"],...}` | undefined | `["a.md"]` | `llm` |
| 12 | empty catalog | (router not called) | critical | `null` (unchanged from default) | `skip.empty_catalog` |

### Unit tests: load-time config validation

File: `packages/gitagent-bridge/test/manifest-loader.test.ts` (extended)

| Test | Config state | Expected behavior |
|---|---|---|
| valid config | all 4 severity keys, all filenames exist | loads clean |
| missing severity key | 3 of 4 present | `KnowledgeIndexSchema` parse error at load |
| nonexistent filename | filename in config doesn't exist under `runbooks/` | load error naming the missing file |
| `runbook_selection` absent entirely | no block | loads clean; `runbookCatalog` still populated |

### Unit tests: aggregator filter

File: `packages/agent/test/aggregator.test.ts` (extended)

Two layers: (1) direct tests on `buildOrchestratorPrompt({ runbookFilter })`, (2) integration tests where `state.selectedRunbooks` drives the aggregator node. Layer 1 verifies the filter logic; layer 2 verifies the `null -> undefined` coalesce.

**Layer 1: `buildOrchestratorPrompt` filter semantics**

| Test | `runbookFilter` | Expected knowledge section |
|---|---|---|
| undefined | `undefined` | all runbooks present (current behavior) |
| empty array | `[]` | no runbooks present; systems-map + slo-policies unchanged |
| single filter | `["kafka-consumer-lag.md"]` | only that runbook; systems-map + slo-policies unchanged |
| two filters | `["a.md","b.md"]` | only those two; systems-map + slo-policies unchanged |
| nonexistent filter | `["bogus.md"]` | no runbooks (filter filters to nothing); systems-map + slo-policies unchanged |

**Layer 2: `state.selectedRunbooks` tri-state drives aggregator**

| Test | `state.selectedRunbooks` | Expected aggregator prompt behavior |
|---|---|---|
| selector did not run | `null` | all runbooks present (coalesced to `undefined` filter) |
| selector chose none | `[]` | no runbooks present |
| selector picked one | `["kafka-consumer-lag.md"]` | only that runbook |

### End-to-end smoke test

Extends the existing SSE smoke test. One new scenario:

- Submit an incident query that unambiguously matches `kafka-consumer-lag.md` (e.g., "consumer group lag on topic X").
- Assert: the LangSmith trace contains a `selectRunbooks` span with `runbook.selection.mode = llm` and `runbook.selection.filenames` includes `kafka-consumer-lag.md`.
- Assert: the aggregator output cites `kafka-consumer-lag.md` by name.
- Validates end-to-end: catalog extraction, router prompt construction, LLM call, state write, downstream aggregator filter, observability emission.

### Regression check

Run the existing SSE smoke tests with `runbook_selection` enabled. Manually review 3-5 sample aggregator outputs before and after the change. Acceptance: the outputs are substantively equivalent - same root-cause analysis, same tool citations, same confidence range. This is judgment-based, not assertion-based, because the spec's goal is non-regression on small catalogs.

### Explicitly not tested

- Semantic selection quality on a synthetic 10-runbook catalog. Deferred until the 3-runbook version ships and we have at least one real runbook added beyond the initial three.
- Sub-agent behavior under selection. Sub-agents do not read `selectedRunbooks`.
- LLM output determinism. The router is temperature=0.2 like the rest of the orchestrator, not zero.

## Rollout

1. Land this spec (commit to the repository).
2. Run `superpowers:writing-plans` to produce a step-by-step implementation plan.
3. Create a Linear issue for the implementation work with the plan attached. All implementation begins from that issue per the project's Linear-first rule.
4. Implement behind a **config gate**: if `runbook_selection` is absent from `knowledge/index.yaml`, the `selectRunbooks` node is **not wired** into the graph. `state.selectedRunbooks` stays `null` throughout the run, and the aggregator sees all runbooks. This makes the feature opt-in at the deployment level — upgrading `gitagent-bridge` does not force any existing deployment to adopt lazy selection.
5. Enable in this repository by adding the config block to `agents/incident-analyzer/knowledge/index.yaml`. Run the smoke tests. Perform a manual regression pass against the existing 3-runbook behavior.
6. Monitor LangSmith for `fallback.*` and `error.*` modes for one week post-enable. Triage rules:
   - `fallback.parse_error` dominant → revisit the router prompt (likely JSON format instructions)
   - `fallback.invalid_filenames` dominant → revisit the catalog summary format (the model is hallucinating names)
   - `fallback.timeout` nontrivial → revisit the 10s timeout or the model choice
   - `error.missing_severity` nonzero → revisit the `normalize` prompt; this indicates a real bug in severity extraction
7. Document the feature in `docs/architecture/agent-pipeline.md` and `docs/architecture/gitagent-bridge.md` under the `knowledge/ (Reference Knowledge)` subsection added by SIO-639.

## Open Questions

None at spec time. Implementation plan will surface any further questions.

## Appendix: Alternatives Considered

Documented here for the record so future changes can understand what was rejected and why.

**Rule-based matcher on `NormalizedIncident`.** Match runbook frontmatter (new convention: `affected_services`, `severity`, `signals`) against `NormalizedIncident` fields via deterministic predicates. Rejected because it requires inventing a frontmatter grammar that overlaps with Phase 2 brainstorm E, and because LLM-based routing composes more naturally with the existing pipeline shape.

**Hybrid rule filter + LLM tiebreaker.** Best precision. Rejected for complexity - adds the frontmatter grammar AND the LLM hop, and the pre-emptive nature of this change does not justify the cost.

**Selection applied to sub-agents.** Pass `selectedRunbooks` down to each sub-agent via `Send[]`. Rejected because sub-agents today are tool-only and don't read runbooks. Changing that is a different architecture shift best done in its own brainstorm (overlaps with Phase 2 brainstorm C).

**Selection applied to validate and proposeMitigation.** Rejected because those nodes benefit from seeing all runbooks for retry/mitigation strategy. Narrowing them would reduce the breadth the final recommendation draws from. The aggregator is where precision matters most.

**Haiku model for the router hop.** Cheaper per call. Rejected for the first cut to avoid adding a second model dependency. Can be optimized later if latency or cost shows up as a problem.

**Catalog extracted per-request.** Rejected because runbook content is already in memory and re-parsing on every call is wasted work.

**Automatic LLM retry on parse error.** Rejected because severity fallback is the single retry mechanism. Multiple retry layers hide systematic problems and double latency for marginal gain.
