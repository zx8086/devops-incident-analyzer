# Handover: pi-fleet Phase 3, skillflow graph and agent handlers, structured verdicts into live memory

- Date: 2026-09-06
- Ticket: [SIO-1651](https://linear.app/siobytes/issue/SIO-1651) (Backlog; set In Progress when work starts). Parent program: the pi-fleet feasibility plan in `docs/architecture/pi-fleet-gitagent-feasibility.md`; program handover `experiments/HANDOFF-2026-09-06-pi-fleet-program.md`. Sibling epic: [SIO-848](https://linear.app/siobytes/issue/SIO-848) (SkillsFlow executor, Backlog but the executor is real).
- Repo state: `main` at `cb2fcdca` (PR #695 merged, Phase 2b). Every earlier phase (0b, 0, 1, 1b, 2a, 2b) is merged; see the program handover's status line.
- Suggested branch: `claude/sio-1651-phase3-pi-handoff-workflow` off `origin/main`. Write the plan to `docs/superpowers/plans/2026-09-06-pi-fleet-phase-3.md` first (the previous phases' plans in that directory are the format).

## TL;DR

Run the incident analyzer and a pi-coms spoke after each other as a deterministic skillflow workflow, and let the spoke's verdict flow back into the analyzer's live memory as structured fields only. Concretely: register `graph` and `agent` step handlers (both currently throw `MissingHandlerError`), add `agents/incident-analyzer/workflows/pi-handoff.yaml` chaining `analyze` (graph) to `verify` (agent), trigger it from incident close or manually, and call `recordKeyDecision` with enums and ids after a successful verify (both the SIO-1635 card path and the workflow path). Success: the skillflow test runs graph then agent in order with fake handlers; end to end, closing an incident sends the report to the estate spoke, the verdict lands in `memory/runtime/key-decisions.md` as enums, and the next turn's prompt shows the decision line with no free text.

## Context: how this ticket came to be

Phases 0 to 2b built the transport (per-environment hubs, hub client with sender prefix, heartbeat and mailbox), the personas and fleet deploy, the operator pane (SIO-1650) and the passive inbox node (SIO-1652). What is still missing is the sequenced hand-off: today the verify card (SIO-1635) is user-triggered and its verdict is rendered as data only, never remembered. The feasibility doc's Phase 3 section (`pi-fleet-gitagent-feasibility.md:151-158`) specifies the two handlers and the memory rule. The standing invariant from PR #682 and repeated in every later phase: hub replies are data, never an LLM input; memory writes are structured fields only.

## Where the bodies are buried

**The two missing handlers.** `packages/skillflow/src/resolvers.ts:23-29` and `:59-63`:

```ts
export type StepHandler = (resolved: ResolvedStep) => Promise<Record<string, string>>;

export interface StepHandlers {
	skill?: StepHandler;
	agent?: StepHandler;
	tool?: StepHandler;
	node?: StepHandler;
	graph?: StepHandler;
}
...
export class MissingHandlerError extends Error {
	constructor(public readonly kind: StepKind) {
		super(`no handler registered for "${kind}" steps`);
```

`runWorkflow(def, options)` at `packages/skillflow/src/executor.ts:179` runs topological layers with `Promise.all`; a `MissingHandlerError` rejects the whole run on purpose (caller wiring bug), a `TemplateError` is folded into a failed step result. Handler outputs are `Record<string, string>`, so the report must travel as a string.

**The registration precedent to copy.** `packages/agent/src/incident-close-workflow-handlers.ts:109-140` (`runIncidentClose`) wires `skill` and `tool` handlers inline in the `runWorkflow` call, redacts inputs with `redactPiiContent` before they leave the process, and never throws (every failure becomes a result). `resolve-identifiers-workflow-handlers.ts:165` is the second precedent. Workflow YAML is loaded once per process by `packages/agent/src/close-workflow.ts:14` via `loadWorkflows(getAgentsDir("incident-analyzer")).get("incident-close")`; mirror that for `pi-handoff`.

**The workflow template.** `agents/incident-analyzer/workflows/incident-close.yaml` (manual trigger, three steps, `${{ trigger.report }}` and `${{ steps.<name>.outputs.<x> }}` templates, `error_handling: continue` per step and `best_effort` at the top). Phase 3's YAML is two steps:

```yaml
name: pi-handoff
version: 0.1.0
triggers:
  - type: manual
steps:
  - name: analyze
    graph: true
    with:
      thread_id: ${{ trigger.thread_id }}
    outputs:
      - report
  - name: verify
    agent: aws-spoke
    depends_on:
      - analyze
    with:
      estate: ${{ trigger.estate }}
      report: ${{ steps.analyze.outputs.report }}
    outputs:
      - verdict
      - msg_id
error_handling: best_effort
```

Check `WorkflowStepSchema` in `packages/gitagent-bridge` for the exact `graph:` value form before committing to `graph: true` (`stepTarget` returns the literal `"graph"` for that kind).

**The hub client for the `agent` handler.** `packages/agent/src/action-tools/pi-coms-client.ts`: `new PiComsClient(hub, { fetchImpl?, now?, sessionId?, senderPrefix? })`, `register()`, `send(target, prompt, { responseSchema?, ttlMs? })`, `awaitReply(msgId, budgetMs)` (25 s slices with heartbeat), `deregister()`. Hub selection by estate suffix: `selectHubForEstate(estate, config)` in `pi-verifier.ts:95`; preferred target: `preferredTargetForEstate`; online check: `resolvePiTarget`. The verify path to reuse or factor out: `executePiVerify` and `runHubTask` in `pi-verifier.ts`; the verdict schema and its JSON-Schema twin: `PiVerdictSchema` and `PI_VERDICT_RESPONSE_SCHEMA` in `packages/shared/src/pi-coms-types.ts`. The ticket asks for sender prefix `pi-fleet`, which on a directory-mode hub needs the `pi-fleet` principal (SIO-1650, `PI_COMS_PANE_TOKENS` pattern); decide whether the workflow uses the analyzer principal (`incident-analyzer-*`, no new token) instead and record it.

**The `graph` handler.** The incident graph is invoked from the web app, not the agent package: `apps/web/src/lib/server/agent.ts` (`invokeAgent`, `getGraph`, thread ids as `thread_id` in the checkpointer config; `graph.getState(config)` returns `finalAnswer` in `values`). The handler either receives an `invokeGraph(threadId, prompt)` dependency from the web layer (the `ClosureDeps` idiom in `runIncidentClose`) or reads the finished turn's `finalAnswer` from the checkpoint. Prefer the dependency: the workflow runs post-turn in the background, exactly like incident close (`packages/agent/src/index.ts:61`, `runPostTurn` in `lifecycle.ts`).

**Memory writer.** `recordKeyDecision(decision: KeyDecision, baseDir?)` at `packages/agent/src/memory-writer.ts:183`; `KeyDecision` at `:44` is `{ requestId, decision, rationale?, annotations?, ttlSeconds? }`. The `decision` string is rendered into the next turn's prompt, so it must be built from enums and ids only: verdict, per-claim statuses, `msg_id`, target, timestamp. Never `summary` or `evidence`. Put the structured labels in `annotations` (SIO-959 pattern) so the Agent Memory backend can filter them.

**Optional KG write.** Same structured-only rule; additive and soft-failing like `recordRootCauseData` (`packages/agent/src/graph-knowledge.ts`).

## The fix, step by step

1. Plan file, Linear SIO-1651 to In Progress with a start comment.
2. `packages/agent/src/pi-handoff-workflow-handlers.ts`: `runPiHandoff(ctx: { threadId, estate, report? }, deps: { invokeGraph, hubDeps? })` calling `runWorkflow(loadPiHandoffWorkflow(), { trigger, handlers: { graph, agent } })`. `graph` returns `{ report }`; `agent` selects the hub for the estate, registers, sends with `PI_VERDICT_RESPONSE_SCHEMA`, awaits within `verifyTimeoutMs`, deregisters, validates with `PiVerdictSchema`, returns `{ verdict: <enum>, msg_id }`. Never throws; a hub or schema failure becomes a failed step result.
3. `agents/incident-analyzer/workflows/pi-handoff.yaml` as above; `packages/agent/src/pi-handoff-workflow.ts` loader mirroring `close-workflow.ts`.
4. `recordVerdictDecision(verdict, { estate, target, msgId, requestId })` in a small module, called from `executePiVerify` on success and from the workflow's verify step. Decision text like `pi verify eu-oit-prd: confirmed (claims: 3 confirmed, 0 contradicted, 1 unverifiable) msg 01J...`, annotations `{ kind: "pi-verify", estate, target, verdict, msg_id }`.
5. Trigger: post-turn hook next to the incident-close call in `apps/web/src/lib/server/agent.ts` (on an explicit close command when an AWS estate was assessed), plus a manual route or pane button if cheap.
6. Tests: skillflow-level test with fake handlers (order and template resolution); handler tests with a scripted hub (reuse the `hubFake` shape from `apps/web/src/lib/server/pi-fleet.test.ts` or `pi-verifier.test.ts`); memory-writer test asserting the decision line contains no `summary` text.
7. Docs: `docs/architecture/pi-coms-verification.md` (memory section), `agent-pipeline.md` if any node changes (none expected), `.env.example` if a new variable appears, feasibility tracking row.

## Verification

```bash
bun run typecheck && bun run lint
cd packages/agent && bun test --isolate
cd packages/skillflow && bun test
cd apps/web && bun run test
```

Manual, needs a hub with a registered `aws-spoke` peer: close an incident with an AWS estate assessed, watch the hub log for the send and reply, read `agents/incident-analyzer/memory/runtime/key-decisions.md` for the enum line, open the next turn and confirm the decision line renders without free text. Kill every hub or peer you start and prove the ports free.

## Files to modify

| File | Change |
|---|---|
| `packages/agent/src/pi-handoff-workflow-handlers.ts` | new: `runPiHandoff`, `graph` and `agent` handlers |
| `packages/agent/src/pi-handoff-workflow.ts` | new: loader |
| `agents/incident-analyzer/workflows/pi-handoff.yaml` | new |
| `packages/agent/src/action-tools/pi-verifier.ts` | call the verdict decision writer on success; maybe factor `runHubTask` for reuse |
| `packages/agent/src/memory-writer.ts` or a new `pi-verdict-memory.ts` | structured decision builder |
| `packages/agent/src/index.ts` | export `runPiHandoff` |
| `apps/web/src/lib/server/agent.ts` | post-turn trigger next to incident close |
| tests as listed; docs as listed |

## Workflow

Branch off main; commits `SIO-1651: ...` with the Co-Authored-By trailer; PR ready for review (never draft); Greptile skips account-wide (SIO-1642) so the gate is CI plus the user's explicit merge go-ahead; ledger row in `docs/code-review-bakeoff.md` after the merge; never set Linear Done (the PR link transitions it).

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Free text leaks into memory through `decision` or `rationale` | Medium | builder takes enums and ids only; test asserts no `summary` substring |
| `graph: true` is not the schema's spelling | Medium | read `WorkflowStepSchema` first |
| Workflow blocks the user-facing turn | Low | run post-turn in the background like incident close, best effort |
| Directory-mode hub rejects the sender prefix | High if `pi-fleet` | reuse the analyzer principal or document the token |
| Spoke offline | Medium | the send queues to the fallback inbox; the step reports `queued`, no decision is written |

## Out of scope

A Pi extension on spokes calling the Couchbase Agent Memory REST service (separate design: outbound path, per-account secret, trust decision); a third analyzer graph (2c); hub protocol changes; step 6 of the ticket unless 2c has landed.

## Related code references

`packages/agent/src/incident-close-workflow-handlers.ts:109-140` (handler wiring and never-throw contract); `packages/agent/src/close-workflow.ts:14` (workflow loading); `packages/skillflow/src/executor.ts:179` (`runWorkflow`); `packages/skillflow/src/resolvers.ts:23-63` (handler types, `MissingHandlerError`); `packages/agent/src/action-tools/pi-verifier.ts` (`executePiVerify`, `runHubTask`, `selectHubForEstate`, `estatesFromState`); `packages/agent/src/action-tools/pi-coms-client.ts` (client); `packages/shared/src/pi-coms-types.ts` (`PiVerdictSchema`, `PI_VERDICT_RESPONSE_SCHEMA`); `packages/agent/src/memory-writer.ts:44,183` (`KeyDecision`, `recordKeyDecision`); `apps/web/src/lib/server/pi-fleet.ts` (the pane's hub access, a second client-usage precedent).

## Memory references

`reference_sio1652_fleet_inbox_node`, `reference_sio1650_pi_fleet_pane`, `reference_sio1635_pi_coms_hub_client_gotchas`, `project_pi_fleet_gitagent_feasibility`, `feedback_no_cross_environment_access`, `reference_agent_memory_backend_seam`, `reference_agent_memory_session_end_and_annotations`, `reference_greptile_skips_docs_only_prs`, `feedback_never_create_linear_done`, `feedback_repo_is_public_sanitize_before_commit`, `reference_bun_test_isolate_kills_mock_module_pollution`.
