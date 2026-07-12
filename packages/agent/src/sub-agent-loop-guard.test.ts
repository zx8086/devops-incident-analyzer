// agent/src/sub-agent-loop-guard.test.ts

import { describe, expect, test } from "bun:test";
import {
	AWS_START_QUERY_STOP_MESSAGE,
	awsErrorKind,
	createLoopGuardState,
	isDiscoveryCall,
	isGuardedTool,
	isObservedTool,
	isUnproductiveResult,
	LOOP_GUARD_STOP_MESSAGE,
	recordResult,
	reserveSignature,
	shouldShortCircuit,
	stopMessageFor,
	toolCallSignature,
	unwrapCallArgs,
} from "./sub-agent-loop-guard.ts";

const EMPTY_SEARCH = "Total results: 0, showing 0 from position 0"; // the 43-byte empty result
const DISCOVERY_ARGS = {
	index: "logs-*,logs-apm.*",
	size: 0,
	aggs: { by_service: { terms: { field: "service.name", size: 50 } } },
};

// Helper: run a discovery agg to arm the consecutive-empty stop, returning a search
// signature for the discovery call so callers can chain further searches.
function armDiscovery(state: ReturnType<typeof createLoopGuardState>): void {
	const sig = toolCallSignature("elasticsearch_search", DISCOVERY_ARGS);
	recordResult(state, "elasticsearch_search", sig, EMPTY_SEARCH, DISCOVERY_ARGS);
}

describe("SIO-1029: loop guard result classification", () => {
	test("recognizes the empty elasticsearch_search string as unproductive", () => {
		expect(isUnproductiveResult(EMPTY_SEARCH)).toBe(true);
	});

	test("empty array and empty content are unproductive", () => {
		expect(isUnproductiveResult("[]")).toBe(true);
		expect(isUnproductiveResult("")).toBe(true);
	});

	test("a real result with hits is productive", () => {
		expect(isUnproductiveResult('[{"_source":{"message":"boom"}}]')).toBe(false);
		expect(isUnproductiveResult("Total results: 5, showing 5 from position 0")).toBe(false);
	});

	test("guarded tools are elasticsearch_search and aws_logs_start_query", () => {
		expect(isGuardedTool("elasticsearch_search")).toBe(true);
		expect(isGuardedTool("aws_logs_start_query")).toBe(true);
		expect(isGuardedTool("kafka_list_topics")).toBe(false);
	});

	test("observed tools include describe_log_groups (not guarded but recorded)", () => {
		expect(isObservedTool("aws_logs_describe_log_groups")).toBe(true);
		expect(isGuardedTool("aws_logs_describe_log_groups")).toBe(false);
		expect(isObservedTool("kafka_list_topics")).toBe(false);
	});
});

describe("SIO-1084 A0: signature hashes args, not the tool-call wrapper", () => {
	test("unwrapCallArgs strips the ReAct tool-call envelope", () => {
		const wrapped = { name: "elasticsearch_search", id: "call_1", type: "tool_call", args: { q: "a" } };
		expect(unwrapCallArgs(wrapped)).toEqual({ q: "a" });
		expect(unwrapCallArgs({ q: "a" })).toEqual({ q: "a" }); // bare args pass through
	});

	test("identical args with different call ids collide (duplicate detection works)", () => {
		const call1 = { name: "elasticsearch_search", id: "call_1", type: "tool_call", args: { q: "same" } };
		const call2 = { name: "elasticsearch_search", id: "call_2", type: "tool_call", args: { q: "same" } };
		expect(toolCallSignature("elasticsearch_search", call1)).toBe(toolCallSignature("elasticsearch_search", call2));
	});

	test("signature is stable across key ordering", () => {
		expect(toolCallSignature("elasticsearch_search", { a: 1, b: 2 })).toBe(
			toolCallSignature("elasticsearch_search", { b: 2, a: 1 }),
		);
	});
});

describe("SIO-1084 A1: discovery-call detection", () => {
	test("size:0 with a service.name terms agg is a discovery call", () => {
		expect(isDiscoveryCall(DISCOVERY_ARGS)).toBe(true);
	});

	test("detects discovery through the tool-call wrapper", () => {
		expect(isDiscoveryCall({ name: "elasticsearch_search", id: "c1", args: DISCOVERY_ARGS })).toBe(true);
	});

	test("nested aggs targeting service.name still count", () => {
		const args = { size: 0, aggs: { outer: { aggs: { inner: { terms: { field: "service.name" } } } } } };
		expect(isDiscoveryCall(args)).toBe(true);
	});

	test("a normal search is not a discovery call", () => {
		expect(isDiscoveryCall({ index: "logs-*", query: { match: { message: "boom" } } })).toBe(false);
	});

	test("size:0 with a non-service.name terms agg is not discovery", () => {
		expect(isDiscoveryCall({ size: 0, aggs: { by_host: { terms: { field: "host.name" } } } })).toBe(false);
	});

	test("service.name.keyword (no such subfield on APM) is not treated as discovery", () => {
		expect(isDiscoveryCall({ size: 0, aggs: { s: { terms: { field: "service.name.keyword" } } } })).toBe(false);
	});
});

describe("SIO-1084 A1: elastic guard is discovery-aware", () => {
	test("does NOT stop after two literal-name empties when no discovery has run yet", () => {
		const state = createLoopGuardState();
		const sig1 = toolCallSignature("elasticsearch_search", { index: "logs-*", q: "order-service" });
		const sig2 = toolCallSignature("elasticsearch_search", { index: "logs-apm.*", q: "order-service" });
		const sig3 = toolCallSignature("elasticsearch_search", DISCOVERY_ARGS);

		expect(shouldShortCircuit(state, "elasticsearch_search", sig1, { index: "logs-*", q: "order-service" })).toBe(
			false,
		);
		recordResult(state, "elasticsearch_search", sig1, EMPTY_SEARCH, { index: "logs-*", q: "order-service" });

		expect(shouldShortCircuit(state, "elasticsearch_search", sig2, { index: "logs-apm.*", q: "order-service" })).toBe(
			false,
		);
		recordResult(state, "elasticsearch_search", sig2, EMPTY_SEARCH, { index: "logs-apm.*", q: "order-service" });

		// The discovery agg is ALWAYS allowed through, even after two empties.
		expect(shouldShortCircuit(state, "elasticsearch_search", sig3, DISCOVERY_ARGS)).toBe(false);
	});

	test("post-discovery, two empties DO stop (budget restored)", () => {
		const state = createLoopGuardState();
		armDiscovery(state); // discoveryRan = true, consecutiveEmpty = 1 (empty discovery)

		const sigA = toolCallSignature("elasticsearch_search", { q: "a" });
		const sigB = toolCallSignature("elasticsearch_search", { q: "b" });
		// discovery empty already counts as 1; one more empty exhausts the budget of 2
		recordResult(state, "elasticsearch_search", sigA, EMPTY_SEARCH, { q: "a" });
		expect(shouldShortCircuit(state, "elasticsearch_search", sigB, { q: "b" })).toBe(true);
	});

	test("a repeated identical discovery agg is still short-circuited (duplicate protection)", () => {
		const state = createLoopGuardState();
		const sig = toolCallSignature("elasticsearch_search", DISCOVERY_ARGS);
		recordResult(state, "elasticsearch_search", sig, EMPTY_SEARCH, DISCOVERY_ARGS);
		expect(shouldShortCircuit(state, "elasticsearch_search", sig, DISCOVERY_ARGS)).toBe(true);
	});

	test("bounded stop: the agent terminates within a few calls even if discovery keeps returning empty", () => {
		const state = createLoopGuardState();
		let stopped = false;
		for (let i = 0; i < 10 && !stopped; i++) {
			// alternate a distinct literal search each iteration
			const args = { index: "logs-*", q: `perm-${i}` };
			const sig = toolCallSignature("elasticsearch_search", args);
			if (shouldShortCircuit(state, "elasticsearch_search", sig, args)) {
				stopped = true;
				break;
			}
			recordResult(state, "elasticsearch_search", sig, EMPTY_SEARCH, args);
			if (i === 0) armDiscovery(state); // discovery runs early
		}
		expect(stopped).toBe(true);
	});

	// SIO-1084 regression (finder-caught): a permuting LLM that issues DISTINCT empty
	// searches and NEVER runs discovery must still terminate via the hard cap -- the
	// discovery-aware soft stop (gated on discoveryRan) would otherwise never fire.
	test("hard cap terminates a distinct-arg permuter that never runs discovery (SIO-1029 non-regression)", () => {
		const state = createLoopGuardState();
		let calls = 0;
		let stopped = false;
		for (let i = 0; i < 40 && !stopped; i++) {
			const args = { index: "logs-*", q: `distinct-${i}` }; // never a discovery agg
			const sig = toolCallSignature("elasticsearch_search", args);
			if (shouldShortCircuit(state, "elasticsearch_search", sig, args)) {
				stopped = true;
				break;
			}
			calls += 1;
			recordResult(state, "elasticsearch_search", sig, EMPTY_SEARCH, args);
		}
		expect(stopped).toBe(true);
		// Well under the recursionLimit of 40.
		expect(calls).toBeLessThanOrEqual(6);
	});

	// SIO-1084 (finder-caught): a zero-bucket discovery agg renders as "Search results
	// with aggregations (0 total hits...)", which EMPTY_SEARCH_RE misses. It must still
	// count as unproductive so it doesn't reset the streak and re-arm the guard.
	test("an empty-bucket discovery agg is unproductive", () => {
		const emptyAgg =
			"Search results with aggregations (0 total hits, 3ms):\n\n" + JSON.stringify({ by_service: { buckets: [] } });
		expect(isUnproductiveResult(emptyAgg)).toBe(true);
		// a NON-empty agg is productive
		const fullAgg =
			"Search results with aggregations (5 total hits, 3ms):\n\n" +
			JSON.stringify({ by_service: { buckets: [{ key: "svc" }] } });
		expect(isUnproductiveResult(fullAgg)).toBe(false);
	});

	test("a productive result resets the consecutive-empty streak", () => {
		const state = createLoopGuardState();
		armDiscovery(state);
		const sigA = toolCallSignature("elasticsearch_search", { q: "a" });
		const sigB = toolCallSignature("elasticsearch_search", { q: "b" });
		const sigC = toolCallSignature("elasticsearch_search", { q: "c" });
		recordResult(state, "elasticsearch_search", sigA, '[{"_source":{"x":1}}]', { q: "a" }); // productive -> reset
		expect(shouldShortCircuit(state, "elasticsearch_search", sigB, { q: "b" })).toBe(false);
		recordResult(state, "elasticsearch_search", sigB, EMPTY_SEARCH, { q: "b" });
		expect(shouldShortCircuit(state, "elasticsearch_search", sigC, { q: "c" })).toBe(false);
	});

	test("exact-duplicate non-discovery call is short-circuited immediately", () => {
		const state = createLoopGuardState();
		const args = { index: "logs-*", q: "same" };
		const sig = toolCallSignature("elasticsearch_search", args);
		recordResult(state, "elasticsearch_search", sig, '[{"_source":{"x":1}}]', args);
		expect(shouldShortCircuit(state, "elasticsearch_search", sig, args)).toBe(true);
	});

	// SIO-1084 (finder-caught): parallel tool calls from one AIMessage could both pass
	// shouldShortCircuit before either records. Reserving the signature pre-invoke makes
	// the concurrent duplicate a detected loop.
	test("reserveSignature makes a concurrent identical call a duplicate", () => {
		const state = createLoopGuardState();
		const args = { index: "logs-*", q: "same" };
		const sig = toolCallSignature("elasticsearch_search", args);
		// first call passes, then reserves before its await completes
		expect(shouldShortCircuit(state, "elasticsearch_search", sig, args)).toBe(false);
		reserveSignature(state, "elasticsearch_search", sig);
		// concurrent identical call now short-circuits before recordResult runs
		expect(shouldShortCircuit(state, "elasticsearch_search", sig, args)).toBe(true);
	});

	test("reserveSignature no-ops for non-guarded tools", () => {
		const state = createLoopGuardState();
		reserveSignature(state, "kafka_list_topics", "kafka_list_topics::{}");
		expect(state.seenSignatures.size).toBe(0);
	});
});

describe("SIO-1084 A2: aws_logs_start_query guard", () => {
	const RETENTION_ERROR = JSON.stringify({ _error: { kind: "bad-input", advice: "outside retention" } });
	const NOT_FOUND_ERROR = JSON.stringify({ _error: { kind: "resource-not-found" } });
	const IAM_ERROR = JSON.stringify({ _error: { kind: "iam-permission-missing" } });
	const QUERY_ID = JSON.stringify({ queryId: "q-123", $metadata: {} });

	test("awsErrorKind extracts the kind, or null for a normal result", () => {
		expect(awsErrorKind(RETENTION_ERROR)).toBe("bad-input");
		expect(awsErrorKind(QUERY_ID)).toBe(null);
		expect(awsErrorKind("Total results: 0")).toBe(null);
	});

	test("a retention _error is unproductive; a successful queryId is productive", () => {
		expect(isUnproductiveResult(RETENTION_ERROR, "aws_logs_start_query")).toBe(true);
		expect(isUnproductiveResult(NOT_FOUND_ERROR, "aws_logs_start_query")).toBe(true);
		expect(isUnproductiveResult(QUERY_ID, "aws_logs_start_query")).toBe(false);
		// iam/throttle are terminal/transient, not loop-unproductive
		expect(isUnproductiveResult(IAM_ERROR, "aws_logs_start_query")).toBe(false);
	});

	test("after a retention rejection, the next start_query is short-circuited until describe_log_groups runs", () => {
		const state = createLoopGuardState();
		const sig1 = toolCallSignature("aws_logs_start_query", { logGroupName: "/ecs/x", startTime: 1, endTime: 2 });
		const sig2 = toolCallSignature("aws_logs_start_query", { logGroupName: "/ecs/x", startTime: 3, endTime: 4 });

		expect(shouldShortCircuit(state, "aws_logs_start_query", sig1)).toBe(false);
		recordResult(state, "aws_logs_start_query", sig1, RETENTION_ERROR);

		// re-anchor gate is armed: even a DIFFERENT window is blocked until describe runs
		expect(shouldShortCircuit(state, "aws_logs_start_query", sig2)).toBe(true);

		// an intervening describe_log_groups clears the gate
		recordResult(state, "aws_logs_describe_log_groups", "", "{}");
		expect(shouldShortCircuit(state, "aws_logs_start_query", sig2)).toBe(false);
	});

	test("an exact-duplicate start_query is short-circuited", () => {
		const state = createLoopGuardState();
		const sig = toolCallSignature("aws_logs_start_query", { logGroupName: "/ecs/x", startTime: 1, endTime: 2 });
		recordResult(state, "aws_logs_start_query", sig, QUERY_ID); // productive, but seen
		expect(shouldShortCircuit(state, "aws_logs_start_query", sig)).toBe(true);
	});

	test("stopMessageFor selects the AWS re-anchor message for start_query", () => {
		expect(stopMessageFor("aws_logs_start_query")).toBe(AWS_START_QUERY_STOP_MESSAGE);
		expect(stopMessageFor("elasticsearch_search")).toBe(LOOP_GUARD_STOP_MESSAGE);
	});
});

describe("non-guarded tools", () => {
	test("never short-circuit", () => {
		const state = createLoopGuardState();
		const sig = toolCallSignature("kafka_list_topics", {});
		recordResult(state, "kafka_list_topics", sig, EMPTY_SEARCH);
		recordResult(state, "kafka_list_topics", sig, EMPTY_SEARCH);
		expect(shouldShortCircuit(state, "kafka_list_topics", sig)).toBe(false);
	});
});
