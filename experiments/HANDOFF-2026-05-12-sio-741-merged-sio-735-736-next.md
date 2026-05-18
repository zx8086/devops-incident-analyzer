# Handoff — 2026-05-12 — SIO-741 merged (PR #84); SIO-735 + SIO-736 next

## Where things stand

- **`main` is at `f83609b`** — SIO-741 merged via PR #84 ("SIO-741: split mitigation node into 3 parallel LangGraph branches"). Local main is clean, no uncommitted work, feature branch deleted.
- **SIO-735 and SIO-736 are both `Todo`, Priority Medium** — same shape: paginate one more unbounded topic-list call, mirroring the SIO-731 pattern that just landed in PR #78 (`89f2286`).
- **SIO-716 was canceled** — not a bug; dev MCP correctly points at dev Confluent. Production Kafka MCP will be a separate deployment with prd-pointed env, not a code fix here.

## Why we're doing these together

Both are tiny follow-ups to the same pattern. One feature branch, two commits, one PR is the right shape. The total diff is probably ~150 LoC source + ~150 LoC tests across both.

## Reference: what SIO-731 actually did (read this first)

Commit `89f2286`, PR #78. Key moves in `packages/mcp-server-kafka/`:

1. Added a sibling method `KafkaService.listTopicsPaged()` — kept the old `listTopics()` untouched because `listDlqTopics` depends on its unbounded shape.
2. Three new params on the `kafka_list_topics` tool: `prefix` (case-sensitive startsWith, applied before the regex `filter`), `limit` (1–500, default 100), `offset` (>=0, default 0).
3. Response shape: `{ topics, total, truncated, hint? }`. `hint` only appears when `truncated` OR when `offset >= total` (past-the-end signal for the LLM).
4. Topics are sorted ASCII before slicing so `offset` is stable across calls — Kafka Admin gives no order guarantee.

Tests in `packages/mcp-server-kafka/src/services/kafka-service.test.ts` (or wherever the listTopics paged tests live) cover: 500 mock topics + default limit → 100 + `truncated: true`; `prefix: "user-"` filters; offset overflow returns empty + hint.

Run `git show 89f2286 -- packages/mcp-server-kafka` for the exact diff to mirror.

## SIO-735 — paginate `kafka_get_cluster_info` topic list

**File**: `packages/mcp-server-kafka/src/services/kafka-service.ts:580-596` (the `getClusterInfo()` method, current shape verified on `main@f83609b`).

Current body returns:

```ts
return {
  provider: provider.type,
  providerName: provider.name,
  topicCount: topics.length,
  topics,                      // <-- unbounded, same problem as SIO-731
  ...providerMetadata,
};
```

The `topics` field is the same unbounded `string[]` SIO-731 just fixed for `kafka_list_topics`. On the c72 prod MSK (166 topics today) this isn't catastrophic, but every cluster-info call pays the full token bloat.

### Approach

Mirror SIO-731. Two choices for the API surface:

- **Option A (recommended)**: keep `topicCount` (it's the useful aggregate), add the SIO-731 paging shape inside a nested `topicList: { topics, total, truncated, hint? }` field. Default limit unchanged from SIO-731 (100). Add `prefix` / `limit` / `offset` params to the `kafka_get_cluster_info` tool's Zod schema (or have `getClusterInfo()` accept the same opts object as `listTopicsPaged()`).
- **Option B**: just replace `topics` with the paged shape inline. Simpler but changes the field-name layout for any existing consumer of `topics`. Check if the aggregator/sub-agent prompts in `agents/incident-analyzer/agents/kafka-agent/` actually read `cluster_info.topics` — if not, B is fine. If they do, prefer A.

### Steps

1. Grep `cluster_info` / `getClusterInfo` references in `agents/` and `packages/agent/` first to choose A vs B.
2. Extract a shared helper if you can — `sliceTopics(topics: string[], opts: { prefix?, limit?, offset? }): { topics, total, truncated, hint? }`. Currently SIO-731 has this logic inline in `listTopicsPaged`; pulling it out costs ~20 LoC and removes the duplication for SIO-735 + SIO-736.
3. Update the Zod schema in `src/tools/read/parameters.ts` (find the `kafka_get_cluster_info` block; if it doesn't accept params today, you need to add one).
4. Update the prompt in `src/tools/read/prompts.ts` to mention the limit + prefix knobs (one sentence).
5. Tests: same fixture pattern as SIO-731.

### Acceptance

- `kafka_get_cluster_info` with default params on a 500-topic mock cluster returns `topicCount: 500`, a topicList with 100 items + `truncated: true`.
- `prefix: "DLQ_"` returns only the DLQ topics.
- `bun run typecheck` + `bun run lint` clean; new tests green.

## SIO-736 — paginate `restproxy_list_topics`

**File**: `packages/mcp-server-kafka/src/services/restproxy-service.ts:43-45`. Current body:

```ts
async listTopics(): Promise<string[]> {
  return this.request<string[]>("GET", "/topics");
}
```

REST Proxy v2 has no pagination on `/topics` upstream — you fetch all of them and slice client-side. Same as the AdminClient-backed path SIO-731 solved.

### Approach

- Add a `listTopicsPaged({ prefix?, limit?, offset? })` sibling method that calls `request<string[]>("GET", "/topics")` then runs the same `sliceTopics` helper from SIO-735 (so do SIO-735 first to land the shared helper, then SIO-736 is just ~30 LoC).
- The Confluent REST Proxy endpoint is the same shape that powers `restproxy_*` tools when the runtime is in `RESTPROXY_ENABLED` mode (the env state currently used by the AgentCore Kafka MCP per `reference_confluent_endpoints_used_by_agentcore_kafka_mcp.md`).
- Find the corresponding tool registration (likely in `src/tools/read/` or `src/tools/restproxy/`) and wire the three new params on it, same Zod / prompt updates as SIO-735.

### Acceptance

- `restproxy_list_topics` with default params on a mock cluster of 500 topics returns 100 + `truncated: true`.
- `prefix: "DLQ_"` filters as expected.
- `bun run typecheck` + `bun run lint` clean; new tests green.

## Verification (both tickets)

1. `bun run typecheck` — workspace clean.
2. `bun run lint` — clean on the kafka MCP package (ignore the unrelated pre-existing `mcp-server-couchbase` import-sort warning).
3. `bun test --filter @devops-agent/mcp-server-kafka` — all green.
4. **Manual smoke (worth doing)**: run the agent against c72 prod once the new MCP is deployed (or with a local broker that has >100 topics seeded) and observe the tool response is bounded.

## CLAUDE.md guardrails (do not skip)

- Both Linear issues (SIO-735, SIO-736) already exist. Implementation can start immediately.
- Never commit without explicit "commit + push + PR" from the user.
- Never set Linear issues to "Done" without user approval.
- All work goes through PR review — push to a feature branch, open a PR, don't push to main.

## Quick-start commands for the new session

```bash
# 1. Confirm clean state
git status
git log --oneline -3        # top should be f83609b SIO-741

# 2. Create feature branch (one branch for both tickets)
git checkout -b simonowusupvh/sio-735-736-paginate-cluster-info-restproxy-topics

# 3. Read this handoff + the reference PR diff first
cat experiments/HANDOFF-2026-05-12-sio-741-merged-sio-735-736-next.md
git show 89f2286 -- packages/mcp-server-kafka

# 4. Land SIO-735 first (introduces the shared sliceTopics helper)
#    then SIO-736 reuses it in one ~30 LoC commit.
```

## Out of scope (do not bundle in)

- SIO-716 was canceled — dev vs prd endpoint routing is an infra/deployment concern, not a code fix.
- Any new restproxy_* / connect_* tools (these already exist).
- Touching `listDlqTopics` — it depends on the unbounded `listTopics()` shape on purpose; leave it alone (SIO-731 did the same).

## Risks

1. **Aggregator prompt consumes `cluster_info.topics`** — if any prompt template reads that field today, Option B (replace inline) would silently break it. Grep first.
2. **Shared helper placement** — putting `sliceTopics` in `src/services/kafka-service.ts` ties it to that file's module; if it's used by both kafka-service.ts and restproxy-service.ts, pull it to `src/services/topic-pagination.ts` to avoid a circular-ish dep. ~10 LoC of housekeeping.
3. **Test coverage drift** — SIO-731 already has the slicing tests. SIO-735/736's tests should focus on the `getClusterInfo` / `restproxy listTopics` wiring, not re-test the slice logic itself if the helper has its own unit tests.

## Memory pointers (for the new session's auto-memory layer)

- `feedback_handoff_docs_main_branch.md` — handoff doc commits can go straight to main (no PR)
- `feedback_linear_doc_syncs.md` — doc-only commits don't need a new Linear ticket
- `reference_confluent_endpoints_used_by_agentcore_kafka_mcp.md` — confirms RESTPROXY_ENABLED reach today
- `feedback_never_create_linear_done.md` — SIO-735/736 stay in Todo until the user approves the move
- `reference_experiments_dir_gitignored.md` — this file is local-only; do not force-add
