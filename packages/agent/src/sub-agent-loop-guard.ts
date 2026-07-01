// packages/agent/src/sub-agent-loop-guard.ts

import { describeToolResult } from "./sub-agent-tool-result-shape.ts";

// SIO-1029: the elastic ReAct sub-agent loops on elasticsearch_search. An empty
// search is a valid 200 result -- the literal string
// "Total results: 0, showing 0 from position 0" (mcp-server-elastic search.ts)
// -- NOT an error, so the LLM keeps permuting index patterns/queries until it
// blows the recursion limit (40) and the whole datasource returns nothing. This
// module makes repetition terminal: after two consecutive unproductive searches
// (or an exact-duplicate call), the guard returns a stop-and-synthesize string
// to the LLM instead of re-hitting ES. Conservative by design -- it only trips
// on a real repeat, so legitimate progressive refinement (SIO-689) is untouched.

// Only guard the tool that actually loops. Kept as a set so a future looping
// tool can be added without touching the instrumentation call site.
const GUARDED_TOOLS = new Set<string>(["elasticsearch_search"]);

// An empty elasticsearch_search renders as "Total results: 0, showing 0 ...".
const EMPTY_SEARCH_RE = /Total results:\s*0\b/i;

// Consecutive unproductive results after which the NEXT guarded call is stopped.
const CONSECUTIVE_EMPTY_LIMIT = 2;

export const LOOP_GUARD_STOP_MESSAGE =
	"No results for this query, and equivalent searches have already returned nothing. " +
	"Stop searching -- do not call this tool again with a similar query. Synthesize your " +
	"findings from the data you have gathered so far and report what you found (including " +
	"that the searched indices/patterns returned no matching documents).";

export interface LoopGuardState {
	consecutiveEmpty: number;
	seenSignatures: Set<string>;
}

export function createLoopGuardState(): LoopGuardState {
	return { consecutiveEmpty: 0, seenSignatures: new Set<string>() };
}

// Stable signature of a tool call for exact-duplicate detection. Args are
// JSON-normalized with sorted keys so semantically identical calls collide.
export function toolCallSignature(toolName: string, arg: unknown): string {
	return `${toolName}::${stableStringify(arg)}`;
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

// A result is "unproductive" when it carries no usable data: an explicit empty
// search ("Total results: 0"), an empty content type, an empty array, or a
// trivially-small string. Kept narrow so real (non-empty) results never trip it.
export function isUnproductiveResult(content: unknown): boolean {
	const { shape } = describeToolResult(content);
	if (shape.contentType === "empty") return true;
	if (shape.contentType === "array" && shape.topLevelArrayLen === 0) return true;
	if (shape.contentType === "object" && shape.hitsLen === 0) return true;
	if (shape.contentType === "string") {
		const text = typeof content === "string" ? content : "";
		return EMPTY_SEARCH_RE.test(text);
	}
	return false;
}

// Decide BEFORE invoking whether this call should be short-circuited. Trips when
// the exact same (tool, args) call was already seen, OR the consecutive-empty
// budget is exhausted. Only guarded tools are considered; everything else runs.
export function shouldShortCircuit(state: LoopGuardState, toolName: string, signature: string): boolean {
	if (!GUARDED_TOOLS.has(toolName)) return false;
	if (state.seenSignatures.has(signature)) return true;
	return state.consecutiveEmpty >= CONSECUTIVE_EMPTY_LIMIT;
}

// Update state AFTER a real (non-short-circuited) guarded call completes.
// Records the signature for duplicate detection and tracks the empty streak.
export function recordResult(state: LoopGuardState, toolName: string, signature: string, content: unknown): void {
	if (!GUARDED_TOOLS.has(toolName)) return;
	state.seenSignatures.add(signature);
	if (isUnproductiveResult(content)) {
		state.consecutiveEmpty += 1;
	} else {
		state.consecutiveEmpty = 0;
	}
}

export function isGuardedTool(toolName: string): boolean {
	return GUARDED_TOOLS.has(toolName);
}
