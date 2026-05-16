# Spec — Activate `gitlab-deploy-vs-datastore-runtime` correlation rule (SIO-771 + SIO-772)

**Date:** 2026-05-16
**Author:** Claude (with Simon)
**Status:** Draft — for review
**Tickets:** [SIO-771](https://linear.app/siobytes/issue/SIO-771), [SIO-772](https://linear.app/siobytes/issue/SIO-772) (both children of [SIO-764](https://linear.app/siobytes/issue/SIO-764))
**Branch base:** `main` @ `e208df7`

## Context

The `gitlab-deploy-vs-datastore-runtime` correlation rule (`packages/agent/src/correlation/rules.ts:504-548`) is the last of the five originally-dormant rules surfaced during SIO-764 brainstorming. It detects an unresolved cross-source contradiction: a GitLab MR merged within the last 30 days claims a fix has been deployed, yet a datastore observation *after* that merge timestamp shows a query whose statement shares a distinctive token with the MR body — i.e., the same "buggy behaviour" the MR purported to fix is still running.

It is dormant because both helpers (`getGitLabMergedRequests`, `getDatastoreSlowQueries`) cast `result.data` to a typed object, but in production `result.data` is the LLM's prose summary (a string). SIO-764 Phase A established the structured-findings pattern (typed `kafkaFindings` sibling populated by an extractor in the `extractFindings` graph node) but only wired the kafka domain. SIO-771 and SIO-772 are the gitlab and datastore counterparts.

The SIO-771/772 ticket descriptions assume Phase A already added `gitlabFindings` and `couchbaseFindings` schema slots — **it did not**. Only `kafkaFindings` exists on `DataSourceResult` today. The schema work is in scope here.

This spec narrows the original ticket scope to one datastore (couchbase) — konnect is omitted. The rule's existing konnect branch becomes dead code that we leave as-is; widening it costs work without a real consumer, and the rule will still fire when gitlab + couchbase both have qualifying data.

## Goals

1. `gitlab_list_merge_requests` MCP tool returns enough per-MR data for the rule's token-matching and timestamp filters.
2. `capella_get_longest_running_queries` returns `lastExecutionTime` alongside its existing columns so the post-merge filter has a comparison anchor.
3. `extractFindings` populates typed `gitlabFindings.mergedRequests[]` and `couchbaseFindings.slowQueries[]` siblings on `DataSourceResult` from those tools' raw outputs.
4. The rule's helpers read the typed slots (with a brief `result.data` fallback during the transition is **not** in scope — see "Non-goals").
5. `gitlab-deploy-vs-datastore-runtime` fires in production traffic when both sides have qualifying data, capping confidence per the existing rule body.

## Non-goals

- **Konnect side.** The rule's `getDatastoreSlowQueries(state, "konnect")` branch keeps casting `result.data`. It stays dormant for konnect. Add a `konnectFindings` extractor only when a real consumer arrives (matches the SIO-773 deferral policy).
- **Backward-compat fallback in helpers.** The rule currently reads `result.data as {...}`. We replace that with `result.couchbaseFindings.slowQueries` / `result.gitlabFindings.mergedRequests`. No `result.data` fallback — the LLM never wrote the structured shape there in production, so a fallback would have nothing to fall back to.
- **Removing the rule's konnect iteration.** Code clarity says delete dead branches, but the konnect side may activate later via the same SIO-773 process; leave it. Mark it with a `SIO-771` comment explaining the temporary asymmetry.
- **Phase C / SIO-773 work** (AWS, elastic, atlassian extractors). Out of scope here.

## Decisions

### Field naming: snake_case (GitLab API native)

The rule already reads `mr.id`, `mr.title`, `mr.description`, `mr.merged_at`. The GitLab REST API returns these exact field names. Mirroring the API one-to-one means:

- The extractor is a pass-through validator, not a renamer.
- The rule body doesn't change beyond swapping the helper's source.
- Future fields needed by future rules just flow through.

The SIO-771 ticket proposed `mergedAt` / `projectId` (camelCase). I'm rejecting that. The cost (renaming the rule's reads + every future rule needing to know "we renamed merged_at to mergedAt for fashion") outweighs the consistency benefit.

### Couchbase tool: extend existing SQL, do not add a new tool

`capella_get_longest_running_queries` already has a `min_time_ms` arg and runs `n1qlLongestRunningQueries`. The SQL returns `{statement, avgServiceTime, queries}` per statement group but lacks `lastExecutionTime`. Fix by adding `MAX(requestTime) AS lastExecutionTime` to the existing query. The change is additive — existing callers see a new column they can ignore. Avoids duplicating SQL across two tools that mean the same thing.

The "Add a new tool" path was rejected because (a) "slow queries" and "longest-running queries with a min-time filter" are the same thing, (b) duplicating analysis SQL invites drift, and (c) the rule consumes the same shape either way.

### Single PR or split?

Single PR with four logical commits:

1. `SIO-771/772: add GitLabFindings + CouchbaseFindings schema slots`
2. `SIO-771/772: convert kafka extractor to Zod for uniformity`
3. `SIO-771: add gitlab_list_merge_requests tool + extractor`
4. `SIO-772: add lastExecutionTime to longest-running query + couchbase extractor; activate rule`

The schema commit is a prerequisite for both extractors and the helper migration. The kafka-conversion commit lands second so the two new extractors land alongside a uniform pattern across all three domains (gitlab, couchbase, kafka). Keeping them in one PR means the rule is dormant up to commit 4 and live at commit 4 — atomic activation. Splitting into two PRs means the first one (gitlab only) leaves the rule still dormant despite touching the helper, which is more confusing than helpful.

### Helper migration approach

Replace `getGitLabMergedRequests` and `getDatastoreSlowQueries` bodies to read the new typed slot. Keep the function signature identical so the rule body needs no changes beyond that. Delete the inline `interface GitLabMergedRequest` and `interface DatastoreSlowQuery` from `rules.ts:449-460` and import the equivalent types (`GitLabMergedRequest`, `CouchbaseSlowQuery`) from `@devops-agent/shared` so there's one canonical shape.

## Components

### 1. Shared schemas (`packages/shared/src/agent-state.ts`)

Add two schemas mirroring `KafkaFindingsSchema`:

```typescript
export const GitLabMergedRequestSchema = z.object({
  id: z.union([z.number(), z.string()]),
  project_id: z.number().int().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  merged_at: z.string().optional(), // ISO-8601 from GitLab API
  web_url: z.string().optional(),   // useful for future UI rendering
});
export type GitLabMergedRequest = z.infer<typeof GitLabMergedRequestSchema>;

export const GitLabFindingsSchema = z.object({
  mergedRequests: z.array(GitLabMergedRequestSchema).optional(),
});
export type GitLabFindings = z.infer<typeof GitLabFindingsSchema>;

export const CouchbaseSlowQuerySchema = z.object({
  statement: z.string(),
  avgServiceTime: z.string().optional(), // SQL DURATION_TO_STR format, e.g. "1.234ms"
  lastExecutionTime: z.string().optional(), // ISO-8601
  queries: z.number().int().optional(),
});
export type CouchbaseSlowQuery = z.infer<typeof CouchbaseSlowQuerySchema>;

export const CouchbaseFindingsSchema = z.object({
  slowQueries: z.array(CouchbaseSlowQuerySchema).optional(),
});
export type CouchbaseFindings = z.infer<typeof CouchbaseFindingsSchema>;
```

Widen `DataSourceResultSchema` to add `gitlabFindings: GitLabFindingsSchema.optional()` and `couchbaseFindings: CouchbaseFindingsSchema.optional()` (mirrors the Phase A `kafkaFindings` field).

Re-export the four types + four schemas from `packages/shared/src/index.ts`.

### 2. GitLab tool (`packages/mcp-server-gitlab/src/tools/code-analysis/list-merge-requests.ts`)

New sibling of `list-commits.ts` etc. Signature mirrors `registerListCommitsTool`:

```typescript
export function registerListMergeRequestsTool(server: McpServer, restClient: GitLabRestClient): void {
  server.tool(
    "gitlab_list_merge_requests",
    `[READ] List merge requests for a project. ...`,  // describe state, time-window, why id is numeric
    {
      project_id: z.number().int().describe("Numeric project ID. URL-encoded paths return 404 against /api/v4 (see memory: reference_gitlab_internal_vs_public)."),
      state: z.enum(["merged", "opened", "closed", "all"]).optional().default("merged"),
      updated_after: z.string().optional().describe("ISO-8601 timestamp; only return MRs updated after this (server-side filter)."),
      per_page: z.number().int().min(1).max(100).optional().default(20),
    },
    async (args) => {
      const res = await restClient.get(`/projects/${args.project_id}/merge_requests`, {
        params: { state: args.state ?? "merged", updated_after: args.updated_after, per_page: args.per_page ?? 20 },
      });
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    },
  );
}
```

Returned shape is GitLab's native MR array — already matches `GitLabMergedRequestSchema` 1:1.

Register in `code-analysis-registry.ts` (bump the return count from 5 to 6).

### 3. GitLab extractor (`packages/agent/src/correlation/extractors/gitlab.ts`)

```typescript
import type { GitLabFindings, GitLabMergedRequest, ToolOutput } from "@devops-agent/shared";
import { GitLabMergedRequestSchema } from "@devops-agent/shared";

export function extractGitLabFindings(outputs: ToolOutput[]): GitLabFindings {
  const mergedRequests: GitLabMergedRequest[] = [];

  for (const o of outputs) {
    if (o.toolName !== "gitlab_list_merge_requests") continue;
    if (!Array.isArray(o.rawJson)) continue;
    for (const mr of o.rawJson) {
      const parsed = GitLabMergedRequestSchema.safeParse(mr);
      if (parsed.success) mergedRequests.push(parsed.data);
    }
  }

  return mergedRequests.length > 0 ? { mergedRequests } : {};
}
```

Use Zod `safeParse` per the project's "Zod for all runtime validation" rule (CLAUDE.md). The kafka extractor's hand-rolled `isRecord` + `typeof` guards are an outlier from Phase A; commit 2 of this PR brings kafka in line (see component 8 below).

Sibling test file mirroring `extractors/kafka.test.ts` shape: bare-array fixture, schema-conformant entries pass through, malformed entries drop silently.

### 4. Couchbase tool change + extractor

**SQL change in `n1qlLongestRunningQueries`**: add `MAX(requestTime) AS lastExecutionTime` after the `LETTING` clause. Test by reading the SQL row shape and threading it through `executeAnalysisQuery`'s mapping (verify during implementation — the util may need a small change too).

**Critical structural problem**: `executeAnalysisQuery` (queryAnalysisUtils.ts:22-91) returns a `ToolResponse` whose `content[0].text` is a **markdown document** — a heading, a JSON-fenced code block, and "Query Execution Details" / "Limit Application" sections. The agent's `tryParseJson(String(m.content))` cannot parse markdown, so `o.rawJson` for `capella_get_longest_running_queries` is the raw markdown string, not a structured object. The naive extractor approach fails here.

**Fix**: add a sibling helper `executeAnalysisQueryStructured` in `queryAnalysisUtils.ts` that returns the same rows but emits them as a JSON payload via the `---STRUCTURED---` sentinel pattern (or just as a bare JSON `ToolResponse`). Use it from `getLongestRunningQueries.ts`. This is additive — the existing helper stays for any tool that genuinely wants markdown rendering. The new tool emits machine-readable JSON only.

Decision: **bare JSON ToolResponse**, not the sentinel.  The sentinel pattern was designed for *errors* with structured metadata appended after a human message. The success-path equivalent is just `JSON.stringify(rows)` as the entire text — same path `tryParseJson` uses for kafka tools. Don't introduce a new sentinel; reuse the kafka success pattern.

```typescript
// In queryAnalysisUtils.ts, sibling to executeAnalysisQuery
export async function executeAnalysisQueryStructured(
  bucket: Bucket,
  queryString: string,
  parameters?: Record<string, unknown>,
): Promise<ToolResponse> {
  const cluster = bucket.cluster;
  const result = parameters && Object.keys(parameters).length > 0
    ? await cluster.query(queryString, { parameters })
    : await cluster.query(queryString);
  const rows = await result.rows;
  return { content: [{ type: "text", text: JSON.stringify(rows) }] };
}
```

`getLongestRunningQueries.ts` switches to the structured helper. Existing tests for the markdown-rendering version of the tool need updating (or — preferred — get split so the markdown rendering keeps its own unit test if other tools still use it). The structured tool's response is now a bare `DlqTopic[]`-style array, parsed directly by `tryParseJson` into `o.rawJson` as `CouchbaseSlowQuery[]`.

**New extractor** at `packages/agent/src/correlation/extractors/couchbase.ts`:

```typescript
import type { CouchbaseFindings, CouchbaseSlowQuery, ToolOutput } from "@devops-agent/shared";
import { CouchbaseSlowQuerySchema } from "@devops-agent/shared";

export function extractCouchbaseFindings(outputs: ToolOutput[]): CouchbaseFindings {
  const slowQueries: CouchbaseSlowQuery[] = [];
  for (const o of outputs) {
    if (o.toolName !== "capella_get_longest_running_queries") continue;
    if (!Array.isArray(o.rawJson)) continue;
    for (const q of o.rawJson) {
      const parsed = CouchbaseSlowQuerySchema.safeParse(q);
      if (parsed.success) slowQueries.push(parsed.data);
    }
  }
  return slowQueries.length > 0 ? { slowQueries } : {};
}
```

The extractor mirrors `kafka_list_dlq_topics` — bare-array `rawJson`, schema-validated entries pushed into the accumulator. Symmetric and simple once the markdown problem is solved upstream.

### 5. `extract-findings.ts` node registration

Today the node calls `extractKafkaFindings(r.toolOutputs ?? [])` for the kafka result. Extend the per-domain dispatch to also call `extractGitLabFindings` for `r.dataSourceId === "gitlab"` and `extractCouchbaseFindings` for `r.dataSourceId === "couchbase"`. Pattern stays domain-keyed; no abstraction.

### 6. Rule helper migration (`rules.ts`)

```typescript
// Delete the inline interfaces at rules.ts:449-460. Import from @devops-agent/shared.

function getGitLabMergedRequests(state: AgentStateType): GitLabMergedRequest[] {
  const result = state.dataSourceResults.find((r) => r.dataSourceId === "gitlab");
  if (!result || result.status !== "success") return [];
  return result.gitlabFindings?.mergedRequests ?? [];
}

function getDatastoreSlowQueries(state: AgentStateType, dataSourceId: "couchbase" | "konnect"): CouchbaseSlowQuery[] {
  // SIO-771/772: couchbase reads the typed sibling populated by extractCouchbaseFindings.
  // konnect remains dormant -- no extractor wired in this iteration. Returns [] which
  // makes the rule's konnect iteration a no-op without removing the branch.
  if (dataSourceId === "konnect") return [];
  const result = state.dataSourceResults.find((r) => r.dataSourceId === "couchbase");
  if (!result || result.status !== "success") return [];
  return result.couchbaseFindings?.slowQueries ?? [];
}
```

Update the dormancy comment at `rules.ts:483-489` to reflect that gitlab + couchbase are now live, konnect intentionally deferred.

### 8. Kafka extractor backport to Zod (`packages/agent/src/correlation/extractors/kafka.ts`)

Phase A's extractor uses hand-rolled `isRecord` + `typeof` guards. Convert to Zod `safeParse` for consistency with the two new extractors and to match the project's "Zod for all runtime validation" rule:

```typescript
import type { KafkaFindings, ToolOutput } from "@devops-agent/shared";
import { z } from "zod";

const ListConsumerGroupsRowSchema = z.object({ id: z.string(), state: z.string() });
const ListConsumerGroupsWrapperSchema = z.object({ groups: z.array(z.unknown()) });

const GetConsumerGroupLagSchema = z.object({ groupId: z.string(), totalLag: z.number() });

const ListDlqTopicsRowSchema = z.object({
  name: z.string(),
  totalMessages: z.number(),
  recentDelta: z.number().nullable(),
});

export function extractKafkaFindings(outputs: ToolOutput[]): KafkaFindings {
  const byId = new Map<string, { id: string; state?: string; totalLag?: number }>();
  const dlqTopics: Array<z.infer<typeof ListDlqTopicsRowSchema>> = [];

  for (const o of outputs) {
    if (o.toolName === "kafka_list_consumer_groups") {
      const wrapper = ListConsumerGroupsWrapperSchema.safeParse(o.rawJson);
      if (!wrapper.success) continue;
      for (const g of wrapper.data.groups) {
        const parsed = ListConsumerGroupsRowSchema.safeParse(g);
        if (!parsed.success) continue;
        const existing = byId.get(parsed.data.id) ?? { id: parsed.data.id };
        existing.state = parsed.data.state;
        byId.set(parsed.data.id, existing);
      }
    } else if (o.toolName === "kafka_get_consumer_group_lag") {
      const parsed = GetConsumerGroupLagSchema.safeParse(o.rawJson);
      if (!parsed.success) continue;
      const existing = byId.get(parsed.data.groupId) ?? { id: parsed.data.groupId };
      existing.totalLag = parsed.data.totalLag;
      byId.set(parsed.data.groupId, existing);
    } else if (o.toolName === "kafka_list_dlq_topics") {
      if (!Array.isArray(o.rawJson)) continue;
      for (const t of o.rawJson) {
        const parsed = ListDlqTopicsRowSchema.safeParse(t);
        if (parsed.success) dlqTopics.push(parsed.data);
      }
    }
  }

  const findings: KafkaFindings = {};
  if (byId.size > 0) findings.consumerGroups = Array.from(byId.values());
  if (dlqTopics.length > 0) findings.dlqTopics = dlqTopics;
  return findings;
}
```

The local row schemas stay file-private — they describe the **tool output** shape, not the **finding** shape that lives in `@devops-agent/shared`. Each tool's output schema is owned by its extractor.

Existing tests in `extractors/kafka.test.ts` should pass unchanged because the parser logic is semantically identical — same fixtures, same pass/drop decisions, just expressed via Zod.

### 7. Engine tests (`packages/agent/tests/correlation/engine.test.ts`)

Existing tests at line ~127 onwards exercise the rule via `withKafkaResult`-style helpers that hand-build `result.data` objects. Migrate to new helpers in `test-helpers.ts`:

```typescript
export function withGitLabFindings(state: AgentStateType, gitlabFindings: GitLabFindings): AgentStateType { ... }
export function withCouchbaseFindings(state: AgentStateType, couchbaseFindings: CouchbaseFindings): AgentStateType { ... }
```

Existing test assertions should be preserved verbatim where possible — the rule's `context` shape doesn't change.

## File-by-file change summary

| File | Change | Commit |
|---|---|---|
| `packages/shared/src/agent-state.ts` | Add 4 schemas + 4 types + widen `DataSourceResultSchema` with 2 optional slots. | 1 |
| `packages/shared/src/index.ts` | Re-export 4 types + 4 schemas. | 1 |
| `packages/agent/src/correlation/extractors/kafka.ts` | Convert hand-rolled `isRecord`/`typeof` guards to Zod `safeParse` with file-private row schemas. Semantically identical; tests pass unchanged. | 2 |
| `packages/mcp-server-gitlab/src/tools/code-analysis/list-merge-requests.ts` | New file. Pattern mirrors `list-commits.ts`. | 3 |
| `packages/mcp-server-gitlab/src/tools/code-analysis-registry.ts` | Register the new tool. Bump return count 5 → 6. | 3 |
| `packages/mcp-server-gitlab/tests/...` | Add test for `gitlab_list_merge_requests` if existing pattern supports it. | 3 |
| `packages/agent/src/correlation/extractors/gitlab.ts` | New extractor + sibling test. | 3 |
| `packages/agent/src/correlation/extractors/gitlab.test.ts` | New test. | 3 |
| `packages/mcp-server-couchbase/src/tools/queryAnalysis/analysisQueries.ts` | Add `MAX(requestTime) AS lastExecutionTime` to `n1qlLongestRunningQueries`. | 4 |
| `packages/mcp-server-couchbase/src/tools/queryAnalysis/queryAnalysisUtils.ts` | Add new `executeAnalysisQueryStructured` helper that emits bare-JSON `ToolResponse` (vs. the existing markdown-rendering `executeAnalysisQuery`). | 4 |
| `packages/mcp-server-couchbase/src/tools/queryAnalysis/getLongestRunningQueries.ts` | Switch to `executeAnalysisQueryStructured` so the agent receives parseable JSON. | 4 |
| `packages/mcp-server-couchbase/tests/...` | Update existing `getLongestRunningQueries` tests to assert JSON shape, not markdown. | 4 |
| `packages/agent/src/correlation/extractors/couchbase.ts` | New extractor + sibling test. | 4 |
| `packages/agent/src/correlation/extractors/couchbase.test.ts` | New test. | 4 |
| `packages/agent/src/extract-findings.ts` | Wire both new extractors into the per-domain dispatch. | 4 |
| `packages/agent/src/correlation/rules.ts` | Migrate `getGitLabMergedRequests`, `getDatastoreSlowQueries`. Delete inline interfaces. Update dormancy comment. | 4 |
| `packages/agent/tests/correlation/test-helpers.ts` | Add `withGitLabFindings`, `withCouchbaseFindings`. | 4 |
| `packages/agent/tests/correlation/engine.test.ts` | Migrate gitlab-deploy-vs-datastore-runtime tests to new helpers. | 4 |

## Verification

```bash
# Per-package iteration during dev
bun run --filter @devops-agent/shared typecheck
bun run --filter @devops-agent/mcp-server-gitlab typecheck && bun run --filter @devops-agent/mcp-server-gitlab test
bun run --filter @devops-agent/mcp-server-couchbase typecheck && bun run --filter @devops-agent/mcp-server-couchbase test
bun run --filter @devops-agent/agent typecheck && bun run --filter @devops-agent/agent test

# Final workspace pass
bun run typecheck
bun test packages/agent/tests/correlation/engine.test.ts \
         packages/agent/src/correlation/extractors/
```

**Manual MCP probes** (optional, requires GitLab + Couchbase reachable):

```bash
# GitLab
GITLAB_PERSONAL_ACCESS_TOKEN=... bun run --filter @devops-agent/mcp-server-gitlab dev &
curl -s http://localhost:9084/mcp -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[] | select(.name=="gitlab_list_merge_requests")'

# Couchbase (verify lastExecutionTime in returned rows)
CB_HOSTNAME=... CB_USERNAME=... CB_PASSWORD=... bun run --filter @devops-agent/mcp-server-couchbase dev &
curl -s http://localhost:9082/mcp -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"capella_get_longest_running_queries","arguments":{"limit":5,"min_time_ms":100}}}'
```

**LangSmith integration replay** (post-merge): fire a query like "What changed in the orders-service repo recently? Cross-check with couchbase slow queries since then." Inspect the trace for `extractFindings` populating both `gitlabFindings.mergedRequests[]` and `couchbaseFindings.slowQueries[]`, then `enforceCorrelationsAggregate` evaluating `gitlab-deploy-vs-datastore-runtime`. The rule fires only when there's a token overlap + post-merge observation — finding live firings will likely require an actual styles-v3-style incident, which is fine.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Adding `lastExecutionTime` to the SQL breaks an unrelated assertion in couchbase MCP tests | Medium | Run couchbase MCP suite at every step; bump any snapshot/structural assertions same-commit. |
| Other consumers of `n1qlLongestRunningQueries` (LLM prompts, runbooks) break if the SQL adds an extra column | Low | The column is additive; downstream consumers should ignore unknown columns. Grep `n1qlLongestRunningQueries` for callers before merging. |
| Switching `getLongestRunningQueries` to JSON response loses the human-friendly markdown rendering | Medium | The markdown was helpful when humans read raw tool output. Now the sub-agent receives JSON and renders its own prose summary — UI rendering still works because the LLM's prose lands in `result.data`. If we discover users were directly invoking this tool via the MCP CLI for human reading, we can add a `format: "markdown" \| "json"` arg. Defer until that complaint surfaces. |
| GitLab REST returns a paginated array with extra `link` headers the extractor doesn't expect | Low | The tool returns `restClient.get(...)` raw — extractor handles arrays only. Pagination is acceptable to defer. |
| Konnect dormancy comment becomes stale if konnect later activates | Low | The comment names SIO-771/772 explicitly; future konnect work will read it. |
| The rule's `gitlabRef: mr.id` field becomes inconsistent with new `web_url` shape | None | `mr.id` is already in the schema; passing through. |
| Kafka extractor rewrite (commit 2) regresses existing extractor behaviour | Low | Existing 8 fixture tests in `extractors/kafka.test.ts` cover the parse logic comprehensively. Run before/after to confirm identical pass set. If anything fails, the Zod schemas need a `passthrough()` or field rename to match the existing hand-rolled checks. |

## Out of scope

- Konnect findings extractor (defer per SIO-773 deferral policy)
- Removing the rule's konnect iteration branch (intentional — see [konnect dormancy comment in helper](#6-rule-helper-migration-rulests))
- Phase C extractors (AWS, elastic, atlassian)
- UI surfacing of the rule's `context.statementSignature` output

## Memory references

- `reference_gitlab_internal_vs_public` — `gitlab_list_commits` requires numeric `project_id`; URL-encoded paths 404. Same constraint applies to the new tool.
- `feedback_plan_authority_over_pattern` — prefer the spec's design (snake_case fields, single PR, schema-first) over reviewer hindsight on individual aspects unless a real defect surfaces.
- `reference_first_deploy_to_fresh_account_bugs` — when activating dormant code, expect cluster of latent issues to surface. Run all three packages' tests at each step.
- `reference_kafka_mcp_agentcore_ksql_disabled` — not directly relevant, but a reminder that tool registration ≠ tool reachability in all deployments; verify locally before claiming AgentCore parity.
