# pi-fleet Phase 3 Implementation Plan (SIO-1651): skillflow graph and agent handlers, structured verdicts into live memory

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the incident analyzer and a pi-coms spoke after each other as a deterministic skillflow workflow, and let the spoke's verdict reach the analyzer's live memory as structured fields only. Register the two step handlers that have never had a production wiring (`graph`, `agent`), chain them in `pi-handoff.yaml`, fire the workflow post-turn on an incident close that assessed an AWS estate, and write the verdict as a key decision built from enums and ids.

**Architecture:** `runPiHandoff` mirrors `runIncidentClose` exactly: a detached post-turn background run, never throwing, every failure folded into a soft result. The `graph` step READS the completed turn rather than re-invoking the pipeline (see Context) and the `agent` step reuses the existing hub path (`runHubTask`, exported for this) so verify has one implementation, not two. The verdict writer is a pure builder plus a thin `recordKeyDecision` call, shared by the SIO-1635 card path and the workflow path so both remember a verdict identically.

**Tech Stack:** Bun, TypeScript strict, Zod 4, skillflow executor (`@devops-agent/skillflow`), Bun test (`--isolate` for `packages/agent`).

**Spec:** Linear SIO-1651; handover `experiments/HANDOFF-2026-09-06-SIO-1651-pi-fleet-phase-3.md`; `docs/architecture/pi-fleet-gitagent-feasibility.md` Phase 3 section.

## Context (verified 2026-09-06 against the code, not the handover)

- `graph: z.literal(true).optional()` (`packages/gitagent-bridge/src/workflow.ts:21`). The handover's `graph: true` spelling is correct; its flagged "wrong spelling" risk is retired.
- `WorkflowSchema` requires `description` as NON-optional (`workflow.ts:67`). The handover's YAML template omits it and would fail to load; every step in `incident-close.yaml` also carries a step-level `description`. The YAML below adds both.
- **The `graph` step reads the completed turn; it does NOT re-invoke the pipeline.** `classify` snapshots the prior report into `closingReport` before this turn's responder overwrites `finalAnswer` (`classifier.ts:189-197`, `state.ts:520`), for the stated SIO-1357 reason that closing an incident must not re-run a multi-minute investigation. Re-invoking would be a second full 7-agent fan-out to reproduce a report that already exists. Decision recorded on SIO-1651; the handover's step 2 (`invokeGraph`) is superseded.
- `awsTargetEstates` survives the close turn: `turnReset` (`classifier.ts:98-107`) does not clear it, its reducer is `(_, next) => next ?? []`, and the close command routes to the SIMPLE path so `awsEstateRouter` never runs to overwrite it. So the estate and the report both come from the same post-turn snapshot, and `getPiHandoffRequest` is one `graph.getState` call, exactly like `getClosureRequest`.
- Read state BEFORE `pruneThreadState` — pruning writes `dataSourceResults: []` (`apps/web/src/lib/server/agent.ts:450`), which `estatesFromState` falls back to when `awsTargetEstates` is empty.
- `senderPrefix` defaults to `PI_COMS_SENDER_NAME_PREFIX` = `"incident-analyzer"` (`pi-coms-client.ts:183,226`) and `runHubTask` never overrides it. The workflow reuses the analyzer principal: no `pi-fleet` principal, no new token, no directory-mode rejection. The handover's one "High" risk is retired.
- `runHubTask` (`pi-verifier.ts:305`) already does register / list / resolve target / send / await / deregister with the queued-vs-reply distinction, and returns a `HubOutcome` union instead of throwing. It is currently module-private; export it rather than writing a second hub path.
- `MissingHandlerError` is deliberately NOT caught by the executor (`executor.ts:79-82`) and rejects the whole run. Both handlers must be registered on every `runWorkflow` call in this feature, including tests that exercise only one step.
- Handler outputs are `Record<string, string>` (`resolvers.ts:23`), so the verdict crosses the step boundary as its enum string plus ids, never as an object.
- `recordKeyDecision` (`memory-writer.ts:183`) renders `decision` into `key-decisions.md` AND forwards it to the agent-memory backend as a durable fact. The structured-only rule therefore applies to both paths; `annotations` is `AnnotationMap = Record<string, string>` (`packages/shared/src/agent-memory.ts:50`).
- `PiVerdictSchema` carries free text in `summary`, `claims[].evidence` and `additional_observations` (`pi-coms-types.ts:18-30`). Only `verdict`, `claims[].status`, `target`, `estate` and `msg_id` may reach memory.
- The post-turn trigger site is `apps/web/src/routes/api/agent/stream/+server.ts:245-272`: gate, read state, prune, `runPostTurn`, then a detached `void ...then().catch()`. The pi-handoff trigger goes next to it and follows the same shape.

## Global Constraints

- Bun, TypeScript strict, never `any`, Zod, no `.default()` in config schemas, Biome, named exports. Env read at call time, never at module scope.
- No emojis, no em dashes.
- Public repo: no account ids, hostnames or tokens in commits. Test fixtures use `111122223333`-style synthetic ids.
- Hub replies are DATA, never an LLM input (standing invariant since PR #682). Memory writes are structured fields only.
- No cross-environment access: the estate's own hub, chosen by suffix via `selectHubForEstate`.
- Nothing on this path may affect the user-facing turn: detached, best-effort, never throws.
- Commit format `SIO-1651: message` with the Co-Authored-By trailer; PR ready for review; merge on explicit go-ahead; ledger row in `docs/code-review-bakeoff.md` after.
- Tests: `bun run typecheck && bun run lint`; `cd packages/agent && bun test --isolate`; `cd packages/skillflow && bun test`; `cd apps/web && bun run test`.

## File structure

```
agents/incident-analyzer/workflows/pi-handoff.yaml          new: analyze (graph) -> verify (agent)
packages/agent/src/pi-handoff-workflow.ts                   new: cached loader, mirrors close-workflow.ts
packages/agent/src/pi-handoff-workflow-handlers.ts          new: runPiHandoff, graph + agent handlers, production deps
packages/agent/src/pi-handoff-workflow-handlers.test.ts     new: scripted hub, handler wiring, never-throws
packages/agent/src/pi-verdict-memory.ts                     new: pure decision builder + recordVerdictDecision
packages/agent/src/pi-verdict-memory.test.ts                new: no free text reaches the decision line
packages/agent/src/action-tools/pi-verifier.ts              export runHubTask; write the verdict decision on success
packages/agent/src/index.ts                                 export runPiHandoffForClosingTurn, isPiHandoffEnabled
apps/web/src/lib/server/agent.ts                            getPiHandoffRequest (state read, before pruning)
apps/web/src/routes/api/agent/stream/+server.ts             detached post-turn trigger next to incident close
packages/skillflow/src/executor.test.ts                     graph-then-agent ordering with fake handlers
.env.example                                                PI_HANDOFF_ENABLED
docs/architecture/pi-coms-verification.md                   memory section; feasibility tracking row; handover status
```

### Task 1: Workflow YAML and loader

- [ ] `agents/incident-analyzer/workflows/pi-handoff.yaml` (note `description` at both levels; `graph: true` is the literal the schema requires):

```yaml
name: pi-handoff
version: 0.1.0
description: >
  SIO-1651: sequenced analyzer-to-spoke hand-off. Runs POST-TURN in the
  background after an incident close that assessed an AWS estate. The analyze
  step READS the completed turn's report (it does not re-run the pipeline);
  the verify step sends it to that estate's pi-coms spoke and returns a
  structured verdict. Best-effort: nothing here may affect the turn that
  already answered.

triggers:
  - type: manual

steps:
  - name: analyze
    graph: true
    description: Read the completed investigation report for this thread
    with:
      thread_id: ${{ trigger.thread_id }}
    outputs:
      - report

  - name: verify
    agent: aws-spoke
    description: Ask the estate's pi spoke to verify the report's claims
    depends_on:
      - analyze
    with:
      estate: ${{ trigger.estate }}
      report: ${{ steps.analyze.outputs.report }}
    outputs:
      - verdict
      - msg_id
    error_handling: continue

error_handling: best_effort
```

- [ ] `packages/agent/src/pi-handoff-workflow.ts`: `loadPiHandoffWorkflow()`, cached module-level, mirroring `close-workflow.ts:14` verbatim with `"pi-handoff"`.

### Task 2: Export the hub seam

- [ ] In `pi-verifier.ts`, change `async function runHubTask` to `export async function runHubTask` and export the `HubOutcome` type. No behavior change; the `agent` handler calls it so verify has exactly one hub implementation.

### Task 3: Verdict memory writer

- [ ] `packages/agent/src/pi-verdict-memory.ts`. Pure builder + thin writer:

```ts
export interface VerdictDecisionInput {
  estate: string;
  target: string;
  msgId: string;
  requestId: string;
  verdict: PiVerdict;
}

// Enums, counts and ids only. NEVER verdict.summary, claims[].evidence or
// additional_observations -- `decision` is rendered into the next turn's
// prompt and into the agent-memory durable fact.
export function buildVerdictDecision(input: VerdictDecisionInput): KeyDecision;
export function recordVerdictDecision(input: VerdictDecisionInput): void;
```

- Decision text: `pi verify <estate>: <verdict> (claims: N confirmed, N contradicted, N unverifiable) target <target> msg <msgId>`. Counts come from `claims[].status` tallies, so the only strings interpolated are the estate, the target, the msg id and enum members.
- `annotations`: `{ kind: "pi-verify", estate, target, verdict, msg_id, claims_confirmed, claims_contradicted, claims_unverifiable }` (all values stringified; `AnnotationMap` is `Record<string, string>`).
- No `rationale` (it is redacted-but-rendered free text; nothing structured needs it).
- `recordVerdictDecision` wraps `recordKeyDecision` in try/catch and logs on failure: a memory write must never fail a verify.

### Task 4: The two handlers

- [ ] `packages/agent/src/pi-handoff-workflow-handlers.ts`:

```ts
export interface PiHandoffContext { threadId: string; estate: string; requestId: string }
export interface PiHandoffDeps {
  readCompletedReport: (threadId: string) => Promise<string>;  // injected by the web layer
  verifierDeps?: PiVerifierDeps;                                // fetchImpl/now/env for tests
}
export type PiHandoffResult =
  | { status: "verdict"; verdict: PiVerdict["verdict"]; target: string; msgId: string }
  | { status: "queued"; target: string; msgId: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export async function runPiHandoff(ctx, deps): Promise<PiHandoffResult>
```

- `graph` handler: `{ report: await deps.readCompletedReport(ctx.threadId) }`. Throws if the report is empty (the executor folds it into a failed step, and `best_effort` keeps the run's shape).
- `agent` handler: rejects any `resolved.target` other than `aws-spoke` (unbound-target guard, mirroring the `memory-pr` tool guard at `incident-close-workflow-handlers.ts:137`); resolves config via `resolvePiComsConfig`; calls `runHubTask` with `PI_VERDICT_RESPONSE_SCHEMA` and `config.verifyTimeoutMs`; on `queued` returns `{ verdict: "", msg_id }` so the step still satisfies its declared outputs; on `reply` parses with `PiVerdictSchema`, calls `recordVerdictDecision`, and returns `{ verdict: <enum>, msg_id }`.
- Report redaction: `redactPiiContent` before the report leaves the process, as `runIncidentClose` does. `buildVerifyPrompt` is reused so the prompt is identical to the card path.
- `runPiHandoff` never throws: it reads the `verify` step result and maps it to `PiHandoffResult`.
- `isPiHandoffEnabled(env)`: `PI_HANDOFF_ENABLED` is `"true"`/`"1"`, default OFF (the `CLOSURE_LEARNING_ENABLED` idiom, flipped after live verification).
- `runPiHandoffForClosingTurn(ctx)`: production deps plus its own top-level try/catch, mirroring `runIncidentCloseForClosingTurn:190`.

### Task 5: Card path writes the same decision

- [ ] In `executePiVerify`, after a successful `PiVerdictSchema` parse, call `recordVerdictDecision`. The card path and the workflow path then remember a verdict identically. Guarded by the same try/catch inside `recordVerdictDecision`, so a memory failure cannot change the card's outcome.

### Task 6: Post-turn trigger

- [ ] `apps/web/src/lib/server/agent.ts`: `getPiHandoffRequest(threadId)` returning `{ threadId, estate, requestId } | null` — one `graph.getState` call reading `closeIncidentRequested`, `closingReport` (non-empty) and `estatesFromState`; returns the FIRST estate (one hand-off per close; multi-estate fan-out is out of scope). Best-effort try/catch returning `null`, mirroring `getClosureRequest:617`.
- [ ] `apps/web/src/routes/api/agent/stream/+server.ts`: alongside the existing closure block, gate on `isPiHandoffEnabled()`, read the request BEFORE `pruneThreadState`, and fire `void runPiHandoffForClosingTurn(...).then(log).catch(log)` detached after `runPostTurn`.
- [ ] `packages/agent/src/index.ts`: export `runPiHandoffForClosingTurn`, `isPiHandoffEnabled`, `runPiHandoff`.

### Task 7: Tests

- [ ] `packages/skillflow/src/executor.test.ts`: a two-step `graph` -> `agent` workflow with fake handlers asserting (a) execution order, (b) `${{ steps.analyze.outputs.report }}` resolves into the agent step's inputs, (c) omitting the `graph` handler rejects with `MissingHandlerError`.
- [ ] `packages/agent/src/pi-handoff-workflow-handlers.test.ts` with a scripted `fetchImpl` (the `pi-verifier.test.ts` hub fake shape): happy path returns the verdict enum and writes one decision; offline spoke returns `queued` and writes NO decision; schema-mismatch reply returns `failed` and writes no decision; an empty report fails the analyze step without throwing; `runPiHandoff` never rejects.
- [ ] `packages/agent/src/pi-verdict-memory.test.ts`: the decision line contains the verdict enum, the counts and the msg id, and does NOT contain the fixture's `summary`, `evidence` or `additional_observations` text (assert on the distinctive fixture substrings).
- [ ] `apps/web` stream-route test: the trigger fires only when the gate is on and the state says close-with-estate, and a rejecting hand-off never breaks the response (the existing closure tests at `server.test.ts:814-880` are the template).

### Task 8: Docs

- [ ] `docs/architecture/pi-coms-verification.md`: a memory section (what is written, the structured-only rule, both call paths).
- [ ] `.env.example`: `PI_HANDOFF_ENABLED`.
- [ ] `docs/architecture/pi-fleet-gitagent-feasibility.md`: Phase 3 tracking row.
- [ ] `experiments/HANDOFF-2026-09-06-pi-fleet-program.md`: status line.
- [ ] No `agent-pipeline.md` change: no graph node is added or moved (node count stays 32).

## Out of scope

Multi-estate fan-out on close (first estate only); a Pi extension on spokes writing to Agent Memory directly; the optional KG write (additive, deferrable, and the memory write already carries the structured facts); hub protocol changes; a manual pane button for the hand-off; step 6 of the ticket unless 2c has landed.
