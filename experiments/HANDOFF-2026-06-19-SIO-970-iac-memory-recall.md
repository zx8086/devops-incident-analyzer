# HANDOFF — SIO-970: recall prior agent-memory on the IaC change path

| | |
|---|---|
| **Date** | 2026-06-19 |
| **This ticket** | [SIO-970](https://linear.app/siobytes/issue/SIO-970) — *Backlog* |
| **Builds on (merged)** | [SIO-967](https://linear.app/siobytes/issue/SIO-967) (PR #260), [SIO-968](https://linear.app/siobytes/issue/SIO-968) (PR #261), [SIO-969](https://linear.app/siobytes/issue/SIO-969) (PR #262) |
| **Repo state** | `main` @ `ba28ddb` (all three above merged). Clean. |
| **Suggested branch** | `sio-970-iac-memory-recall` |

---

## TL;DR

The elastic-iac change/MR path is **memory write-only**. It WRITES a durable fact when an MR opens, annotated with `stack_instance`/`deployment`/`stack`/`workflow`/`outcome` — but it never RECALLS prior memory while drafting a change. SIO-969 closed the **graph** half of grounding (history + failed-change risk on the plan-review card). SIO-970 closes the **memory** half: pull "what we learned / decided last time we touched this stack" into the proposal/plan-review, across sessions. Success = a prior learning for a (deployment, stack) surfaces on the plan-review card before the user approves, verified live.

## Context — how this ticket came to be

A user asked whether changes/MRs are grounded + enriched from the graph and memory. Tracing it (SIO-969) found: the graph side worked but wasn't displayed (fixed in #262), and the **memory side is write-only on the change path**. Semantic recall (`searchAgentMemory`) is wired ONLY into the info-query path (`search_memory` local tool in `answerInfo`/`converseIac`), not into the change/draft flow. This ticket was split out deliberately to avoid scope-creeping #262.

## Where the bodies are buried (precise file:line)

**Memory is WRITTEN on the change path (the symmetry to exploit):**
- `packages/agent/src/iac/nodes.ts:6309-6314` — on a gitops MR turn (`!isFleet && state.intent === "gitops" && state.mrUrl && selectedBackend() === "agent-memory"`), calls `recordKeyDecision({ ... annotations: buildIacChangeAnnotations(state) })`.
- `packages/agent/src/iac/nodes.ts:6201` — `buildIacChangeAnnotations(state)` stamps the annotation keys recall can filter on:
  ```ts
  { kind: "iac-change", outcome, config_change_id, thread_id?, deployment?, stack?,
    stack_instance? /* "<dep>/<stack>" */, workflow?, version?, mr_url?, pipeline_id?, pipeline_status? }
  ```

**The recall primitive already exists (just not called on this path):**
- `packages/agent/src/memory-backend.ts:262` — `searchAgentMemory(agentName, query, filter?: AnnotationMap): Promise<MemorySearchHit[]>`. Cross-session semantic recall, optional annotation filter, soft-fails to `[]` on the file backend / errors. `MemorySearchHit` = `{ text, annotations }`.
- `packages/agent/src/iac/local-tools.ts` — `runMemorySearch` shows the exact filter-building pattern (`{ deployment, stack, kind }`).

**Where the recall slots in (next to the graph read SIO-969 just extended):**
- `packages/agent/src/iac/graph-knowledge.ts:118` — `graphEnrichIac(state)`. Runs post-`readClusterState`, pre-draft. Already resolves `deployment` (`targetDeploymentName(state)`) and `stack` (`stackFromPaths(state.proposedFiles)`), builds `iacGraphContext` + (SIO-969) `lastStackInstanceOutcome`. This is the natural home for a memory recall — same node, same resolved keys.

**Where it gets shown (the SIO-969 rendering pattern to mirror):**
- `packages/agent/src/iac/state.ts:506` — `iacGraphContext` annotation; `:507`-ish — SIO-969 added `lastStackInstanceOutcome`. Add a `priorLearnings?: string` (or structured) annotation the same way.
- `packages/agent/src/iac/nodes.ts` `reviewPlan` (~`:3776`) — sets `recentChanges: state.iacGraphContext` on the review payload (~`:3964`) and (SIO-969) `unshift`es a HIGH risk when `state.lastStackInstanceOutcome?.outcome === "failed"`. Add the memory block / risk here.
- `apps/web/src/lib/stores/agent-reducer.ts:25` `IacReview` — SIO-969 added `recentChanges?: string`. Add the new field here too (client type, or the card can't read it — that was the SIO-969 gotcha).
- `apps/web/src/lib/components/PlanReviewCard.svelte` — SIO-969 rendered `recentChanges` via `MarkdownRenderer` in a `<details>` block. Mirror for the memory block.

## The fix (step-by-step)

1. **state**: add `priorLearnings` to `IacState` (`state.ts`) — markdown string (simplest) or a structured `{text, annotations}[]`.
2. **enrich**: in `graphEnrichIac` (`graph-knowledge.ts`), after resolving `deployment`/`stack`/`siId`, add:
   ```ts
   // gate: agent-memory backend only; never block the turn
   let priorLearnings = "";
   if (selectedBackend() === "agent-memory" && siId) {
     const hits = await searchAgentMemory("elastic-iac", <query from iacRequest/title>, { stack_instance: siId });
     priorLearnings = renderLearnings(hits);  // markdown; "" when empty
   }
   ```
   Return it alongside `iacGraphContext`. Wrap in the existing try/catch (already soft-fails to `{}`). NOTE: `graph-knowledge.ts` does not import `searchAgentMemory`/`selectedBackend` yet — add from `../memory-backend.ts`.
3. **review**: in `reviewPlan`, set `priorLearnings: state.priorLearnings || undefined` on the review payload (next to `recentChanges`). Optionally fold a strong signal into `risks`.
4. **client type**: add `priorLearnings?: string` to `IacReview` (`agent-reducer.ts`).
5. **UI**: render it in `PlanReviewCard.svelte` (copy the `recentChanges` `<details>` + `MarkdownRenderer` block; label e.g. "Prior learnings (memory)").

## Verification

```bash
bun run typecheck && bun run lint && bun run yaml:check
bun test packages/agent/src/iac/graph-knowledge.test.ts   # add a recall-enrich case (mock searchAgentMemory; see local-tools.test.ts for the __setAgentMemoryClient stub)
bun run --filter @devops-agent/web typecheck              # svelte-check; ignore stale-LSP "does not exist on IacReview" — re-run fresh
```

**Live e2e (mirror the SIO-969 throwaway script under packages/agent/):** seed an agent-memory fact for a `stack_instance` (needs `LIVE_MEMORY_BACKEND=agent-memory` + `AGENT_MEMORY_*` env), run `graphEnrichIac` then `reviewPlan` for the same cell, assert `priorLearnings` lands on the review payload. If agent-memory isn't reachable in-session, fall back to mocking `searchAgentMemory` (the `__setAgentMemoryClient` test stub) and assert wiring.

## Risks / gotchas

| Risk | Mitigation |
|---|---|
| `graphEnrichIac` is best-effort; a memory call that throws must not break drafting | Keep inside the existing try/catch; gate on `selectedBackend() === "agent-memory"` |
| Client `IacReview` type silently drops new fields (SIO-969 bug) | Add `priorLearnings?` to `agent-reducer.ts` IacReview or the card can't read it |
| Stale-LSP false error on `PlanReviewCard.svelte` after the type edit | Authoritative check is a fresh `svelte-check`; SIO-969 hit this exact phantom |
| Recall noise (daily-log chatter vs durable decisions) | Filter `kind: "iac-change"` (or "key-decision") alongside `stack_instance`; see `factAnnotations`/`messageAnnotations` in memory-backend.ts |

## Out of scope

Re-architecting the deterministic proposers to reason via an LLM (SIO-969 established they're deterministic — a computed enrichment/risk is the right shape). Incident-analyzer side.

## Memory references (slugs)

- `reference_lbug_exclusive_file_lock`, `reference_lbug_cypher_and_teardown_gotchas` — KG engine constraints (graph side).
- `reference_elastic_iac_repo_three_layer_structure` — stack-instance keying.
- Spec: `docs/superpowers/specs/2026-06-17-couchbase-agent-memory-backend-design.md` (the agent-memory backend + annotations).
