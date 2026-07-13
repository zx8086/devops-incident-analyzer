# Elastic discover -> broad -> use Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the elastic sub-agent find a service's error data in one broad query (discover names + index families, then one `multi_match` phrase search across candidate fields wide by default), instead of pinning to `logs-apm.error-*`/`error.exception.message`/incident-window and thrashing when that pin is empty.

**Architecture:** Three layers change in lockstep so the agent is never given a narrow pin: (1) the SOUL procedure, (2) the per-turn focus-block guidance injected into the prompt, (3) the loop guard that compensated for narrow-query thrash. The MCP search tool and the resolveIdentifiers probe are unchanged. All three prompt-side changes point the agent at `logs-*,logs-apm.*` with a `multi_match` over `[message, error.exception.message, body.text]` and a `now-30d` default window; the loop guard is stripped to exact-duplicate detection + a hard call-count backstop.

**Tech Stack:** Bun, TypeScript (strict, no `any`), Biome, `bun test`. LangGraph ReAct sub-agents. Elasticsearch MCP on `:9080` (deployment `eu-b2b`) for live verification.

## Global Constraints

- Runtime: Bun. Use `bun test`, `bun run typecheck`, `bun run lint` (never jest/node).
- TypeScript strict; `noExplicitAny: "error"`. No `: any`, `as any`, `Record<string, any>`.
- No emojis in code, comments, logs, commit messages, or output.
- Commit format: `SIO-1090: <message>`. Never commit without the slash-command/authorization already given (it is given for this plan).
- Named exports preferred. Ticket references (`SIO-1090`) kept in comments; business-logic "why" comments kept.
- Branch: `claude/afs-season-code-data-gap-9b5ded` (already checked out in this worktree). Never push to main.
- Live verification deployment is `eu-b2b`; the MCP server is on `http://localhost:9080/mcp` and requires header `x-elastic-deployment: eu-b2b` and `Accept: application/json, text/event-stream`.
- The exact broad query shape (validated live 2026-07-13, returns 10,000+ hits, top hit `service.name: prana-order-service`):
  ```json
  { "index": "logs-*,logs-apm.*", "size": 5, "track_total_hits": true,
    "query": { "bool": {
      "must": [ { "multi_match": { "query": "<cited-error>", "type": "phrase",
          "fields": [ "message", "error.exception.message", "body.text" ] } } ],
      "filter": [ { "terms": { "service.name": [ "<name>", "..." ] } },
        { "range": { "@timestamp": { "gte": "now-30d" } } } ] } },
    "sort": [ { "@timestamp": "desc" } ] }
  ```

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `packages/agent/src/sub-agent-loop-guard.ts` | ONLY: exact-duplicate stop (`seenSignatures`) + hard `MAX_UNPRODUCTIVE_SEARCHES` backstop + never-stop-a-discovery-agg + AWS start_query guard (untouched). All widen/latch/post-discovery/discovery-gating state removed. |
| `packages/agent/src/sub-agent-loop-guard.test.ts` | Tests for the reduced surface only. Latch/widen/post-discovery/discovery-aware-soft-stop tests deleted. |
| `packages/agent/src/sub-agent-focus-block.ts` | Elastic resolved-identifiers block emits broad-field guidance (search `message`/`error.exception.message`/`body.text` across `logs-*,logs-apm.*`, wide default window). Resolved-name injection kept. |
| `packages/agent/src/sub-agent-focus-block.test.ts` | Elastic-block assertions updated to the broad guidance. |
| `agents/incident-analyzer/agents/elastic-agent/SOUL.md` | Named-service search procedure replaced with discover -> broad -> use. Cluster/node/connectivity/healthy-state sections unchanged. |

Ordering rationale: loop guard first (it has the widest blast radius and its tests are self-contained), then the focus block (prompt guidance), then the SOUL (prose), then an end-to-end live verification task. Each task ends green on `bun test` for its package.

---

### Task 1: Strip the loop guard to duplicate-stop + hard cap

**Files:**
- Modify: `packages/agent/src/sub-agent-loop-guard.ts`
- Test: `packages/agent/src/sub-agent-loop-guard.test.ts` (rewrite the elastic sections; keep AWS + duplicate sections)

**Interfaces:**
- Consumes: called from `sub-agent-instrumentation.ts:102,120,128,150` via `shouldShortCircuit(state, toolName, signature, arg)`, `reserveSignature(state, toolName, signature)`, `recordResult(state, toolName, signature, content, arg)`, `stopMessageFor(toolName, state)`, `createLoopGuardState()`, `isGuardedTool`, `isObservedTool`, `toolCallSignature`. These SIGNATURES MUST NOT CHANGE (the call site is out of scope).
- Produces: same exported function names with unchanged signatures; `LoopGuardState` loses fields (`bestResult`, `timeWindowWidened`, `widenRetryAllowed`, `postDiscoveryRequeryAllowed`, `discoveryRan`, `consecutiveEmpty`). Removed exports: `LOOP_GUARD_WIDEN_WINDOW_MESSAGE`, `LOOP_GUARD_LATCHED_STOP_LEAD`, `latchedStopMessage`, `BestResult`, `hasTimeWindow`, `serviceNameFilter`, `extractHitCount`, `windowLabel`.

- [ ] **Step 1: Write the failing tests for the reduced surface**

Replace the elastic-specific describe blocks in `packages/agent/src/sub-agent-loop-guard.test.ts` (the SIO-1084 A1 "discovery-aware", SIO-1086 C/D "post-discovery"/"latch", SIO-1089 "widen"/"latch" blocks) with the block below. KEEP the existing `SIO-1029 loop guard result classification`, `SIO-1084 A0 signature`, `SIO-1084 A2 aws_logs_start_query guard`, and `non-guarded tools` describe blocks verbatim (they test surface that survives).

```typescript
describe("SIO-1090: elastic guard = duplicate-stop + hard cap only", () => {
	const NON_DISCOVERY = { index: "logs-*,logs-apm.*", query: { match_phrase: { message: "x" } } };
	const DISCOVERY_ARGS = {
		index: "logs-*,logs-apm.*",
		size: 0,
		aggs: { by_service: { terms: { field: "service.name" } } },
	};
	const EMPTY = "Total results: 0, showing 0 from position 0";

	test("exact-duplicate non-discovery call is short-circuited", () => {
		const state = createLoopGuardState();
		const sig = toolCallSignature("elasticsearch_search", NON_DISCOVERY);
		recordResult(state, "elasticsearch_search", sig, EMPTY, NON_DISCOVERY);
		expect(shouldShortCircuit(state, "elasticsearch_search", sig, NON_DISCOVERY)).toBe(true);
	});

	test("distinct empties do NOT stop before the hard cap", () => {
		const state = createLoopGuardState();
		// Two distinct empty searches: below MAX_UNPRODUCTIVE_SEARCHES (5), keep going.
		for (let i = 0; i < 2; i++) {
			const args = { ...NON_DISCOVERY, query: { match_phrase: { message: `x${i}` } } };
			const sig = toolCallSignature("elasticsearch_search", args);
			expect(shouldShortCircuit(state, "elasticsearch_search", sig, args)).toBe(false);
			recordResult(state, "elasticsearch_search", sig, EMPTY, args);
		}
	});

	test("hard cap terminates a distinct-arg permuter within MAX_UNPRODUCTIVE_SEARCHES calls", () => {
		const state = createLoopGuardState();
		let stoppedAt = -1;
		for (let i = 0; i < 12; i++) {
			const args = { ...NON_DISCOVERY, query: { match_phrase: { message: `perm${i}` } } };
			const sig = toolCallSignature("elasticsearch_search", args);
			if (shouldShortCircuit(state, "elasticsearch_search", sig, args)) {
				stoppedAt = i;
				break;
			}
			recordResult(state, "elasticsearch_search", sig, EMPTY, args);
		}
		expect(stoppedAt).toBeGreaterThan(0);
		expect(stoppedAt).toBeLessThanOrEqual(5);
	});

	test("a single discovery agg is never short-circuited below the hard cap", () => {
		const state = createLoopGuardState();
		const sig = toolCallSignature("elasticsearch_search", DISCOVERY_ARGS);
		expect(shouldShortCircuit(state, "elasticsearch_search", sig, DISCOVERY_ARGS)).toBe(false);
	});

	test("a repeated identical discovery agg IS short-circuited (duplicate protection)", () => {
		const state = createLoopGuardState();
		const sig = toolCallSignature("elasticsearch_search", DISCOVERY_ARGS);
		recordResult(state, "elasticsearch_search", sig, EMPTY, DISCOVERY_ARGS);
		expect(shouldShortCircuit(state, "elasticsearch_search", sig, DISCOVERY_ARGS)).toBe(true);
	});

	test("stopMessageFor(elasticsearch_search) returns the single stop message", () => {
		expect(stopMessageFor("elasticsearch_search")).toBe(LOOP_GUARD_STOP_MESSAGE);
	});
});
```

Also remove, from the top-of-file imports in the test, any now-deleted symbols (`LOOP_GUARD_WIDEN_WINDOW_MESSAGE`, `LOOP_GUARD_LATCHED_STOP_LEAD`, `latchedStopMessage`, `hasTimeWindow`, `serviceNameFilter`, `extractHitCount`, `windowLabel`, `BestResult`). Keep `createLoopGuardState`, `shouldShortCircuit`, `recordResult`, `reserveSignature`, `toolCallSignature`, `stopMessageFor`, `isGuardedTool`, `isObservedTool`, `isUnproductiveResult`, `isDiscoveryCall`, `awsErrorKind`, `unwrapCallArgs`, `LOOP_GUARD_STOP_MESSAGE`, `AWS_START_QUERY_STOP_MESSAGE`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/agent/src/sub-agent-loop-guard.test.ts`
Expected: FAIL — compile errors on removed imports and `shouldShortCircuit` still applying the discovery-aware soft stop / widen grant.

- [ ] **Step 3: Rewrite `sub-agent-loop-guard.ts` to the reduced surface**

Replace the file's elastic-guard state and logic. The full new file:

```typescript
// packages/agent/src/sub-agent-loop-guard.ts

import { describeToolResult } from "./sub-agent-tool-result-shape.ts";

// SIO-1029/SIO-1090: the elastic ReAct sub-agent can loop on elasticsearch_search
// because an empty search is a valid 200 result ("Total results: 0, showing 0 from
// position 0"), not an error. Under SIO-1090 the SOUL/focus-block now issue ONE broad
// multi_match query over logs-*,logs-apm.* wide by default, so the narrow-window thrash
// that motivated the widen/latch/discovery-aware machinery is gone. This guard is now
// just two termination guarantees: (1) an exact-duplicate (tool,args) call is stopped,
// and (2) a hard cap on total unproductive elasticsearch_search calls stops a permuter
// well under recursionLimit 40. A single service.name discovery agg is never stopped
// below the cap so the discover step always runs. AWS aws_logs_start_query guarding
// (retention re-anchor) is unchanged.

const GUARDED_TOOLS = new Set<string>(["elasticsearch_search", "aws_logs_start_query"]);

const AWS_DESCRIBE_LOG_GROUPS = "aws_logs_describe_log_groups";

// An empty elasticsearch_search renders as "Total results: 0, showing 0 ...".
const EMPTY_SEARCH_RE = /Total results:\s*0\b/i;

// SIO-1084: AWS tool results carry an {_error:{kind,...}} envelope on failure. The
// looping kinds are the retention-window rejection (bad-input) and wrong-group
// (resource-not-found).
const AWS_LOOPING_ERROR_KINDS = new Set<string>(["bad-input", "resource-not-found"]);

// SIO-1090: absolute cap on TOTAL unproductive elasticsearch_search calls in one
// sub-agent run. The termination backstop even if the LLM permutes distinct args; well
// under recursionLimit 40. One broad query should suffice, so this is generous headroom.
const MAX_UNPRODUCTIVE_SEARCHES = 5;

export const LOOP_GUARD_STOP_MESSAGE =
	"No results for this query, and equivalent searches have already returned nothing. " +
	"Stop searching -- do not call this tool again with a similar query. Synthesize your " +
	"findings from the data you have gathered so far. If the discovery aggregation surfaced " +
	"a candidate service.name you have not yet confirmed, treat the service as present under " +
	"that name; only if discovery surfaced no matching service at all, report that the " +
	"searched indices/patterns returned no matching documents.";

export const AWS_START_QUERY_STOP_MESSAGE =
	"The previous aws_logs_start_query window was rejected as outside the log group's " +
	"retention window, and you have not re-anchored since. Do NOT re-issue the same query. " +
	"Call aws_logs_describe_log_groups first to read retentionInDays and creationTime, then " +
	"re-anchor startTime/endTime to the incident/event timestamp (usually recent) inside " +
	"[now - retentionInDays, now] before calling aws_logs_start_query again.";

export interface LoopGuardState {
	seenSignatures: Set<string>;
	// SIO-1090: TOTAL unproductive elasticsearch_search calls this run. Drives the
	// MAX_UNPRODUCTIVE_SEARCHES backstop.
	unproductiveSearches: number;
	// SIO-1084: set when the last aws_logs_start_query returned a retention/bad-input
	// _error; cleared by an intervening aws_logs_describe_log_groups.
	awsStartQueryNeedsReanchor: boolean;
}

export function createLoopGuardState(): LoopGuardState {
	return {
		seenSignatures: new Set<string>(),
		unproductiveSearches: 0,
		awsStartQueryNeedsReanchor: false,
	};
}

// SIO-1084: In the ReAct/ToolNode path invoke() receives { id, name, args, type }, not
// the bare args. Unwrap so the signature/discovery detection key on args.
export function unwrapCallArgs(arg: unknown): unknown {
	if (arg && typeof arg === "object" && "args" in arg && !Array.isArray(arg)) {
		return (arg as { args: unknown }).args;
	}
	return arg;
}

export function toolCallSignature(toolName: string, arg: unknown): string {
	return `${toolName}::${stableStringify(unwrapCallArgs(arg))}`;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// SIO-1084/1090: a service.name discovery aggregation is `size: 0` with a terms agg on
// `service.name`. It is bounded and load-bearing (the discover step), so the guard never
// stops the FIRST one below the hard cap.
export function isDiscoveryCall(arg: unknown): boolean {
	const args = unwrapCallArgs(arg);
	if (!args || typeof args !== "object") return false;
	const obj = args as Record<string, unknown>;
	if (obj.size !== 0) return false;
	const aggs = obj.aggs ?? obj.aggregations;
	return aggsTargetServiceName(aggs);
}

function aggsTargetServiceName(aggs: unknown): boolean {
	if (!aggs || typeof aggs !== "object") return false;
	for (const node of Object.values(aggs as Record<string, unknown>)) {
		if (!node || typeof node !== "object") continue;
		const terms = (node as Record<string, unknown>).terms;
		if (terms && typeof terms === "object") {
			const field = (terms as Record<string, unknown>).field;
			if (field === "service.name") return true;
		}
		const nested = (node as Record<string, unknown>).aggs ?? (node as Record<string, unknown>).aggregations;
		if (aggsTargetServiceName(nested)) return true;
	}
	return false;
}

export function awsErrorKind(content: unknown): string | null {
	const text = typeof content === "string" ? content : safeStringify(content);
	if (!text.includes("_error")) return null;
	const start = text.indexOf("{");
	if (start === -1) return null;
	try {
		const parsed = JSON.parse(text.slice(start));
		if (parsed && typeof parsed === "object") {
			const err = (parsed as Record<string, unknown>)._error;
			if (err && typeof err === "object") {
				const kind = (err as Record<string, unknown>).kind;
				return typeof kind === "string" ? kind : "unknown";
			}
		}
	} catch {
		return null;
	}
	return null;
}

function safeStringify(value: unknown): string {
	if (value === undefined || value === null) return "";
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

// SIO-1086: the elastic MCP renders a search/agg result as an ARRAY of text blocks;
// @langchain/mcp-adapters delivers that array RAW. Coalesce a text-block array back to
// the string it logically is so the string checks below apply.
function coalesceTextBlocks(content: unknown): string | null {
	if (!Array.isArray(content) || content.length === 0) return null;
	const texts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "text" in block) {
			const t = (block as { text?: unknown }).text;
			if (typeof t === "string") texts.push(t);
		}
	}
	return texts.length > 0 ? texts.join("\n\n") : null;
}

// A result is "unproductive" when it carries no usable data. Elastic: explicit empty
// search, empty content, empty array, or zero-bucket aggregation. AWS start_query: an
// _error envelope with a looping kind.
export function isUnproductiveResult(content: unknown, toolName?: string): boolean {
	if (toolName === "aws_logs_start_query") {
		const kind = awsErrorKind(content);
		return kind !== null && AWS_LOOPING_ERROR_KINDS.has(kind);
	}
	const coalesced = coalesceTextBlocks(content);
	const asText = typeof content === "string" ? content : coalesced;
	if (typeof asText === "string") {
		if (asText.length === 0) return true;
		if (EMPTY_SEARCH_RE.test(asText)) return true;
		if (isEmptyAggregationResult(asText)) return true;
	}
	const { shape } = describeToolResult(asText ?? content);
	if (shape.contentType === "empty") return true;
	if (shape.contentType === "array" && shape.topLevelArrayLen === 0) return true;
	if (shape.contentType === "object" && shape.hitsLen === 0) return true;
	return false;
}

function isEmptyAggregationResult(text: string): boolean {
	if (!/aggregations/i.test(text)) return false;
	const start = text.indexOf("{");
	if (start === -1) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start));
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object") return false;
	return aggregationsAreEmpty(parsed as Record<string, unknown>);
}

function aggregationsAreEmpty(node: Record<string, unknown>): boolean {
	let sawBuckets = false;
	let allEmpty = true;
	const walk = (obj: Record<string, unknown>): void => {
		for (const value of Object.values(obj)) {
			if (!value || typeof value !== "object") continue;
			const buckets = (value as Record<string, unknown>).buckets;
			if (Array.isArray(buckets)) {
				sawBuckets = true;
				if (buckets.length > 0) allEmpty = false;
			}
			walk(value as Record<string, unknown>);
		}
	};
	walk(node);
	return sawBuckets && allEmpty;
}

// Decide BEFORE invoking whether this call should be short-circuited. Trips when the
// exact same (tool, args) call was already seen, OR (elastic) the hard unproductive-call
// cap is exhausted, OR (aws) a prior retention rejection has not yet been re-anchored.
export function shouldShortCircuit(state: LoopGuardState, toolName: string, signature: string, arg?: unknown): boolean {
	if (!GUARDED_TOOLS.has(toolName)) return false;

	if (toolName === "aws_logs_start_query") {
		if (state.seenSignatures.has(signature)) return true;
		if (state.awsStartQueryNeedsReanchor) return true;
		return false;
	}

	// elasticsearch_search
	if (state.seenSignatures.has(signature)) return true;
	// Hard termination backstop: once TOTAL unproductive searches hit the cap, stop
	// unconditionally -- even a discovery call.
	if (state.unproductiveSearches >= MAX_UNPRODUCTIVE_SEARCHES) return true;
	// A fresh service.name discovery agg is bounded + load-bearing: below the cap, never
	// stop the discover step.
	if (isDiscoveryCall(arg)) return false;
	return false;
}

// SIO-1084: reserve a guarded call's signature BEFORE invoking so a concurrent identical
// call is caught as a duplicate. Idempotent.
export function reserveSignature(state: LoopGuardState, toolName: string, signature: string): void {
	if (!GUARDED_TOOLS.has(toolName)) return;
	state.seenSignatures.add(signature);
}

// Update state AFTER a real (non-short-circuited) call completes.
export function recordResult(
	state: LoopGuardState,
	toolName: string,
	signature: string,
	content: unknown,
	_arg?: unknown,
): void {
	if (toolName === AWS_DESCRIBE_LOG_GROUPS) {
		state.awsStartQueryNeedsReanchor = false;
		return;
	}
	if (!GUARDED_TOOLS.has(toolName)) return;

	state.seenSignatures.add(signature);

	if (toolName === "aws_logs_start_query") {
		state.awsStartQueryNeedsReanchor = isUnproductiveResult(content, toolName);
		return;
	}

	// elasticsearch_search
	if (isUnproductiveResult(content, toolName)) {
		state.unproductiveSearches += 1;
	}
}

export function isGuardedTool(toolName: string): boolean {
	return GUARDED_TOOLS.has(toolName);
}

export function isObservedTool(toolName: string): boolean {
	return GUARDED_TOOLS.has(toolName) || toolName === AWS_DESCRIBE_LOG_GROUPS;
}

// SIO-1084/1090: select the stop message for a guarded tool. `state` is accepted for a
// stable signature with the call site but is no longer needed to choose the elastic
// message (only one remains).
export function stopMessageFor(toolName: string, _state?: LoopGuardState): string {
	if (toolName === "aws_logs_start_query") return AWS_START_QUERY_STOP_MESSAGE;
	return LOOP_GUARD_STOP_MESSAGE;
}
```

- [ ] **Step 4: Verify the instrumentation call site still compiles against the reduced state**

The call site reads `runState.loopGuard.consecutiveEmpty` in a log line (`sub-agent-instrumentation.ts:110`). That field no longer exists. Change that one log field:

In `packages/agent/src/sub-agent-instrumentation.ts`, replace line 110:
```typescript
									consecutiveEmpty: runState.loopGuard.consecutiveEmpty,
```
with:
```typescript
									unproductiveSearches: runState.loopGuard.unproductiveSearches,
```

- [ ] **Step 5: Run the loop-guard tests and typecheck**

Run: `bun test packages/agent/src/sub-agent-loop-guard.test.ts && bun run --filter '@devops-agent/agent' typecheck`
Expected: PASS (all loop-guard tests green; no type errors from the removed fields).

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/sub-agent-loop-guard.ts packages/agent/src/sub-agent-loop-guard.test.ts packages/agent/src/sub-agent-instrumentation.ts
git commit -m "SIO-1090: strip elastic loop guard to duplicate-stop + hard cap"
```

---

### Task 2: Broaden the focus-block elastic guidance

**Files:**
- Modify: `packages/agent/src/sub-agent-focus-block.ts:83-98` (the `case "elastic":` block)
- Test: `packages/agent/src/sub-agent-focus-block.test.ts` (the elastic assertions)

**Interfaces:**
- Consumes: `resolved.elastic?.serviceNames: string[]` (from `packages/shared/src/agent-state.ts:475`, unchanged) and `buildFocusBlock(focus, nowIso, resolved, dataSourceId)` called at `sub-agent.ts:694` (unchanged signature).
- Produces: the rendered focus block for `dataSourceId === "elastic"` now instructs a broad `multi_match` over `[message, error.exception.message, body.text]` across `logs-*,logs-apm.*` with a `now-30d` default window, instead of pinning `logs-apm.error-*`/`error.exception.message`.

- [ ] **Step 1: Update the failing test first**

In `packages/agent/src/sub-agent-focus-block.test.ts`, find the elastic-block test (the one whose fixture is `elastic: { serviceNames: ["pvh-services-orders", "orders"] }`, ~line 91) and replace its assertions with:

```typescript
	test("elastic resolved block instructs a broad multi_match, not an error-logs pin", () => {
		const block = buildFocusBlock(FOCUS, NOW_ISO, { resolvedForServices: FOCUS.services, elastic: { serviceNames: ["pvh-services-orders", "orders"] } }, "elastic");
		expect(block).toContain("pvh-services-orders");
		expect(block).toContain("logs-*,logs-apm.*");
		expect(block).toContain("multi_match");
		expect(block).toContain("message");
		expect(block).toContain("error.exception.message");
		expect(block).toContain("body.text");
		expect(block).toContain("now-30d");
		// The old error-logs-only pin must be gone.
		expect(block).not.toContain("logs-apm.error-*");
	});
```

(Reuse whatever `FOCUS` / `NOW_ISO` constants the test file already defines; if the existing test used inline literals, define `const NOW_ISO = "2026-07-13T02:00:00.000Z"` and a `FOCUS` with `services: ["order-service"]` and matching `resolvedForServices` so `sameServiceSet` passes.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/agent/src/sub-agent-focus-block.test.ts`
Expected: FAIL — the current block contains `logs-apm.error-*` and lacks `multi_match`/`message`/`now-30d`.

- [ ] **Step 3: Rewrite the elastic case in `sub-agent-focus-block.ts`**

Replace lines 83-98 (`case "elastic":` through its `break;`) with:

```typescript
		case "elastic":
			if (resolved.elastic?.serviceNames.length) {
				lines.push(`- Elastic service.name candidates: ${resolved.elastic.serviceNames.join(", ")}`);
				// SIO-1090: hand the agent the WORKING broad query shape so it finds the data in
				// one call instead of thrashing. The incident message can live in generic app logs
				// (`message`), APM app logs, OR APM error logs (`error.exception.message`) -- searching
				// only one index/field misses it (validated live: the AFS message is ~100x more
				// present in `message` than in `error.exception.message`). Search all candidate fields
				// across logs-*,logs-apm.* with a wide default window; a chronic error is easily missed
				// by a narrow slice.
				lines.push(
					"  Search across index `logs-*,logs-apm.*` with ONE query: a `terms` filter on the " +
						"candidate service.name(s) + a `multi_match` (`type: phrase`) of the cited error over " +
						"fields [`message`, `error.exception.message`, `body.text`], and an `@timestamp` range " +
						"`gte: now-30d` (wide by default -- do NOT bound to a 1h/24h slice; a chronic error " +
						"recurs for days at low frequency). Report which `_index` and field matched, the exact " +
						"count (`track_total_hits: true`), the latest timestamp, and sample messages. Do NOT " +
						"pin to `logs-apm.error-*` only, and do NOT run per-name permutations -- put all " +
						"candidate names in one `terms` filter.",
				);
			}
			break;
```

- [ ] **Step 4: Run the focus-block tests and typecheck**

Run: `bun test packages/agent/src/sub-agent-focus-block.test.ts && bun run --filter '@devops-agent/agent' typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/sub-agent-focus-block.ts packages/agent/src/sub-agent-focus-block.test.ts
git commit -m "SIO-1090: focus block -- broad multi_match guidance, drop error-logs pin"
```

---

### Task 3: Rewrite the SOUL named-service search procedure

**Files:**
- Modify: `agents/incident-analyzer/agents/elastic-agent/SOUL.md` (lines ~16-129: the "Searching for a named service's errors" section AND the "Stop on Empty Results" section)

**Interfaces:**
- Consumes: nothing programmatic — this is the sub-agent's system prompt prose, loaded by the gitagent bridge. No code references it by line.
- Produces: prose that matches the focus-block guidance from Task 2 (same index, fields, window) so the two prompt sources are consistent.

- [ ] **Step 1: Replace the named-service procedure**

In `agents/incident-analyzer/agents/elastic-agent/SOUL.md`, replace the entire section from the header `## Searching for a named service's errors -- follow these steps IN ORDER` (line 16) through the end of the `THE ONE RULE THAT OVERRIDES EVERYTHING` paragraph (line 105) with:

```markdown
## Searching for a named service's errors -- discover, then search broad, then use

The incident message can live in ANY of three index families, under DIFFERENT fields:
generic application logs (`logs-*`, field `message`), APM app logs (`logs-apm.app.*`,
field `message`/`body.text`), or APM error logs (`logs-apm.error-*`, field
`error.exception.message`). Do NOT assume it is an APM error -- search all of them in
one query. `service.name` is a keyword (use `service.name`, never
`service.name.keyword`). The `<angle-bracket>` values are PLACEHOLDERS -- substitute the
incident's deployment, service name(s), and error text.

PHASE 1 -- DISCOVER the real service name(s) and which index families carry them. Run
ONE aggregation (the incident's loose name is often prefixed, e.g. `styles-v3` ->
`pvh-services-styles-v3`, so filter by an anchor-token wildcard, not a bare top-N):
```json
{ "deployment": "<deployment>", "index": "logs-*,logs-apm.*", "size": 0,
  "query": { "wildcard": { "service.name": "*<anchor-token>*" } },
  "aggs": {
    "by_service": { "terms": { "field": "service.name", "size": 100 } },
    "by_index":   { "terms": { "field": "_index",       "size": 50 } } } }
```
- Take every `by_service` bucket that matches the anchor (bare OR prefixed) as a
  candidate name. `by_index` tells you which index families hold the service.
- No bucket matches the anchor at all => the service is genuinely absent; report that.

PHASE 2 -- SEARCH BROAD. Run ONE query for the cited error across all candidate names
and all three text fields, WIDE BY DEFAULT (`now-30d`, no `lte`). Put every candidate
name in a single `terms` filter -- do NOT permute one query per name:
```json
{ "deployment": "<deployment>", "index": "logs-*,logs-apm.*", "size": 5,
  "track_total_hits": true,
  "query": { "bool": {
    "must": [ { "multi_match": { "query": "<cited-error>", "type": "phrase",
        "fields": [ "message", "error.exception.message", "body.text" ] } } ],
    "filter": [
      { "terms": { "service.name": [ "<name-1>", "<name-2>" ] } },
      { "range": { "@timestamp": { "gte": "now-30d" } } } ] } },
  "sort": [ { "@timestamp": "desc" } ] }
```

PHASE 3 -- USE the hits. Report which `_index` and field matched, the exact count, the
latest `@timestamp`, and sample messages (APM stack traces are under
`error.exception.stacktrace.*`). If the caller needs incident-window scoping, note how
many hits fall inside the incident window versus the wider window -- do NOT re-query to
narrow. You are done.

Only if PHASE 2 returns zero at `now-30d` AND PHASE 1 discovery surfaced no matching
service is an "absent" conclusion allowed. A zero from a narrow window you chose
yourself is never grounds for "absent" -- PHASE 2 is wide by default precisely so a
chronic, low-frequency error is not missed. Once any query returns a hit, the service is
present -- that is final; do not keep permuting queries after you have your answer.
```

- [ ] **Step 2: Replace the "Stop on Empty Results" section for consistency**

Replace the `## Stop on Empty Results` section (lines ~120-129) with:

```markdown
## Stop on Empty Results
For a NAMED service, follow the PHASE 1 -> 2 -> 3 procedure above -- it defines when an
"absent" conclusion is allowed (only when PHASE 2 is zero at `now-30d` AND PHASE 1
discovery found no matching service). The most common cause of a false zero is searching
too narrow -- the wrong index/field or a 1-hour window on a chronic error -- which PHASE 2
avoids by searching `logs-*,logs-apm.*` across three fields at `now-30d`. For any OTHER
search (not a named-service lookup), an empty result is a valid final answer only after a
`now-30d` retry is also empty; then report "no matching documents for <criteria> (searched
logs-*,logs-apm.* over now-30d)" rather than permuting queries.
```

- [ ] **Step 3: Validate the YAML/agent definition still parses**

Run: `bun run yaml:check`
Expected: PASS (SOUL.md is Markdown, not YAML, but this confirms the agent bundle is still well-formed).

- [ ] **Step 4: Commit**

```bash
git add agents/incident-analyzer/agents/elastic-agent/SOUL.md
git commit -m "SIO-1090: SOUL -- discover/broad/use, drop error-logs-only pin"
```

---

### Task 4: Full-suite green + live end-to-end verification

**Files:**
- No new edits expected. If a package-level test outside the three files above referenced a removed loop-guard symbol, fix it here (it should not — those symbols were elastic-guard-internal).

**Interfaces:**
- Consumes: the running elastic MCP on `:9080` (deployment `eu-b2b`) and the running web app on `:5173` (the incident-analyzer graph) for replay.

- [ ] **Step 1: Full workspace typecheck, lint, test**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS. If any file references a deleted symbol (`LOOP_GUARD_WIDEN_WINDOW_MESSAGE`, `latchedStopMessage`, `hasTimeWindow`, `serviceNameFilter`, `extractHitCount`, `windowLabel`, `LOOP_GUARD_LATCHED_STOP_LEAD`, `BestResult`), remove that reference and re-run. Grep to be sure:

Run: `grep -rn "LOOP_GUARD_WIDEN_WINDOW_MESSAGE\|latchedStopMessage\|LOOP_GUARD_LATCHED_STOP_LEAD\|\bhasTimeWindow\b\|\bserviceNameFilter\b\|\bwindowLabel\b\|\bextractHitCount\b\|BestResult" packages/ apps/`
Expected: no matches (all removed).

- [ ] **Step 2: Live-verify PHASE 1 (discovery) against eu-b2b**

Run:
```bash
curl -s -m 30 -X POST http://localhost:9080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'x-elastic-deployment: eu-b2b' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"elasticsearch_search","arguments":{"deployment":"eu-b2b","index":"logs-*,logs-apm.*","size":0,"query":{"wildcard":{"service.name":"*order*"}},"aggs":{"by_service":{"terms":{"field":"service.name","size":100}},"by_index":{"terms":{"field":"_index","size":50}}}}}}' \
  | grep '^data:' | tail -1
```
Expected: a `by_service` bucket for an order-service-family name (e.g. `prana-order-service` / `orders-service`) AND a `by_index` with buckets spanning at least `logs-apm.error-default-*` and a generic `logs-...fargate...` index.

- [ ] **Step 3: Live-verify PHASE 2 (broad search) returns non-zero**

Run:
```bash
curl -s -m 30 -X POST http://localhost:9080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'x-elastic-deployment: eu-b2b' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"elasticsearch_search","arguments":{"deployment":"eu-b2b","index":"logs-*,logs-apm.*","size":5,"track_total_hits":true,"query":{"bool":{"must":[{"multi_match":{"query":"Unable to fetch AFS season code","type":"phrase","fields":["message","error.exception.message","body.text"]}}],"filter":[{"terms":{"service.name":["orders-service","prana-order-service","order-service"]}},{"range":{"@timestamp":{"gte":"now-30d"}}}]}},"sort":[{"@timestamp":"desc"}]}}}' \
  | grep '^data:' | tail -1
```
Expected: `Total results:` with a count in the thousands+ (NOT `Total results: 0`); top hits from `service.name: prana-order-service`.

- [ ] **Step 4: Replay the incident through the agent (fresh thread)**

Confirm the web app is up (start only if not):
```bash
lsof -i :5173 -P | grep LISTEN || bun run --filter @devops-agent/web dev &
```
Then replay:
```bash
curl -s -N -X POST http://localhost:5173/api/agent/stream \
  -H 'Content-Type: application/json' \
  -d '{"message":"In the prana order service we have this issue: Unable to fetch AFS season code by FMS season code, sales organization THE1","threadId":"sio1090-verify","dataSources":["elastic"]}' \
  | grep -iE 'elastic|AFS|Total results|prana|no data|no matching' | head -40
```
Expected: the elastic datasource returns the AFS message with a count and latest timestamp, NOT "no data" / "investigation truncated" / "no matching documents". Compare against the pre-fix behaviour (all-zero).

- [ ] **Step 5: Final commit (only if Step 1 required a fix)**

```bash
git add -A
git commit -m "SIO-1090: remove dangling references to deleted loop-guard symbols"
```

(If Step 1 was already clean, skip — no empty commit.)

---

## Self-Review

**Spec coverage:**
- Discover phase (names + index families) -> Task 3 (SOUL PHASE 1) + Task 4 Step 2 live-verify. Covered.
- Broad search (one `multi_match`, wide default) -> Task 2 (focus block) + Task 3 (SOUL PHASE 2) + Task 4 Step 3. Covered.
- Use the hits -> Task 3 (SOUL PHASE 3). Covered.
- Loop guard strip (keep duplicate-stop + hard cap + discovery not-stopped + AWS untouched; remove widen/latch/post-discovery/discovery-gating) -> Task 1. Covered, matches the spec's KEEP/GOES lists exactly.
- Remove error-logs-only + `message`/`body.text` prohibition from SOUL -> Task 3 Step 1. Covered.
- resolveIdentifiers unchanged -> not modified; Task 2 confirms its output still flows to the focus block. Covered.
- Verification (live PHASE 1/2 + replay + typecheck/lint/test) -> Task 4. Covered.

**Placeholder scan:** No "TBD"/"TODO"/"handle edge cases"/"similar to Task N". Every code step shows full code; every command shows expected output. The one conditional ("reuse existing FOCUS/NOW_ISO constants") gives an explicit fallback definition.

**Type consistency:** `LoopGuardState` fields used across Task 1 (`seenSignatures`, `unproductiveSearches`, `awsStartQueryNeedsReanchor`) match `createLoopGuardState` and the reduced interface. `stopMessageFor(toolName, _state?)` keeps the two-arg call-site contract. `unproductiveSearches` referenced in the instrumentation log (Task 1 Step 4) matches the field name. `resolved.elastic.serviceNames` (Task 2) matches `packages/shared/src/agent-state.ts:475`. No mismatched names.

**Removed-symbol safety:** Task 4 Step 1 greps for every deleted export so a stray reference fails loudly rather than silently.
