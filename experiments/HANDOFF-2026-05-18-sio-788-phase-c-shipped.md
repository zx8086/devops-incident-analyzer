# Handover — Post-SIO-788 (SIO-778 Phase C shipped, then patched)

| | |
|---|---|
| Date | 2026-05-18 (late evening, two PRs after the SIO-787 handover) |
| Branch state | `main` at `96b6477` |
| Today's PRs merged (cumulative) | [#118](https://github.com/zx8086/devops-incident-analyzer/pull/118), [#119](https://github.com/zx8086/devops-incident-analyzer/pull/119), [#120](https://github.com/zx8086/devops-incident-analyzer/pull/120), [#121](https://github.com/zx8086/devops-incident-analyzer/pull/121), [#122](https://github.com/zx8086/devops-incident-analyzer/pull/122), [#123](https://github.com/zx8086/devops-incident-analyzer/pull/123) — six on the day |
| This session merged | [#122](https://github.com/zx8086/devops-incident-analyzer/pull/122) (Phase C initial), [#123](https://github.com/zx8086/devops-incident-analyzer/pull/123) (Phase C real-fixture fix) |
| Linear transitioned (this session) | [SIO-788](https://linear.app/siobytes/issue/SIO-788) — In Review (awaiting Done approval) |
| Suggested next move | SIO-787 / SIO-788 status reconciliation; then either ship the next epic feature or open Phase D (correlation rules consuming the elastic findings) under SIO-773 |

## TL;DR

The elastic findings story is now **complete on `main`**: synthetic monitors (Phase A) + APM services (Phase B) + log clusters (Phase C) all rendering in `ElasticFindingsCard.svelte`, all backed by real eu-b2b fixtures, all unit-tested. SIO-788 shipped in two PRs because **#122 was broken** — it returned 0 clusters against the real eu-b2b response shape because I'd deferred fixture capture and guessed wrong about the payload. #123 captured the real fixture, added the YAML-block parser the merged extractor was missing, and replaced the synthetic-fixture-only test with a fixture-driven happy-path test.

**The headline lesson for next session**: the SvelteKit `/api/agent/stream` endpoint takes a curl POST and runs the full agent pipeline server-side. Fixture capture does NOT require Chrome MCP or a human in the browser. This was the third time this week `feedback_extractor_fixtures_must_mirror_real_mcp` got reinforced and the first time I had a working autonomous capture path that I almost didn't try.

## Context — how SIO-788 got here today

This was the fourth Linear ticket in a single day:

1. **SIO-785 Phase 2** (PR #118, this morning) — 5 findings cards built.
2. **SIO-786** (PR #119, evening) — fixed ElasticFindingsCard text-block regression.
3. **SIO-778** (PR #120, late evening) — design spec for Phases B + C.
4. **SIO-787 / SIO-778 Phase B** (PR #121, late evening) — apmServices, shipped with live eu-b2b probe.
5. **SIO-788 / SIO-778 Phase C** (PR #122, this session) — shipped with synthetic fixtures only because I framed Chrome MCP as the only fixture-capture path and the user said "skip live capture, ship it." Smoke test against real data after merge: **0 clusters**.
6. **SIO-788 follow-up** (PR #123, this session) — captured the real eu-b2b fixture, added the missing parser, fixed the bug, added the fixture-driven test.

## What shipped in PR #122 + #123 (combined)

### Schema (`packages/shared/src/agent-state.ts:155-176`)

```ts
export const ElasticLogClusterSchema = z.object({
	signature: z.string(),        // sha1 hex, 16 chars
	sampleMessage: z.string(),    // representative original message verbatim
	count: z.number(),
	level: z.string(),            // dominant level (typically "error")
	service: z.string().optional(),
	firstSeen: z.string().optional(),
	lastSeen: z.string().optional(),
});
export type ElasticLogCluster = z.infer<typeof ElasticLogClusterSchema>;

export const ElasticFindingsSchema = z.object({
	syntheticMonitors: z.array(ElasticSyntheticMonitorSchema).optional(),
	apmServices: z.array(ElasticApmServiceSchema).optional(),
	logClusters: z.array(ElasticLogClusterSchema).optional(),  // NEW
});
```

All fields `.optional()` so checkpointed state from before Phase C still parses.

### Extractor (`packages/agent/src/correlation/extractors/elastic.ts`)

The merged extractor has three code paths for the logs branch — pick whichever matches the response shape:

1. **YAML-block path (primary, eu-b2b production shape)** — `parseLogClustersFromBlockText` at `:471-489`. Walks `Document ID:`-delimited sections, extracts `message` (multi-line scalar), `log.level` (JSON object), `service.name` (JSON object), `@timestamp` (bare scalar). Reuses `extractJsonBlock` / `parseJsonBlock` / `extractScalarField` from Phase A. New helper `extractMultiLineScalar` at `:453-469` captures messages that wrap past line boundaries.
2. **JSON-envelope path (defensive)** — when the response is parsed JSON with `hits.hits[]`, walk it directly via `SearchResponseSchema`.
3. **Bare-JSON text-block path (fallback)** — `parseLogsHitsFromText` at `:491-536` walks a prefix-sentence + brace-balanced JSON object.

The detection guard in `extractElasticFindings` (`:556-559`) is strict: `/logs-/i` index hint OR majority `level: "error"` hits, with explicit exclusion when the index hint is `traces-apm-*` or `synthetics-*`. The three branches (synthetic / APM / logs) are mutually exclusive on index hints.

`distinctiveTokens` from `packages/agent/src/correlation/rules.ts:451` was **exported** (body unchanged) so the extractor can reuse the deploy-vs-runtime tokeniser without forking it. Single-line change, no behavioural impact on the rules engine.

### Card (`apps/web/src/lib/components/ElasticFindingsCard.svelte`)

Three row groups stacked vertically: synthetic monitors → APM services → log clusters. Each is independently gated on its array being non-empty. The card has `hasContent` derived from any of the three.

Log-clusters row pattern: monospace `sampleMessage` truncated to 80 chars (full text in `title=` attr), purple count badge, optional modal-service tag, optional relative `lastSeen` timestamp. Top-K cap of 10 applied in both the extractor and the `$derived` (defense in depth).

### Fixtures

- `packages/agent/src/correlation/extractors/__fixtures__/elastic-log-clusters-real.txt` *(NEW, 52KB)* — captured 2026-05-18 from eu-b2b, 100 documents, modal service `metricbeat` + `(no service)` control-plane log entries, top cluster *"Error fetching data for metricset kubernetes.state_container: ... unexpected status code 400 from server"* with count 14.

### Tests (`packages/agent/src/correlation/extractors/elastic.test.ts`)

- 9 synthetic-data tests (Phase C initial): signature determinism, distinctive-token noise reduction, modal-service tiebreak (≥50%), firstSeen/lastSeen extents, empty-token drop, top-K cap, traces-apm exclusion, synthetics exclusion, error-majority detection without index hint, Phase A/B no-regression.
- 1 fixture-driven happy-path test (follow-up): asserts ≥2 clusters, top-K cap, count-desc sort, sha1-hex-16 signatures, and that the modal-service branch resolves to a real service name (`metricbeat`).

Agent suite went 552 → 562 (Phase C) → 563 (follow-up).

### Linear

- New ticket **[SIO-788](https://linear.app/siobytes/issue/SIO-788)** opened as child of SIO-778, In Progress → In Review. Both PR #122 and PR #123 linked.

### Memory additions

- `reference_agent_stream_curl_endpoint` *(NEW)* — POST `/api/agent/stream` body schema + curl recipe + LangSmith CLI pairing.
- `feedback_prefer_curl_over_browser_automation` *(NEW)* — the lesson from this session: don't defer fixture work because you framed Chrome MCP as the only path.

## Where the bodies are buried

- `packages/agent/src/correlation/extractors/elastic.ts:471-489` — `parseLogClustersFromBlockText`, the YAML-block parser added in PR #123. **This is the load-bearing path for production**; the JSON-envelope and bare-JSON paths were defensive guesses that never fired in practice.
- `packages/agent/src/correlation/extractors/elastic.ts:453-469` — `extractMultiLineScalar`. Captures `message:` values that wrap onto subsequent lines (real Java stack-trace messages do this constantly). Bounded by the next top-level YAML key OR the next `Document ID:` marker.
- `packages/agent/src/correlation/extractors/elastic.ts:556-565` — text-block branch in `extractElasticFindings`. Tries YAML-block parser first; falls back to bare-JSON only when no Document ID markers are present. Both feed into the same `extractLogClustersFromHits` and the same outer `clustersBySignature` map.
- `packages/agent/src/correlation/rules.ts:451` — `distinctiveTokens` is exported. Phase D rules can import it directly.
- `apps/web/src/lib/components/ElasticFindingsCard.svelte:21-26` — `logClusters` `$derived` block with the top-10 cap (mirrors the extractor's cap for defence in depth).

## How to fire the eu-b2b probe yourself (the curl path)

This is the recipe documented in the new memory entries. Use it whenever you need to verify a card renders against real production data OR capture a fixture.

```bash
# 1. Confirm dev server is running. If not, start it in the background:
lsof -i :5173 || bun run dev &

# 2. Fire the prompt (replace the content with your incident query):
curl -sS -X POST http://localhost:5173/api/agent/stream \
  -H "Content-Type: application/json" \
  -d '{
    "messages":[{"role":"user","content":"<prompt>"}],
    "dataSources":["elastic"],
    "targetDeployments":["eu-b2b"]
  }' \
  --max-time 180 -o /tmp/sse-stream.txt

# 3. Find the tool run in LangSmith:
set -a; source .env; set +a
langsmith run list --run-type tool --name elasticsearch_search \
  --last-n-minutes 10 --limit 5 --format json

# 4. Pull the full run (inputs + outputs):
langsmith run get <run_id> --full --format json -o /tmp/tool-run.json

# 5. Extract content. The shape is content-block array:
jq '.outputs.output.kwargs.content' /tmp/tool-run.json   # inspect
jq -r '.outputs.output.kwargs.content | map(.text) | join("\n\n")' /tmp/tool-run.json \
  > packages/agent/src/correlation/extractors/__fixtures__/<topic>-real.txt
```

The pipeline takes 60-180s for a fan-out incident query. SSE events stream while it runs; you can watch them live or wait for the `done` event.

## Verification block (session-start)

```bash
git fetch
git checkout main && git pull --ff-only           # should land at 96b6477 or later
bun install
bun run typecheck                                  # 0 errors
bun run --filter '@devops-agent/agent' test       # 563 pass, 18 skip, 0 fail
cd apps/web && bun test && cd ..                   # 100 pass
bun run lint                                       # 12 pre-existing errors (baseline, out of scope)
```

If continuing the elastic findings work:

```bash
# Smoke-test against the real fixture:
bun -e '
import { extractElasticFindings } from "./packages/agent/src/correlation/extractors/elastic.ts";
import { readFileSync } from "node:fs";
const text = readFileSync("./packages/agent/src/correlation/extractors/__fixtures__/elastic-log-clusters-real.txt", "utf8");
const r = extractElasticFindings([{ toolName: "elasticsearch_search", toolArgs: { index: "logs-*" }, rawJson: text } as any]);
console.log("clusters:", r.logClusters?.length);
'
# Expected: 10 clusters, top: count=14 service=metricbeat
```

## Risks and edge cases (forward-looking)

| Risk | Likelihood | Mitigation |
|---|---|---|
| Another sub-agent's MCP response is similarly mis-shaped (kafka, capella, gitlab, konnect, atlassian) | Medium | When opening Phase D rules or new card work, fire the curl probe FIRST against the real deployment, before writing the extractor. Don't trust the spec — it was wrong for both Phase B (text-block aggregation) and Phase C (YAML blocks) on elastic alone. |
| Linear SIO-788 still In Review | High | User decision required to set Done. SIO-787 was auto-set to Done by the merge automation — confirm with user whether that's intended policy or a violation of "Never set Done without approval." |
| Phase D rule integration (joins between apmServices and Kafka consumer groups) | Medium | The plural/singular normalisation problem (`reference_b2b_apm_service_naming`) is real; build a `getElasticApmService` helper in `rules.ts` rather than mutating the extractor's verbatim field. Don't fork `distinctiveTokens`; build new helpers on top. |
| `logClusters` cardinality on busy incidents | Low | Top-K cap of 10 in both extractor and card. Will not blow up the UI. |
| Multi-line scalar parser greedily eats subsequent fields | Low | The boundary regex requires `\n<word>:` followed by space OR `Document ID:`. Tested against the 100-doc real fixture (no false positives). If it ever fails, the symptom is `message` swallowing trailing fields and a cluster getting a freakishly long sampleMessage. |
| Card render width with long sample messages | Low | Truncated at 80 chars with full text in `title=` attr. |

## Out of scope (do NOT do next session unless explicitly asked)

- Phase D correlation rules consuming `apmServices` / `logClusters` — stays under [SIO-773](https://linear.app/siobytes/issue/SIO-773).
- eu-b2b plural/singular normalisation against `kafkaFindings.consumerGroups[]`.
- `service.environment` field on apmServices (deferred Phase B follow-up).
- Konnect findings card (separate ticket if needed).
- The 12 pre-existing biome-formatter drift errors on `main`.
- Forking `distinctiveTokens` in `rules.ts`.
- Force-pushing or rewriting PRs #118-#123.

## Other open follow-ups (carried forward from prior handovers)

| Item | Priority | Notes |
|---|---|---|
| Kafka MCP redeploy to AgentCore | Medium | Needed for DLQ + `*_health_check` tools. Blocks next-row kafka work. |
| Component health badges row in KafkaFindingsCard | Low | Depends on kafka redeploy. |
| Server-side response slimming for `connect_list_connectors` | Low | 226KB per call. |
| Entity-extractor `focusServices` filter | Low | Don't anchor on generic questions. |
| Storybook-style preview route for findings cards | Low | Decouple visual QA from real-data conditions. |
| SIO-787 auto-Done state | Low | Verify whether Linear automation auto-Done on merge is desired; the policy in CLAUDE.md says "Never set Done without user approval." |

## Files to look at first if extending this work

- `packages/agent/src/correlation/extractors/elastic.ts` — three extractor branches, all in one file (~600 lines). Pattern reference for any new "typed findings" extractor on another sub-agent.
- `packages/shared/src/agent-state.ts:129-181` — the elastic schemas (synthetic, apmService, logCluster, composite findings).
- `apps/web/src/lib/components/ElasticFindingsCard.svelte` — three row groups, gated independently. Pattern reference for any new findings card.
- `docs/superpowers/specs/2026-05-18-sio-778-elastic-findings-schema-design.md` — the spec, but treat it as guidance; both Phase B and Phase C real shapes diverged from the spec's example queries.

## Related code references

- `packages/agent/src/correlation/extractors/elastic.ts:153-194` — `parseSyntheticMonitorsFromText` (Phase A). Same YAML-block shape family. Phase C's `parseLogClustersFromBlockText` is the structural twin.
- `packages/agent/src/correlation/extractors/elastic.ts:262-291` — `parseApmAggregationFromText` (Phase B). Brace-balanced JSON walker; different shape (aggregation envelope vs hits).
- `packages/agent/src/sub-agent.ts:155-175` — `normalizeToolContent`. Boundary invariant — extractor sees string or parsed JSON, never raw content blocks.
- `packages/mcp-server-elastic/tests/dev/fixtures/real-elasticsearch-data.json:23-33` — the spec's reference logs-* shape. Note: this is the *spec's claim* of the shape; the real eu-b2b production response is the YAML-block format documented in `elastic-log-clusters-real.txt`, NOT the JSON envelope shown in this fixture.

## Memory references

- `reference_agent_stream_curl_endpoint` *(NEW this session)* — the curl recipe + body schema for `/api/agent/stream`.
- `feedback_prefer_curl_over_browser_automation` *(NEW this session)* — the lesson: don't defer fixture capture because you framed Chrome MCP as the only path.
- `reference_elastic_apm_finding_shape` — Phase B field-set + plural-form decision.
- `reference_elastic_mcp_text_block_response` — text-block payload shape (Phases A, B, C all confirmed it).
- `reference_normalize_tool_content` — boundary invariant.
- `feedback_extractor_fixtures_must_mirror_real_mcp` — Phase C reinforced this for the **fourth** time this week (post-merge defect proved the rule applies even when the user says "skip live capture").
- `reference_b2b_apm_service_naming` — preserve verbatim service names; don't normalise in extractor.
- `reference_langsmith_child_runs_via_sdk` — why `langsmith run get` (Go CLI), not `langsmith-fetch` (Python CLI).
- `feedback_handover_doc_structure` — followed for this doc.
- `feedback_handoff_docs_main_branch` — handover commits to main directly.
- `feedback_no_direct_push_to_main` — code-change PRs only; this doc is doc-only.

## What to remember (for next session)

The elastic findings story is **closed** as a UI feature. Three signals on `main`, all backed by real eu-b2b fixtures. The story now waits on Phase D (rule integration, SIO-773) — but Phase D is a `rules.ts` problem, not a card problem.

Two policy-level things to verify with the user before doing anything else next session:

1. **SIO-788 status**: currently In Review. User decides on Done transition.
2. **SIO-787 auto-Done**: PR #121's merge auto-flipped Linear to Done without user approval. Either Linear automation overrides the CLAUDE.md "never set Done without approval" rule, or this is a policy violation worth flagging.

The headline operational lesson is in `feedback_prefer_curl_over_browser_automation`: I now have an autonomous fixture-capture path via curl + the langsmith CLI. Use it. Don't ask "should I capture the fixture?" — capture it.
