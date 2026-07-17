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

	// SIO-1084 (finder-caught): parallel tool calls from one AIMessage could both pass
	// shouldShortCircuit before either records. Reserving the signature pre-invoke makes
	// the concurrent duplicate a detected loop. Still load-bearing under SIO-1090.
	test("reserveSignature makes a concurrent identical call a duplicate", () => {
		const state = createLoopGuardState();
		const sig = toolCallSignature("elasticsearch_search", NON_DISCOVERY);
		expect(shouldShortCircuit(state, "elasticsearch_search", sig, NON_DISCOVERY)).toBe(false);
		reserveSignature(state, "elasticsearch_search", sig);
		expect(shouldShortCircuit(state, "elasticsearch_search", sig, NON_DISCOVERY)).toBe(true);
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

	// SIO-1141: a retention rejection no longer blocks a DISTINCT (re-anchored) window. The
	// pre-SIO-1141 latch blocked every subsequent start_query until a describe ran, which
	// prevented the agent from correcting its window and left eu-oit-prd logs unretrieved.
	test("after a retention rejection, a re-anchored (distinct-window) start_query is ALLOWED", () => {
		const state = createLoopGuardState();
		const sig1 = toolCallSignature("aws_logs_start_query", { logGroupName: "/ecs/x", startTime: 1, endTime: 2 });
		const sig2 = toolCallSignature("aws_logs_start_query", { logGroupName: "/ecs/x", startTime: 3, endTime: 4 });

		expect(shouldShortCircuit(state, "aws_logs_start_query", sig1)).toBe(false);
		recordResult(state, "aws_logs_start_query", sig1, RETENTION_ERROR);

		// A DIFFERENT window is a genuine re-anchor attempt -- allow it (no describe required).
		expect(shouldShortCircuit(state, "aws_logs_start_query", sig2)).toBe(false);
		// The exact-same failed window is still blocked.
		expect(shouldShortCircuit(state, "aws_logs_start_query", sig1)).toBe(true);
	});

	// SIO-1141: describe -> corrected start_query still works (and resets the backstop counter).
	test("describe_log_groups then a corrected start_query is allowed", () => {
		const state = createLoopGuardState();
		const sig1 = toolCallSignature("aws_logs_start_query", { logGroupName: "/ecs/x", startTime: 1, endTime: 2 });
		const sig2 = toolCallSignature("aws_logs_start_query", { logGroupName: "/ecs/x", startRelative: "now-30d" });

		recordResult(state, "aws_logs_start_query", sig1, RETENTION_ERROR);
		recordResult(state, "aws_logs_describe_log_groups", "", "{}");
		expect(state.awsStartQueryUnproductive).toBe(0);
		expect(shouldShortCircuit(state, "aws_logs_start_query", sig2)).toBe(false);
	});

	// SIO-1141: termination backstop -- a permuter that keeps landing outside retention still
	// stops once the total unproductive-attempt cap is hit, even with all-distinct windows.
	test("distinct-window permuter stops at the unproductive-attempt cap", () => {
		const state = createLoopGuardState();
		let blocked = false;
		for (let i = 0; i < 12 && !blocked; i++) {
			const sig = toolCallSignature("aws_logs_start_query", { logGroupName: "/ecs/x", startTime: i, endTime: i + 1 });
			if (shouldShortCircuit(state, "aws_logs_start_query", sig)) {
				blocked = true;
				break;
			}
			recordResult(state, "aws_logs_start_query", sig, RETENTION_ERROR);
		}
		expect(blocked).toBe(true);
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
