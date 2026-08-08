# Handover: SIO-1445 — Spike: Per-Domain graphContext Slice in Sub-Agent Dispatch Payloads

**Date**: 2026-08-08
**Ticket**: [SIO-1445](https://linear.app/siobytes/issue/SIO-1445/spike-evaluate-per-domain-graphcontext-slice-in-sub-agent-dispatch) (Backlog, High-level research spike, NO code deliverable)
**Related (all Done/merged, context only)**: [SIO-1444](https://linear.app/siobytes/issue/SIO-1444/okf-audit-tier-4-sub-agent-spec-alignment-context-assembly-doc-sub) (tier-4 audit, PR [#635](https://github.com/zx8086/devops-incident-analyzer/pull/635), merged `d7327833`), [SIO-1446](https://linear.app/siobytes/issue/SIO-1446/bootstrap-agent-memory-semantic-recall-is-discarded-never-reaches-the) (bootstrap-recall fix, PR [#636](https://github.com/zx8086/devops-incident-analyzer/pull/636), merged `e70a046f`)
**Parent project**: [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)
**Repo state**: `origin/main` HEAD is `e70a046f22e69a1c2e4d9627735c7b239072f9dd` ("SIO-1446: wire discarded bootstrap semantic recall into the aggregator prompt (#636)"). Branch off this.
**Suggested branch name**: none needed for the spike itself (research note only). If the spike concludes "go", the follow-up implementation ticket gets its own branch.

## TL;DR

The tier-4 audit (SIO-1444) confirmed sub-agents deliberately receive NO knowledge-graph context: `graphEnrich` output is consumed only by the aggregator's single completion. SIO-1445 asks the one question that decision left open: would a narrow, per-domain, read-only slice of that same enrichment help specific sub-agents (e.g. gitlab-agent re-derives prior-MR/root-cause correlations from scratch every turn)? Deliverable is a research note with measured token costs and a go/no-go — not code. Success = the note exists, cites real measurements, and either closes SIO-1445 as "no-go, documented" or spawns a properly-scoped implementation ticket.

## Context — how this came to be

The OKF audit tiers 1-4 (SIO-1440/1441/1442/1444) established that the 7 sub-agents' missing memory/KG wiring is deliberate architecture, not a gap: live memory is root-only (SIO-843), and the KG reaches the pipeline as enrichment only (SIO-1026/1027 — the fan-out is hard-bounded to the 7 `DATA_SOURCE_IDS`, so a graph sub-agent can never be dispatched). That is documented in `docs/architecture/sub-agent-context-assembly.md` (merged in PR #635). SIO-1445 was filed during that audit as the deliberately-separated "is the current single-enrichment-point design actually serving sub-agents' needs" question. SIO-1446 (merged) is relevant only as a pattern precedent: it shows the repo's accepted shape for threading per-session context into a prompt without breaking the probe/eval paths.

## Where the bodies are buried

### 1. The data ALREADY travels to the sub-agent node — it is just never rendered

`supervise` (`packages/agent/src/supervisor.ts:106-114`) spreads the whole state into every dispatch:

```typescript
return validSources.map(
    (dataSourceId) =>
        new Send("queryDataSource", {
            ...state,
            ...skippedState,
            currentDataSource: dataSourceId,
            dataSourceResults: [],
        }),
);
```

So `state.graphContext` is physically present in each `Send` payload today. The "wiring" the spike evaluates is NOT new data plumbing — it is whether `packages/agent/src/sub-agent.ts` (which currently has zero references to graphContext/memory/KG, verified 2026-08-07) should render a slice of it into the sub-agent's dispatch message, and what that costs. This materially narrows the spike: no graph-topology change, no new state channel, no supervisor change.

### 2. What graphContext contains and where it is built

`graphEnrich` (`packages/agent/src/graph-knowledge.ts:167-289`) reads prior dependencies + vector-similar incidents (annotated with confirmed `rootCauseForIncident`, SIO-1026) and returns:

```typescript
return { graphContext: buildGraphContext(deps, similar) + networkContext, graphBlastRadius, knownServiceNames };
```

State channel: `packages/agent/src/state.ts:186` (`graphContext: Annotation<string>`). Note `graph-knowledge.ts:39`: the network render is bounded "because graphContext is uncapped downstream" — any per-sub-agent slice must respect that the source string is UNCAPPED; slicing/bounding is the spike's job to design.

### 3. Where sub-agent prompt cost multiplies

The sub-agent system prompt is the Bedrock prompt-cache STABLE half (SIO-1257 comment in `packages/gitagent-bridge/src/skill-loader.ts:141-143`). A per-turn volatile slice must ride the dispatch HumanMessage instead, and is re-sent on EVERY ReAct iteration of EVERY dispatched sub-agent. Cost model: `slice_tokens x dispatched_agents (up to 7+ AWS estate expansion) x ReAct iterations`. This is the number the spike must actually measure, not estimate.

### 4. Prior art for "optional per-session context into a prompt" (SIO-1446 pattern)

`buildAggregatorMessages` gained an optional trailing param so the tier-2 probe harness (`packages/agent/src/eval/single-agent-probe.ts:96`) stays byte-identical (`packages/agent/src/aggregator.ts:149-157`). Any "go" implementation for sub-agents must preserve the same property for `buildSubAgentPrompt`/`sub-agent.ts` consumers: eval and probe paths byte-identical when the feature is off. Gate any wiring behind its own env flag per the SIO-640 edge-gate idiom (see `KNOWLEDGE_GRAPH_ENABLED` handling in `packages/agent/src/graph.ts`).

## The work (step-by-step, research only)

1. **Enumerate candidate slices per datasource.** Read `buildGraphContext`'s actual output shape (`graph-knowledge.ts`) against each sub-agent's SOUL/RULES/skills to find where a sub-agent re-derives something the KG already knows. The gitlab-agent prior-MR/root-cause case was the motivating example; verify it is real by reading `agents/incident-analyzer/agents/gitlab-agent/skills/code-change-correlation/SKILL.md` and asking "would a prior-incident line change the first tool call?"
2. **Measure, not estimate.** Pull 3-5 real `graphContext` values (LangSmith traces per `~/.claude/CLAUDE.md` LangSmith recipe, or a live run with `KNOWLEDGE_GRAPH_ENABLED=true`) and compute realistic slice sizes in tokens. Multiply by observed dispatch counts and ReAct iteration counts from the same traces.
3. **Weigh against the SIO-1026/1027 rationale** (memory `reference_incident_kg_enrichment_not_fanout` — read it in full first): the enrichment seam exists because entities are incident-level, not sub-agent-level. A slice proposal must say why per-domain value beats incident-level aggregation for that specific datasource.
4. **Write the research note** (suggested: `docs/superpowers/specs/2026-08-XX-sio1445-graphcontext-slice-spike.md`) with the measured numbers and a go/no-go per datasource. If "go" for any: file the implementation ticket with the flag design and the `sub-agent.ts` injection point; if "no-go": close SIO-1445 with the note linked (user approval required before setting Done).

## Verification

Baseline (should be green on `origin/main` @ `e70a046f` before starting):

```bash
bun run typecheck && bun run lint && bun run test
```

Expected: typecheck exit 0 across packages; lint "Found 12 warnings" (pre-existing, 0 errors); 19/19 packages green (`agent` 3996+ pass).

For trace-based measurement (step 2):

```bash
grep "^LANGSMITH_API_KEY=" .env
LANGSMITH_API_KEY=<key> LANGSMITH_PROJECT=<project> langsmith-fetch traces /tmp/traces --limit 5 --include-metadata
```

## Files to modify

None for the spike. If the spike concludes "go", the likely implementation surface is:

| Area | Likely files |
|------|-------------|
| Slice renderer (pure, bounded) | new module beside `packages/agent/src/graph-knowledge.ts` |
| Injection point | `packages/agent/src/sub-agent.ts` (dispatch HumanMessage assembly, NOT the cached system prompt) |
| Flag | env gate + `docs/architecture/sub-agent-context-assembly.md` update (its exclusions table currently says sub-agents get no KG — must be amended in the same PR) |

## Workflow

Spike note is documentation — but it changes a spec dir, so still go through a PR (ready-for-review, never draft) unless the user says otherwise; handover docs are the only direct-to-main exception. Linear: SIO-1445 Backlog -> In Progress when started; never Done without user approval. CodeRabbit lifecycle per CLAUDE.md (SHA-scoped completion check).

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Spike concludes "go" and implementation quietly reintroduces the cost the enrichment seam avoids | Medium | The note must carry the measured `slice x agents x iterations` number; the implementation ticket inherits it as a budget ceiling |
| graphContext is empty in most real runs (KG gated off, or store cold) making measurement unrepresentative | Medium | Check `KNOWLEDGE_GRAPH_ENABLED` in the live env first; a mostly-empty graphContext is itself a no-go signal worth recording |
| Slicing the uncapped graphContext string by regex/heuristics is brittle | High if attempted | Slice at the SOURCE (have `buildGraphContext` return structured parts) rather than parsing the rendered string — note this in the implementation ticket if "go" |
| KG store issues bleed into measurement (SIO-1339 corruption history) | Low | See memory `reference_kg_store_corruption_not_lock_contention`; use the main repo's live store, never a stale worktree copy |

## Out of scope

- Re-auditing tier 4 or re-litigating the SIO-843 / SIO-1026/1027 decisions — settled and documented in `docs/architecture/sub-agent-context-assembly.md`.
- Any live-memory recall for sub-agents (explicitly excluded in SIO-1445's constraints).
- KG tools (`kg_*`) in the fan-out or a `knowledge-graph` datasource — permanently off the table per the enrichment-seam decision.
- Touching SIO-1444/1446 code — both merged; only cited as patterns.

## Related code references

- `packages/agent/src/supervisor.ts:106-114` — Send spreads full state (the slice's transport already exists).
- `packages/agent/src/graph-knowledge.ts:167-289` — graphEnrich; `:39` uncapped-downstream note.
- `packages/agent/src/state.ts:186` — graphContext channel.
- `packages/agent/src/sub-agent.ts` — zero memory/KG references today (verified 2026-08-07); the would-be injection point.
- `packages/agent/src/aggregator.ts:149-157` + `packages/agent/src/eval/single-agent-probe.ts:96` — SIO-1446's optional-param pattern for probe-path byte-identity.
- `packages/gitagent-bridge/src/skill-loader.ts:141-148` — why the sub-agent system prompt must stay cache-stable.
- `docs/architecture/sub-agent-context-assembly.md` — the decisions table this spike either upholds or amends.

## Memory references

Slugs under `/Users/Simon.Owusu@Tommy.com/.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/`:

- `reference_incident_kg_enrichment_not_fanout` — READ FIRST; the settled rationale this spike must argue against per-datasource, not in general.
- `project_okf_audit_tier4_subagent_alignment` — tier-4 outcome incl. the "never inventory tests by describe-headers" gotcha.
- `reference_sio1446_bootstrap_recall_stash` — the optional-param + per-thread-stash pattern, and the live-memory-section extraction (mock-pollution dodge).
- `reference_agent_memory_relevant_k_default_10_truncation` — recall sizing gotcha if any recall-adjacent measurement is done.
- `reference_kg_store_corruption_not_lock_contention` + `reference_kg_inprocess_vite_ssr_bootstrap` — KG store operational gotchas for live measurement.
- `reference_supervisor_send_shape` — prior Send-shape learnings.
