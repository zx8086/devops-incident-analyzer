# Handover — SIO-785 Phase 2 shipped (AWS + Atlassian cards + ElasticFindingsCard regression)

| | |
|---|---|
| Date | 2026-05-18 |
| Tickets | [SIO-785](https://linear.app/siobytes/issue/SIO-785) Phase 2 — AWS + Atlassian cards + live-verify (reused per user direction; the prior session's "Done" status covers Phase 1) |
| Parent epic | [SIO-775](https://linear.app/siobytes/issue/SIO-775) (Done — findings card system) |
| PR | https://github.com/zx8086/devops-incident-analyzer/pull/118 |
| Repo state | branch `simonowusupvh/findings-card-render-followups` at `9c41d67`; `main` still at `e6a95c5` |
| New tickets to file | 2 — see "Follow-up Linear tickets" below |
| Suggested branch for next session | depends on which follow-up — see "Workflow note" |

## TL;DR

Five findings cards live-verified end-to-end. Two new cards (AWSFindingsCard, AtlassianFindingsCard) built TDD-first, threaded through the schema → extractor → SSE → reducer → ChatMessage pipeline, and pipeline-verified in browser. A blocking regression was discovered in `ElasticFindingsCard`: the elastic MCP returns `elasticsearch_search` results as multiple plain-text content blocks, not the JSON envelope the extractor expects, so the card never renders for real elastic queries. Filed as the highest-priority follow-up. AWS + Atlassian cards' populated-state render is fully covered by unit tests but couldn't be live-verified with rendered rows — the dev AWS account has zero alarms and this Jira instance's labels don't match what `findLinkedIncidents` searches for.

## Context — how this work came to be

The 2026-05-18 morning session (handover: `experiments/HANDOFF-2026-05-18-sio-785-followups-shipped.md`) shipped 5 SIO-785 follow-ups but explicitly punted live-verification of the 3 new cards (Couchbase, GitLab, Elastic) and the construction of 2 more cards (AWS, Atlassian). This session picked those up via the plan at `~/.claude/plans/1-git-fetch-elegant-wombat.md`.

Phase A (live-verify the 3 existing) and Phase B+C (build AWS + Atlassian) were both completed. The ElasticFindingsCard regression was discovered in Phase A — exactly the failure mode the `feedback_extractor_fixtures_must_mirror_real_mcp` memory warns against.

## What shipped (and how to verify)

### Commit chain on `simonowusupvh/findings-card-render-followups`

```
9c41d67 docs: SIO-785 Phase 2 — live-verification log + screenshots
7b13524 chore: biome auto-format SIO-785 Phase 2 test files + fixture
32b38fa SIO-785: AtlassianFindingsCard component + mount in ChatMessage
68695f1 SIO-785: Atlassian linked-incidents findings extractor
8a047f7 SIO-785: AWSFindingsCard component + mount in ChatMessage
065b4d6 SIO-785: thread awsFindings + atlassianFindings through SSE + reducer
743e819 SIO-785: AWS extractor + register + truncation allowlist
d2284e7 SIO-785: add AwsFindings + AtlassianFindings schemas
```

Verify:

```bash
git fetch origin && git diff main..origin/simonowusupvh/findings-card-render-followups --stat
bun run typecheck                                    # 0 errors expected
bun test packages/agent/src                          # 439 pass, 18 skip
cd apps/web && bun test                              # 100 pass
cd ../../packages/shared && bun test                 # 287 pass
```

### Where the bodies are buried

- `packages/shared/src/agent-state.ts:143-186` — `AwsCloudWatchAlarmSchema` + `AwsFindingsSchema` + `AtlassianLinkedIssueSchema` + `AtlassianFindingsSchema`. Threaded into `DataSourceResultSchema` (lines 199-200) and `StreamEventSchema.datasource_result` variant (lines 271-273).
- `packages/shared/src/index.ts:8-15` — barrel re-exports for the 4 new types.
- `packages/agent/src/correlation/extractors/aws.ts` — extractor reads PascalCase `MetricAlarms[]` envelope and maps to camelCase typed findings. CompositeAlarms intentionally out of scope for v1.
- `packages/agent/src/correlation/extractors/atlassian.ts` — extractor reads `{issues}` envelope from `findLinkedIncidents`. Concatenates across multiple tool calls.
- `packages/agent/src/extract-findings.ts:65-67` — registration of `aws` and `atlassian` extractor entries in the `extractors` Record.
- `packages/agent/src/sub-agent-instrumentation.ts:36-37` — `aws_cloudwatch_describe_alarms` and `findLinkedIncidents` added to `TYPED_FINDING_TOOLS` allowlist (truncation skip).
- `apps/web/src/lib/server/sse-pump.ts:124-125,150-152` — `datasource_result` emission threads `awsFindings` + `atlassianFindings` in the spread.
- `apps/web/src/lib/stores/agent-reducer.ts:34-35,100-101` — reducer interface + applyStreamEvent populate new fields.
- `apps/web/src/lib/components/AWSFindingsCard.svelte` — state-aggregate header + sorted alarm rows.
- `apps/web/src/lib/components/AtlassianFindingsCard.svelte` — linked-key + status pill + severity badge row.
- `apps/web/src/lib/components/ChatMessage.svelte:69-70,90-97` — card-mount block extended with `awsFindings` + `atlassianFindings` `@const` + `{#if}` blocks.

### Probe outputs (saved fixtures)

- `packages/agent/src/correlation/extractors/__fixtures__/aws-alarms.json` — 3-row fixture with ALARM/INSUFFICIENT_DATA/OK rows for extractor tests (live account had 0 alarms; this fixture was hand-built from the documented SDK contract).

## ElasticFindingsCard regression — file follow-up ticket

`apps/web/src/lib/components/ElasticFindingsCard.svelte` never renders against real elastic MCP output. Root cause traced:

1. The elastic MCP's `elasticsearch_search` returns `result.content` as multiple `text` blocks: a `Total results: N, showing M from position P` summary, then one block per document with `Document ID: <id>\nScore: <n>\n\nagent: {...}\nsummary: {...}\nobserver: {...}` pretty-printed form.
2. `@langchain/mcp-adapters` joins those blocks into a single ToolMessage `content` string.
3. `packages/agent/src/sub-agent.ts:475` runs `tryParseJson(String(m.content))` → returns `null` because the joined text isn't JSON.
4. `packages/agent/src/correlation/extractors/elastic.ts:64` calls `SearchResponseSchema.safeParse(o.rawJson)` against `null` → fails.
5. Extractor emits `{}` → no `elasticFindings` → card hidden.

Existing unit tests at `packages/agent/src/correlation/extractors/elastic.test.ts` (if present) use fabricated `{hits:{hits:[...]}}` fixtures, masking the real-shape mismatch.

**Recommended fix:** update `extractElasticFindings` to detect the text-block format and parse via regex (narrow blast radius; no MCP redeploy required). See full discussion in `experiments/findings-card-verification.md` § "Task 3".

## Follow-up Linear tickets to file

### 1. ElasticFindingsCard never renders against real elastic MCP output (HIGHEST priority)

**Why:** Card silently invisible for the most-used datasource. Markdown report still describes monitor details, so users see SOME info; the typed card is just gone. Risk pattern is the same as the SIO-783 case-sensitivity bug.

**Fix sketch (option A):**

```ts
// in extractElasticFindings, before the SearchResponseSchema branch:
// If rawJson is null (parse failed) AND we have text content stored
// elsewhere — extract via regex.
//
// Need to store the joined content text in ToolOutput.rawText alongside rawJson
// (single-line change in sub-agent.ts:473-476), then in the extractor:
//
// for (const o of outputs) {
//   if (o.toolName !== "elasticsearch_search") continue;
//   if (o.rawJson) { /* existing JSON-envelope path */ }
//   else if (o.rawText) {
//     // parse "Document ID: ...\nmonitor: {...}\n" blocks via regex
//     const monitorRegex = /monitor:\s*\{[^}]*"name":\s*"([^"]+)"[^}]*"status":\s*"([^"]+)"/g;
//     // ... extract name + status + geo + timestamp into ElasticSyntheticMonitor
//   }
// }
```

**Estimate:** 2-3 hours including unit test fixtures that mirror the real MCP shape.

### 2. Storybook-style preview route for populated-state visual QA (LOW priority)

**Why:** AWS + Atlassian cards couldn't be visually verified with rendered rows because the dev AWS account has zero alarms and this Jira instance's labels don't match `findLinkedIncidents`'s JQL. A `/preview/findings-cards?fixture=<name>` route would render any card against a chosen fixture, decoupling visual QA from real-data conditions.

**Estimate:** 4 hours.

### 3. (deferred — pre-existing) Kafka MCP redeploy to AgentCore + component health badges row

Unchanged from the prior handover. See `experiments/HANDOFF-2026-05-18-sio-785-followups-shipped.md` § "Follow-up Linear tickets" #1 and #3.

### 4. (deferred — pre-existing) `connect_list_connectors` server-side response slimming

Unchanged from the prior handover.

### 5. (deferred — pre-existing) Entity-extractor `focusServices` filter

Unchanged from the prior handover.

## Workflow note for the next session

- **Branch is open as PR #118.** When implementing the ElasticFindingsCard fix, branch off `main` again (or off the PR branch if it hasn't merged yet) — don't keep stacking commits onto the PR branch unless explicitly desired.
- **Linear:** add a comment to SIO-785 with the PR #118 link summarising Phase 2 scope (5 cards verified, 2 new cards shipped). Per CLAUDE.md, do NOT flip SIO-785 to Done without user approval. The 2 new follow-ups above need their own tickets.
- **Lint drift on `main`:** 11 pre-existing biome-formatting errors exist on `main` (not caused by this PR). They show up if `bun run lint:fix` is run against the working tree. Separate cleanup PR recommended; do not include in feature PRs.

## Verification block

```bash
# Sync + sanity check at start of next session:
git fetch
git checkout main && git pull
git checkout -b <user>/elastic-card-regression-fix

# Test suites:
bun run typecheck                                    # 0 errors
bun test packages/agent/src                          # 439 pass, 18 skip
cd apps/web && bun test                              # 100 pass
cd ../../packages/shared && bun test                 # 287 pass

# Pre-flight infra (next session):
bun run oauth:seed:atlassian                         # only if tokens stale (>30d)
# Couchbase IP allowlist: confirm public IP at https://cloud.couchbase.com
# Verify all MCPs:
bun run --filter @devops-agent/mcp-server-couchbase dev &
bun run --filter @devops-agent/mcp-server-gitlab dev &
bun run --filter @devops-agent/mcp-server-atlassian dev &
bun run --filter @devops-agent/mcp-server-elastic dev &
bun run --filter @devops-agent/mcp-server-aws dev &
sleep 25
# All five should print "started successfully"

# Probe elasticsearch_search to confirm regression still present:
curl -s -X POST http://localhost:9080/mcp \
  -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"elasticsearch_search","arguments":{"index":"synthetics-*","query":{"match_all":{}},"size":3}}}' \
  | grep -c "Document ID:"
# Expect: ≥1 — confirms the text-block format that broke the extractor
```

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| New ElasticFindingsCard fix uses fixtures that don't mirror real MCP shape | High if not careful | Probe live before writing the extractor; copy text-block samples into fixtures verbatim. The `feedback_extractor_fixtures_must_mirror_real_mcp` memory now has two reinforcing incidents. |
| AWS account gets alarms before next session and AWSFindingsCard renders broken | Low | Unit tests cover the populated state. Re-run live verify if alarms appear. |
| Jira labeling conventions change and `findLinkedIncidents` starts returning results | Low | Same — unit tests cover the populated state. |
| Pre-existing lint drift on `main` blocks future CI runs | Medium | Filed mentally as "lint cleanup PR needed" — not in scope for any individual feature ticket. |

## Out of scope (do NOT do next session)

- Reformat the 11 pre-existing biome-drift files. Separate PR.
- Force-push or rewrite PR #118's branch history. Already pushed.
- Add Konnect findings card. User explicitly deferred this in the previous session.
- Extend ElasticFindingsCard beyond synthetic monitors (APM service summary, log clusters). Wait for the extractor fix to land first.

## Related code references

- `apps/web/src/lib/components/KafkaFindingsCard.svelte` — multi-section reference pattern (used as template for AWS card's aggregate header).
- `apps/web/src/lib/components/GitLabFindingsCard.svelte` — link-row reference pattern (used as template for Atlassian card).
- `packages/agent/src/correlation/extractors/couchbase.ts` — minimal extractor reference (used as template for AWS + Atlassian).
- `packages/agent/src/correlation/extractors/couchbase.test.ts` — extractor test pattern (used as template for AWS + Atlassian tests).
- `apps/web/src/lib/components/CouchbaseFindingsCard.test.ts` — Svelte SSR `render()` test pattern.

## Memory references

- `feedback_extractor_fixtures_must_mirror_real_mcp` — reinforced by the elastic card regression discovery. Two incidents now (this + SIO-783).
- `feedback_no_direct_push_to_main` — followed; all work on a feature branch + PR.
- `reference_couchbase_query_response_shapes` — outdated note about `capella_get_longest_running_queries` returning markdown; live probe today returned bare JSON array. Worth updating the memory.
- `reference_bun_hot_does_not_reresolve_modules` — followed; web dev fully restarted between agent code changes and live verification.
- `reference_b2b_apm_service_naming` — used to pick a known b2b project for the GitLab card probe.
- `reference_gitlab_internal_vs_public` — confirmed; `gitlab_list_merge_requests` requires numeric `project_id`.
- `feedback_handover_doc_structure` — followed for this handover.

## What to remember (for next session)

The plan I followed is at `~/.claude/plans/1-git-fetch-elegant-wombat.md` — leave that file alone unless picking up the exact same task list. The verification log at `experiments/findings-card-verification.md` is the definitive record of what was checked and what was discovered, including the ElasticFindingsCard regression with three ranked fix options.

Three sessions of SIO-785 work are now in the codebase:
- Session 1 (prior morning): foundational case-sensitivity fix + 3 new cards + truncation allowlist
- Session 2 (this): live-verify all 5 cards + 2 new cards (AWS, Atlassian) + Elastic regression discovery
- Session 3 (next): ElasticFindingsCard fix per option (A) + any of the deferred follow-ups
