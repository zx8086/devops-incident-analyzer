# State Pruning (SIO-476)

- Date: 2026-06-17
- Linear: [SIO-476](https://linear.app/siobytes/issue/SIO-476) (parent [SIO-469](https://linear.app/siobytes/issue/SIO-469), LangGraph Production Patterns, Phase 2)
- Status: Design (approved)

## Context

The LangGraph checkpointer holds a per-thread `messages` array that grows unbounded. ReAct runs 10+ tool call/response cycles per datasource, and the multi-datasource fan-out (elastic/kafka/capella/konnect/gitlab/atlassian/aws) plus per-estate AWS expansion multiplies that. A long-lived thread accumulates messages until it risks the recursion limit / token budget. No pruning exists today.

This adds bounded pruning of the persisted checkpoint after each turn. The original ticket (2026-03-13) referenced a 3-node/multi-deployment design and the stale `packages/web/` path; this spec targets the current multi-datasource architecture and the real `apps/web/` server.

## Decisions (approved)

1. **Write-back via `updateState` after the stream drains.** The graph runs through `streamEvents` and `invokeAgent` returns the stream, so there is no in-hand final state. Prune at the `done` point in the SSE route by reading `graph.getState(threadId)` and writing back with `graph.updateState(threadId, …)`. Mirrors the existing `getPendingInterrupt` getState-by-thread pattern.
2. **Protect tool pairing by dropping orphaned tool messages.** Keep the last N non-system messages, then drop any `ToolMessage` whose matching AIMessage `tool_call` id is outside the kept window (an orphaned `ToolMessage` breaks Bedrock's tool-call/result pairing).
3. **Trigger via a cheap `needsPruning` length check every turn**; only run `pruneState` when over the threshold.
4. **`dataSourceResults` reset to `[]`** each turn (hits the reducer's reset branch; the next turn repopulates from fresh fan-out).

## Architecture

```
SSE route (+server.ts): pumpEventStream(eventStream, send) -> "done"
   -> pruneThreadState(threadId, agentName)         [apps/web/src/lib/server/agent.ts]
        graph.getState({configurable:{thread_id}})  -> snapshot.values.messages
        needsPruning(messages, config) ? :           -> skip when under budget
        pruneState(messages, config)                 [packages/agent/src/state-pruning.ts, pure]
          -> { removeIds }
        graph.updateState(config, {
          messages: removeIds.map(id => new RemoveMessage({ id })),
          dataSourceResults: [],
        })
```

Two units:

### 1. Pure pruning function — `packages/agent/src/state-pruning.ts` (new)

No LangGraph/IO; fully unit-testable.

```ts
export interface PruningConfig {
  maxMessages: number;          // last-N non-system messages to keep
  preserveSystemMessages: boolean;
}
export const DEFAULT_PRUNING_CONFIG: PruningConfig = { maxMessages: 20, preserveSystemMessages: true };

export function needsPruning(messages: BaseMessage[], config?: PruningConfig): boolean;
// Returns the ids to remove from the checkpointer (caller issues RemoveMessage).
export function pruneState(messages: BaseMessage[], config?: PruningConfig): { removeIds: string[] };
```

Algorithm:
1. Partition system vs non-system messages (system always preserved when `preserveSystemMessages`).
2. Keep the last `maxMessages` non-system messages; the rest are candidate removals.
3. Build the set of AIMessage `tool_call` ids present in the kept window. Any kept `ToolMessage` whose `tool_call_id` is NOT in that set is an orphan -> also remove it (prevents a dangling tool result at the boundary).
4. Return `removeIds` = ids of (dropped-by-window) + (orphaned tool messages). Messages without an id are skipped (cannot target them with `RemoveMessage`).

`needsPruning` = non-system message count > `maxMessages` (cheap; gates the work).

### 2. Wiring — `apps/web/src/lib/server/agent.ts` (new `pruneThreadState`)

```ts
export async function pruneThreadState(threadId: string, agentName = "incident-analyzer"): Promise<void> {
  try {
    const graph = agentName === "elastic-iac" ? await getIacGraph() : await getGraph();
    const config = { configurable: { thread_id: threadId } };
    const snapshot = await graph.getState(config);
    const messages = (snapshot.values?.messages ?? []) as BaseMessage[];
    if (!needsPruning(messages)) return;
    const { removeIds } = pruneState(messages);
    if (removeIds.length === 0) return;
    const { RemoveMessage } = await import("@langchain/core/messages");
    await graph.updateState(config, {
      messages: removeIds.map((id) => new RemoveMessage({ id })),
      dataSourceResults: [],
    });
  } catch (error) {
    // Best-effort: never break the response. Mirrors the memory/lifecycle seams.
    logger.warn({ error: ... }, "state pruning failed; continuing");
  }
}
```

Called from `apps/web/src/routes/api/agent/stream/+server.ts` after `pumpEventStream` resolves and the `done` event is sent (and from the resume path if it shares the same completion point). Fire-and-forget is acceptable, but awaiting before `done` keeps the next turn's read consistent.

## Why `RemoveMessage` (key correctness insight)

`messages` uses `MessagesAnnotation`, whose reducer merges by id and supports `RemoveMessage`. Writing a *shorter array* via `updateState` would merge by id (no-op / partial), NOT truncate. Shrinking the array requires `RemoveMessage({id})` entries. `dataSourceResults` uses an append reducer with an explicit reset branch (`next.length === 0 ? [] : [...prev, ...next]`), so writing `[]` resets it.

## Error handling

Every step is best-effort and wrapped: a `getState`/`updateState` failure logs a warning and returns — pruning must never break answer delivery. Messages lacking an `id` are silently skipped (cannot be removed safely).

## Testing

`packages/agent/src/state-pruning.test.ts`:
- keeps the last N non-system messages and ALL system messages;
- drops an orphaned `ToolMessage` at the window boundary (its AIMessage tool_call fell outside);
- keeps an AIMessage tool_call + its `ToolMessage` when both are in-window;
- `needsPruning` is false at/under threshold, true over it;
- empty / short arrays -> `removeIds: []`;
- messages without ids are not included in `removeIds`.

Wiring: extend `apps/web/src/lib/server/agent.test.ts` mock for `pruneThreadState` (mock `getState` returning an over-threshold snapshot, assert `updateState` called with `RemoveMessage`s + `dataSourceResults: []`). Export `pruneThreadState` only if the test needs it; otherwise keep internal and assert via the route.

Verify: `bun run typecheck && bun run lint && bun test packages/agent` + the web agent tests.

## Files

| File | Change |
|---|---|
| `packages/agent/src/state-pruning.ts` | new — `PruningConfig`, `DEFAULT_PRUNING_CONFIG`, `needsPruning`, `pruneState` |
| `packages/agent/src/state-pruning.test.ts` | new — unit tests |
| `packages/agent/src/index.ts` | export the pruning API |
| `apps/web/src/lib/server/agent.ts` | new `pruneThreadState`; import pruning API |
| `apps/web/src/routes/api/agent/stream/+server.ts` | call `pruneThreadState` after the turn completes |

## Out of scope

- Token-based pruning (message-count only; YAGNI).
- Pruning `extractedEntities`/`previousEntities` (single-value, reducer already replaces — no growth).
- An in-graph pruning node (rejected: mutating messages mid-graph risks pairing + every edge).
- Preserving a "latest turn" slice of `dataSourceResults` (reset to `[]`; no turn marker exists to slice by).
