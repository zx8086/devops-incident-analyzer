# LangSmith Compliance Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject compliance metadata from agent.yaml into every LangSmith trace via `RunnableConfig.metadata`.

**Architecture:** Call `complianceToMetadata()` from gitagent-bridge inside `invokeAgent()` and merge the result into the metadata object passed to `graph.streamEvents()`. LangChain auto-propagates `RunnableConfig.metadata` to all child nodes and sub-agents.

**Tech Stack:** TypeScript, Bun, LangGraph, gitagent-bridge (`complianceToMetadata`), `@langchain/langgraph`

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `apps/web/src/lib/server/agent.ts` | Add `complianceToMetadata` import, merge compliance metadata into `streamEvents` config |
| Create | `apps/web/src/lib/server/agent.test.ts` | Unit test verifying compliance metadata is passed to `streamEvents` |

---

### Task 1: Write failing test for compliance metadata injection

**Files:**
- Create: `apps/web/src/lib/server/agent.test.ts`

- [ ] **Step 1: Create the test file with mock setup and test case**

```typescript
// apps/web/src/lib/server/agent.test.ts
import { describe, expect, mock, test } from "bun:test";

const mockStreamEvents = mock(() => ({
	async *[Symbol.asyncIterator]() {
		// empty stream
	},
}));

mock.module("@devops-agent/agent", () => ({
	buildGraph: mock(() =>
		Promise.resolve({
			streamEvents: mockStreamEvents,
		}),
	),
	createMcpClient: mock(() => Promise.resolve()),
	getAgent: () => ({
		manifest: {
			compliance: {
				risk_tier: "medium" as const,
				supervision: {
					human_in_the_loop: "conditional" as const,
				},
				recordkeeping: {
					audit_logging: true,
					retention_period: "1y",
					immutable: true,
				},
				data_governance: {
					pii_handling: "redact" as const,
					data_classification: "internal",
				},
			},
			runtime: { max_turns: 30, timeout: 300 },
		},
		tools: [],
		subAgents: new Map(),
		knowledge: [],
	}),
}));

mock.module("@devops-agent/gitagent-bridge", () => ({
	getRecursionLimit: (maxTurns?: number) => (maxTurns ?? 30) * 2,
	complianceToMetadata: (compliance?: Record<string, unknown>) => {
		if (!compliance) return {};
		return {
			compliance_risk_tier: "medium",
			compliance_audit_logging: "true",
			compliance_retention_period: "1y",
			compliance_immutable_logs: "true",
			compliance_hitl: "conditional",
			compliance_pii_handling: "redact",
			compliance_data_classification: "internal",
		};
	},
}));

mock.module("@devops-agent/shared", () => ({
	isKillSwitchActive: () => false,
	KillSwitchError: class KillSwitchError extends Error {},
}));

mock.module("@langchain/core/messages", () => ({
	HumanMessage: class HumanMessage {
		content: string;
		constructor(content: string | { content: string }) {
			this.content = typeof content === "string" ? content : content.content;
		}
	},
}));

const { invokeAgent } = await import("./agent.ts");

describe("invokeAgent", () => {
	test("merges compliance metadata into streamEvents config", async () => {
		await invokeAgent([{ role: "user", content: "test" }], {
			threadId: "thread-1",
			metadata: {
				request_id: "req-1",
				session_id: "sess-1",
			},
		});

		expect(mockStreamEvents).toHaveBeenCalledTimes(1);

		const [, config] = mockStreamEvents.mock.calls[0] as [unknown, Record<string, unknown>];
		const metadata = config.metadata as Record<string, unknown>;

		// Compliance fields are present
		expect(metadata.compliance_risk_tier).toBe("medium");
		expect(metadata.compliance_audit_logging).toBe("true");
		expect(metadata.compliance_retention_period).toBe("1y");
		expect(metadata.compliance_immutable_logs).toBe("true");
		expect(metadata.compliance_hitl).toBe("conditional");
		expect(metadata.compliance_pii_handling).toBe("redact");
		expect(metadata.compliance_data_classification).toBe("internal");

		// Per-request fields are preserved (not overwritten)
		expect(metadata.request_id).toBe("req-1");
		expect(metadata.session_id).toBe("sess-1");
	});

	test("includes compliance metadata even without per-request metadata", async () => {
		mockStreamEvents.mockClear();

		await invokeAgent([{ role: "user", content: "test" }], {
			threadId: "thread-2",
		});

		expect(mockStreamEvents).toHaveBeenCalledTimes(1);

		const [, config] = mockStreamEvents.mock.calls[0] as [unknown, Record<string, unknown>];
		const metadata = config.metadata as Record<string, unknown>;

		expect(metadata.compliance_risk_tier).toBe("medium");
		expect(metadata.compliance_hitl).toBe("conditional");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test src/lib/server/agent.test.ts`

Expected: FAIL -- the current `invokeAgent()` uses `...(options.metadata && { metadata: options.metadata })` which does not include compliance fields. The first test will fail because `metadata.compliance_risk_tier` is `undefined`. The second test will fail because `metadata` itself is `undefined` (no `options.metadata` was passed).

---

### Task 2: Implement compliance metadata injection

**Files:**
- Modify: `apps/web/src/lib/server/agent.ts:2,109`

- [ ] **Step 3: Add `complianceToMetadata` import**

In `apps/web/src/lib/server/agent.ts`, change line 3:

```typescript
// Before:
import { getRecursionLimit } from "@devops-agent/gitagent-bridge";

// After:
import { complianceToMetadata, getRecursionLimit } from "@devops-agent/gitagent-bridge";
```

- [ ] **Step 4: Replace metadata spread with compliance merge**

In `apps/web/src/lib/server/agent.ts`, change line 109:

```typescript
// Before:
			...(options.metadata && { metadata: options.metadata }),

// After:
			metadata: {
				...complianceToMetadata(getAgent().manifest.compliance),
				...options.metadata,
			},
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && bun test src/lib/server/agent.test.ts`

Expected: PASS -- both tests green.

- [ ] **Step 6: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`

Expected: No errors.

- [ ] **Step 7: Run full test suite**

Run: `bun run test`

Expected: All tests pass, no regressions.

---

### Task 3: Commit

- [ ] **Step 8: Commit all changes**

```bash
git add apps/web/src/lib/server/agent.ts apps/web/src/lib/server/agent.test.ts
git commit -m "SIO-590: Wire compliance metadata into LangSmith traces

Call complianceToMetadata() in invokeAgent() and merge into
RunnableConfig.metadata passed to graph.streamEvents(). All graph
node traces and sub-agent invocations inherit the compliance fields
automatically via LangChain metadata propagation."
```
