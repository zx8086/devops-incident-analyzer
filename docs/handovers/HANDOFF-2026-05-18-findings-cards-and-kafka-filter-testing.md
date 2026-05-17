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
- Always-pass-through rules: `state !== "Stable"` OR `totalLag > 0` OR `dlqTopic.recentDelta > 0`.
- Empty-focus fallback: render all (matches pre-SIO-785 behaviour).

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
