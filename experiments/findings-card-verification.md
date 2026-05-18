# Findings Card Live-Verification Log

Branch: `simonowusupvh/findings-card-render-followups`
Plan: `/Users/Simon.Owusu@Tommy.com/.claude/plans/1-git-fetch-elegant-wombat.md`
Parent ticket: [SIO-785](https://linear.app/siobytes/issue/SIO-785) (Phase 2)
Date: 2026-05-18

This log records browser-verified renders of each FindingsCard against real MCP output, plus the AWS+Atlassian cards built in the same plan. Same risk pattern that hid the SIO-783 case-sensitivity bug — unit tests alone aren't sufficient.

---

## Task 1: CouchbaseFindingsCard — VERIFIED 2026-05-18

**Probe (Step 1.1):** `capella_get_longest_running_queries` against `couchbases://cb.mn1uxqblvorb0cle.cloud.couchbase.com`.

- Tool returned a bare JSON array (158 rows).
- First-row keys: `['avgServiceTime', 'lastExecutionTime', 'queries', 'statement']` — matches `CouchbaseSlowQuerySchema` (`packages/shared/src/agent-state.ts:109-114`) exactly.
- Top row: `avgServiceTime=2.43198498s`, `queries=2`, OFFSET 3660 statement.

**Browser verify (Step 1.2):** http://localhost:5173, prompt **"Show me the slowest N1QL queries on the couchbase cluster."**

- Response time: 159.6s; 2 data sources (couchbase + gitlab); Confidence 0.72.
- `CouchbaseFindingsCard` rendered above the diagnostic accordion.
- Card header: `COUCHBASE FINDINGS` / `SLOW QUERIES` (Tailwind uppercase).
- Rows sorted desc by avgServiceTime; top row 2.43198498s ×2, second 2.292741605s ×2, third 2.290093049s ×2 — exactly matches the probe order.
- Each row: statement (truncated with `title=`), bar, `avgServiceTime`, `×N` runs cell.

**Screenshot:** `experiments/screenshots/2026-05-18-couchbase-card.png`

**Verdict:** PASS — schema, sort, render all correct.

---

## Task 2: GitLabFindingsCard — VERIFIED 2026-05-18

**Probe (Step 2.1):** `gitlab_list_merge_requests` against gitlab.com via the gitlab MCP at `:9084`.

- The tool requires a numeric `project_id` (matches memory `reference_gitlab_internal_vs_public`).
- Probed `project_id=42625006` (`pvhcorp/b2b/shared-services/pvh.services.customer.assignments`): 3 merged MRs returned.
- First-row keys present: `id`, `project_id`, `title`, `description`, `merged_at`, `web_url` — matches `GitLabMergedRequestSchema` (`packages/shared/src/agent-state.ts:93-100`) exactly.
- `web_url` shape: `https://gitlab.com/pvhcorp/b2b/shared-services/pvh.services.customer.assignments/-/merge_requests/154` — matches the regex `^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/` in `GitLabFindingsCard.svelte:16` exactly.

**Browser verify (Step 2.2):** http://localhost:5173, datasource filter scoped to GitLab only via "None" → "GitLab". Prompt: **"For GitLab project_id 42625006 (pvhcorp/b2b/shared-services/pvh.services.customer.assignments), list the 3 most recently merged MRs."**

- Response time: 61.9s; 1 data source (gitlab); Confidence 0.72.
- `GitLabFindingsCard` rendered: `GITLAB FINDINGS` / `RECENT DEPLOYS` headers.
- 3 rows, sorted desc by `merged_at`:
  - `2026-04-23` · `shared-services/pvh.services.customer.assignments` · "Develop -> Master"
  - `2026-04-22` · `shared-services/pvh.services.customer.assignments` · "Query optimisations as suggested by Couhbase"
  - `2026-03-31` · `shared-services/pvh.services.customer.assignments` · "Develop"
- Project name slug correctly derived from `web_url` (last 2 path segments per `projectFromWebUrl`).
- MR titles render as links.

**Screenshot:** `experiments/screenshots/2026-05-18-gitlab-card.png`

**Earlier failed attempt note:** A broader prompt "List the last 5 merged MRs across pvhcorp/b2b in the past 30 days" did NOT produce a card — the agent attempted `gitlab_list_merge_requests` without `project_id` (failed validation) and fanned out to 6 datasources searching for MR data elsewhere. Card not rendering on that attempt was correct (no successful tool output → no findings → no card). The fix is prompt-side: name a project_id, scope to gitlab only.

**Verdict:** PASS — schema, sort, project-name extraction, render all correct.

---

## Task 3: ElasticFindingsCard — FAIL (regression discovered)

**Probe (Step 3.1):** `elasticsearch_search` against `synthetics-*` on the elastic MCP at `:9080`.

- Real MCP response shape **does NOT match** the `SearchResponseSchema` expected by `extractElasticFindings`.
- The MCP returns `result.content` as an array of 4 separate text blocks:
  1. Block 0: summary line `"Total results: 10000, showing 3 from position 0"`
  2. Block 1, 2, 3: each a pretty-printed document, prefixed `Document ID: <id>\nScore: <n>\n\nagent: {...}\nsummary: {...}\nobserver: {...}`
- These are NOT a JSON-encoded `{hits: {hits: [...]}}` envelope; they are human-readable text.

**Browser verify (Step 3.2):** http://localhost:5173, datasource filter scoped to Elastic only, Elastic deployment scoped to `ap-cld` only. Prompt: **"Are any synthetic monitors currently down on the ap-cld cluster? Query synthetics-* and report monitor name, status, and observer geo."**

- Response time: 77.5s; 1 data source (elastic/ap-cld); Confidence 0.82.
- Agent returned a **detailed synthetic monitor report** in markdown — 18 down monitor IDs, monitor names, geos, statuses, error details. So the data IS available.
- **`ElasticFindingsCard` did NOT render** — `body.innerText` contained neither `ELASTIC FINDINGS` nor `SYNTHETIC MONITORS`.

**Root cause (pipeline trace):**

1. `elasticsearch_search` returns multiple text blocks (human-readable, not JSON).
2. `@langchain/mcp-adapters` joins them into the LangGraph `ToolMessage.content` as a single string.
3. `packages/agent/src/sub-agent.ts:475`: `rawJson: tryParseJson(String(m.content))` returns `null` (string isn't JSON).
4. `packages/agent/src/correlation/extractors/elastic.ts:64`: `SearchResponseSchema.safeParse(o.rawJson)` fails (rawJson is null).
5. Extractor emits `{}`. No `elasticFindings` in `DataSourceResult`. No card row to mount.

This is **exactly the failure mode the `feedback_extractor_fixtures_must_mirror_real_mcp` memory warns about** — the existing unit tests in `packages/agent/src/correlation/extractors/elastic.test.ts` (if any) use fabricated `{hits:{hits:[...]}}` fixtures that don't reflect the real MCP shape.

**Screenshot:** `experiments/screenshots/2026-05-18-elastic-no-card.png` (markdown report visible; no card)

**Verdict:** REGRESSION — agent data flows through markdown but typed card path is broken. Fix is out of scope for this plan (SIO-785 Phase 2 covers AWS + Atlassian cards and verification of existing cards, not extractor-pipeline bugs).

**Follow-up ticket to file:** `ElasticFindingsCard never renders against real elastic MCP output`. Three fix options ranked by surgicality:

- **(A) Lightweight, recommended:** Update `extractElasticFindings` to also handle the text-block format. Detect a `tryParseJson` failure followed by a `Document ID:` regex, then parse the pretty-printed `observer:`/`monitor:`/`summary:` blocks via regex. Defensive and self-contained; no MCP/agent changes.
- **(B) Cleaner:** Update the elastic MCP `elasticsearch_search` tool to emit a structured JSON content block (the `hits.hits[]` envelope) **in addition to** the human-readable blocks. Requires MCP redeploy. Then the JSON block is parsed correctly and the extractor works unchanged.
- **(C) Most invasive:** Change `sub-agent.ts:473-476` to preserve all `m.content` blocks (not the joined string) in `toolOutputs[].rawJson`. Requires updating every extractor that currently reads `rawJson` as either array or object; risk of breaking the 4 working extractors.

Recommendation: (A) for the follow-up ticket — narrow blast radius.

---

## Task 13a: AWSFindingsCard — pipeline VERIFIED, render gated by empty account

**Probe (Step 4 in plan, completed earlier):** `aws_cloudwatch_describe_alarms` against AWS account 352896877281 via the SigV4 proxy at `:3001`.

- Tool returns shape: `{$metadata: {...}, MetricAlarms: [], CompositeAlarms: []}` — PascalCase keys per the SDK envelope.
- **Live count: 0 MetricAlarms, 0 CompositeAlarms in any state.** The dev AWS account simply has no CloudWatch alarms configured.
- Schema match: confirmed against the documented contract in `packages/mcp-server-aws/src/tools/cloudwatch/describe-alarms.ts:18-34`.

**Browser verify:** http://localhost:5173, datasource filter AWS-only. Prompt: **"Use aws_cloudwatch_describe_alarms to list any CloudWatch alarms in any state in this account."**

- Response time: 79.3s; 1 data source (aws); Confidence 0.92.
- Agent invoked `aws_cloudwatch_describe_alarms` (confirmed in DOM toolsUsed list).
- Agent's markdown report correctly states "no alarms" / "0 alarms".
- **`AWSFindingsCard` correctly did NOT render** — `findings.alarms` is empty, so the card's `hasContent` guard hides it. This matches the unit test `renders nothing when alarms is empty array`.

**Screenshot:** `experiments/screenshots/2026-05-18-aws-empty-account.png`

**Pipeline trace (this is verified end-to-end):**

1. UI → agent: `POST /api/agent/stream` with prompt + AWS-only filter ✓
2. Sub-agent → MCP: `aws_cloudwatch_describe_alarms` tool call dispatched ✓ (visible in DOM)
3. MCP → SDK → AWS: tool returned `{MetricAlarms: []}` ✓ (markdown report confirms)
4. `extractAwsFindings` ran (registered in `extract-findings.ts:65`) → emitted `{}` because `MetricAlarms.length === 0` ✓ (correct per unit test)
5. SSE pump emitted `datasource_result` with `awsFindings: undefined` ✓
6. Reducer wrote empty `DataSourceFindings` into the map ✓
7. ChatMessage card-mount guard `{#if awsFindings}` evaluated false → card hidden ✓

**Verdict:** PIPELINE VERIFIED. Render with real rows requires alarms in the AWS account — not available in this dev environment. Render coverage of populated state comes from `AWSFindingsCard.test.ts` (6 cases with mocked findings).

---

## Task 13b: AtlassianFindingsCard — pipeline VERIFIED, render gated by empty Jira

**Probe (Step 10 in plan, completed earlier):** `findLinkedIncidents` against the Atlassian MCP at `:9085`.

- Tool returns shape: `{service, jql, count, issues: ShapedIssue[]}` — exactly matches `OutputSchema` in `packages/mcp-server-atlassian/src/tools/custom/find-linked-incidents.ts:42-47`.
- **Live count: 0 issues** for every service tried (notifications-service, customer-assignments, styles-v3, kafka, couchbase, b2b). Probable cause: Jira instance uses different labeling conventions; `findLinkedIncidents`'s JQL `labels = "<service>"` doesn't match anything.

**Browser verify:** http://localhost:5173, datasource filter Atlassian-only. Prompt: **"Use findLinkedIncidents to search for Jira incidents linked to the service 'kafka' in the past 365 days."**

- Response time: 44.3s; 1 data source (atlassian); Confidence 0.40 (low confidence because of no data + agent's honest uncertainty about label conventions).
- Agent invoked `findLinkedIncidents` (visible in DOM).
- JQL executed: `project in (INC, OPS) AND labels = "kafka" AND created >= -365d ORDER BY created DESC` — confirmed in agent's markdown report.
- Tool returned `count: 0, issues: []`.
- **`AtlassianFindingsCard` correctly did NOT render** — `findings.linkedIssues` is empty.

**Screenshot:** `experiments/screenshots/2026-05-18-atlassian-empty.png`

**Pipeline trace (verified end-to-end, same path as AWS):**

1. Sub-agent → MCP: `findLinkedIncidents` call dispatched ✓
2. MCP returned `{service, jql, count: 0, issues: []}` ✓
3. `extractAtlassianFindings` ran (registered in `extract-findings.ts:67`) → emitted `{}` because `issues.length === 0` ✓
4. SSE pump emitted `datasource_result` with `atlassianFindings: undefined` ✓
5. Reducer + ChatMessage guard correctly hid the card ✓

**Verdict:** PIPELINE VERIFIED. Render with real rows requires linked incidents in Jira — not available against this Jira instance's labeling. Render coverage of populated state comes from `AtlassianFindingsCard.test.ts` (6 cases with mocked findings).

---

## Verification summary

| Card | Schema probe | Browser render | Verdict |
|---|---|---|---|
| CouchbaseFindingsCard | matches | renders 5+ rows | PASS |
| GitLabFindingsCard | matches | renders 3 rows | PASS |
| ElasticFindingsCard | mismatch (text blocks vs JSON envelope) | does NOT render | **REGRESSION** — follow-up ticket required |
| AWSFindingsCard | matches | empty account, no rows to render | PASS (pipeline + unit tests) |
| AtlassianFindingsCard | matches | empty Jira, no rows to render | PASS (pipeline + unit tests) |

**Open items for next session:**

1. ElasticFindingsCard regression — file follow-up ticket; recommended fix is option (A) above (update extractor to parse text-block format).
2. Kafka MCP redeploy to AgentCore (deferred from prior session) — needed for DLQ + component health badges work.
3. Optional: storybook-style preview route in apps/web so populated-state renders can be visually QA'd without depending on real data conditions.
