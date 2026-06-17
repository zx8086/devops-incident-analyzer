# State Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap unbounded LangGraph checkpointer growth by pruning persisted thread state after each turn, without breaking Bedrock tool-call/result pairing.

**Architecture:** A pure `state-pruning.ts` (`needsPruning` + `pruneState`) computes which message ids to drop (last-N non-system kept, system preserved, orphaned tool messages removed). A thin `pruneThreadState` in the web server reads the checkpoint via `graph.getState`, and writes back removals via `graph.updateState` with `RemoveMessage` entries + `dataSourceResults: []`. Called after the SSE stream drains.

**Tech Stack:** Bun, TypeScript (strict), `@langchain/langgraph` ^1.2.2 (`RemoveMessage`, `updateState`), `@langchain/core/messages`, `bun:test`.

Spec: `docs/superpowers/specs/2026-06-17-state-pruning-design.md`. Linear: SIO-476.

## Global Constraints

- TypeScript strict mode; never use `any` (biome `noExplicitAny: error`). Use `BaseMessage` / message subclasses from `@langchain/core/messages`.
- No `.default()` in config schemas (N/A here — `PruningConfig` is a plain interface with a `DEFAULT_PRUNING_CONFIG` constant).
- Named exports preferred. No emojis in code/commits/output.
- File header: single-line relative path comment only.
- Run `bun run typecheck`, `bun run lint`, and relevant `bun test` after changes.
- Commit format: `SIO-476: message`. Never commit without authorization (this plan's execution IS authorization).

---

### Task 1: Pure pruning function (`state-pruning.ts`)

**Files:**
- Create: `packages/agent/src/state-pruning.ts`
- Test: `packages/agent/src/state-pruning.test.ts`

**Interfaces:**
- Consumes: `BaseMessage`, `AIMessage`, `ToolMessage`, `SystemMessage` from `@langchain/core/messages`.
- Produces:
  - `interface PruningConfig { maxMessages: number; preserveSystemMessages: boolean }`
  - `const DEFAULT_PRUNING_CONFIG: PruningConfig`
  - `function needsPruning(messages: BaseMessage[], config?: PruningConfig): boolean`
  - `function pruneState(messages: BaseMessage[], config?: PruningConfig): { removeIds: string[] }`

- [ ] **Step 1: Write the failing tests**

Create `packages/agent/src/state-pruning.test.ts`:

```typescript
// agent/src/state-pruning.test.ts
import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { DEFAULT_PRUNING_CONFIG, needsPruning, pruneState } from "./state-pruning.ts";

const human = (id: string) => new HumanMessage({ id, content: `h-${id}` });

describe("needsPruning", () => {
	test("false when non-system count is at/under maxMessages", () => {
		const msgs = Array.from({ length: 20 }, (_, i) => human(`m${i}`));
		expect(needsPruning(msgs, { maxMessages: 20, preserveSystemMessages: true })).toBe(false);
	});

	test("true when non-system count exceeds maxMessages", () => {
		const msgs = Array.from({ length: 21 }, (_, i) => human(`m${i}`));
		expect(needsPruning(msgs, { maxMessages: 20, preserveSystemMessages: true })).toBe(true);
	});

	test("system messages do not count toward the threshold", () => {
		const msgs = [new SystemMessage({ id: "s", content: "sys" }), ...Array.from({ length: 20 }, (_, i) => human(`m${i}`))];
		expect(needsPruning(msgs, { maxMessages: 20, preserveSystemMessages: true })).toBe(false);
	});
});

describe("pruneState", () => {
	const cfg = { maxMessages: 3, preserveSystemMessages: true };

	test("removes oldest non-system messages beyond the window, keeps system", () => {
		const msgs = [
			new SystemMessage({ id: "sys", content: "s" }),
			human("a"),
			human("b"),
			human("c"),
			human("d"),
			human("e"),
		];
		const { removeIds } = pruneState(msgs, cfg);
		// keep last 3 non-system (c,d,e) + system; remove a,b
		expect(removeIds.sort()).toEqual(["a", "b"]);
	});

	test("drops an orphaned ToolMessage whose AIMessage tool_call fell outside the window", () => {
		// Window keeps last 3: [tool(t1), human(z), human(y)] -- the AIMessage with the
		// matching tool_call is older (removed), so the kept ToolMessage is orphaned.
		const ai = new AIMessage({ id: "ai", content: "", tool_calls: [{ id: "t1", name: "x", args: {} }] });
		const tool = new ToolMessage({ id: "tm", content: "r", tool_call_id: "t1" });
		const msgs = [human("old1"), ai, tool, human("z"), human("y")];
		const { removeIds } = pruneState(msgs, cfg);
		// keep last 3 = tool,z,y; ai is outside -> tool is orphaned -> also removed
		expect(removeIds).toContain("ai");
		expect(removeIds).toContain("old1");
		expect(removeIds).toContain("tm");
	});

	test("keeps a tool-call pair intact when both are in-window", () => {
		const ai = new AIMessage({ id: "ai", content: "", tool_calls: [{ id: "t1", name: "x", args: {} }] });
		const tool = new ToolMessage({ id: "tm", content: "r", tool_call_id: "t1" });
		const msgs = [human("old"), ai, tool];
		const { removeIds } = pruneState(msgs, { maxMessages: 3, preserveSystemMessages: true });
		expect(removeIds).toEqual([]); // 3 fit; nothing removed
	});

	test("empty / short arrays remove nothing", () => {
		expect(pruneState([], cfg).removeIds).toEqual([]);
		expect(pruneState([human("a")], cfg).removeIds).toEqual([]);
	});

	test("messages without an id are never targeted for removal", () => {
		const noId = new HumanMessage({ content: "no id" }); // no id
		const msgs = [noId, human("a"), human("b"), human("c"), human("d")];
		const { removeIds } = pruneState(msgs, cfg);
		// last 3 (b,c,d) kept; candidates a + noId; noId has no id so only "a" removable
		expect(removeIds).toEqual(["a"]);
	});

	test("DEFAULT_PRUNING_CONFIG keeps 20 non-system messages", () => {
		expect(DEFAULT_PRUNING_CONFIG).toEqual({ maxMessages: 20, preserveSystemMessages: true });
	});
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `bun test packages/agent/src/state-pruning.test.ts`
Expected: FAIL — `Cannot find module './state-pruning.ts'` (module not created yet).

- [ ] **Step 3: Implement `state-pruning.ts`**

Create `packages/agent/src/state-pruning.ts`:

```typescript
// agent/src/state-pruning.ts
//
// SIO-476: bound the LangGraph checkpointer's message array. Pure functions:
// needsPruning is a cheap gate; pruneState returns the message ids to drop
// (last-N non-system kept, system preserved, orphaned tool messages removed so
// a dangling ToolMessage never breaks Bedrock tool-call/result pairing). The
// caller turns removeIds into RemoveMessage entries for graph.updateState.

import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";

export interface PruningConfig {
	maxMessages: number;
	preserveSystemMessages: boolean;
}

export const DEFAULT_PRUNING_CONFIG: PruningConfig = {
	maxMessages: 20,
	preserveSystemMessages: true,
};

function isSystem(m: BaseMessage): boolean {
	return m instanceof SystemMessage;
}

// Non-system message count drives the threshold (system messages are always kept).
export function needsPruning(messages: BaseMessage[], config: PruningConfig = DEFAULT_PRUNING_CONFIG): boolean {
	const nonSystem = messages.filter((m) => !isSystem(m)).length;
	return nonSystem > config.maxMessages;
}

export function pruneState(
	messages: BaseMessage[],
	config: PruningConfig = DEFAULT_PRUNING_CONFIG,
): { removeIds: string[] } {
	if (!needsPruning(messages, config)) return { removeIds: [] };

	// Walk from the end keeping the last maxMessages non-system messages; everything
	// else (non-system, beyond the window) is a removal candidate. System messages
	// are kept when preserveSystemMessages.
	const keep = new Set<BaseMessage>();
	let kept = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (isSystem(m)) {
			if (config.preserveSystemMessages) keep.add(m);
			continue;
		}
		if (kept < config.maxMessages) {
			keep.add(m);
			kept++;
		}
	}

	// tool_call ids present on kept AIMessages -> a kept ToolMessage whose
	// tool_call_id is not among them is orphaned and must also be removed.
	const keptToolCallIds = new Set<string>();
	for (const m of keep) {
		if (m instanceof AIMessage) {
			for (const tc of m.tool_calls ?? []) {
				if (tc.id) keptToolCallIds.add(tc.id);
			}
		}
	}

	const removeIds: string[] = [];
	for (const m of messages) {
		const id = m.id;
		if (!id) continue; // cannot target an id-less message with RemoveMessage
		if (!keep.has(m)) {
			removeIds.push(id);
			continue;
		}
		if (m instanceof ToolMessage && !keptToolCallIds.has(m.tool_call_id)) {
			removeIds.push(id); // orphaned tool result inside the kept window
			keep.delete(m);
		}
	}
	return { removeIds };
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `bun test packages/agent/src/state-pruning.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck + lint**

Run: `bun run --filter '@devops-agent/agent' typecheck && bun run lint`
Expected: agent typecheck exits 0; lint reports no new errors in `state-pruning*.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/state-pruning.ts packages/agent/src/state-pruning.test.ts
git commit -m "SIO-476: pure state-pruning function (needsPruning + pruneState)"
```

---

### Task 2: Export the pruning API

**Files:**
- Modify: `packages/agent/src/index.ts`

**Interfaces:**
- Consumes: the exports from Task 1.
- Produces: `needsPruning`, `pruneState`, `DEFAULT_PRUNING_CONFIG`, `type PruningConfig` re-exported from `@devops-agent/agent`.

- [ ] **Step 1: Add the export**

In `packages/agent/src/index.ts`, add an export line in alphabetical position (after the line exporting `./state.ts`, before `./sub-agent.ts`):

```typescript
export { DEFAULT_PRUNING_CONFIG, needsPruning, type PruningConfig, pruneState } from "./state-pruning.ts";
```

- [ ] **Step 2: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/index.ts
git commit -m "SIO-476: export pruning API from @devops-agent/agent"
```

---

### Task 3: `pruneThreadState` wiring in the web server

**Files:**
- Modify: `apps/web/src/lib/server/agent.ts`
- Test: `apps/web/src/lib/server/agent.test.ts`

**Interfaces:**
- Consumes: `needsPruning`, `pruneState` from `@devops-agent/agent` (Task 2); `getGraph()` / `getIacGraph()` (existing in agent.ts); `RemoveMessage` from `@langchain/core/messages`; `getLogger` from `@devops-agent/observability`.
- Produces: `export async function pruneThreadState(threadId: string, agentName?: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`apps/web/src/lib/server/agent.test.ts` already mocks `@devops-agent/agent` (see its `mock.module` block). Add `needsPruning`/`pruneState` to that mock object and a graph stub exposing `getState`/`updateState`. Append this test (adapt the existing mock — do NOT create a second `mock.module`):

```typescript
// In the existing mock.module("@devops-agent/agent", () => ({ ... })) object, add:
//   needsPruning: (msgs: unknown[]) => msgs.length > 2,
//   pruneState: () => ({ removeIds: ["old1"] }),
// and make buildGraph's resolved object also expose:
//   getState: mockGetState,
//   updateState: mockUpdateState,
// where (top of file):
//   const mockUpdateState = mock(() => Promise.resolve());
//   const mockGetState = mock(() => Promise.resolve({ values: { messages: [{ id: "old1" }, { id: "a" }, { id: "b" }] } }));

import { pruneThreadState } from "./agent";

test("pruneThreadState removes ids via updateState when over threshold", async () => {
	await pruneThreadState("thread-1", "incident-analyzer");
	expect(mockUpdateState).toHaveBeenCalled();
	const [config, update] = mockUpdateState.mock.calls[0];
	expect(config).toEqual({ configurable: { thread_id: "thread-1" } });
	// messages is an array of RemoveMessage; dataSourceResults reset to []
	expect(Array.isArray((update as { messages: unknown[] }).messages)).toBe(true);
	expect((update as { dataSourceResults: unknown[] }).dataSourceResults).toEqual([]);
});

test("pruneThreadState is a no-op when under threshold", async () => {
	mockUpdateState.mockClear();
	mockGetState.mockResolvedValueOnce({ values: { messages: [{ id: "a" }] } });
	await pruneThreadState("thread-2", "incident-analyzer");
	expect(mockUpdateState).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test apps/web/src/lib/server/agent.test.ts`
Expected: FAIL — `pruneThreadState` not exported / `needsPruning` not in mock.

- [ ] **Step 3: Implement `pruneThreadState` + imports**

In `apps/web/src/lib/server/agent.ts`:

(a) Add `needsPruning, pruneState` to the existing `@devops-agent/agent` import block (alphabetical, after `installMemoryPromotion`):

```typescript
	installMemoryPromotion,
	needsPruning,
	pruneState,
	runBootstrap,
```

(b) Add a logger near the top (after the imports), since agent.ts has none yet:

```typescript
import { getLogger } from "@devops-agent/observability";
// ...
const pruneLog = getLogger("agent:state-pruning");
```

(c) Add the function (place it next to `getPendingInterrupt`, which already shows the getState-by-thread pattern):

```typescript
// SIO-476: prune the persisted checkpoint after a turn. Reads thread state,
// drops messages beyond the window (RemoveMessage honored by MessagesAnnotation;
// a shorter array would merge, not truncate), and resets dataSourceResults via
// its reducer's empty-array reset branch. Best-effort: never breaks the response.
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
		pruneLog.info({ threadId, removed: removeIds.length }, "pruned thread state");
	} catch (error) {
		pruneLog.warn({ error: error instanceof Error ? error.message : String(error) }, "state pruning failed; continuing");
	}
}
```

(d) Add the `BaseMessage` type import to the `@langchain/core/messages` type-import line:

```typescript
import type { BaseMessage, MessageContentComplex } from "@langchain/core/messages";
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test apps/web/src/lib/server/agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: typecheck exits 0 for all packages; no new lint errors in `agent.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/server/agent.ts apps/web/src/lib/server/agent.test.ts
git commit -m "SIO-476: pruneThreadState writes pruned checkpoint via updateState"
```

---

### Task 4: Call `pruneThreadState` from the SSE route

**Files:**
- Modify: `apps/web/src/routes/api/agent/stream/+server.ts`

**Interfaces:**
- Consumes: `pruneThreadState` (Task 3); existing `threadId`, `body.agentName` in scope.
- Produces: pruning runs after each completed turn (both the elastic-iac and incident-analyzer `done` paths).

- [ ] **Step 1: Import `pruneThreadState`**

In `apps/web/src/routes/api/agent/stream/+server.ts`, add `pruneThreadState` to the existing import from `$lib/server/agent` (line 8 imports `getIacTurnOutcome, getLastAssistantText, getPendingInterrupt, invokeAgent`):

```typescript
import { getIacTurnOutcome, getLastAssistantText, getPendingInterrupt, invokeAgent, pruneThreadState } from "$lib/server/agent";
```

- [ ] **Step 2: Call it before the incident-analyzer `done`**

In the non-iac path, immediately before the `send({ type: "done", … dataSourceContext })` block (the one at the end with `responseTime`), add:

```typescript
				// SIO-476: prune the checkpoint after the turn completes (best-effort).
				await pruneThreadState(threadId, body.agentName);
```

- [ ] **Step 3: Call it before the elastic-iac `done`**

In the `if (body.agentName === "elastic-iac")` branch, immediately before its `send({ type: "done", … outcome })` block, add the same line:

```typescript
					await pruneThreadState(threadId, body.agentName);
```

(Do NOT add it on the early-return interrupt paths — a paused/interrupted turn isn't complete; its state must stay intact for resume.)

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: web typecheck reports `0 ERRORS`.

- [ ] **Step 5: Run the SSE route test**

Run: `bun test apps/web/src/routes/api/agent/stream/server.test.ts`
Expected: PASS (existing tests still green; the route's `@devops-agent/agent` mock may need `pruneThreadState` — if the mock is on `$lib/server/agent` it already resolves; if it errors "pruneThreadState not found", add it to that mock as `pruneThreadState: mock(() => Promise.resolve())`).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/api/agent/stream/+server.ts
git commit -m "SIO-476: call pruneThreadState after each completed turn"
```

---

### Task 5: Full verification

- [ ] **Step 1: Typecheck + lint + targeted tests**

Run:
```bash
bun run typecheck && bun run lint
bun test packages/agent/src/state-pruning.test.ts apps/web/src/lib/server/agent.test.ts apps/web/src/routes/api/agent/stream/server.test.ts
```
Expected: typecheck 0 errors; lint no new errors (24 pre-existing `noTemplateCurlyInString` warnings + the pre-existing `iac/nodes.ts noNonNullAssertion` error are unrelated — confirm via `git stash` if unsure); tests green.

- [ ] **Step 2: Full agent suite (regression)**

Run: `bun test packages/agent/`
Expected: 0 fail.

- [ ] **Step 3: Update Linear + open PR**

Move SIO-476 to In Review; open a PR (ready for review, not draft) titled `SIO-476: checkpointer state pruning` citing the spec and the verification results.

## Self-Review

- **Spec coverage:** Task 1 = pure `pruneState`/`needsPruning` (spec §Architecture unit 1) ✅; Task 2 = export ✅; Task 3 = `pruneThreadState` + `RemoveMessage`/`updateState` + `dataSourceResults: []` (spec unit 2, "Why RemoveMessage", error handling) ✅; Task 4 = SSE wiring at `done`, skipping interrupt paths (spec data-flow) ✅; Task 5 = verification (spec §Testing) ✅. Out-of-scope items (token pruning, entities, graph node, latest-turn slice) are not implemented ✅.
- **Placeholder scan:** none — every code step has full code.
- **Type consistency:** `PruningConfig`/`DEFAULT_PRUNING_CONFIG`/`needsPruning`/`pruneState`/`pruneThreadState` names + signatures match across Tasks 1→4. `removeIds: string[]` consumed as `RemoveMessage({id})` in Task 3.
