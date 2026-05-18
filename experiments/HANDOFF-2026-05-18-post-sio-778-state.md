# Handover — Post-SIO-778 state + next-session candidates

| | |
|---|---|
| Date | 2026-05-18 (late evening) |
| Branch state | `main` at `d1ff464` (post-PR #120 merge) |
| Today's PRs merged | [#118](https://github.com/zx8086/devops-incident-analyzer/pull/118) (SIO-785 Phase 2), [#119](https://github.com/zx8086/devops-incident-analyzer/pull/119) (SIO-786), [#120](https://github.com/zx8086/devops-incident-analyzer/pull/120) (SIO-778 spec + kafka casing fix) |
| Today's Linear transitions to Done | [SIO-785](https://linear.app/siobytes/issue/SIO-785), [SIO-786](https://linear.app/siobytes/issue/SIO-786), [SIO-776](https://linear.app/siobytes/issue/SIO-776), [SIO-777](https://linear.app/siobytes/issue/SIO-777), [SIO-778](https://linear.app/siobytes/issue/SIO-778) |
| Branch hygiene | All 17 stale local branches swept; main is the only branch locally |

## TL;DR

SIO-778 spec shipped (PR #120). The spec retroactively documents Phase A (synthetic monitors, already on main) and specifies Phase B (`apmServices`) + Phase C (`logClusters`) so a future ticket can execute them without re-deriving shapes. PR #120 also bundled a sidecar fix for 9 kafka rule tests that had been silently failing on `main` since SIO-785's casing normalisation — 19 PascalCase test fixtures flipped to UPPERCASE.

**The natural next task is Phase B of SIO-778: implement `apmServices` per the spec.** All Phase A and the kafka rule test suite are clean (544 pass / 0 fail). Several Low-priority follow-ups from the earlier SIO-785 handover remain open.

## Context — how the backlog got here

Today closed three related streams:

1. **SIO-785 Phase 2** (PR #118, this morning) — 5 findings cards built (Kafka, Couchbase, GitLab, Elastic, AWS) + Atlassian.
2. **SIO-786** (PR #119, this evening) — fixed ElasticFindingsCard regression caused by elastic MCP returning text-block content instead of JSON.
3. **SIO-778** (PR #120, this late evening) — design spec retroactively documenting Phase A + specifying Phase B/C. Surfaced + fixed a casing-drift bug in kafka rule tests as a sidecar.

The SIO-778 spec uses the SIO-764 kafka findings spec as the structural template. It explicitly defers Phase D (correlation rule integration consuming `elasticFindings`) to SIO-773's tracking-ticket policy.

## What stays in the backlog as next-session candidates

### 1. **Phase B of SIO-778 — `apmServices`** (HIGH priority, recommended next session)

**Current state:** Spec is written; zero code lands until the implementation ticket opens.

**Why this is the next move:** the spec was written *today*, the elastic Phase A is shipping in production, and Phase B is sized as a single PR. Every later session pays a re-loading cost on the spec context.

**Suggested next-session prompt:**
> "Execute Phase B of SIO-778 per `docs/superpowers/specs/2026-05-18-sio-778-elastic-findings-schema-design.md`. First step: capture a real `traces-apm-*` aggregation response from `eu-b2b` (use the SOUL's Synthetic-Monitor Cross-Check trigger query as the template; swap `index: 'synthetics-*'` for `index: 'traces-apm-*'`). Commit the fixture, then add `ElasticApmServiceSchema`, the `extractApmServicesFromHits` private helper in `packages/agent/src/correlation/extractors/elastic.ts`, the card row, and 6-8 unit tests. Watch for the eu-b2b plural-vs-singular service-name gotcha (memory `reference_b2b_apm_service_naming`) — store the verbatim plural form."

**Files to touch (per spec):**
- `packages/shared/src/agent-state.ts` — add `ElasticApmServiceSchema`, extend `ElasticFindingsSchema` with optional `apmServices`.
- `packages/shared/src/index.ts` — re-export.
- `packages/agent/src/correlation/extractors/elastic.ts` — add `extractApmServicesFromHits`; call from `extractElasticFindings`.
- `apps/web/src/lib/components/ElasticFindingsCard.svelte` — add `apmServices` row group below the synthetic-monitors group.
- `packages/agent/tests/correlation/extractors/elastic.test.ts` — 6-8 unit tests.
- `packages/agent/tests/correlation/fixtures/` *(new dir if needed)* — apm aggregation fixture.

**Acceptance criteria (from spec):**
- `bun run typecheck && bun run lint && bun run test` green.
- Manual probe against `eu-b2b` shows the card row populates for at least one service in the SOUL's investigation window.
- No regression in Phase A synthetic-monitor card rendering.

**Memory to read first:**
- `reference_b2b_apm_service_naming` — critical; ES indexes plural, Kafka groups use singular.
- `reference_elastic_mcp_text_block_response` — Phase A response-form lesson; may carry to Phase B.
- `reference_normalize_tool_content` — invariant about what extractors see at the boundary.
- `feedback_extractor_fixtures_must_mirror_real_mcp` — reinforced by SIO-786; capture real fixtures, never invent shapes.

### 2. Pre-existing follow-ups from SIO-785 Phase 2 (still open, unchanged)

From `experiments/HANDOFF-2026-05-18-sio-785-cards-phase-2-shipped.md`:

| Item | Priority | Notes |
|---|---|---|
| Kafka MCP redeploy to AgentCore | Medium | Needed for DLQ + `*_health_check` tools. Blocks the next row. |
| Component health badges row in KafkaFindingsCard | Low | Depends on kafka redeploy. |
| Server-side response slimming for `connect_list_connectors` | Low | Currently 226KB per call; LLM only needs name/state/type/taskFailures. |
| Entity-extractor focusServices filter | Low | Don't anchor `focusServices: ["kafka"]` on generic questions. |
| Storybook-style preview route for findings cards | Low | Decouple visual QA from real-data conditions (AWS account empty; Jira labels don't match). |

All five are independently small. None block each other (except #2 which depends on #1).

### 3. Phase C of SIO-778 — `logClusters` (ready, lower priority)

**Current state:** Specified; awaits Phase B finishing first so the extractor file isn't churned in parallel. Spec details the `signatureFromTokens` helper (reuses `distinctiveTokens` from `rules.ts:449-458`) and top-10 cap.

**Out of scope until a real consumer needs it.**

### 4. SIO-773 — Phase C extractors tracking ticket (stays in Backlog by design)

Marker ticket. No action unless a new correlation rule needs typed konnect signals OR elastic Phase B/C want to graduate to rule-engine integration. Then open a child ticket per SIO-773's deferral policy.

## What shipped today (recap for the next session)

### PR #118 — SIO-785 Phase 2
- AwsFindings + AtlassianFindings schemas in shared
- AWS + Atlassian extractors registered in `extract-findings.ts`
- AWSFindingsCard, AtlassianFindingsCard
- 31 new unit tests + live-verification log at `experiments/findings-card-verification.md`

### PR #119 — SIO-786
- `normalizeToolContent` helper in `sub-agent.ts` (joins content-block arrays before `tryParseJson`)
- Text-block parser in `extractors/elastic.ts` (`parseSyntheticMonitorsFromText` with brace-balanced JSON extraction + status priority chain)
- 17 new unit tests; live-verified `ap-cld` synthetic monitor

### PR #120 — SIO-778 + kafka casing fix
- `docs/superpowers/specs/2026-05-18-sio-778-elastic-findings-schema-design.md` (303 lines, mirrors SIO-764 structure)
- 19 PascalCase → UPPERCASE fixture replacements across `engine.test.ts`, `enforce-node.test.ts`, `c72-replay.test.ts`. Agent suite went from 535 pass / 9 fail → **544 pass / 0 fail**.

## Where the bodies are buried

- `docs/superpowers/specs/2026-05-18-sio-778-elastic-findings-schema-design.md` — the spec itself. Phase B and Phase C are precisely specified; future implementer reads this top-to-bottom.
- `packages/agent/src/correlation/extractors/elastic.ts:135-236` — Phase A extractor with two paths: text-block parser + JSON-envelope. Phase B's `extractApmServicesFromHits` lives in the same file.
- `packages/agent/src/correlation/rules.ts:449-458` — `distinctiveTokens` helper, reused (unmodified) for Phase C log clustering.
- `packages/agent/src/correlation/rules.ts:134-147` — kafka rule UPPERCASE comparisons. Any future rule that introduces casing normalisation must update fixtures in the same PR (see new memory `reference_kafka_rule_state_casing_drift`).
- `experiments/findings-card-verification.md` — definitive log of which cards have been live-verified.

## Verification block (session-start)

```bash
git fetch
git checkout main && git pull --ff-only           # should land at d1ff464 or later
bun install                                        # in case dependencies drifted
bun run typecheck                                  # 0 errors expected
bun run --filter '@devops-agent/agent' test       # 544 pass, 18 skip, 0 fail expected
cd apps/web && bun test                            # 100 pass expected
cd ..
bun run lint                                       # 12 pre-existing biome drift errors — unchanged, out of scope

# Pre-flight if attacking SIO-778 Phase B:
# 1. Open docs/superpowers/specs/2026-05-18-sio-778-elastic-findings-schema-design.md
# 2. Open packages/agent/src/correlation/extractors/elastic.ts side-by-side
# 3. Open agents/incident-analyzer/agents/kafka-agent/SOUL.md (the SIO-717 cross-check
#    pattern is the model for the apm aggregation query — same query envelope,
#    different `index` and `aggs` shape)
# 4. Start `bun run dev`, fire a query that hits `traces-apm-*` against eu-b2b,
#    and capture the elasticsearch_search response from LangSmith for the fixture.
```

## Out of scope (do NOT do next session unless explicitly asked)

- Phase C of SIO-778 (logClusters). Land Phase B first; same file churn risk.
- Konnect findings card. Deferred in SIO-785 Phase 2 brainstorming.
- The 12 pre-existing biome-formatter drift issues on main. Separate cleanup PR.
- Phase D (correlation rules consuming `elasticFindings`). Stays under SIO-773 until a rule actually needs it.
- Force-pushing or rewriting any merged history (PRs #118, #119, #120).

## Risks and edge cases (Phase B specific)

| Risk | Likelihood | Mitigation |
|---|---|---|
| `traces-apm-*` aggregation envelope shape differs from what the spec assumes | Medium | Capture real fixture first; adjust extractor to match. `feedback_extractor_fixtures_must_mirror_real_mcp`. |
| Phase B extractor incorrectly fires on a generic `elasticsearch_search` | Medium | Strict detection per spec: `toolArgs.index` regex `/traces-apm/i` OR `aggregations.by_service.buckets` presence. |
| eu-b2b plural service-name confuses a future Phase D rule | High when Phase D lands | Document in the schema's JSDoc; defer normalisation to the future `getElasticApmService` helper, not the extractor. Memory `reference_b2b_apm_service_naming` captures the rule. |
| Card render width with >10 APM services | Low-medium | Same top-K cap pattern Phase C uses; cap at 10 sorted by errorRate desc. Out of spec but easy to add. |

## Related code references

- `packages/agent/src/correlation/extractors/kafka.ts` — sibling extractor with focus-services filtering. Phase B's `extractApmServicesFromHits` can optionally adopt the same pattern if cardinality becomes a problem.
- `packages/agent/src/correlation/extractors/aws.ts` — sibling extractor for PascalCase SDK responses; pattern reference for handling envelope-keyed responses.
- `packages/mcp-server-elastic/src/tools/core/search.ts:496` — the `elasticsearch_search` tool's description explicitly mentions `traces-apm-*` patterns; useful background.
- `agents/incident-analyzer/agents/kafka-agent/SOUL.md:58-68` — the SIO-717 Synthetic-Monitor Cross-Check rule. The query envelope is the template for the Phase B APM aggregation query (swap index + aggs).

## Memory references

- `reference_b2b_apm_service_naming` — critical for Phase B field-shape.
- `reference_elastic_mcp_text_block_response` — RESOLVED in SIO-786; Phase B may face similar multi-block possibility on aggregation responses.
- `reference_normalize_tool_content` — boundary invariant.
- `reference_confluent_synthetic_monitors` — Phase A signal stability lesson.
- `reference_kafka_rule_state_casing_drift` (NEW today) — the pattern; if Phase B introduces casing normalisation, update fixtures in the same PR.
- `feedback_extractor_fixtures_must_mirror_real_mcp` — reinforced by SIO-786 + the SIO-778 casing-drift finding.
- `feedback_handover_doc_structure` — followed for this doc.

## What to remember (for next session)

Today closed the design phase of the elastic findings story: Phase A is live, Phase B + C are specified, and the rule engine test suite is clean for the first time in two days. Phase B is the next move; the spec is fresh and the fixture-capture pattern is established. If Phase B reveals shape surprises (likely — APM is new territory), the spec's risk register has the mitigations pre-staged.
