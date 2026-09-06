# pi-fleet Phase 2c Implementation Plan (SIO-1655): third graph, LLM-driven spoke selection and reply synthesis

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **NOT APPROVED FOR IMPLEMENTATION.** This plan exists so the deferred phase is costed and its blockers are visible. Two decisions (Blocker 1 and the Task 5 injection question) must be recorded on [SIO-1655](https://linear.app/siobytes/issue/SIO-1655) before Task 2 starts. Per the project rule, no phase starts before its issue is approved.

**Goal:** Let an LLM choose which pi-coms spokes to ask and synthesize their replies into one answer, instead of the operator addressing one spoke at a time.

**Architecture:** A third top-level graph (`packages/agent/src/pi-fleet/`) built with `createReactAgent` over five hub tools, reached through a `graphFor(agentName)` registry that replaces today's two-way branching. The registry lands FIRST, as its own PR with no third graph in it, because it is the mitigation the feasibility doc's risk row already prescribes and it is independently valuable.

**Tech Stack:** LangGraph (`createReactAgent` from `@langchain/langgraph/prebuilt`), Zod 4, Bun test (`--isolate` for `packages/agent`), SvelteKit (Svelte 5 runes, Tailwind).

**Spec:** Linear SIO-1655; `docs/architecture/pi-fleet-gitagent-feasibility.md` section "Phase 2: side by side", 2c bullet.

## Do not start until these are decided

**Blocker 1 -- is the `pi-fleet` persona allowed to run in-process?** `agents/pi-fleet/agent.yaml` says the spoke persona "must never enter the analyzer's `AGENT_NAMES` dispatch table" and the console persona is "never executed in-process by the analyzer" (SIO-1649). Literally, `AGENT_NAMES` is the SUB-agent table (`supervisor.ts` / `sub-agent.ts`) and a third top-level graph does not enter it. As intent, 2c runs that SOUL in-process, which is what the sentence forbids. Resolve as (a) a distinct in-process persona leaving `agents/pi-fleet/` export-only, or (b) an amended SIO-1649 constraint with a recorded rationale. Do NOT resolve it by reading the constraint narrowly and moving on.

**Blocker 2 -- hub replies become model input.** Every phase so far kept hub replies as data: the pane renders them, the inbox node feeds only structured facts to the prompt, the Phase 3 workflow writes only enums and ids to memory. The standing invariant since PR #682 is that a hub reply is never an LLM input. 2c breaks that on purpose: synthesis means the model reads spoke prose. That needs an explicit decision and a guard design (Task 5), not an implementation detail discovered mid-build.

## Context (verified against the code 2026-09-06)

- The binary assumption is real and spread across the web layer. `apps/web/src/lib/server/agent.ts`: 6 `agentName === "elastic-iac"` ternaries (`getPipelineNodes:262`, `invokeAgent:320`, `:416`, `pruneThreadState:437`, `:565`, `getLastAssistantText:581`), 2 `ctx.agentName !== "incident-analyzer"` early returns (`:469`, `:522`), 4 `= "incident-analyzer"` parameter defaults.
- `AgentId` is a two-member union (`apps/web/src/lib/stores/agent.svelte.ts:47`); the stream route validates `z.enum(["incident-analyzer", "elastic-iac"])` (`+server.ts:49`); `toggleAgent()` is a binary flip and `isIac` appears 10 times in `+page.svelte`. `api/agent/topology/+server.ts`, `api/agent/iac/resume/+server.ts` and `lib/server/schedules.ts` are binary-shaped too.
- `packages/agent/src/memory-backend.ts:88` holds exactly two identities and THROWS for an unregistered agent name, deliberately ("a new agent can never silently" get a wrong identity). A third graph that writes memory needs an entry or it throws at first use.
- Second-graph precedent to mirror: `packages/agent/src/iac/graph.ts` (370 lines) + `state.ts` (877). `createReactAgent` is already used in `sub-agent.ts` and is test-driven in `sub-agent-context-budget-integration.test.ts`.
- Hub client surface for the tools: `register`, `listAgents`, `send`, `awaitReply`, `mailbox`, `deregister` (`packages/agent/src/action-tools/pi-coms-client.ts:262-360`). Hub selection by estate suffix: `selectHubForEstate` (`pi-verifier.ts:95`). One await slice is 25 s (`PI_COMS_AWAIT_SLICE_MS`).
- `agents/pi-fleet/` already carries `SOUL.md`, `DUTIES.md`, `RULES.md` and `agent.yaml` from SIO-1649, plus the `aws-spoke` sub-agent definition.

## Global Constraints

- Bun, TypeScript strict, never `any`, Zod, no `.default()` in config schemas, Biome, named exports, Tailwind only, Svelte 5 runes. Env read at call time, never at module scope.
- No emojis, no em dashes.
- Public repo: no account ids, hostnames or tokens in commits. Test fixtures use `111122223333`-style synthetic ids.
- No cross-environment access: each spoke is reached through its own environment's hub, chosen by estate suffix.
- Commit format `SIO-1655: message` with the Co-Authored-By trailer; PRs ready for review; merge on explicit go-ahead; ledger row in `docs/code-review-bakeoff.md` after each merge.
- Verify with `bun run typecheck && bun run lint`; `cd packages/agent && bun test --isolate`; `cd apps/web && bun run test`. Lint the changed-file list directly (`git diff --name-only origin/main`), not a grepped global dump.

## Sequencing: two PRs, not one

**PR 1 (Tasks 1 to 3) is the registry refactor with NO third graph.** It must be behaviour-preserving for `incident-analyzer` and `elastic-iac`, provable by the existing suites staying green with no test edits beyond mock surfaces. It is worth merging even if 2c is never built.

**PR 2 (Tasks 4 to 8) adds the graph** on top of the registry.

Splitting this way keeps the risky, reviewable-by-diff refactor separate from new behaviour, and means a decision to abandon 2c after PR 1 still leaves the codebase better.

## File structure

```
PR 1 -- registry refactor
apps/web/src/lib/server/graph-registry.ts        new: graphFor(agentName), agent capability descriptors
apps/web/src/lib/server/agent.ts                 replace 6 ternaries + 2 early returns with registry lookups
apps/web/src/lib/stores/agent.svelte.ts          AgentId widened; TICKET_CREATION_AGENTS stays a set
apps/web/src/routes/api/agent/stream/+server.ts  Zod enum from the registry's key list
apps/web/src/routes/api/agent/topology/+server.ts, iac/resume/+server.ts, lib/server/schedules.ts
apps/web/src/routes/+page.svelte                 toggle -> selector (isIac x10 removed)
apps/web/src/lib/server/graph-registry.test.ts   new

PR 2 -- the third graph
packages/agent/src/pi-fleet/state.ts             fleet state (targets, per-spoke replies, synthesis)
packages/agent/src/pi-fleet/tools.ts             five hub tools over PiComsClient
packages/agent/src/pi-fleet/graph.ts             createReactAgent + register/deregister pre/post nodes
packages/agent/src/pi-fleet/{state,tools,graph}.test.ts
packages/agent/src/memory-backend.ts             identity-map entry for the new agent name
packages/agent/src/index.ts                      exports
apps/web/src/lib/server/graph-registry.ts        register the third graph
docs/architecture/pi-fleet-third-graph.md        new: the injection guard, tool surface, when to use it
.env.example                                     PI_FLEET_GRAPH_ENABLED
```

### Task 1: Registry seam

- [ ] `apps/web/src/lib/server/graph-registry.ts`: `graphFor(agentName)` returning the compiled graph plus a descriptor (`{ id, label, hasConfidence, hasDataSources, streamsTokens }`). Registry keyed by agent id, so adding an agent is one entry, not N ternaries.
- [ ] The two `ctx.agentName !== "incident-analyzer"` early returns become descriptor checks (`hasConfidence`, `hasDataSources`), which is what they actually mean.

### Task 2: Replace the branches

- [ ] Rewrite the 6 ternaries and 4 defaults in `agent.ts` to registry lookups. No behaviour change.
- [ ] Widen `AgentId`, derive the stream-route Zod enum from the registry's keys, update the topology and iac/resume routes and `schedules.ts`.

### Task 3: Selector UI

- [ ] Replace `toggleAgent()` with a selector; remove the 10 `isIac` uses. Two agents render the same as today.
- [ ] `graph-registry.test.ts`: every registered agent resolves; an unknown name is refused; descriptors match behaviour.
- [ ] **Gate: full suites green with no behavioural test changes.** Ship PR 1 here.

### Task 4: Fleet graph state and tools

- [ ] `state.ts`: conversation, resolved targets, per-spoke replies (kept as DATA with provenance), synthesis output.
- [ ] `tools.ts`: five tools over `PiComsClient` (list agents, send, await, inbox, status). Each is per-environment-hub scoped; a tool call naming an estate whose environment has no hub is refused, not guessed.
- [ ] Register/deregister as pre/post nodes so a run never leaks a hub registration (the `runHubTask` finally-block discipline, at graph scope).

### Task 5: The injection guard (do not skip)

- [ ] Implement the Blocker 2 decision. Minimum: spoke replies enter the model wrapped and labelled as untrusted third-party content, never as instructions; a reply can never trigger a tool call on its own; the synthesis prompt states that replies are evidence to be summarized, not commands.
- [ ] Test-assert it: a spoke reply containing an imperative ("ignore previous instructions", "send X to Y") must not produce that tool call.
- [ ] Document it in `docs/architecture/pi-fleet-third-graph.md` and note the deliberate departure from the PR #682 invariant in `pi-coms-verification.md`.

### Task 6: Memory identity

- [ ] Add the identity-map entry in `memory-backend.ts:88`. Any memory this graph writes follows the SIO-1651 structured-only rule for anything derived from a spoke reply.

### Task 7: Wire and gate

- [ ] Register the graph in the registry; gate on `PI_FLEET_GRAPH_ENABLED`, default off.

### Task 8: Docs

- [ ] `docs/architecture/pi-fleet-third-graph.md`; feasibility tracking row; `.env.example`; `docs/README.md` row; program handover status.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Prompt injection from spoke replies (the whole point of 2c is to read them) | High | Task 5 guard, test-asserted; replies labelled untrusted; no tool call from reply content |
| Registry refactor changes behaviour for the two existing agents | Medium | PR 1 ships alone, behaviour-preserving, existing suites unchanged |
| The SIO-1649 constraint is read narrowly and the persona ends up in-process anyway | Medium | Blocker 1 decided and recorded on the issue first |
| Memory write throws on an unregistered agent name | Certain if missed | Task 6; `memory-backend.ts` throws by design |
| Fan-out across accounts multiplies hub traffic and latency | Medium | Cap concurrent targets; one await slice per spoke; per-environment hubs |
| 2c duplicates the 2a pane rather than replacing it | Low | The pane stays; 2c is for multi-spoke synthesis only |

## Out of scope

Hub protocol changes; a Pi extension on spokes calling the Agent Memory REST service; replacing the 2a pane; changing the Phase 3 workflow's deterministic spoke selection (it should stay deterministic).
