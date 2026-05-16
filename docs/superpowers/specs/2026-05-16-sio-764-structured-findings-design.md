# SIO-764 — Sub-agent structured findings (design)

**Status:** Approved 2026-05-16, ready for implementation planning
**Epic:** SIO-764
**Predecessor specs:** `2026-05-07-mandatory-cross-agent-correlation-design.md` (SIO-681 correlation framework)
**Out-of-scope follow-ups:** `kafka-tool-failures` field-name fix (sidecar ticket), Kafka MCP tool gaps (Phase B sub-tickets), remaining-datasource extractors (Phase C parent ticket), atlassianFindings (blocked by SIO-766)

## Context

The DevOps Incident Analyzer's correlation framework (SIO-681) defined rules that read typed fields off `DataSourceResult.data` — e.g. `consumerGroups[].state === "Empty"`. But sub-agents have always emitted `result.data` as a prose string from the ReAct loop's final message (`packages/agent/src/sub-agent.ts:414`). Five rules in `packages/agent/src/correlation/rules.ts` were written against the expected typed shape and are dormant against production traffic:

- `kafka-empty-or-dead-groups` (line 131)
- `kafka-significant-lag` (line 143)
- `kafka-dlq-growth` (line 161)
- `kafka-tool-failures` (line 174)
- `gitlab-deploy-vs-datastore-runtime` (line 501)

The 12 currently-live rules are prose-matching or error-based, which works but means: (a) correlation evidence is paraphrased, not factual; (b) every new rule is implicitly a workaround for the missing structured channel.

This epic closes the gap by populating tool outputs and deriving per-domain structured findings via a new pipeline node, without touching the prose summary that aggregator/validator/UI already consume.

## Background verified during brainstorming

- `DataSourceResult.toolOutputs[]` (`packages/shared/src/agent-state.ts:37`) was scaffolded in commit `125b3f9` (Epic 4) but has been set to `[]` in production from day one. Only consumer is `follow-up-generator.ts:54` reading tool names; the fallback `?? []` means it's effectively dead code.
- SIO-681's spec assumed `result.data` would be typed; that contract was never built.
- Of the 5 dormant rules, none are satisfiable by raw `toolOutputs[]` alone — they need light merging or fan-out aggregation, and 2 of them need MCP tools that aren't currently exposed.
- `kafka-tool-failures` reads `result.data.toolErrors[]` (nested), which has never existed. The top-level `result.toolErrors` field (populated since SIO-725/728) is what the rule meant. This is a one-line bug fix, not a structured-emission problem — carved out as an independent sidecar ticket.

## Approaches considered

**A. New `extractFindings` graph node** (chosen) — pure-function node between `aggregate` and `enforceCorrelationsRouter` reads each sub-agent's populated `toolOutputs[]` and writes derived typed findings to sibling fields on `DataSourceResult`.

**B. Extract inside rule helpers** — rewrite `getKafkaData` / `getGitLabMergedRequests` to read `toolOutputs[]` and extract on demand. Rejected: hides the structured-emission concept inside helpers; harder to share extracted data with aggregator/UI; re-extracts on every rule evaluation.

**C. Extract inside `sub-agent.ts`** — per-domain extractor runs at the end of each sub-agent's ReAct loop. Rejected: couples sub-agent execution to domain extractors; harder to debug a bad extractor (would need to re-run the sub-agent); mixes "produce raw outputs" with "derive structured signals" into one phase.

A was chosen because it gives the best **debuggability** (toolOutputs[] stays pristine in state, derived findings are inspectable independently in LangSmith), matches the existing pure-transformation node pattern of `align` and `enforceCorrelationsAggregate`, and keeps sub-agents agent-agnostic.

## Recommended approach (A in detail)

### Schema design

Per-domain Findings schemas as **separate top-level fields** on `DataSourceResult` (not a discriminated union — gives strict type safety per agent without runtime narrowing; cross-agent rules already read multiple results, so per-field is no penalty).

```ts
// packages/shared/src/agent-state.ts (additions)
export const KafkaFindingsSchema = z.object({
  consumerGroups: z.array(z.object({
    name: z.string(),
    state: z.string().optional(),       // "Empty" | "Dead" | "Stable" | ...
    totalLag: z.number().optional(),
  })).optional(),
  dlqTopics: z.array(z.object({
    name: z.string(),
    recentDelta: z.number(),
  })).optional(),
});
export type KafkaFindings = z.infer<typeof KafkaFindingsSchema>;

export const GitLabFindingsSchema = z.object({
  mergedRequests: z.array(z.object({
    title: z.string(),
    mergedAt: z.string(),
    projectId: z.number().optional(),
  })).optional(),
});
export type GitLabFindings = z.infer<typeof GitLabFindingsSchema>;

export const CouchbaseFindingsSchema = z.object({
  slowQueries: z.array(z.object({
    statement: z.string(),
    avgDurationMs: z.number(),
  })).optional(),
});
export type CouchbaseFindings = z.infer<typeof CouchbaseFindingsSchema>;

// DataSourceResult gains (all optional):
kafkaFindings: KafkaFindingsSchema.optional(),
gitlabFindings: GitLabFindingsSchema.optional(),
couchbaseFindings: CouchbaseFindingsSchema.optional(),
```

`result.data` remains the prose summary. No change to aggregator (`aggregator.ts:226`) or validator consumption.

### Pipeline change

```
... -> align -> aggregate -> extractFindings -> enforceCorrelationsRouter
  -> [correlationFetch ->] enforceCorrelationsAggregate -> checkConfidence -> ...
```

13-node pipeline becomes 14-node. Update `CLAUDE.md` (pipeline diagram) and `docs/architecture/agent-pipeline.md` (full diagram + new "Findings extraction" subsection).

New module `packages/agent/src/extract-findings.ts`:

```ts
const EXTRACTORS: Record<string, (r: DataSourceResult) => Partial<DataSourceResult>> = {
  kafka: r => ({ kafkaFindings: extractKafkaFindings(r.toolOutputs ?? []) }),
  gitlab: r => ({ gitlabFindings: extractGitLabFindings(r.toolOutputs ?? []) }),
  couchbase: r => ({ couchbaseFindings: extractCouchbaseFindings(r.toolOutputs ?? []) }),
};

export async function extractFindings(state: AgentState): Promise<Partial<AgentState>> {
  const results = (state.results ?? []).map(r => {
    const extractor = EXTRACTORS[r.dataSourceId];
    if (!extractor) return r;
    try {
      return { ...r, ...extractor(r) };
    } catch (err) {
      logger.warn({ dataSourceId: r.dataSourceId, err }, "extractFindings failed");
      return r;
    }
  });
  return { results };
}
```

Pure (no I/O, no LLM). Soft-fails per agent.

### Tool output capture

`packages/agent/src/sub-agent.ts:417` — replace `toolOutputs: []` with capture from `ToolMessage` content during the ReAct loop:

```ts
const toolOutputs: ToolOutput[] = [];
for (const msg of langGraphMessages) {
  if (msg._getType() === "tool") {
    toolOutputs.push({
      toolName: msg.name ?? "unknown",
      rawJson: tryParseJson(String(msg.content)),
    });
  }
}
```

`tryParseJson` returns parsed JSON when content is valid JSON, else the raw string. Captures all tool calls from the ReAct loop, not just the last one.

### Per-domain extractor scope (Phase A)

Each lives at `packages/agent/src/correlation/extractors/<domain>.ts` + sibling `.test.ts`. Pure function `(outputs: ToolOutput[]) => <Domain>Findings`.

#### `extractors/kafka.ts`

| Source MCP tool | Output field | Merge strategy |
|---|---|---|
| `kafka_get_consumer_group_lag` (per-group call) | `consumerGroups[].name`, `consumerGroups[].totalLag` | One entry per tool call; sum from response. |
| `kafka_list_consumer_groups` | `consumerGroups[].name`, `consumerGroups[].state` | Single tool output; response `{groups: [...]}` mapped to `name = id`. |

Outputs from both tools merged by `name`. Unblocks `kafka-empty-or-dead-groups` (needs `.state`) and `kafka-significant-lag` (needs `.totalLag`).

**Plan-step verification needed:** exact MCP tool names against `packages/mcp-server-kafka/src/tools/`.

#### `extractors/gitlab.ts`

| Source MCP tool | Output field |
|---|---|
| `gitlab_list_merge_requests` (verify in plan step) | `mergedRequests[].title`, `mergedRequests[].mergedAt`, `mergedRequests[].projectId` |

Filter to `state === "merged"` if the source returns mixed states. Unblocks the gitlab side of `gitlab-deploy-vs-datastore-runtime`.

#### `extractors/couchbase.ts`

| Source MCP tool | Output field |
|---|---|
| `couchbase_get_slow_queries` (verify in plan step) | `slowQueries[].statement`, `slowQueries[].avgDurationMs` |

Unblocks the couchbase side of `gitlab-deploy-vs-datastore-runtime`. Combined with gitlab extractor, the cross-agent rule goes live.

### Rule helper migration

`packages/agent/src/correlation/rules.ts`:

- `getKafkaData(state)` reads `r.kafkaFindings` (was: `r.data` cast through `z.unknown()`).
- `getGitLabMergedRequests(state)` reads `r.gitlabFindings.mergedRequests`.
- `getDatastoreSlowQueries(state)` reads `r.couchbaseFindings.slowQueries`.

The five dormant rules don't need their body changed — they call helpers. Helpers' return types become the typed `KafkaFindings | null` etc., removing `z.unknown()` casts in the rules file.

## Phasing

### Sidecar (independent) — `kafka-tool-failures` field-name fix

One-line helper change reading top-level `result.toolErrors` instead of nonexistent `result.data.toolErrors[]`. Unit test asserts firing. ~30 min, mergeable independently of any extractor work. **Own sub-ticket.**

### Phase A — Capture + first extractors (this PR cluster)

1. Schema additions in `packages/shared/src/agent-state.ts`.
2. `toolOutputs[]` capture in `sub-agent.ts`.
3. `extractFindings` node + wiring into the graph (verify pipeline-assembly file path in plan step).
4. Per-domain extractors (`extractors/{kafka,gitlab,couchbase}.ts`).
5. Rule helper migration in `rules.ts`.
6. Test migration: `engine.test.ts` dormant-rule tests switch from `withKafkaResult(state, {consumerGroups: ...})` to populating `kafkaFindings`.
7. Update `CLAUDE.md` and `docs/architecture/agent-pipeline.md`.

**Acceptance:**
- 3 previously-dormant rules fire in production traffic when matching tools are called: `kafka-empty-or-dead-groups`, `kafka-significant-lag`, `gitlab-deploy-vs-datastore-runtime`. Validated by LangSmith trace inspection on at least one query per rule.
- `bun run typecheck`, `bun run lint`, `bun run test` pass.
- 12 live rules unchanged — manual replay of a canonical incident query confirms no regression.

### Phase B — Missing Kafka MCP tools (separate sub-tickets)

1. Expose `kafka_list_dlq_topics` MCP tool (service method exists at `packages/mcp-server-kafka/src/services/kafka.ts:308`; needs registration + Zod schema + integration test).
2. Phase A's `extractors/kafka.ts` extended to read the new output and populate `dlqTopics[]`.
3. `kafka-dlq-growth` rule goes live.

Optional batch state-aggregator tool — only if measurement shows N per-group calls is a bottleneck.

### Phase C — Cleanup + follow-up tickets

1. Remove any `z.unknown()` casts in `rules.ts` made unnecessary by typed findings.
2. Document the findings extraction layer in `docs/architecture/agent-pipeline.md`.
3. Create Linear follow-up tickets (after spec approval and implementation plan exist):
   - Parent: "Findings extractors for remaining datasources, on demand" — for future `awsFindings` / `elasticFindings` / `konnectFindings` when a structured rule needs them.
   - Child (blocked by SIO-766): "atlassianFindings extractor once atlassian-agent is wired into fan-out".

## Non-goals (explicit)

- Replacing prose `result.data`. Aggregator and UI keep consuming the prose summary unchanged.
- LLM-emitted JSON. Extractors are deterministic TypeScript over raw tool JSON. No prompt changes to any SOUL.md.
- Schema-per-tool validation. Extractors parse defensively (try/catch); they don't strict-`.parse()` tool outputs against MCP-side schemas.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| MCP tool response shapes drift, breaking an extractor | Medium | Soft-fail per result; broken extractor = rule stays dormant, not a crash. Fixture tests pin expected shapes. |
| `toolOutputs[]` payload bloats LangGraph checkpoint size | Low-medium | Measure in Phase A. Add a per-output `SUBAGENT_TOOL_RESULT_CAP_BYTES`-style cap only if measurement shows the problem. |
| `extractFindings` node breaks the reducer | Low | Returns `{results}` (existing reducer key); new fields are optional; reducer's array-append behaviour unchanged. |
| Phase B blocks Phase A merging | None | Phase A is fully shippable without Phase B — unblocked rules fire; dormant ones stay dormant until Phase B. |

## Critical files to modify (Phase A)

| File | Change |
|---|---|
| `packages/shared/src/agent-state.ts` | Add `KafkaFindingsSchema`, `GitLabFindingsSchema`, `CouchbaseFindingsSchema` + the 3 sibling fields on `DataSourceResult`. |
| `packages/shared/src/index.ts` | Re-export new types/schemas. |
| `packages/agent/src/sub-agent.ts:417` | Populate `toolOutputs[]` from `ToolMessage` content. |
| `packages/agent/src/extract-findings.ts` | NEW — `extractFindings` graph node. |
| `packages/agent/src/correlation/extractors/kafka.ts` | NEW — extractor + tests. |
| `packages/agent/src/correlation/extractors/gitlab.ts` | NEW. |
| `packages/agent/src/correlation/extractors/couchbase.ts` | NEW. |
| `packages/agent/src/correlation/rules.ts` | Migrate `getKafkaData` / `getGitLabMergedRequests` / `getDatastoreSlowQueries` to read typed sibling fields. |
| `packages/agent/src/graph.ts` (or pipeline-assembly file — verify path in plan step) | Add `extractFindings` node between `aggregate` and `enforceCorrelationsRouter`. |
| `packages/agent/tests/correlation/engine.test.ts` | Migrate dormant-rule tests from `withKafkaResult(state, {consumerGroups: ...})` to populating `kafkaFindings`. |
| `CLAUDE.md` | Update pipeline diagram (13 → 14 nodes). |
| `docs/architecture/agent-pipeline.md` | Update full diagram + add "Findings extraction" subsection. |

## Verification end-to-end

1. **Unit:** `bun run --filter @devops-agent/agent test` covers extractor fixtures + rule-helper migration + integration test for the `extractFindings` node.
2. **Type/lint:** `bun run typecheck && bun run lint` clean across all packages.
3. **Integration replay:** start `bun run dev`, fire a Kafka-related query that touches `kafka_get_consumer_group_lag` and `kafka_list_consumer_groups`, then inspect the LangSmith trace for the run:
   - `extractFindings` node appears with `kafkaFindings.consumerGroups[]` populated.
   - `kafka-empty-or-dead-groups` or `kafka-significant-lag` evaluates as "fired" (visible in `enforceCorrelationsAggregate` output) when conditions are met.
   - Aggregator output and validator output unchanged in shape.
4. **No-regression:** rerun the SIO-767 manual-validation query ("How is my AWS landscape?") and confirm answer shape + confidence are unchanged (this query touches none of the migrated rules).

## Memory considerations

- `reference_supervisor_send_shape` — relevant to integration test wiring.
- `reference_first_deploy_to_fresh_account_bugs` — pattern reminder: surface dormant bugs together; Phase B + sidecar may surface more.
- `feedback_plan_authority_over_pattern` — the schema design (separate per-domain fields vs discriminated union) is a deliberate divergence from a discriminated-union pattern that's common elsewhere; defend if a reviewer flags.
- `feedback_handoff_docs_main_branch` — this spec is a doc-only commit, pushed direct to main without PR.
