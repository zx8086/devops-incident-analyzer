# Handover — SIO-769: fix `kafka-tool-failures` field-name bug

**Date:** 2026-05-16
**Linear:** [SIO-769](https://linear.app/siobytes/issue/SIO-769) (Todo · Medium · ~30 min · 1 point)
**Parent epic:** [SIO-764](https://linear.app/siobytes/issue/SIO-764) (Done — Phase A merged as PR #101 / commit `3268a1a`)
**Repo state:** `main` at `3268a1a` — SIO-764 Phase A merged
**Branch suggestion:** `sio-769-kafka-tool-failures-fieldname-fix`

This document is self-contained — you can pick up SIO-769 without re-reading the SIO-764 epic history.

---

## TL;DR

The `kafka-tool-failures` correlation rule helper at `packages/agent/src/correlation/rules.ts:177` reads `result.data.toolErrors[]` — a nested field path that has **never existed** in production. The actual data lives at top-level `result.toolErrors` (the `ToolError[]` array populated since SIO-725/728 via the `---STRUCTURED---` sentinel in `sub-agent.ts`).

The rule has been dormant by mistake since SIO-681 introduced it, not by design. Other rules (e.g. `kafka-tool-failures` in tests) already read the top-level field correctly. This sidecar fixes the helper, updates the rule's match `context`, and migrates the engine test.

**One known failing test** in the codebase pinpoints this:
```
bun test packages/agent/tests/correlation/engine.test.ts
# kafka-tool-failures: 1 fail (the only failure on main as of 3268a1a)
```

Fix that, and the kafka rule set is fully live.

---

## Context: how this ticket came to be

During SIO-764 brainstorming (2026-05-16), the spec-writer's exploration of dormant rules surfaced **five** rules that don't fire in production:

1. `kafka-empty-or-dead-groups` — needed structured emission (✅ SIO-764 Phase A)
2. `kafka-significant-lag` — needed structured emission (✅ SIO-764 Phase A)
3. `kafka-dlq-growth` — needs structured emission + missing MCP tool (SIO-770)
4. **`kafka-tool-failures` — does NOT need structured emission. Just reads the wrong field. ← this ticket**
5. `gitlab-deploy-vs-datastore-runtime` — needs gitlab + couchbase work (SIO-771, SIO-772)

SIO-769 was carved out because it doesn't need any of SIO-764's new infrastructure (no `extractFindings` node logic, no `kafkaFindings` schema work, no `toolOutputs[]` capture). It's a single-line helper fix plus a test migration.

---

## The bug, precisely

### Current state — `packages/agent/src/correlation/rules.ts:174-185`

```typescript
{
	name: "kafka-tool-failures",
	description: "Kafka tool failures suggest provider/instance issues to correlate with elastic-agent.",
	trigger: (state) => {
		const k = getKafkaData(state);
		if (!k.toolErrors || k.toolErrors.length === 0) return null;
		return { context: { toolErrors: k.toolErrors } };
	},
	requiredAgent: "elastic-agent",
	retry: { attempts: 1, timeoutMs: 60_000 },
},
```

The trigger calls `getKafkaData(state).toolErrors`. After SIO-764 Phase A, `getKafkaData` reads `result.kafkaFindings` (not `result.data`). The new `KafkaFindings` schema (`packages/shared/src/agent-state.ts`) does **not** define a `toolErrors` field — and even before Phase A, the old code path read `result.data.toolErrors[]`, which the sub-agent **never populated** (it only ever wrote a prose string to `result.data`).

So the rule has always returned `null` against real traffic.

### The truth: top-level `result.toolErrors` IS populated

Look at `packages/agent/src/sub-agent.ts:412-423` (post-Phase A version on main):

```typescript
return {
	dataSourceId,
	data: lastResponse ? String(lastResponse.content) : "No response from sub-agent",
	status: allToolsFailed ? "error" : "success",
	duration,
	toolOutputs,          // SIO-764: now populated
	isAlignmentRetry: isRetry,
	messageCount: response.messages.length,
	...(deploymentId && { deploymentId }),
	...(toolErrors.length > 0 && { toolErrors }),   // ← THIS is the populated field
	...(allToolsFailed && { error: `All ${toolErrors.length} tool calls failed` }),
};
```

`toolErrors` here is the top-level `DataSourceResult.toolErrors: ToolError[]` from `@devops-agent/shared` (`packages/shared/src/agent-state.ts:14-28`), with the full structured shape:

```typescript
export const ToolErrorSchema = z.object({
	toolName: z.string(),
	category: ToolErrorCategorySchema,           // "auth" | "session" | "transient" | "unknown"
	message: z.string(),
	retryable: z.boolean(),
	hostname: z.string().nullish(),              // SIO-725
	upstreamContentType: z.string().nullish(),   // SIO-729
	statusCode: z.number().int().nullish(),      // SIO-728
});
```

This is what other live rules already consume — see `getKafkaResultSignals` at `rules.ts:39-45`, which has been reading top-level `result.toolErrors` correctly since SIO-717.

---

## The fix

### Step 1: Rewrite the rule's trigger

Replace `packages/agent/src/correlation/rules.ts:174-185` with:

```typescript
{
	name: "kafka-tool-failures",
	description: "Kafka tool failures suggest provider/instance issues to correlate with elastic-agent.",
	trigger: (state) => {
		// SIO-769: read top-level result.toolErrors (populated since SIO-725/728 via
		// sub-agent.ts), not the nested result.data.toolErrors which has never existed.
		const result = state.dataSourceResults.find((r) => r.dataSourceId === "kafka");
		if (!result || result.status !== "success") return null;
		const toolErrors = result.toolErrors;
		if (!toolErrors || toolErrors.length === 0) return null;
		return { context: { toolErrors } };
	},
	requiredAgent: "elastic-agent",
	retry: { attempts: 1, timeoutMs: 60_000 },
},
```

Note: `getKafkaData` is the helper for **structured findings** (kafkaFindings.consumerGroups, etc.). Tool errors are a different concern — they live on the top-level `DataSourceResult`, not inside findings. So inline the lookup rather than adding a new field to `KafkaFindings` just for this rule.

**Alternative (consider but probably reject):** extend `getKafkaResultSignals` (which already exists at `rules.ts:39-45`) to be the single source of truth for both prose and toolErrors. But that helper is currently used by 4 other live rules and changing its signature risks regressions. Inline is safer.

### Step 2: Fix the test

The failing test is in `packages/agent/tests/correlation/engine.test.ts` around line 77-85. Today it probably looks like (verify by reading the file):

```typescript
test("fires when kafka tool errors are present", () => {
	const state = withKafkaResult(baseState(), {
		toolErrors: [{ tool: "kafka_list_topics", code: "AUTH_ERROR" }],
	});
	const decisions = evaluate(state, correlationRules);
	const rule = decisions.find((d) => d.rule.name === "kafka-tool-failures");
	expect(rule?.status).toBe("needs-invocation");
});
```

`withKafkaResult` writes to `result.data` (see `packages/agent/tests/correlation/test-helpers.ts:41-48`), not to top-level `toolErrors`. The fix needs to build a result with top-level `toolErrors[]`. Add a new helper to `test-helpers.ts`:

```typescript
import type { ToolError } from "@devops-agent/shared";

export function withKafkaToolErrors(state: AgentStateType, toolErrors: ToolError[]): AgentStateType {
	return {
		...state,
		dataSourceResults: [
			...state.dataSourceResults,
			{
				dataSourceId: "kafka",
				status: "success",
				data: "prose summary placeholder",
				duration: 100,
				toolErrors,
			} as never,
		],
	};
}
```

Then migrate the failing test to use it:

```typescript
test("fires when kafka tool errors are present", () => {
	const state = withKafkaToolErrors(baseState(), [
		{
			toolName: "kafka_list_topics",
			category: "auth",
			message: "Authentication failed",
			retryable: false,
		},
	]);
	const decisions = evaluate(state, correlationRules);
	const rule = decisions.find((d) => d.rule.name === "kafka-tool-failures");
	expect(rule?.status).toBe("needs-invocation");
	expect(rule?.match?.context.toolErrors).toHaveLength(1);
});
```

Note: the rule's `context` shape changes from `{toolErrors: [{tool, code}]}` to `{toolErrors: ToolError[]}` (the structured shape). If any consumer reads `context.toolErrors[].tool` or `.code`, those need updating to `.toolName` / `.category`. Audit with:

```bash
grep -rn 'kafka-tool-failures\|toolErrors\[\]\.tool\|toolErrors\[\]\.code' packages/agent/ apps/web/
```

---

## Verification

```bash
# Branch
git checkout main && git pull
git checkout -b sio-769-kafka-tool-failures-fieldname-fix

# After making the edits:
bun run --filter @devops-agent/agent typecheck
# Expected: Exited with code 0

bun test packages/agent/tests/correlation/engine.test.ts
# Expected: all tests pass (the kafka-tool-failures one was the sole failure on main)

bun run typecheck && bun run lint
# Expected: clean across workspace

bun run test
# Expected: full suite passes; specifically zero failures in @devops-agent/agent
```

Manual integration check (optional, but the rule is now live in production):

1. `bun run dev` and fire a Kafka query that will trigger tool failures (e.g. point `KAFKA_BROKERS` at a non-existent host briefly, or query a topic the credentialed user doesn't have ACL access to).
2. Inspect the LangSmith trace for `enforceCorrelationsAggregate` — the `kafka-tool-failures` rule should now appear with status `needs-invocation` and a `context.toolErrors[]` array.
3. Confirm the `enforceCorrelationsRouter` then dispatches a `correlationFetch` Send to elastic-agent (since `requiredAgent: "elastic-agent"`).

---

## Files to modify

| File | Change |
|---|---|
| `packages/agent/src/correlation/rules.ts:174-185` | Rewrite `kafka-tool-failures` trigger to read top-level `result.toolErrors`. |
| `packages/agent/tests/correlation/test-helpers.ts` | Add `withKafkaToolErrors` helper. |
| `packages/agent/tests/correlation/engine.test.ts` | Migrate the `kafka-tool-failures` test fixture from `withKafkaResult({toolErrors: ...})` to `withKafkaToolErrors([...])` with the structured `ToolError` shape. |

No schema additions. No graph changes. No new pipeline node.

---

## Workflow

1. Move SIO-769 to **In Progress** in Linear (per CLAUDE.md, before code lands).
2. Branch off main, make the three edits above.
3. Run the verification block.
4. Commit:
   ```bash
   git add packages/agent/src/correlation/rules.ts \
           packages/agent/tests/correlation/test-helpers.ts \
           packages/agent/tests/correlation/engine.test.ts
   git commit -m "$(cat <<'EOF'
   SIO-769: kafka-tool-failures reads top-level result.toolErrors

   The rule has been dormant since SIO-681 introduced it because the
   helper read result.data.toolErrors[] — a nested path the sub-agent
   has never populated. The top-level result.toolErrors field (populated
   since SIO-725 via the ---STRUCTURED--- sentinel) is what the rule
   should consume. Inline the lookup rather than adding a toolErrors
   slot to KafkaFindings (which is for structured findings derived from
   tool outputs, not tool failures).

   Also migrates the engine test from withKafkaResult (writes
   result.data) to a new withKafkaToolErrors helper (writes top-level
   toolErrors). Test now uses the structured ToolError shape (toolName,
   category, message, retryable) instead of the made-up {tool, code}
   shape.

   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```
5. Push and open PR. Move SIO-769 to **In Review**.
6. After merge: SIO-769 to **Done** with user approval (per CLAUDE.md).

---

## Why this stays a sidecar, not a Phase A rework

It's tempting to bundle this into a "kafka rules cleanup" PR with SIO-770. Don't:

- SIO-770 needs an MCP tool registration in `mcp-server-kafka` and an extractor extension. Different scope, different reviewers.
- SIO-769 is risk-free: one rule, one test, no new code paths.
- Phase A's PR #101 deliberately left this failing test in place and documented it so the sidecar fix is independently reviewable and revertible.

---

## Related code references

- `packages/agent/src/correlation/rules.ts:39-45` — `getKafkaResultSignals` — already correctly reads `result.toolErrors`. Pattern to mirror.
- `packages/agent/src/correlation/rules.ts:51-57` — `getAwsResultSignals` — same pattern, mirror of the kafka version for aws-agent.
- `packages/agent/src/sub-agent.ts:421` — `...(toolErrors.length > 0 && { toolErrors })` — where the field is populated.
- `packages/shared/src/agent-state.ts:14-28` — `ToolErrorSchema` definition (canonical shape).
- `packages/agent/src/correlation/rules.ts:174-185` — the broken rule being fixed.

---

## Memory references

- `reference_first_deploy_to_fresh_account_bugs` — pattern: dormant bugs surface in clusters; SIO-764 brainstorming found 5 dormant rules together.
- `feedback_handoff_docs_main_branch` — this handover doc stays in `experiments/` (gitignored), not committed.
- `reference_experiments_dir_gitignored` — same.

End of handover.
