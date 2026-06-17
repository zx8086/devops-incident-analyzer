# elastic-iac conversational follow-ups + per-outcome completion chip

- **Date:** 2026-06-17
- **Repo state:** branch `claude/charming-cohen-cdf758`, HEAD `c64197a`
- **Status:** approved (brainstorming) — pending implementation plan
- **Linear:** [SIO-930](https://linear.app/siobytes/issue/SIO-930)

## TL;DR

The `elastic-iac` maker agent is structurally incapable of conversational follow-ups, and renders a plan rejection as a green "Completed" chip. Two coupled fixes, one PR:

1. **A `converse` lane** — a new intent + node that answers follow-up questions *about the agent's own previous answer* ("why was that config wrong?", "explain that") using the full conversation history, mirroring the incident graph's `respond()`. Explain-only: read-only Elastic tools allowed, never drafts/opens an MR.
2. **A per-outcome completion chip** — emit a turn `outcome` on the `done` SSE event derived from terminal IaC state, and render the chip with the right color/label (rejected, declined, blocked, unsupported, pipeline-failed, completed) instead of an unconditional green "Completed".

## Context — how this came to be

A live session against the IaC agent (`localhost:5173`) showed two failures in one screenshot:

- The user rejected a proposed ILM policy, then asked "How did you fail that config?" with a detailed critique. The agent classified it `intent: pipeline-status` and ran `watchPipeline` — hunting for an unrelated open MR — instead of explaining its proposal.
- Each rejection rendered under a green "Completed in 2.4s" chip.

Root cause (see memory `reference_iac_agent_no_conversational_memory`):

- **No conversation history.** Every IaC node reads `lastHumanText(state)` (latest human message only) at `packages/agent/src/iac/nodes.ts:37`. Contrast `packages/agent/src/responder.ts:32`, which does `llm.invoke([system, ...state.messages])`.
- **No conversational intent.** `classifyIacIntent` (`nodes.ts:308`) emits only six *action* intents (gitops/fleet-upgrade/synthetics-drift/drift/pipeline-status/info); the catch-all `info` runs a fresh read-only Elastic loop, not a "discuss the prior turn" path. There is no `classify -> {simple: responder}` fork like the incident graph (`graph.ts:128`).
- **Rejection looks like success.** Both `apps/web/src/routes/api/agent/stream/+server.ts:121` and `.../iac/resume/+server.ts:102` emit a bare `{type:"done"}`; `agent-reducer.ts:386` stores only timing; `CompletedProgress.svelte:94` is hardcoded green check + "Completed".

## Where the bodies are buried

- `packages/agent/src/iac/state.ts:363` — `intent` annotation union (6 values + null). Add `"converse"`.
- `packages/agent/src/iac/nodes.ts:37` — `lastHumanText` (latest-only reader; every node uses it).
- `packages/agent/src/iac/nodes.ts:250-268` — `intentFromText`, returns 6-value union; default `"info"`.
- `packages/agent/src/iac/nodes.ts:276-303` — `looksLikeFleetStatusCheck`, the existing deterministic guard idiom to mirror.
- `packages/agent/src/iac/nodes.ts:308-355` — `classifyIacIntent`; the LLM prompt enumerating intent words (`nodes.ts:347`).
- `packages/agent/src/iac/nodes.ts:520-572` — `INFO_TOOL_NAMES` + `infoTools()` + `answerInfo` (the bounded read-only loop `converseIac` copies).
- `packages/agent/src/iac/graph.ts:81-96` — the `classifyIacIntent` conditional fan-out.
- `apps/web/src/lib/server/agent.ts:177-197` — IaC initial state is `{ messages, requestId }` only; `isFollowUp` (passed at the incident branch, `agent.ts:206`) is dropped for IaC.
- `apps/web/src/routes/api/agent/stream/+server.ts:109-159` — IaC `done` emission (initial turn).
- `apps/web/src/routes/api/agent/iac/resume/+server.ts:97-102` — IaC `done` emission (resume turn).
- `apps/web/src/lib/stores/agent-reducer.ts:386-395` — `done` reducer case.
- `apps/web/src/lib/components/CompletedProgress.svelte:87-104` — the hardcoded-green chip.

## Section 1 — Backend: the `converse` lane

### Intent + routing
- Add `"converse"` to the `intent` union in `state.ts:363` and the `intentFromText` return type in `nodes.ts:252`. `intentFromText` matches `converse` before the `info` fallback (keyword `"converse"`; the classifier emits the bare word).
- Thread `isFollowUp` into `IacState`: add `isFollowUp: Annotation<boolean>` (default `false`) to `state.ts`, and pass `isFollowUp: options.isFollowUp ?? false` in the IaC initial state at `agent.ts:180`.
- `classifyIacIntent` gains a deterministic guard, in the spirit of `looksLikeFleetStatusCheck`:
  - The classifier prompt adds a 7th option, `converse`: "a follow-up that asks about, critiques, seeks the reasoning behind, or reacts to the agent's OWN previous answer or proposal — NOT a request to change infrastructure. Examples: 'why was that wrong?', 'explain that', 'what would you change?', 'I don't think that policy is complete'."
  - **`converse` is only selectable on a follow-up turn.** When `state.isFollowUp === false`, a returned `converse` is coerced to `info` (a first turn cannot be about a prior answer). This kills the first-turn false positive without weakening action detection.
  - A follow-up that is itself a new action ("now downsize warm to 8g", "also bump the aws integration") still classifies `gitops` — `isFollowUp` only *enables* the `converse` candidate; the LLM disambiguates action-vs-converse within follow-ups.

### Node
- New `converseIac(state)` in `nodes.ts`:
  - Builds `convo = [SystemMessage(buildSystemPrompt(getAgentByName(AGENT)) + EXPLAIN_ONLY_GUARDRAIL), ...state.messages]`. **This is the only node that passes full history.**
  - `EXPLAIN_ONLY_GUARDRAIL`: "This is a conversational follow-up about your previous answer. Explain, justify, or critique using the conversation above. You MAY use the read-only Elastic tools to ground your answer in live state. You must NOT draft Terraform, edit config, create a branch, or open an MR — if the user wants a change made, tell them to ask for it directly and it will go through the normal review-gated proposal flow."
  - Uses the same bounded tool loop as `answerInfo` over `infoTools()` (the `INFO_TOOL_NAMES` subset) — physically cannot reach write tools. `MAX_STEPS = 5`, final no-tool synthesis on budget exhaustion.
  - Returns `{ messages: [new AIMessage(answer)] }`.

### Graph
- `graph.ts`: `.addNode("converseIac", converseIac)`; extend the `classifyIacIntent` conditional to route `s.intent === "converse" -> "converseIac"`; add `"converseIac"` to that edge's destination array; `.addEdge("converseIac", END)`.

## Section 2 — Per-outcome completion chip

### Outcome derivation (pure, server-side)
- New pure helper `iacTurnOutcome(state): IacTurnOutcome` in `nodes.ts` (exported, unit-tested). `IacTurnOutcome = "completed" | "rejected" | "declined" | "blocked" | "unsupported" | "pipeline-failed"`.

| outcome | condition (first match wins) |
|---|---|
| `rejected` | `reviewDecision === "rejected"` AND no gate-decline flag (plan-review reject) |
| `declined` | synthetics push declined (`syntheticsPushApproved === false` with a report present) OR fleet-upgrade declined (`fleetUpgradeApproved === false` with a report present) |
| `unsupported` | `blockedReason` present AND `iacRequest?.workflow === "other"` (capability message) |
| `blocked` | `blockedReason` present (guard / draft block) |
| `pipeline-failed` | `isTerminalPipelineStatus(pipelineStatus)` AND `pipelineStatus === "failed"` |
| `completed` | otherwise (MR opened, info answered, converse, drift summary, successful apply) |

Ordering rationale: explicit human decisions (reject/decline) outrank `blocked`; `unsupported` is a more specific `blocked`; `pipeline-failed` only applies on an otherwise-successful path that reached a failed CI run.

### Wire
- New `getIacTurnOutcome(threadId): Promise<IacTurnOutcome>` in `$lib/server/agent.ts`: reads the checkpoint state (same access pattern as `getLastAssistantText`) and runs `iacTurnOutcome`. Returns `"completed"` if state can't be read.
- Both IaC `done` emissions (`stream/+server.ts` and `iac/resume/+server.ts`) include `outcome: await getIacTurnOutcome(threadId)`. The incident-analyzer `done` is **not** changed (no `outcome` field → treated as `completed`).

### Store + chip
- `agent-reducer.ts` `done` case stores `lastOutcome: event.outcome` (type widened in the store/event types). Default/absent → `"completed"`.
- `CompletedProgress.svelte` switches icon + color + label on `lastOutcome`:
  - `completed` → green check, "Completed{ in <time>}" (unchanged).
  - `rejected` → amber, "Plan rejected".
  - `declined` → amber, "Declined".
  - `blocked` → amber, "Blocked".
  - `unsupported` → neutral/gray, "Not supported yet".
  - `pipeline-failed` → red, "Pipeline failed".
  - The data-source suffix (`-- N data sources`) stays only on `completed`.

## Testing

Backend (`packages/agent/src/iac/`):
- `intentFromText("converse")` → `"converse"`; precedence vs other keywords.
- `classifyIacIntent`: returns `converse` for "why was that wrong / explain that" **only when `isFollowUp: true`**; coerces to `info` when `isFollowUp: false`; still returns `gitops` for "now downsize warm to 8g" on a follow-up. **Regression:** "How did you fail that config?" with `isFollowUp: true` → `converse`, NOT `pipeline-status`.
- `converseIac`: answers from history; given a mocked LLM that tries to call a write tool, the tool is rejected (not in `infoTools()`); never returns a `blockedReason` or MR.
- `iacTurnOutcome`: one assertion per outcome row, plus ordering (reject+blocked → rejected; workflow "other" block → unsupported).

Frontend:
- reducer: `done` with each `outcome` sets `lastOutcome`; absent `outcome` → `completed`.
- (light) `CompletedProgress` renders the right label per outcome.

Canary: adding `"converse"` to the intent union must compile against existing tests that spell the union; `pipeline-status.test.ts` / `fleet-upgrade.test.ts` assert specific values and should remain green.

## Verification

```bash
bun run typecheck && bun run lint && bun run test
```

Manual probe (server on :5173, IaC MCP on :9086):
```bash
# 1. propose a change, reject it at the gate (via UI or resume with {decision:"rejected"})
# 2. send a conversational follow-up on the SAME threadId:
curl -sN localhost:5173/api/agent/stream -H 'content-type: application/json' -d '{
  "agentName":"elastic-iac","threadId":"<thread>","isFollowUp":true,
  "messages":[{"role":"user","content":"Why was that config wrong?"}]
}'
# expect: classified IaC intent -> "converse"; an explanation that references the prior proposal;
#         the rejected turn'\''s done event carries outcome:"rejected".
```

## Files to modify

| File | Change |
|---|---|
| `packages/agent/src/iac/state.ts` | add `"converse"` to `intent` union; add `isFollowUp` annotation |
| `packages/agent/src/iac/nodes.ts` | `intentFromText` + type; `classifyIacIntent` guard + prompt; `converseIac` node; `iacTurnOutcome` helper + type |
| `packages/agent/src/iac/graph.ts` | register `converseIac`; route `converse`; edge to END |
| `apps/web/src/lib/server/agent.ts` | thread `isFollowUp` into IaC initial state; `getIacTurnOutcome` |
| `apps/web/src/routes/api/agent/stream/+server.ts` | include `outcome` on IaC `done` |
| `apps/web/src/routes/api/agent/iac/resume/+server.ts` | include `outcome` on `done` |
| `apps/web/src/lib/stores/agent-reducer.ts` | store `lastOutcome` (+ event/store types) |
| `apps/web/src/lib/components/CompletedProgress.svelte` | per-outcome icon/color/label |
| `packages/agent/src/iac/*.test.ts`, web reducer test | tests above |

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| LLM still misroutes a follow-up to an action intent | Med | `isFollowUp` gate only enables `converse`; action detection unchanged; regression test on the exact reported phrase |
| `converse` swallows a genuine new action on a follow-up turn | Med | Prompt is explicit that a change request is gitops; test "now downsize warm" stays gitops |
| Outcome derived from stale checkpoint fields | Low | `iacTurnOutcome` reads only terminal fields the graph sets this turn; `reviewDecision` etc. are per-turn |
| Incident-analyzer chip regresses | Low | Incident `done` omits `outcome`; reducer defaults to `completed`; chip unchanged for that path |
| Read-only tool leak in converse | Low | reuses `infoTools()` allow-set; write tools physically unbindable |

## Out of scope

- Re-proposing a corrected config inside the converse lane (explain-only by decision).
- Any change to the incident-analyzer graph.
- Topic-shift detection for IaC.
- New chip outcomes beyond the six above.

## Memory references

- `reference_iac_agent_no_conversational_memory` — the root-cause writeup this spec resolves.
- `reference_confidence_prose_vs_gate` — prior IaC-vs-incident divergence pattern.
- `project_elastic_iac_agent_proposes_gitops_disposes` — propose-only HITL contract the converse lane must not break.
