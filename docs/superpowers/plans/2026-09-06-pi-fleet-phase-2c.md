# pi-fleet Phase 2c Implementation Plan (SIO-1655): third graph, LLM-driven spoke selection and reply synthesis

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Build spec. Not yet scheduled.** Both open questions were decided on 2026-09-06 and are recorded on [SIO-1655](https://linear.app/siobytes/issue/SIO-1655): 2c uses a SEPARATE in-process persona (`agents/pi-fleet-console/`), leaving `agents/pi-fleet/` export-only, and spoke replies enter the model only inside the synthesis step behind the Task 5 guard. Nothing here is blocked; this is ready to build when the work is scheduled.

**Goal:** Let an LLM choose which pi-coms spokes to ask and synthesize their replies into one answer, instead of the operator addressing one spoke at a time.

**Architecture:** A third top-level graph (`packages/agent/src/pi-fleet/`) built with `createReactAgent` over five hub tools, reached through a `graphFor(agentName)` registry that replaces today's two-way branching. The registry lands FIRST, as its own PR with no third graph in it, because it is the mitigation the feasibility doc's risk row already prescribes and it is independently valuable.

**Tech Stack:** LangGraph (`createReactAgent` from `@langchain/langgraph/prebuilt`), Zod 4, Bun test (`--isolate` for `packages/agent`), SvelteKit (Svelte 5 runes, Tailwind).

**Spec:** Linear SIO-1655; `docs/architecture/pi-fleet-gitagent-feasibility.md` section "Phase 2: side by side", 2c bullet.

## Decisions taken (2026-09-06)

**Persona: separate, in-process.** 2c gets `agents/pi-fleet-console/`. `agents/pi-fleet/` stays export-only and the SIO-1649 constraint in its `agent.yaml` is left intact.

The two runtimes have different tool vocabularies: the exported persona drives Pi + coms-net on a fleet host, the in-process graph drives five `PiComsClient` tools through LangGraph. SIO-1649's own risk row already names tool-vocabulary drift as the reason `aws-spoke/RULES.md` was authored fresh rather than reused from aws-agent; the same reasoning applies. Separation also leaves the exporter's allowlist/denylist untouched, so no in-process edit can widen what ships to public fleet hosts, and keeps one persona per `pi-fleet-vX.Y.Z` tag. Cost: two persona sources that can drift, mitigated as SIO-1649 does it, with shared invariants in `agents/shared/`.

**Spoke replies as model input.** 2c reads spoke prose on purpose, which every earlier phase avoided (PR #682: hub replies are data, never an LLM input). This is a deliberate, scoped departure: replies reach the model only inside the synthesis step, wrapped and labelled untrusted, and Task 5 builds and test-asserts the guard. Memory writes derived from replies stay structured-only per SIO-1651.

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
agents/pi-fleet-console/{agent.yaml,SOUL,RULES,DUTIES}   new: in-process console persona (pi-fleet/ stays export-only)
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

### Task 4: Console persona, fleet graph state and tools

- [ ] `agents/pi-fleet-console/{agent.yaml,SOUL.md,RULES.md,DUTIES.md}`: the in-process persona. RULES authored for the LangGraph tool vocabulary, not Pi's; shared invariants stay in `agents/shared/`.

- [ ] `state.ts`: conversation, resolved targets, per-spoke replies (kept as DATA with provenance), synthesis output.
- [ ] `tools.ts`: five tools over `PiComsClient` (list agents, send, await, inbox, status). Each is per-environment-hub scoped; a tool call naming an estate whose environment has no hub is refused, not guessed.
- [ ] Register/deregister as pre/post nodes so a run never leaks a hub registration (the `runHubTask` finally-block discipline, at graph scope).

### Task 5: The injection guard (do not skip)

- [ ] Implement the reply-handling decision above. Minimum: spoke replies enter the model wrapped and labelled as untrusted third-party content, never as instructions; a reply can never trigger a tool call on its own; the synthesis prompt states that replies are evidence to be summarized, not commands.
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
| The two personas drift (console vs exported spoke) | Medium | Shared invariants in `agents/shared/`; console RULES authored for the LangGraph tool vocabulary |
| Memory write throws on an unregistered agent name | Certain if missed | Task 6; `memory-backend.ts` throws by design |
| Fan-out across accounts multiplies hub traffic and latency | Medium | Cap concurrent targets; one await slice per spoke; per-environment hubs |
| 2c duplicates the 2a pane rather than replacing it | Low | The pane stays; 2c is for multi-spoke synthesis only |

## Out of scope

Hub protocol changes; a Pi extension on spokes calling the Agent Memory REST service; replacing the 2a pane; changing the Phase 3 workflow's deterministic spoke selection (it should stay deterministic).
