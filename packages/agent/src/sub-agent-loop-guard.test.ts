// agent/src/sub-agent-loop-guard.test.ts

import { describe, expect, test } from "bun:test";
import {
	AWS_EMPTY_RESULTS_ADVICE,
	AWS_FAILED_QUERY_ADVICE,
	AWS_INVALID_QUERY_ID_ADVICE,
	AWS_SERVICE_ABSENT_STOP_MESSAGE,
	AWS_START_QUERY_STOP_MESSAGE,
	awsEcsAbsenceProven,
	awsErrorKind,
	consumeAbsenceExitLog,
	consumeEmptyAwsResultsAdvice,
	consumeFailedQueryAdvice,
	consumeGitlabCorrelationWidenAdvice,
	consumeInvalidQueryIdAdvice,
	createLoopGuardState,
	DUPLICATE_CALL_STOP_MESSAGE,
	GENERIC_LOOP_GUARD_STOP_MESSAGE,
	GITLAB_CORRELATION_WIDEN_ADVICE,
	isDiscoveryCall,
	isEmptyAwsQueryResults,
	isEmptyGitlabCorrelationResult,
	isFailedAwsQueryResults,
	isGuardedTool,
	isInvalidQueryIdResult,
	isObservedTool,
	isRecentCorrelationWindow,
	isUnproductiveResult,
	LOOP_GUARD_STOP_MESSAGE,
	type LoopGuardState,
	recordResult,
	reserveSignature,
	shouldShortCircuit,
	stopMessageFor,
	stopReasonFor,
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

	// SIO-1232: isObservedTool is now true for EVERY tool. It previously returned false for anything
	// outside the bespoke set, so recordResult never saw those tools' outcomes and they had no
	// termination guarantee at all -- which is how gitlab made 97 calls. isGuardedTool still marks
	// only the two tools with bespoke rulesets; everything else runs on the generic guard.
	test("every tool is observed; isGuardedTool still marks only the bespoke ones", () => {
		expect(isObservedTool("aws_logs_describe_log_groups")).toBe(true);
		expect(isObservedTool("kafka_list_topics")).toBe(true);
		expect(isObservedTool("gitlab_search")).toBe(true);
		expect(isGuardedTool("aws_logs_describe_log_groups")).toBe(false);
		expect(isGuardedTool("kafka_list_topics")).toBe(false);
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

	// SIO-1232: reserveSignature now records EVERY tool so the generic duplicate rule can see
	// concurrent identical calls. It previously no-opped outside the bespoke set.
	test("reserveSignature records non-bespoke tools too", () => {
		const state = createLoopGuardState();
		reserveSignature(state, "kafka_list_topics", "kafka_list_topics::{}");
		expect(state.seenSignatures.size).toBe(1);
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

// SIO-1232: tools without a bespoke ruleset used to have NO termination guarantee -- shouldShortCircuit
// returned false for them unconditionally. In the reported run gitlab reached iteration 97 (dozens of
// gitlab_search calls returning a bare `[]`) and only the 6-minute wall stopped it, after which
// alignment re-dispatched the whole sub-agent for another 360s.
describe("SIO-1232: generic loop guard for non-bespoke tools", () => {
	const EMPTY_ARRAY = "[]"; // gitlab_search's real empty shape: bytes: 2
	const REAL_RESULT = '[{"id":1,"name":"prana-order-service"}]';

	test("an exact-duplicate call is stopped", () => {
		const state = createLoopGuardState();
		const sig = toolCallSignature("gitlab_search", { search: "prana" });
		reserveSignature(state, "gitlab_search", sig);
		expect(shouldShortCircuit(state, "gitlab_search", sig)).toBe(true);
	});

	test("distinct args are allowed until the per-tool unproductive cap", () => {
		const state = createLoopGuardState();
		let stoppedAt = 0;
		for (let i = 1; i <= 10; i++) {
			const sig = toolCallSignature("gitlab_search", { search: `attempt-${i}` });
			if (shouldShortCircuit(state, "gitlab_search", sig)) {
				stoppedAt = i;
				break;
			}
			recordResult(state, "gitlab_search", sig, EMPTY_ARRAY);
		}
		// MAX_UNPRODUCTIVE_PER_TOOL = 3, so the 4th distinct empty attempt is refused.
		expect(stoppedAt).toBe(4);
	});

	test("a productive result clears that tool's unproductive streak", () => {
		const state = createLoopGuardState();
		for (let i = 1; i <= 3; i++) {
			recordResult(state, "gitlab_search", toolCallSignature("gitlab_search", { q: `e${i}` }), EMPTY_ARRAY);
		}
		recordResult(state, "gitlab_search", toolCallSignature("gitlab_search", { q: "hit" }), REAL_RESULT);
		expect(shouldShortCircuit(state, "gitlab_search", toolCallSignature("gitlab_search", { q: "next" }))).toBe(false);
	});

	test("the run-wide cap stops a permuter that rotates tool NAMES", () => {
		const state = createLoopGuardState();
		// Two empties each across four distinct tools stays under the per-tool cap of 3, but
		// MAX_UNPRODUCTIVE_PER_RUN = 8 must still terminate the run.
		for (const tool of ["gitlab_search", "gitlab_list_commits", "gitlab_get_repository_tree", "gitlab_blast_radius"]) {
			for (let i = 1; i <= 2; i++) {
				recordResult(state, tool, toolCallSignature(tool, { q: `${tool}-${i}` }), EMPTY_ARRAY);
			}
		}
		expect(state.totalUnproductive).toBe(8);
		expect(
			shouldShortCircuit(state, "gitlab_pipeline_failures", toolCallSignature("gitlab_pipeline_failures", {})),
		).toBe(true);
	});

	test("a non-bespoke tool gets the generic stop message, never the elastic one", () => {
		expect(stopMessageFor("gitlab_search")).toBe(GENERIC_LOOP_GUARD_STOP_MESSAGE);
		// The elastic message talks about indices/patterns and the service.name discovery agg,
		// so handing it to a gitlab or kafka tool would be actively misleading.
		expect(stopMessageFor("elasticsearch_search")).toBe(LOOP_GUARD_STOP_MESSAGE);
		expect(stopMessageFor("aws_logs_start_query")).toBe(AWS_START_QUERY_STOP_MESSAGE);
	});

	// SIO-1267: the generic message used to be a disjunction ("this exact call was already made, OR
	// this tool has returned nothing useful several times") handed to BOTH branches. On run 2445908e
	// all 8 gitlab_search stops were DUPLICATE stops -- every one logged `unproductiveSearches: 0` --
	// but project-resolution/SKILL.md STEP 3 keys its escape hatch on the second clause, so the model
	// was told to report "resolution was not attempted ... after repeated empty results". False.
	describe("SIO-1267 duplicate vs unproductive-streak attribution", () => {
		const args = { scope: "projects", search: "styles" };
		const sig = toolCallSignature("gitlab_search", args);

		test("a duplicate-signature stop gets the duplicate message", () => {
			const state = createLoopGuardState();
			reserveSignature(state, "gitlab_search", sig);
			expect(shouldShortCircuit(state, "gitlab_search", sig)).toBe(true);
			expect(stopReasonFor(state, sig)).toBe("duplicate-call");
			expect(stopMessageFor("gitlab_search", state, sig)).toBe(DUPLICATE_CALL_STOP_MESSAGE);
		});

		test("an unproductive-streak stop keeps the streak message", () => {
			const state = createLoopGuardState();
			// Three distinct empty calls -> the per-tool streak cap, without any repeat.
			for (let i = 0; i < 3; i++) {
				const a = { search: `blob-${i}` };
				recordResult(
					state,
					"gitlab_search",
					toolCallSignature("gitlab_search", a),
					`No code matches found for "b${i}"`,
				);
			}
			// A FRESH signature: not a duplicate, so only the streak rule can fire.
			expect(shouldShortCircuit(state, "gitlab_search", sig)).toBe(true);
			expect(stopReasonFor(state, sig)).toBe("unproductive-streak");
			expect(stopMessageFor("gitlab_search", state, sig)).toBe(GENERIC_LOOP_GUARD_STOP_MESSAGE);
		});

		test("the duplicate message does NOT claim the tool returned nothing", () => {
			// This is the whole defect: SKILL.md STEP 3 matches on that phrase and converts it into
			// "resolution was not attempted ... after repeated empty results".
			expect(DUPLICATE_CALL_STOP_MESSAGE).not.toContain("returned nothing useful several times");
			expect(DUPLICATE_CALL_STOP_MESSAGE).toContain("already in your context");
			expect(DUPLICATE_CALL_STOP_MESSAGE).toContain("NOT a failure");
		});

		test("the streak message keeps the wording project-resolution/SKILL.md STEP 3 keys on", () => {
			// Pinned coupling: STEP 3's escape hatch was written for THIS branch and must keep matching
			// it. sub-agent-focus-block.test.ts asserts the SKILL.md side of the same contract.
			expect(GENERIC_LOOP_GUARD_STOP_MESSAGE).toContain("returned nothing useful several times");
		});

		test("duplicate wins over streak, matching shouldShortCircuit's own precedence", () => {
			const state = createLoopGuardState();
			for (let i = 0; i < 3; i++) {
				const a = { search: `blob-${i}` };
				recordResult(
					state,
					"gitlab_search",
					toolCallSignature("gitlab_search", a),
					`No code matches found for "b${i}"`,
				);
			}
			// Now ALSO a duplicate. shouldShortCircuit checks seenSignatures first, so must the message.
			const dupSig = toolCallSignature("gitlab_search", { search: "blob-0" });
			expect(stopReasonFor(state, dupSig)).toBe("duplicate-call");
			expect(stopMessageFor("gitlab_search", state, dupSig)).toBe(DUPLICATE_CALL_STOP_MESSAGE);
		});

		test("without a signature the caller gets the streak message, as before", () => {
			// Back-compat: the 1- and 2-arg call sites and the bespoke tools are unchanged.
			const state = createLoopGuardState();
			expect(stopMessageFor("gitlab_search")).toBe(GENERIC_LOOP_GUARD_STOP_MESSAGE);
			expect(stopMessageFor("gitlab_search", state)).toBe(GENERIC_LOOP_GUARD_STOP_MESSAGE);
			expect(stopReasonFor(undefined, undefined)).toBe("unproductive-streak");
		});

		test("the bespoke tools keep their domain-specific message even on a duplicate", () => {
			// Both carry concrete recovery instructions (re-anchor the window / use the discovery
			// agg) that a generic duplicate notice would throw away.
			const state = createLoopGuardState();
			const esSig = toolCallSignature("elasticsearch_search", { index: "logs-*" });
			reserveSignature(state, "elasticsearch_search", esSig);
			expect(stopMessageFor("elasticsearch_search", state, esSig)).toBe(LOOP_GUARD_STOP_MESSAGE);
			const awsSig = toolCallSignature("aws_logs_start_query", { logGroupName: "/aws/ecs/x" });
			reserveSignature(state, "aws_logs_start_query", awsSig);
			expect(stopMessageFor("aws_logs_start_query", state, awsSig)).toBe(AWS_START_QUERY_STOP_MESSAGE);
		});
	});

	// NON-NEGOTIABLE: aws_logs_get_query_results MUST be re-polled with the SAME queryId while the
	// query is Running/Scheduled. Applying the generic duplicate rule to it would break every
	// CloudWatch Insights investigation, and the SIO-1159 consecutive-empty advice depends on the
	// repeat being allowed through.
	test("aws_logs_get_query_results is exempt from the duplicate rule (polling)", () => {
		const state = createLoopGuardState();
		const sig = toolCallSignature("aws_logs_get_query_results", { queryId: "q-123" });
		reserveSignature(state, "aws_logs_get_query_results", sig);
		expect(shouldShortCircuit(state, "aws_logs_get_query_results", sig)).toBe(false);
		// ...and repeated in-flight polls never accrue unproductive counts either.
		const inFlight = JSON.stringify({ status: "Running", results: [] });
		for (let i = 0; i < 6; i++) recordResult(state, "aws_logs_get_query_results", sig, inFlight);
		expect(state.totalUnproductive).toBe(0);
		expect(shouldShortCircuit(state, "aws_logs_get_query_results", sig)).toBe(false);
	});

	// CodeRabbit (PR #482): the exemption originally covered the duplicate check ONLY, so the
	// run-wide backstop could still block these two. The test above could not catch it because it
	// starts from a fresh state -- the leak only manifests from OTHER tools' activity, i.e. exactly
	// the runaway this guard exists to bound. In the reported run the gitlab spam would have
	// silently killed an in-flight CloudWatch poll and the SIO-1141 re-anchor recovery.
	test("protocol/recovery tools stay callable after other tools exhaust the run-wide cap", () => {
		const state = createLoopGuardState();
		for (const tool of ["gitlab_search", "gitlab_list_commits", "gitlab_get_repository_tree", "gitlab_blast_radius"]) {
			for (let i = 1; i <= 2; i++) {
				recordResult(state, tool, toolCallSignature(tool, { q: `${tool}-${i}` }), "[]");
			}
		}
		expect(state.totalUnproductive).toBe(8); // at MAX_UNPRODUCTIVE_PER_RUN

		// The in-flight poll must still go through, or the Insights query is abandoned mid-flight.
		const poll = toolCallSignature("aws_logs_get_query_results", { queryId: "q-123" });
		expect(shouldShortCircuit(state, "aws_logs_get_query_results", poll)).toBe(false);

		// ...and so must the re-anchor recovery call for a rejected start_query window.
		const describe = toolCallSignature("aws_logs_describe_log_groups", { logGroupNamePrefix: "/aws/ecs" });
		expect(shouldShortCircuit(state, "aws_logs_describe_log_groups", describe)).toBe(false);

		// An ordinary tool is still stopped -- the exemption is targeted, not a hole in the cap.
		expect(
			shouldShortCircuit(state, "gitlab_pipeline_failures", toolCallSignature("gitlab_pipeline_failures", {})),
		).toBe(true);
	});

	// Neither exempt tool can CONTRIBUTE to the counters (recordResult early-returns for both before
	// the generic accounting), so being blocked BY a counter they cannot raise was incoherent.
	test("exempt tools never contribute to the generic counters", () => {
		const state = createLoopGuardState();
		for (let i = 0; i < 5; i++) {
			recordResult(state, "aws_logs_describe_log_groups", toolCallSignature("aws_logs_describe_log_groups", {}), "[]");
			recordResult(state, "aws_logs_get_query_results", toolCallSignature("aws_logs_get_query_results", {}), "[]");
		}
		expect(state.totalUnproductive).toBe(0);
		expect(state.unproductiveByTool.size).toBe(0);
	});
});

// SIO-1159: a successful-but-empty CloudWatch result ({status:"Complete",results:[]})
// carries no _error, so the SIO-1141 machinery ignores it -- run 270378e0 queried a
// 24h window that silently missed a 2-day-old incident. After 2 consecutive empties
// the guard emits one-shot widen advice.
describe("SIO-1159: empty-success aws_logs_get_query_results advice", () => {
	const TOOL = "aws_logs_get_query_results";
	const EMPTY_RESULT = JSON.stringify({
		queryLanguage: "CWLI",
		results: [],
		statistics: { recordsMatched: 0 },
		status: "Complete",
		$metadata: {},
	});
	const NONEMPTY_RESULT = JSON.stringify({
		results: [[{ field: "@message", value: "CatalogException" }]],
		status: "Complete",
	});
	const RUNNING_RESULT = JSON.stringify({ results: [], status: "Running" });

	test("detects Complete-with-0-rows; Running and non-empty are not empty-success", () => {
		expect(isEmptyAwsQueryResults(EMPTY_RESULT)).toBe(true);
		expect(isEmptyAwsQueryResults(NONEMPTY_RESULT)).toBe(false);
		expect(isEmptyAwsQueryResults(RUNNING_RESULT)).toBe(false);
	});

	test("tool is observed so recordResult sees its outcomes", () => {
		expect(isObservedTool(TOOL)).toBe(true);
		expect(isGuardedTool(TOOL)).toBe(false); // nudge-only: never short-circuits
	});

	test("advice fires after 2 consecutive empties and only once", () => {
		const state = createLoopGuardState();
		recordResult(state, TOOL, "", EMPTY_RESULT);
		expect(consumeEmptyAwsResultsAdvice(state)).toBeNull();
		recordResult(state, TOOL, "", EMPTY_RESULT);
		expect(consumeEmptyAwsResultsAdvice(state)).toBe(AWS_EMPTY_RESULTS_ADVICE);
		// consumed -- the next call without new empties gets no advice
		expect(consumeEmptyAwsResultsAdvice(state)).toBeNull();
	});

	test("a non-empty result resets the consecutive counter", () => {
		const state = createLoopGuardState();
		recordResult(state, TOOL, "", EMPTY_RESULT);
		recordResult(state, TOOL, "", NONEMPTY_RESULT);
		recordResult(state, TOOL, "", EMPTY_RESULT);
		expect(consumeEmptyAwsResultsAdvice(state)).toBeNull();
	});

	test("a Running poll is NEUTRAL: interleaved polling neither counts nor resets", () => {
		// The real call pattern is start_query -> get_query_results(Running)* ->
		// get_query_results(Complete). If Running reset the counter, two consecutive
		// empty queries with interleaved polls could never reach the threshold.
		const state = createLoopGuardState();
		recordResult(state, TOOL, "", EMPTY_RESULT);
		recordResult(state, TOOL, "", RUNNING_RESULT);
		recordResult(state, TOOL, "", EMPTY_RESULT);
		expect(consumeEmptyAwsResultsAdvice(state)).toBe(AWS_EMPTY_RESULTS_ADVICE);
	});

	test("get_query_results outcomes do not disturb the start_query re-anchor state", () => {
		const state = createLoopGuardState();
		recordResult(state, TOOL, "", EMPTY_RESULT);
		recordResult(state, TOOL, "", EMPTY_RESULT);
		expect(state.awsStartQueryUnproductive).toBe(0);
		expect(state.awsStartQueryNeedsReanchor).toBe(false);
	});
});

// SIO-1329: GetQueryResultsResponse.status can be Failed/Cancelled/Timeout -- a genuinely
// FAILED query that AWS still returns as HTTP 200 (no thrown exception, so mapAwsError/
// awsErrorKind never runs). Before this fix, isEmptyAwsQueryResults only recognized
// status:"Complete", so a Failed/Timeout/Cancelled result fell into recordResult's
// `!isInFlightAwsQueryResults` else-branch and silently RESET awsEmptyQueryResults to 0 --
// worse than a no-op, since it erased any accumulated empty-streak progress and emitted no
// signal that the query never actually ran to completion. A rejected aggregation must not
// be indistinguishable from a genuine 0-row success (same class of bug as SIO-1328's
// Elasticsearch _shards.failed swallow).
describe("SIO-1329: failed/timeout/cancelled aws_logs_get_query_results advice", () => {
	const TOOL = "aws_logs_get_query_results";
	const FAILED_RESULT = JSON.stringify({ results: [], status: "Failed", $metadata: {} });
	const TIMEOUT_RESULT = JSON.stringify({ results: [], status: "Timeout", $metadata: {} });
	const CANCELLED_RESULT = JSON.stringify({ results: [], status: "Cancelled", $metadata: {} });
	const COMPLETE_EMPTY_RESULT = JSON.stringify({ results: [], status: "Complete", $metadata: {} });
	const COMPLETE_NONEMPTY_RESULT = JSON.stringify({
		results: [[{ field: "@message", value: "CatalogException" }]],
		status: "Complete",
	});

	test("detects Failed/Timeout/Cancelled; Complete (empty or not) is never a failed result", () => {
		expect(isFailedAwsQueryResults(FAILED_RESULT)).toBe(true);
		expect(isFailedAwsQueryResults(TIMEOUT_RESULT)).toBe(true);
		expect(isFailedAwsQueryResults(CANCELLED_RESULT)).toBe(true);
		expect(isFailedAwsQueryResults(COMPLETE_EMPTY_RESULT)).toBe(false);
		expect(isFailedAwsQueryResults(COMPLETE_NONEMPTY_RESULT)).toBe(false);
	});

	test("a Failed status is never misclassified as an empty-success", () => {
		expect(isEmptyAwsQueryResults(FAILED_RESULT)).toBe(false);
		expect(isEmptyAwsQueryResults(TIMEOUT_RESULT)).toBe(false);
		expect(isEmptyAwsQueryResults(CANCELLED_RESULT)).toBe(false);
	});

	test("advice fires on the FIRST failed/timeout/cancelled result and only once", () => {
		const state = createLoopGuardState();
		recordResult(state, TOOL, "", FAILED_RESULT);
		expect(consumeFailedQueryAdvice(state)).toBe(AWS_FAILED_QUERY_ADVICE);
		expect(consumeFailedQueryAdvice(state)).toBeNull();
	});

	test("a failed/timeout/cancelled result does NOT silently reset the consecutive-empty counter", () => {
		// Before the fix: Failed fell into the `!isInFlightAwsQueryResults` branch and zeroed
		// awsEmptyQueryResults, erasing a genuine 0-row streak's progress toward the widen advice.
		const state = createLoopGuardState();
		recordResult(state, TOOL, "", COMPLETE_EMPTY_RESULT);
		recordResult(state, TOOL, "", FAILED_RESULT);
		recordResult(state, TOOL, "", COMPLETE_EMPTY_RESULT);
		expect(consumeEmptyAwsResultsAdvice(state)).toBe(AWS_EMPTY_RESULTS_ADVICE);
	});

	test("a failed result is not also counted as empty-success", () => {
		const state = createLoopGuardState();
		recordResult(state, TOOL, "", FAILED_RESULT);
		expect(consumeEmptyAwsResultsAdvice(state)).toBeNull();
	});
});

describe("SIO-1162: invalid-queryId aws_logs_get_query_results advice", () => {
	const TOOL = "aws_logs_get_query_results";
	const INVALID_ID_RESULT = JSON.stringify({
		_error: { kind: "bad-input", category: "unknown", message: "The provided queryId = 8f33ec7e-... is invalid" },
	});
	const RESOURCE_NOT_FOUND_RESULT = JSON.stringify({
		_error: { kind: "resource-not-found", category: "not-found", message: "queryId expired" },
	});
	const EMPTY_RESULT = JSON.stringify({ results: [], status: "Complete" });
	const RUNNING_RESULT = JSON.stringify({ results: [], status: "Running" });

	test("detects invalid-queryId on bad-input and resource-not-found _error kinds only", () => {
		expect(isInvalidQueryIdResult(INVALID_ID_RESULT)).toBe(true);
		expect(isInvalidQueryIdResult(RESOURCE_NOT_FOUND_RESULT)).toBe(true);
		expect(isInvalidQueryIdResult(EMPTY_RESULT)).toBe(false);
		expect(isInvalidQueryIdResult(RUNNING_RESULT)).toBe(false);
	});

	test("advice fires on the FIRST invalid-id result and only once", () => {
		const state = createLoopGuardState();
		recordResult(state, TOOL, "", INVALID_ID_RESULT);
		expect(consumeInvalidQueryIdAdvice(state)).toBe(AWS_INVALID_QUERY_ID_ADVICE);
		// consumed -- a subsequent call without a new invalid id gets no advice
		expect(consumeInvalidQueryIdAdvice(state)).toBeNull();
	});

	test("an invalid id resets the consecutive-empty counter (error is not empty-success)", () => {
		const state = createLoopGuardState();
		recordResult(state, TOOL, "", EMPTY_RESULT);
		recordResult(state, TOOL, "", INVALID_ID_RESULT);
		recordResult(state, TOOL, "", EMPTY_RESULT);
		// only one empty since the reset -> widen advice must NOT fire
		expect(consumeEmptyAwsResultsAdvice(state)).toBeNull();
		// but the invalid-id advice from the middle call is still pending
		expect(consumeInvalidQueryIdAdvice(state)).toBe(AWS_INVALID_QUERY_ID_ADVICE);
	});

	test("no invalid id -> no advice", () => {
		const state = createLoopGuardState();
		recordResult(state, TOOL, "", EMPTY_RESULT);
		expect(consumeInvalidQueryIdAdvice(state)).toBeNull();
	});
});

// SIO-1259: isUnproductiveResult had no `contentType === "string"` branch, so ANY non-empty prose
// was PRODUCTIVE -- and a productive result RESETS that tool's streak (recordResult). gitlab_search
// returns its empty answer as PROSE, not `[]`, so every miss silently cleared the counter the
// SIO-1232/SIO-1246 guard depends on. In run cbada913-d22f-4618-826b-0c4c38fd8956, gitlab_search
// ran seven times and four returned 72-114 byte "nothing found" strings that all counted as hits.
describe("SIO-1259: short prose 'nothing found' results are unproductive", () => {
	// VERBATIM shape from packages/mcp-server-gitlab/src/tools/proxy/index.ts, the 0-hit blob-search
	// branch: `No code matches found for "${search}" in project ${projectId}`. Fixed cost 40 bytes.
	// The length assertions are the arithmetic that identifies the run's 72- and 78-byte
	// gitlab_search results as THIS string and nothing else -- if the template is ever reworded,
	// these fail and point straight at the source line.
	const GITLAB_NO_MATCH_72 = 'No code matches found for "RequestCanceledException" in project 12345678';
	const GITLAB_NO_MATCH_78 = 'No code matches found for "CHANNEL_CLOSED_WHILE_IN_FLIGHT" in project 12345678';

	test("the in-repo gitlab blob-search empty template is unproductive", () => {
		expect(GITLAB_NO_MATCH_72.length).toBe(72);
		expect(GITLAB_NO_MATCH_78.length).toBe(78);
		expect(isUnproductiveResult(GITLAB_NO_MATCH_72, "gitlab_search")).toBe(true);
		expect(isUnproductiveResult(GITLAB_NO_MATCH_78, "gitlab_search")).toBe(true);
	});

	test("other in-repo empty-prose templates are unproductive", () => {
		for (const s of [
			"No playbooks found",
			"No results found for this query.",
			"No documents found in inventory.stock to infer schema.",
			"No indices found matching pattern: logs-*",
		]) {
			expect(isUnproductiveResult(s)).toBe(true);
		}
	});

	// THE REGRESSION THIS MUST NOT CAUSE. Each of these is a SHORT, DEFINITIVE, data-bearing answer
	// and a pure length threshold would have swallowed all four. Sources: elastic
	// index_exists.ts/document_exists.ts ("Exists: true", 12 bytes), couchbase pingHandler.ts, and
	// couchbase runSqlPlusPlusQuery.ts.
	test("short definitive answers stay productive", () => {
		expect(isUnproductiveResult("Exists: true")).toBe(false);
		expect(isUnproductiveResult("Exists: false")).toBe(false);
		expect(isUnproductiveResult("Server and database are healthy")).toBe(false);
		expect(isUnproductiveResult("Found 7 distinct sources")).toBe(false);
	});

	// The header+payload multi-block shape. coalesceTextBlocks JOINS these, so the guard sees one
	// string that OPENS with prose. Saved by the "no keyword before the first period" rule, not by
	// the byte ceiling -- from elastic get_nodes_info.
	test("a prose header block followed by a real payload stays productive", () => {
		const blocks = [
			{
				type: "text",
				text: "No parameters specified. Returning node names only. Use {metric: 'os,jvm'} for basic info.",
			},
			{ type: "text", text: JSON.stringify({ nodes: { a1: { name: "node-1" }, a2: { name: "node-2" } } }) },
		];
		expect(isUnproductiveResult(blocks, "elasticsearch_get_nodes_info")).toBe(false);
	});

	// ...and the case the BYTE CEILING is for: a matching opener followed by real data.
	test("a matching opener followed by a real payload stays productive (byte ceiling)", () => {
		const rows = Array.from({ length: 20 }, (_, i) => ({ path: `src/f${i}.ts`, line: i }));
		const text = `No exact matches found for "boom" -- showing near matches:\n\n${JSON.stringify(rows)}`;
		expect(text.length).toBeGreaterThan(400);
		expect(isUnproductiveResult(text, "gitlab_search")).toBe(false);
	});

	// A JSON payload that happens to contain the phrase must be judged on its parsed shape.
	test("a JSON payload containing the phrase is judged on shape, not prose", () => {
		expect(isUnproductiveResult('[{"title":"No results found for this query."}]', "gitlab_search")).toBe(false);
	});

	// aws_logs_start_query keeps its bespoke _error-envelope rule and is never judged on prose.
	test("aws_logs_start_query is unaffected by the prose rule", () => {
		expect(isUnproductiveResult("No matching log events found", "aws_logs_start_query")).toBe(false);
	});

	// SIO-1232 documented gitlab_search's `[]` shape; that path must not regress.
	test("the JSON empty shapes still classify as before", () => {
		expect(isUnproductiveResult("[]")).toBe(true);
		expect(isUnproductiveResult("Total results: 0, showing 0 from position 0")).toBe(true);
	});
});

describe("SIO-1259: streak semantics are deliberately unchanged", () => {
	// The per-tool counter stays a STREAK. Four misses interleaved with three hits never reaches
	// MAX_UNPRODUCTIVE_PER_TOOL -- and that is CORRECT, because
	// list -> empty -> narrower list -> hit -> drill -> empty is what a WORKING investigation looks
	// like. A cumulative per-tool counter would strangle exactly the enumerators every other call
	// depends on. MAX_UNPRODUCTIVE_PER_RUN is the real backstop, and this fix is what lets prose
	// misses reach it at all.
	test("interleaved misses do not trip the per-tool streak, but ARE counted run-wide", () => {
		const state = createLoopGuardState();
		const miss = 'No code matches found for "x" in project 1';
		const hit = '[{"path":"src/a.ts"}]';
		for (let i = 0; i < 4; i++) {
			recordResult(state, "gitlab_search", toolCallSignature("gitlab_search", { search: `m${i}` }), miss);
			if (i < 3) recordResult(state, "gitlab_search", toolCallSignature("gitlab_search", { search: `h${i}` }), hit);
		}
		expect(shouldShortCircuit(state, "gitlab_search", toolCallSignature("gitlab_search", { search: "n" }))).toBe(false);
		// Before this fix every `miss` was PRODUCTIVE and this was 0.
		expect(state.totalUnproductive).toBe(4);
	});

	// PR #482 (CodeRabbit): the two AWS protocol/recovery tools bypass EVERY generic rule, including
	// the run-wide backstop. This fix makes totalUnproductive rise FASTER, so pin the carve-out
	// against the new classification specifically.
	test("exempt AWS tools survive a run-wide cap reached via PROSE misses", () => {
		const state = createLoopGuardState();
		const miss = 'No code matches found for "x" in project 1';
		for (const t of ["gitlab_search", "gitlab_list_commits", "gitlab_get_repository_tree", "gitlab_blast_radius"]) {
			for (let i = 1; i <= 2; i++) recordResult(state, t, toolCallSignature(t, { q: `${t}-${i}` }), miss);
		}
		expect(state.totalUnproductive).toBe(8);
		const poll = toolCallSignature("aws_logs_get_query_results", { queryId: "q-1" });
		expect(shouldShortCircuit(state, "aws_logs_get_query_results", poll)).toBe(false);
		const describeCall = toolCallSignature("aws_logs_describe_log_groups", { logGroupNamePrefix: "/aws/ecs" });
		expect(shouldShortCircuit(state, "aws_logs_describe_log_groups", describeCall)).toBe(false);
	});
});

// SIO-1268: run 2445908e -- the estate WITHOUT the focus service cost 191s / 78 messages / peak
// iteration 59 of 60, against 117s / 29 messages for the estate that HAD it. The agent had the
// decisive evidence by ~iteration 15 (list_clusters + list_services across all 7 clusters matched
// nothing) and spent the rest re-confirming a negative via CloudWatch Insights.
describe("SIO-1268: complete-ECS-enumeration absence early exit", () => {
	const FOCUS = ["order-service"];
	const CLUSTER_ARN = (n: string) => `arn:aws:ecs:eu-west-1:123456789012:cluster/${n}`;
	const SERVICE_ARN = (c: string, s: string) => `arn:aws:ecs:eu-west-1:123456789012:service/${c}/${s}`;
	const clustersPage = (names: string[], nextToken?: string) =>
		JSON.stringify({
			clusterArns: names.map(CLUSTER_ARN),
			...(nextToken ? { nextToken } : {}),
			$metadata: { httpStatusCode: 200 },
		});
	const servicesPage = (cluster: string, svcs: string[], nextToken?: string) =>
		JSON.stringify({ serviceArns: svcs.map((s) => SERVICE_ARN(cluster, s)), ...(nextToken ? { nextToken } : {}) });

	const enabledState = () => createLoopGuardState({ awsAbsenceEarlyExit: true, focusServices: FOCUS });
	const record = (state: LoopGuardState, tool: string, content: string, args: unknown) =>
		recordResult(state, tool, toolCallSignature(tool, args), content, args);

	// The eu-oit-prd shape, reduced to two clusters.
	function walkCleanEstate(state: LoopGuardState) {
		record(state, "aws_ecs_list_clusters", clustersPage(["shared-a", "shared-b"]), {});
		record(state, "aws_ecs_list_services", servicesPage("shared-a", ["billing-api"]), {
			cluster: CLUSTER_ARN("shared-a"),
		});
		record(state, "aws_ecs_list_services", servicesPage("shared-b", []), { cluster: "shared-b" });
	}

	test("a complete, clean, unmatched enumeration proves absence", () => {
		const state = enabledState();
		expect(awsEcsAbsenceProven(state)).toBe(false);
		walkCleanEstate(state);
		expect(awsEcsAbsenceProven(state)).toBe(true);
	});

	// SIO-1272: the run-wide backstop pre-empted the exit. On run eaebc62b
	// aws_ecs_list_clusters was stopped with reason "unproductive-streak" after only TWO calls
	// -- far below MAX_UNPRODUCTIVE_PER_TOOL -- because OTHER tools had spent the run-wide
	// budget. That stop latches awsEcs.failed, so the exit was not delayed but destroyed.
	describe("SIO-1272: the counter-driven caps do not bind ECS enumeration", () => {
		// Mirrors the L319 permuter test: four unrelated tools x2 empties = 8, the run-wide cap.
		function exhaustRunWideBudget(state: LoopGuardState) {
			for (const tool of [
				"gitlab_search",
				"gitlab_list_commits",
				"gitlab_get_repository_tree",
				"gitlab_blast_radius",
			]) {
				for (let i = 1; i <= 2; i++) {
					recordResult(state, tool, toolCallSignature(tool, { q: `${tool}-${i}` }), "[]");
				}
			}
			return state;
		}

		test("an ECS list is NOT blocked by totalUnproductive raised by other tools", () => {
			const state = exhaustRunWideBudget(enabledState());
			// Anti-vacuity: the backstop really is armed.
			expect(state.totalUnproductive).toBeGreaterThanOrEqual(8);
			expect(shouldShortCircuit(state, "aws_ecs_list_clusters", toolCallSignature("aws_ecs_list_clusters", {}))).toBe(
				false,
			);
			expect(
				shouldShortCircuit(
					state,
					"aws_ecs_list_services",
					toolCallSignature("aws_ecs_list_services", { cluster: "shared-a" }),
				),
			).toBe(false);
		});

		// THE REGRESSION GUARD. The obvious fix -- adding these tools to
		// GENERIC_GUARD_EXEMPT_TOOLS -- would return false at that check, which runs FIRST and
		// unconditionally, bypassing the absence block and silently disabling SIO-1268 entirely.
		test("a proven absence STILL blocks an ECS list call", () => {
			const state = enabledState();
			walkCleanEstate(state);
			expect(awsEcsAbsenceProven(state)).toBe(true);
			expect(
				shouldShortCircuit(state, "aws_ecs_list_clusters", toolCallSignature("aws_ecs_list_clusters", { fresh: 1 })),
			).toBe(true);
			expect(
				shouldShortCircuit(
					state,
					"aws_ecs_list_services",
					toolCallSignature("aws_ecs_list_services", { cluster: "fresh" }),
				),
			).toBe(true);
		});

		test("an exact-duplicate ECS list is still stopped", () => {
			const state = enabledState();
			const sig = toolCallSignature("aws_ecs_list_services", { cluster: "shared-a" });
			reserveSignature(state, "aws_ecs_list_services", sig);
			expect(shouldShortCircuit(state, "aws_ecs_list_services", sig)).toBe(true);
		});

		// The live scenario end to end: a busy estate must still reach the exit.
		test("a spent run-wide budget no longer destroys the exit mid-enumeration", () => {
			const state = exhaustRunWideBudget(enabledState());
			const calls: Array<[string, unknown]> = [
				["aws_ecs_list_clusters", {}],
				["aws_ecs_list_services", { cluster: CLUSTER_ARN("shared-a") }],
				["aws_ecs_list_services", { cluster: "shared-b" }],
			];
			for (const [tool, args] of calls) {
				expect(shouldShortCircuit(state, tool, toolCallSignature(tool, args), args)).toBe(false);
			}
			walkCleanEstate(state);
			expect(state.awsEcs.failed).toBe(false);
			expect(awsEcsAbsenceProven(state)).toBe(true);
		});

		// Scope pin: only the two LEDGER tools are exempt. The consumers of the conclusion can
		// genuinely return unproductive results and keep the backstop.
		test("a non-ledger ECS tool is STILL bound by the run-wide backstop", () => {
			const state = exhaustRunWideBudget(enabledState());
			for (const tool of ["aws_ecs_describe_services", "aws_ecs_list_tasks", "aws_ecs_describe_tasks"]) {
				expect(shouldShortCircuit(state, tool, toolCallSignature(tool, { fresh: tool }))).toBe(true);
			}
		});

		// The per-tool cap is a no-op for these tools today (empty ECS lists are classified
		// PRODUCTIVE on purpose), but the exemption makes that invariant explicit rather than
		// leaving the exit one classifier change away from breaking.
		test("an ECS list is not blocked by the per-tool unproductive cap either", () => {
			const state = enabledState();
			state.unproductiveByTool.set("aws_ecs_list_services", 99);
			expect(
				shouldShortCircuit(
					state,
					"aws_ecs_list_services",
					toolCallSignature("aws_ecs_list_services", { cluster: "x" }),
				),
			).toBe(false);
		});
	});

	test("cluster ARNs and short cluster names key the SAME cluster", () => {
		// list_clusters returns ARNs; the `cluster` arg may be either form ("Short name or full
		// ARN"). Without last-segment normalization servicesComplete never intersects clusters and
		// the exit could never fire at all.
		const state = enabledState();
		walkCleanEstate(state);
		expect(state.awsEcs.servicesComplete.has("shared-a")).toBe(true);
		expect(state.awsEcs.servicesComplete.has("shared-b")).toBe(true);
	});

	test("a matching SERVICE name suppresses the exit", () => {
		const state = enabledState();
		record(state, "aws_ecs_list_clusters", clustersPage(["shared-a"]), {});
		record(state, "aws_ecs_list_services", servicesPage("shared-a", ["order-service"]), { cluster: "shared-a" });
		expect(state.awsEcs.matched).toBe(true);
		expect(awsEcsAbsenceProven(state)).toBe(false);
	});

	test("a matching CLUSTER name suppresses the exit", () => {
		const state = enabledState();
		record(state, "aws_ecs_list_clusters", clustersPage(["order-service-cluster"]), {});
		record(state, "aws_ecs_list_services", servicesPage("order-service-cluster", []), {
			cluster: "order-service-cluster",
		});
		expect(awsEcsAbsenceProven(state)).toBe(false);
	});

	// ---- SAFETY CORE: a PARTIAL enumeration must NEVER exit. Suppressing a real finding is
	// strictly worse than the wasted iterations this ticket fixes.
	test("an unwalked cluster blocks the exit", () => {
		const state = enabledState();
		record(state, "aws_ecs_list_clusters", clustersPage(["a", "b", "c"]), {});
		record(state, "aws_ecs_list_services", servicesPage("a", []), { cluster: "a" });
		record(state, "aws_ecs_list_services", servicesPage("b", []), { cluster: "b" });
		expect(awsEcsAbsenceProven(state)).toBe(false);
	});

	test("an unwalked list_clusters page blocks the exit", () => {
		const state = enabledState();
		record(state, "aws_ecs_list_clusters", clustersPage(["a"], "TOKEN"), {});
		record(state, "aws_ecs_list_services", servicesPage("a", []), { cluster: "a" });
		expect(state.awsEcs.clusterPagesComplete).toBe(false);
		expect(awsEcsAbsenceProven(state)).toBe(false);
	});

	test("an unwalked list_services page blocks the exit", () => {
		const state = enabledState();
		record(state, "aws_ecs_list_clusters", clustersPage(["a"]), {});
		record(state, "aws_ecs_list_services", servicesPage("a", ["x"], "TOKEN"), { cluster: "a" });
		expect(awsEcsAbsenceProven(state)).toBe(false);
	});

	test("a byte-truncated page with NO cursor (Case B) blocks the exit permanently", () => {
		// wrap.ts Case B has no continuation token but still dropped items. Treating it as final
		// would be exactly the partial-enumeration false positive this must not produce.
		const state = enabledState();
		record(
			state,
			"aws_ecs_list_clusters",
			JSON.stringify({
				clusterArns: [CLUSTER_ARN("a")],
				_truncated: { shown: 1, total: 40, advice: "Byte-truncated to fit the size cap..." },
			}),
			{},
		);
		record(state, "aws_ecs_list_services", servicesPage("a", []), { cluster: "a" });
		expect(state.awsEcs.failed).toBe(true);
		expect(awsEcsAbsenceProven(state)).toBe(false);
	});

	test("an _error on any ECS list call latches the exit off permanently", () => {
		const state = enabledState();
		record(state, "aws_ecs_list_clusters", clustersPage(["a", "b"]), {});
		record(state, "aws_ecs_list_services", servicesPage("a", []), { cluster: "a" });
		record(state, "aws_ecs_list_services", JSON.stringify({ _error: { kind: "iam-permission-missing" } }), {
			cluster: "b",
		});
		expect(awsEcsAbsenceProven(state)).toBe(false);
		// Latched: a later clean re-list must not resurrect the exit.
		record(state, "aws_ecs_list_services", servicesPage("b", []), { cluster: "b" });
		expect(awsEcsAbsenceProven(state)).toBe(false);
	});

	test("an estate with ZERO clusters is NOT treated as proof", () => {
		// Shape-identical to a scoping/permission artifact; SIO-834 requires the inventory path
		// there, not an early exit.
		const state = enabledState();
		record(state, "aws_ecs_list_clusters", clustersPage([]), {});
		expect(state.awsEcs.clusterPagesComplete).toBe(true);
		expect(awsEcsAbsenceProven(state)).toBe(false);
	});

	test("an unparseable ECS result blocks the exit", () => {
		const state = enabledState();
		record(state, "aws_ecs_list_clusters", "not json at all", {});
		expect(state.awsEcs.failed).toBe(true);
		expect(awsEcsAbsenceProven(state)).toBe(false);
	});

	test("a list_services page with no cluster arg cannot be attributed, so it blocks the exit", () => {
		const state = enabledState();
		record(state, "aws_ecs_list_clusters", clustersPage(["a"]), {});
		record(state, "aws_ecs_list_services", servicesPage("a", []), {});
		expect(state.awsEcs.failed).toBe(true);
		expect(awsEcsAbsenceProven(state)).toBe(false);
	});

	test("the detector is inert when disabled or focus is empty", () => {
		for (const opts of [
			{ awsAbsenceEarlyExit: false, focusServices: FOCUS },
			{ awsAbsenceEarlyExit: true, focusServices: [] },
			{},
		]) {
			const state = createLoopGuardState(opts);
			walkCleanEstate(state);
			expect(state.awsEcs.enabled).toBe(false);
			expect(awsEcsAbsenceProven(state)).toBe(false);
		}
	});

	test("proven absence blocks the hunt chain but not the rest of the estate", () => {
		const state = enabledState();
		walkCleanEstate(state);
		for (const t of ["aws_logs_start_query", "aws_ecs_describe_services", "aws_ecs_list_tasks"]) {
			expect(shouldShortCircuit(state, t, toolCallSignature(t, { fresh: t }))).toBe(true);
		}
		// Account-level work is untouched -- absence of the FOCUS service says nothing about it.
		const alarms = toolCallSignature("aws_cloudwatch_describe_alarms", { stateValue: "ALARM" });
		expect(shouldShortCircuit(state, "aws_cloudwatch_describe_alarms", alarms)).toBe(false);
	});

	// PR #482 (CodeRabbit): the two AWS protocol/recovery tools bypass EVERY generic rule. SIO-1268
	// must not become the exception that strands an in-flight CloudWatch poll.
	test("the PR #482 exempt tools stay exempt under a proven absence", () => {
		const state = enabledState();
		walkCleanEstate(state);
		const poll = toolCallSignature("aws_logs_get_query_results", { queryId: "q-1" });
		expect(shouldShortCircuit(state, "aws_logs_get_query_results", poll)).toBe(false);
		const desc = toolCallSignature("aws_logs_describe_log_groups", { logGroupNamePrefix: "/aws/ecs" });
		expect(shouldShortCircuit(state, "aws_logs_describe_log_groups", desc)).toBe(false);
	});

	test("the absence message supersedes the tool's own stop prose", () => {
		const state = enabledState();
		walkCleanEstate(state);
		expect(stopMessageFor("aws_logs_start_query", state)).toBe(AWS_SERVICE_ABSENT_STOP_MESSAGE);
		// Un-proven absence keeps the re-anchor advice.
		expect(stopMessageFor("aws_logs_start_query", enabledState())).toBe(AWS_START_QUERY_STOP_MESSAGE);
	});

	test("the absence message directs a FINDING, not a gap", () => {
		// RULES.md SIO-1149 already required this and the model ignored the prose, so the stop text
		// restates it at the point of decision.
		expect(AWS_SERVICE_ABSENT_STOP_MESSAGE).toContain("definitive negative finding, not a gap");
		expect(AWS_SERVICE_ABSENT_STOP_MESSAGE).toContain("not deployed in this estate");
		expect(AWS_SERVICE_ABSENT_STOP_MESSAGE).toContain("Write your findings NOW");
	});

	test("the decision log is one-shot", () => {
		const state = enabledState();
		walkCleanEstate(state);
		expect(consumeAbsenceExitLog(state)).toMatchObject({ clustersEnumerated: 2, servicesEnumerated: 2 });
		expect(consumeAbsenceExitLog(state)).toBeNull();
	});

	// Regression pin for the interaction that makes this feature possible AT ALL.
	test("an empty ECS list stays PRODUCTIVE so enumeration is never guard-capped", () => {
		// describeToolResult sets hitsLen only for Elastic-shaped hits.hits, so this falls through
		// as productive. If it ever became unproductive, MAX_UNPRODUCTIVE_PER_TOOL=3 would block
		// list_services on cluster 4 of 7 and complete enumeration -- the precondition of this exit
		// -- would be unreachable, silently disabling the feature.
		expect(isUnproductiveResult('{"serviceArns":[],"$metadata":{}}')).toBe(false);
		const state = enabledState();
		for (let i = 1; i <= 7; i++) {
			const args = { cluster: `c${i}` };
			const sig = toolCallSignature("aws_ecs_list_services", args);
			expect(shouldShortCircuit(state, "aws_ecs_list_services", sig, args)).toBe(false);
			recordResult(state, "aws_ecs_list_services", sig, servicesPage(`c${i}`, []), args);
		}
	});
});

// SIO-1298: staged deploy-correlation window -- empty ~24h result latches the mandatory
// 30-day escalation advice, one-shot per tool.
describe("gitlab correlation widen advice (SIO-1298)", () => {
	const DEPLOYS = "gitlab_recent_deploys";
	const FAILURES = "gitlab_pipeline_failures";
	const recentSince = () => ({ since: new Date(Date.now() - 24 * 3600_000).toISOString() });
	const oldSince = () => ({ since: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() });
	const emptyPayload = JSON.stringify({
		queryTag: "orbit_recent_deploys",
		result: { format_version: "3.0.1", query_type: "traversal", nodes: [], edges: [] },
		query_type: "traversal",
		row_count: 0,
	});
	const nonEmptyPayload = JSON.stringify({
		queryTag: "orbit_recent_deploys",
		result: { format_version: "3.0.1", query_type: "traversal", nodes: [{ type: "MergeRequest" }] },
		query_type: "traversal",
		row_count: 3,
	});

	test("detects empty-success payloads; errors and non-JSON are not empty", () => {
		expect(isEmptyGitlabCorrelationResult(emptyPayload)).toBe(true);
		expect(isEmptyGitlabCorrelationResult(nonEmptyPayload)).toBe(false);
		expect(isEmptyGitlabCorrelationResult(JSON.stringify({ row_count: 0, _error: { kind: "bad-query" } }))).toBe(false);
		expect(isEmptyGitlabCorrelationResult("prose, not JSON")).toBe(false);
		// MCP text-block array form coalesces to the same string
		expect(isEmptyGitlabCorrelationResult([{ type: "text", text: emptyPayload }])).toBe(true);
	});

	test("since recency: default window counts, 30-day lookback does not", () => {
		const now = Date.parse("2026-07-30T00:00:00Z");
		expect(isRecentCorrelationWindow({ since: "2026-07-29T00:00:00Z" }, now)).toBe(true);
		expect(isRecentCorrelationWindow({ since: "2026-06-30T00:00:00Z" }, now)).toBe(false);
		expect(isRecentCorrelationWindow({ since: "not-a-date" }, now)).toBe(false);
		expect(isRecentCorrelationWindow(undefined, now)).toBe(false);
		// future-dated since (LLM year-drift) must not latch the escalation
		expect(isRecentCorrelationWindow({ since: "2027-07-29T00:00:00Z" }, now)).toBe(false);
	});

	test("empty + recent since latches; advice consumed exactly once", () => {
		const state = createLoopGuardState();
		recordResult(state, DEPLOYS, "sig1", emptyPayload, recentSince());
		expect(consumeGitlabCorrelationWidenAdvice(state, DEPLOYS)).toBe(GITLAB_CORRELATION_WIDEN_ADVICE);
		expect(consumeGitlabCorrelationWidenAdvice(state, DEPLOYS)).toBeNull();
	});

	test("latches through the wrapped tool-call envelope (live regression, SIO-1084 shape)", () => {
		const state = createLoopGuardState();
		const wrapped = { name: DEPLOYS, id: "call_1", type: "tool_call", args: recentSince() };
		recordResult(state, DEPLOYS, "sig1", emptyPayload, wrapped);
		expect(consumeGitlabCorrelationWidenAdvice(state, DEPLOYS)).toBe(GITLAB_CORRELATION_WIDEN_ADVICE);
	});

	test("both tools latch independently", () => {
		const state = createLoopGuardState();
		recordResult(state, DEPLOYS, "sig1", emptyPayload, recentSince());
		recordResult(state, FAILURES, "sig2", emptyPayload, recentSince());
		expect(consumeGitlabCorrelationWidenAdvice(state, FAILURES)).toBe(GITLAB_CORRELATION_WIDEN_ADVICE);
		expect(consumeGitlabCorrelationWidenAdvice(state, DEPLOYS)).toBe(GITLAB_CORRELATION_WIDEN_ADVICE);
	});

	test("no latch for non-empty results, old windows, or other tools", () => {
		const state = createLoopGuardState();
		recordResult(state, DEPLOYS, "sig1", nonEmptyPayload, recentSince());
		expect(consumeGitlabCorrelationWidenAdvice(state, DEPLOYS)).toBeNull();
		recordResult(state, DEPLOYS, "sig2", emptyPayload, oldSince());
		expect(consumeGitlabCorrelationWidenAdvice(state, DEPLOYS)).toBeNull();
		recordResult(state, "gitlab_search", "sig3", emptyPayload, recentSince());
		expect(consumeGitlabCorrelationWidenAdvice(state, "gitlab_search")).toBeNull();
	});
});
