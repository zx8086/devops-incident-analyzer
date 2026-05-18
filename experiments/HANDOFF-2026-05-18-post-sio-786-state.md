# Handover — Post-SIO-786 backlog state + next-session candidates

| | |
|---|---|
| Date | 2026-05-18 (evening) |
| Branch state | `main` at `b6e085e` (post-PR #119 merge) |
| Today's PRs merged | [#118](https://github.com/zx8086/devops-incident-analyzer/pull/118) (SIO-785 Phase 2), [#119](https://github.com/zx8086/devops-incident-analyzer/pull/119) (SIO-786 elastic regression) |
| Today's Linear transitions to Done | [SIO-785](https://linear.app/siobytes/issue/SIO-785), [SIO-786](https://linear.app/siobytes/issue/SIO-786), [SIO-776](https://linear.app/siobytes/issue/SIO-776), [SIO-777](https://linear.app/siobytes/issue/SIO-777) |

## TL;DR

Today shipped SIO-785 Phase 2 (AWS + Atlassian findings cards + live-verify of 3 existing cards) and SIO-786 (ElasticFindingsCard regression fix). Backlog audit moved SIO-776 + SIO-777 to Done. Two tickets stay in Backlog as **handover candidates**:

- **[SIO-778](https://linear.app/siobytes/issue/SIO-778)** — Spec: ElasticFindingsSchema design. Phase A (synthetic monitors only) shipped today; the broader spec deliverable was never written and is the natural next-session task.
- **[SIO-773](https://linear.app/siobytes/issue/SIO-773)** — Phase C extractors tracking ticket. AWS + Elastic + Atlassian Phase A shipped today (bypassing the child-ticket pattern); only Konnect remains. Stays in Backlog as a tracker.

Plus pre-existing follow-ups still open from prior session (kafka MCP redeploy, component health badges, server-side connect response slimming, entity-extractor focusServices filter) — these were already documented in `experiments/HANDOFF-2026-05-18-sio-785-cards-phase-2-shipped.md` and remain unchanged.

## Context — how the backlog got here

After shipping SIO-785 Phase 2 (PR #118), I noticed three cards (Couchbase, GitLab, Elastic) were unit-tested but never browser-verified. Live-verifying surfaced a regression in `ElasticFindingsCard`: real elastic MCP responses are delivered as content-block arrays, not joined strings, breaking the typed extractor. SIO-786 was filed and shipped same-day (PR #119) with a two-layer fix in `sub-agent.ts` (`normalizeToolContent`) and `extractors/elastic.ts` (text-block parser).

A backlog audit caught two tickets that overlap with shipped work:
- SIO-776 + SIO-777 (Couchbase/GitLab cards) were closed by PR #118 but never auto-flipped → moved to Done.
- SIO-778 + SIO-773 are partially overlapped but have explicit deliverables that didn't land → staying in Backlog.

## What stays in the backlog as next-session candidates

### 1. SIO-778 — Spec: ElasticFindingsSchema design (HIGH priority, recommended next session)

**Current state:** ~10% complete. Synthetic-monitors-only schema shipped (Phase A), but the design doc deliverable was never written.

**What's done:**
- `packages/shared/src/agent-state.ts` has `ElasticFindingsSchema` with `syntheticMonitors: [{name, status, url?, observedAt?, geo?}]`.
- `packages/agent/src/correlation/extractors/elastic.ts` extracts that shape from both JSON-envelope and text-block content.
- `apps/web/src/lib/components/ElasticFindingsCard.svelte` renders the rows.
- Live-verified against `ap-cld` cluster (PR #119).

**What's NOT done:**
- Design doc at `docs/superpowers/specs/2026-05-XX-elastic-findings-schema-design.md` (the deliverable).
- Catalog of which of the 69 elastic tools produce structured-worth signal.
- `apmServices` shape proposal (with eu-b2b naming gotcha handled — see memory `reference_b2b_apm_service_naming`).
- `logClusters` shape proposal.
- Per-deployment handling design (flat vs blob-per-deployment — today's flat-via-name-dedupe is a default, not a designed choice).
- Correlation impact analysis (no rule consumes `elasticFindings` today).
- Rollout phasing (apmServices Phase B, logClusters Phase C, etc.).

**Suggested next-session prompt:**
> "Write the SIO-778 spec at `docs/superpowers/specs/2026-05-18-sio-778-elastic-findings-schema-design.md` using the kafka findings spec at `docs/superpowers/specs/2026-05-16-sio-764-structured-findings-design.md` as the structural template. Treat today's synthetic-monitors-only implementation as Phase A (already shipped); design Phase B (apmServices) and Phase C (logClusters) to integrate cleanly without breaking the shipped shape. Address the eu-b2b APM plural-vs-singular naming via memory `reference_b2b_apm_service_naming`."

**Files to reference when designing:**
- `docs/superpowers/specs/2026-05-16-sio-764-structured-findings-design.md` (kafka spec; structural template)
- `packages/agent/tests/integration/c72-replay.test.ts` + `packages/agent/tests/integration/styles-v3-replay.test.ts` (real fixtures to mine for elastic tool-output shapes)
- `packages/shared/src/agent-state.ts:138-141` (current `ElasticFindingsSchema` — Phase A)
- `agents/incident-analyzer/agents/elastic-agent/SOUL.md` (the cross-check rule references synthetic monitors)
- Memory: `reference_b2b_apm_service_naming`, `reference_confluent_synthetic_monitors`, `reference_elastic_mcp_text_block_response` (just-updated), `reference_normalize_tool_content` (new today)

### 2. SIO-773 — Phase C extractors tracking ticket (stays in Backlog by design)

**Current state:** 3 of 4 Phase A extractors shipped (AWS / Elastic / Atlassian). Konnect remains. The ticket's own body says "Stays in Backlog until a child ticket is opened" — it's a marker.

**Action for next session:** None unless a new correlation rule needs typed konnect signals OR elastic Phase B (apmServices/logClusters) needs to be wired. If either happens, open a child ticket under SIO-773 with the rule's required field shape, MCP tools called, registration plan, tests.

### 3. Pre-existing follow-ups from SIO-785 Phase 2 (still open, unchanged)

From `experiments/HANDOFF-2026-05-18-sio-785-cards-phase-2-shipped.md`:

| Item | Priority | Notes |
|---|---|---|
| Kafka MCP redeploy to AgentCore | Medium | Needed for DLQ + `*_health_check` tools. Not done today. |
| Component health badges row in KafkaFindingsCard | Low | Depends on kafka redeploy. |
| Server-side response slimming for `connect_list_connectors` | Low | Currently 226KB per call; LLM only needs name/state/type/taskFailures. |
| Entity-extractor focusServices filter | Low | Don't anchor `focusServices: ["kafka"]` on generic questions. |
| Storybook-style preview route for findings cards | Low | Decouple visual QA from real-data conditions (AWS account empty; Jira labels don't match). |

All five are independently small. None block each other (except #2 which depends on #1).

## What shipped today (recap for the next session)

### PR #118 — SIO-785 Phase 2 (merged earlier today)

- AwsFindings + AtlassianFindings schemas in shared
- AWS + Atlassian extractors registered in `extract-findings.ts`
- Both tools added to `TYPED_FINDING_TOOLS` truncation allowlist
- SSE pump + reducer + ChatMessage wired
- `AWSFindingsCard.svelte` (state-aggregate header, ALARM-first sort)
- `AtlassianFindingsCard.svelte` (linked Jira issue rows)
- 31 new unit tests
- `experiments/findings-card-verification.md` — live-verification log for all 5 cards

### PR #119 — SIO-786 ElasticFindingsCard regression fix (merged this evening)

- `normalizeToolContent` helper in `sub-agent.ts` (joins content-block arrays before `tryParseJson`)
- Text-block parser in `extractors/elastic.ts` (`parseSyntheticMonitorsFromText` with brace-balanced JSON extraction + status priority chain)
- 17 new unit tests
- Live-verified card renders for `ap-cld` synthetic monitor

## Where the bodies are buried

- `packages/agent/src/sub-agent.ts:155-176` — `normalizeToolContent`. **Every new extractor must understand it sees a string or a parsed JSON value, never a raw block array.**
- `packages/agent/src/correlation/extractors/elastic.ts:62-180` — text-block parser pattern. Other extractors that ever face multi-block MCP responses can mirror this.
- `experiments/findings-card-verification.md` — definitive log of what was verified live. Task 3 section was updated post-SIO-786 to PASS.
- Memory: `reference_normalize_tool_content` (new), `reference_elastic_mcp_text_block_response` (updated to RESOLVED).

## Verification block

```bash
# At session start:
git fetch
git checkout main && git pull --ff-only        # should land at b6e085e or later
bun run typecheck                                # 0 errors expected
bun test packages/agent/src                     # 469 pass, 18 skip
cd apps/web && bun test                          # 100 pass

# Pre-flight if attacking SIO-778:
# Open docs/superpowers/specs/2026-05-16-sio-764-structured-findings-design.md and study its structure.
# Open packages/agent/tests/integration/c72-replay.test.ts to mine for real elastic tool-output shapes.
# Note that c72 + styles-v3 replays use captured fixtures; the SOUL's synthetic-monitor cross-check rule
# (SIO-717) provides the existing structured signal — apmServices is the natural next slice.
```

## Out of scope (do NOT do next session unless explicitly asked)

- Konnect card. User explicitly deferred in SIO-785 Phase 2 brainstorming.
- Force-pushing or rewriting any merged history (PR #118 + #119).
- Extending the synthetic-monitors-only schema before writing the SIO-778 spec. Even if you see an obvious "apmServices" addition, the spec must come first or the schema risks tech debt across extractor + rules + UI.
- Touching the 12 pre-existing biome-formatter drift issues on main. Separate cleanup PR; not in scope for any feature ticket.

## Memory references

- `reference_normalize_tool_content` (new today) — the invariant for new extractors.
- `reference_elastic_mcp_text_block_response` (updated today) — resolved with code references.
- `reference_b2b_apm_service_naming` — critical for SIO-778 design (plural vs singular).
- `reference_confluent_synthetic_monitors` — synthetic monitor structured signal; already proven stable.
- `feedback_extractor_fixtures_must_mirror_real_mcp` — reinforced again today by SIO-786 discovery. Use real fixtures.
- `feedback_handover_doc_structure` — followed for this doc.

## What to remember (for next session)

Today closed the SIO-785 findings-card system end-to-end:
- 5 cards built (Kafka, Couchbase, GitLab, Elastic, AWS) + Atlassian
- All live-verified or pipeline-verified
- One regression caught + fixed same-day (the Elastic text-block format trip)

The natural next step is writing the SIO-778 design spec so Phase B (apmServices) can land cleanly on top of today's Phase A (synthetic monitors). SIO-773 stays as a tracker; no immediate action.
