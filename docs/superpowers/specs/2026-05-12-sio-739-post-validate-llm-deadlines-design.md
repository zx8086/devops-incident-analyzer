# SIO-739 — Per-call LLM deadlines for post-validate nodes

## 1. Problem

On 2026-05-12 a live AgentCore smoke run (requestId `c4c0d8c9-c604-429e-accb-ce51af20ea34`) advanced through `aggregate → enforceCorrelationsAggregate → checkConfidence → validate`, logged `Validation passed`, and then produced **no further log lines for 25+ minutes**. The frontend never received a `done` event; the user had to refresh.

The 12-minute graph-level timeout (`AbortSignal.timeout(720000)` at `apps/web/src/lib/server/agent.ts:116`) did not stop the hang. Two structural reasons make this possible today:

1. `createLlm()` (`packages/agent/src/llm.ts:71`) wraps the primary `ChatBedrockConverse` with `withFallbacks()`. When the primary stalls or throws, LangChain's `RunnableWithFallbacks` swaps to the fallback model. The AbortSignal contract across that boundary is fragile — a hung HTTPS socket inside `@aws-sdk/client-bedrock-runtime` does not always surface as an AbortError on the merged config signal.
2. Neither `proposeMitigation` (`mitigation.ts:113`, `mitigation.ts:150`) nor `followUp` (`follow-up-generator.ts:91`) sets a per-call wall-clock deadline. They pass the LangGraph-supplied `RunnableConfig` through unchanged, so they have no defence in depth when the graph signal itself fails to propagate.

The handoff doc hypothesised a HITL routing bug. That hypothesis is wrong: `checkConfidence` (`confidence-gate.ts:33-46`) sets `lowConfidence: true` for telemetry but does not change routing. The path `validate → proposeMitigation → followUp → END` is taken regardless of confidence score.

## 2. Goal

Guarantee that the agent pipeline either delivers a report or fails visibly within a bounded wall-clock budget, even when an LLM call hangs.

Specifically:

- Any `llm.invoke()` in `proposeMitigation` or `followUp` returns or aborts within a per-role deadline.
- A deadline timeout in either node degrades gracefully: the validated final answer still reaches the frontend, with a `partial_failure` SSE event marking which post-validate step was skipped.
- A real graph-level abort (kill switch, 720s overall timeout, client disconnect) still aborts the whole pipeline as it does today — the new local deadline must not swallow external aborts.

## 3. Design

### 3.1 New helper: `invokeWithDeadline`

A single helper in `packages/agent/src/llm.ts` merges the graph-level signal with a per-role timeout and invokes the model. All affected callsites switch from `llm.invoke(messages, config)` to `invokeWithDeadline(llm, "<role>", messages, config)`.

```ts
// pseudocode
const localController = new AbortController();
const timer = setTimeout(() => localController.abort(), getRoleDeadlineMs(role));
const merged = AbortSignal.any([
    ...(config?.signal ? [config.signal] : []),
    localController.signal,
]);
try {
    return await llm.invoke(messages, { ...config, signal: merged });
} catch (err) {
    if (localController.signal.aborted && err instanceof Error && err.name === "AbortError") {
        throw new DeadlineExceededError(role, getRoleDeadlineMs(role));
    }
    throw err;
} finally {
    clearTimeout(timer);
}
```

The `localController.signal.aborted` check is what distinguishes a local-deadline trip from an external graph abort. If the graph signal fires first, `localController` was never aborted, so the AbortError is rethrown unchanged and the existing graph-level error path runs.

### 3.2 New error type: `DeadlineExceededError`

```ts
export class DeadlineExceededError extends Error {
    constructor(public readonly role: LlmRole, public readonly deadlineMs: number) {
        super(`LLM call for role '${role}' exceeded deadline of ${deadlineMs}ms`);
        this.name = "DeadlineExceededError";
    }
}
```

Tagged so nodes can branch on `instanceof DeadlineExceededError` cleanly without sniffing message strings.

### 3.3 Per-role deadline configuration

A module-scope map in `llm.ts`:

```ts
const ROLE_DEADLINES_MS: Record<LlmRole, number> = {
    orchestrator: 0,        // 0 = no per-call deadline (rely on graph-level signal)
    classifier: 0,
    subAgent: 0,
    aggregator: 0,
    responder: 0,
    entityExtractor: 0,
    followUp: 60_000,
    normalizer: 0,
    mitigation: 120_000,
    actionProposal: 60_000,
    runbookSelector: 0,
};

function getRoleDeadlineMs(role: LlmRole): number {
    const envKey = `AGENT_LLM_TIMEOUT_${role.toUpperCase()}_MS`;
    const raw = process.env[envKey];
    if (raw != null && raw !== "") {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
    }
    return ROLE_DEADLINES_MS[role];
}
```

A value of `0` means "do not arm a per-call timer; rely on the graph-level signal only" — keeps the helper safe to call from every role without committing the whole pipeline to local deadlines in one PR.

Env-var pattern matches the SUBAGENT_* tunables convention (memory: `reference_subagent_env_tunables.md`).

### 3.4 Soft-fail in nodes

`proposeMitigation` (`mitigation.ts`) wraps both `llm.invoke` calls. The two steps are independent today (Step 2 runs whenever `availableTools.length > 0` and `severity ∈ {critical, high}`, regardless of Step 1 outcome — see `mitigation.ts:142-181`); SIO-739 preserves that independence.

- Step 1 (mitigation steps) on `DeadlineExceededError`: leave `mitigationSteps` at its zero value `{ investigate: [], monitor: [], escalate: [], relatedRunbooks: [] }` and append `{ node: "proposeMitigation", reason: "timeout" }` to `partialFailures`. Step 2 still runs if its existing guards pass.
- Step 2 (action proposals) on `DeadlineExceededError`: leave `pendingActions` empty and append `{ node: "proposeMitigation.actionProposal", reason: "timeout" }` to `partialFailures`. Step 1 results survive.
- If both steps time out, two `partialFailures` entries appear; the SSE handler's `${node}:${reason}` de-dup key prevents duplicate events but keeps the two distinct entries because their `node` differs.

`generateSuggestions` (`follow-up-generator.ts`) wraps its single `llm.invoke`. On `DeadlineExceededError`:

- Return `generateFallbackSuggestions(toolsUsed)` (existing fallback already covers this shape) and append to `partialFailures`.

Other LLM errors (parse failures, fallback-cascade exhaustion) continue to log-and-degrade as today; they do not appear in `partialFailures` — that array is reserved for timeout-driven soft failures so the frontend signal is unambiguous.

### 3.5 New state field: `partialFailures`

Added to `packages/agent/src/state.ts`:

```ts
partialFailures: Annotation<Array<{ node: string; reason: string }>>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
}),
```

Append-only, matching the `dataSourceResults` reducer shape already in the state graph. The SSE handler de-dupes by `${node}:${reason}` if a node fires twice in the same run.

### 3.6 SSE handler — new event type

`apps/web/src/routes/api/agent/stream/+server.ts` adds emission inside the existing `on_chain_end` branch for `proposeMitigation` and `followUp`:

```ts
const partialFailures = event.data?.output?.partialFailures;
if (Array.isArray(partialFailures)) {
    for (const failure of partialFailures) {
        const key = `${failure.node}:${failure.reason}`;
        if (!emittedFailures.has(key)) {
            emittedFailures.add(key);
            send({ type: "partial_failure", node: failure.node, reason: failure.reason });
        }
    }
}
```

`emittedFailures` is a `Set<string>` instantiated alongside the existing `nodeStartTimes` map at line 98. No frontend UI changes are required in this PR — the new event is additive and the existing client ignores unknown event types.

### 3.7 What this design does NOT change

- Graph-level `AbortSignal.timeout(720000)` stays as the outer safety net.
- `RunnableWithFallbacks` cascade stays — we are not removing the fallback model.
- No new dependencies.
- No change to streaming paths (`aggregator`, `responder`) — they call `.stream()`/`.streamEvents()` and emit via SSE; their abort semantics are different and out of scope for SIO-739.
- No env-tunability for non-affected roles (their deadline stays `0`).

## 4. Tests

Three pure-unit test files under `packages/agent/src/`. All use Bun's built-in mock APIs (`import { mock } from "bun:test"`) plus `Bun.sleep` for controllable delays. Total wall clock per file < 1s.

### 4.1 `llm.invoke-with-deadline.test.ts`

Construct a fake `ChatBedrockConverse`-shaped object exposing only `invoke`. Pass it directly to `invokeWithDeadline` (no need to go through `createLlm`).

Cases:
1. **Resolves before deadline** — fake `invoke` returns after 10ms with deadline 100ms. Helper returns the response. Cleanup timer cleared.
2. **Rejects before deadline** — fake `invoke` rejects with a generic Error. Helper rethrows that error unchanged. `DeadlineExceededError` is NOT thrown.
3. **Hangs past deadline** — fake `invoke` awaits a never-settling promise. Deadline 50ms. Helper throws `DeadlineExceededError` with `role` and `deadlineMs` matching the call.
4. **External signal aborts first** — external `AbortController` aborts at 20ms; deadline is 200ms. Helper rethrows the AbortError unchanged (NOT `DeadlineExceededError`), so the graph-level abort path is unaffected.
5. **Deadline 0 means no local timer** — `ROLE_DEADLINES_MS.classifier = 0`; helper does not arm a timer. Confirmed by spying on `setTimeout` (or by running the hang case and asserting the helper waits past what would have been the default deadline).
6. **Env override is honoured** — set `process.env.AGENT_LLM_TIMEOUT_MITIGATION_MS = "30"`, invoke with role `mitigation`, assert deadline trips at ~30ms.

### 4.2 `mitigation.deadline.test.ts`

Mock `createLlm` from `./llm.ts` to return a fake llm whose `invoke` hangs. Invoke `proposeMitigation` with a state containing a long enough `finalAnswer` to trigger the LLM path. Assertions:

- `mitigationSteps` is the empty zero value.
- `pendingActions` is `[]`.
- `partialFailures` includes `{ node: "proposeMitigation", reason: "timeout" }`.
- Total test wall clock < 500ms (deadline mocked to ~50ms via env var).

Second case: Step 1 succeeds, Step 2 hangs. Assert Step 1 results survive and only Step 2 contributes a partialFailures entry.

### 4.3 `follow-up-generator.deadline.test.ts`

Same shape: mock `createLlm` to return a hanging llm. Invoke `generateSuggestions` with a state containing a long enough `finalAnswer`. Assert:

- `suggestions` equals `generateFallbackSuggestions(toolsUsed)`.
- `partialFailures` includes `{ node: "followUp", reason: "timeout" }`.

## 5. Acceptance criteria

- After `validate` passes, the pipeline always reaches `END` within `max(graphTimeout, mitigationDeadline + actionProposalDeadline + followUpDeadline + small overhead)`. With defaults that ceiling is ~240s vs the current unbounded hang.
- A `proposeMitigation` Step 1 LLM hang produces (a) a `partial_failure` SSE event with `node: "proposeMitigation"`, (b) `mitigationSteps` empty, (c) the full validated answer still streams to the user via the aggregator's chat-model stream events.
- A `proposeMitigation` Step 2 LLM hang produces a `partial_failure` SSE event with `node: "proposeMitigation.actionProposal"` and `pendingActions` empty; Step 1 results, if present, survive.
- A `followUp` LLM hang produces (a) a `partial_failure` SSE event with `node: "followUp"`, (b) fallback template suggestions.
- A graph-level abort (kill switch, 720s graph timeout, client disconnect) still aborts the whole run — `invokeWithDeadline` does NOT convert external aborts into `DeadlineExceededError`.
- `bun run typecheck`, `bun run lint`, and `bun test --filter @devops-agent/agent` pass.
- Smoke verification: set `AGENT_LLM_TIMEOUT_MITIGATION_MS=2000`, run a real prompt, confirm in DevTools Network the SSE stream contains `partial_failure` then `done`, and the final report is rendered.

## 6. Out of scope

- Frontend UI for the `partial_failure` event. The new event type is wired through the server; UX surface (toast, badge, etc.) is a follow-up if/when product wants it.
- Per-call deadlines for streaming roles (`aggregator`, `responder`). Their abort semantics differ; SIO-739 is bounded to the post-validate non-streaming nodes that are demonstrably hanging today.
- Per-call deadlines for `orchestrator`, `classifier`, `subAgent`, `entityExtractor`, `normalizer`, `runbookSelector`. They keep `ROLE_DEADLINES_MS = 0` and rely on the graph-level signal. If a future hang report incriminates any of them, flipping a single map entry is the entire fix.
- Removing `withFallbacks()` from `createLlm`. The fallback cascade is a separate reliability story.
- SIO-738 (Kafka sub-agent filter excludes `restproxy_*` / `connect_*` REST tools). Handled separately.
