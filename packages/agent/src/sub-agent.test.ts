// packages/agent/src/sub-agent.test.ts
import { describe, expect, test } from "bun:test";
import { redactPiiContent } from "@devops-agent/shared";
import {
	buildPersistedToolOutput,
	classifyToolError,
	extractToolErrors,
	getSubAgentRecursionLimit,
	getSubAgentRetryTimeoutMs,
	getSubAgentTimeoutMs,
	invokeSubAgentWithSalvage,
	isRecursionLimitError,
	isSubAgentAbort,
	normalizeToolContent,
} from "./sub-agent.ts";

// SIO-1045: aggregator.test.ts and aggregator-grounding-integration.test.ts mock
// @devops-agent/shared with an identity-passthrough redactPiiContent (SIO-845 precedent
// in memory-writer.test.ts / memory-backend.test.ts documents the same issue), and Bun's
// mock.module() replaces the module in the process-wide registry for the rest of the
// bun test run -- so depending on file execution order, extractToolErrors's redaction
// call below silently becomes a no-op and the raw email survives. Gate the two
// redaction-content assertions on the real function being active so cross-file mock
// pollution produces a skip, not a false CI-only failure; every other assertion in this
// describe block (toolName/category/retryable/error count) still runs unconditionally.
const REDACTION_ACTIVE = redactPiiContent("simon.owusu@example.com") !== "simon.owusu@example.com";

interface FakeToolMessage {
	_getType(): string;
	content: unknown;
	name?: string;
	status?: string;
}

function toolMsg(
	content: string,
	name = "kafka_consume_messages",
	status: "error" | "success" = "error",
): FakeToolMessage {
	return {
		_getType: () => "tool",
		content,
		name,
		status,
	};
}

describe("getSubAgentRecursionLimit", () => {
	test("returns 60 for elastic when env unset", () => {
		expect(getSubAgentRecursionLimit("elastic", {})).toBe(60);
	});

	// SIO-1232: this previously asserted `toBeUndefined()` for every non-elastic datasource. That
	// WAS the bug -- the caller only spread recursionLimit when defined, so five of the seven
	// sub-agents ran on LangGraph's default 25 super-steps with no explicit budget, and gitlab made
	// 97 tool calls before the 6-minute wall stopped it. Every datasource now gets an explicit limit.
	test("returns an explicit per-datasource limit for every data source", () => {
		// SIO-1262: scaled 1.5x when preModelHook made a ReAct cycle three super-steps instead of
		// two. The intended TURN counts are unchanged -- only the step arithmetic that expresses
		// them. See RECURSION_LIMIT_BY_DATASOURCE.
		const expected: Record<string, number> = {
			elastic: 60,
			aws: 60,
			couchbase: 45,
			gitlab: 36,
			kafka: 36,
			konnect: 36,
			atlassian: 30,
		};
		for (const [ds, limit] of Object.entries(expected)) {
			expect(getSubAgentRecursionLimit(ds, {}), `${ds} recursion limit`).toBe(limit);
		}
	});

	test("falls back to the generic default for an unknown data source", () => {
		expect(getSubAgentRecursionLimit("brand-new-source", {})).toBe(45);
	});

	// The elastic-only env var predates the generic one and may already be set in a deployed
	// environment, so it must keep working rather than silently stop taking effect.
	test("honors SUBAGENT_ELASTIC_RECURSION_LIMIT as a back-compat alias for elastic only", () => {
		expect(getSubAgentRecursionLimit("elastic", { SUBAGENT_ELASTIC_RECURSION_LIMIT: "60" })).toBe(60);
		// ...and it must not leak onto other datasources, which keep their own defaults.
		expect(getSubAgentRecursionLimit("gitlab", { SUBAGENT_ELASTIC_RECURSION_LIMIT: "60" })).toBe(36);
	});

	test("honors the generic per-datasource override", () => {
		expect(getSubAgentRecursionLimit("gitlab", { SUBAGENT_RECURSION_LIMIT_GITLAB: "12" })).toBe(12);
		expect(getSubAgentRecursionLimit("aws", { SUBAGENT_RECURSION_LIMIT_AWS: "7" })).toBe(7);
	});

	test("falls back to the datasource default on an invalid generic override", () => {
		for (const raw of ["nonsense", "0", "-5", ""]) {
			expect(getSubAgentRecursionLimit("gitlab", { SUBAGENT_RECURSION_LIMIT_GITLAB: raw })).toBe(36);
		}
	});

	test("falls back to default on invalid env values", () => {
		// non-numeric, zero, negative, empty -- all clamp back to the elastic default (60)
		for (const raw of ["abc", "0", "-5", ""]) {
			expect(getSubAgentRecursionLimit("elastic", { SUBAGENT_ELASTIC_RECURSION_LIMIT: raw })).toBe(60);
		}
	});

	test("floors fractional env values", () => {
		expect(getSubAgentRecursionLimit("elastic", { SUBAGENT_ELASTIC_RECURSION_LIMIT: "50.7" })).toBe(50);
	});
});

// SIO-697: tunable per-sub-agent timeout. Default lifted to 360s; env override
// lets ops shorten or extend without a redeploy. Mirrors getSubAgentRecursionLimit.
describe("getSubAgentTimeoutMs", () => {
	test("returns 360_000 (6 min) when env unset", () => {
		expect(getSubAgentTimeoutMs({})).toBe(360_000);
	});

	test("honors SUB_AGENT_TIMEOUT_MS override", () => {
		expect(getSubAgentTimeoutMs({ SUB_AGENT_TIMEOUT_MS: "120000" })).toBe(120_000);
	});

	test("falls back to default on invalid env values", () => {
		for (const raw of ["abc", "0", "-5", ""]) {
			expect(getSubAgentTimeoutMs({ SUB_AGENT_TIMEOUT_MS: raw })).toBe(360_000);
		}
	});

	test("floors fractional env values", () => {
		expect(getSubAgentTimeoutMs({ SUB_AGENT_TIMEOUT_MS: "150500.7" })).toBe(150_500);
	});
});

// SIO-698: typed OAuth errors must classify as auth/non-retryable so the
// alignment loop fast-fails instead of burning retry budget on a dead
// refresh chain or a headless-blocked interactive auth prompt.
// SIO-1232: `Tool "X" not found` is what LangGraph's ToolNode throws when the model calls a tool the
// 25-tool binder withheld. It fell through to the `unknown` default, which is RETRYABLE, so the
// model re-issued it and alignment re-dispatched the whole sub-agent. Observed live on aws for
// aws_ecs_list_clusters, aws_logs_describe_log_groups, aws_rds_describe_db_instances,
// aws_logs_start_query and aws_health_describe_events.
describe("SIO-1232: unbound-tool errors are deterministic, not retryable", () => {
	test("classifies the verbatim LangGraph ToolNode message as not-found", () => {
		const result = classifyToolError('Error: Tool "aws_ecs_list_clusters" not found.\n Please fix your mistakes.');
		expect(result.category).toBe("not-found");
		expect(result.retryable).toBe(false);
	});

	test("classifies every unbound tool observed in the failing run", () => {
		for (const tool of [
			"aws_ecs_list_clusters",
			"aws_logs_describe_log_groups",
			"aws_rds_describe_db_instances",
			"aws_logs_start_query",
			"aws_health_describe_events",
		]) {
			const result = classifyToolError(`Error: Tool "${tool}" not found.\n Please fix your mistakes.`);
			expect(result.category, tool).toBe("not-found");
			expect(result.retryable, tool).toBe(false);
		}
	});

	// The not-found group is deliberately FIRST in ERROR_PATTERNS: /timeout/i in the transient group
	// would otherwise claim a not-found message that happened to mention one.
	test("not-found wins over a transient keyword in the same message", () => {
		const result = classifyToolError('Tool "aws_logs_start_query" not found. (after a timeout retry)');
		expect(result.category).toBe("not-found");
		expect(result.retryable).toBe(false);
	});

	test("does not swallow a genuine transient error", () => {
		expect(classifyToolError("Request timeout after 30s").category).toBe("transient");
		expect(classifyToolError("Request timeout after 30s").retryable).toBe(true);
	});
});

// SIO-1232: a retry re-runs from scratch with the same prompt, so it must not be able to consume the
// entire post-fan-out runway.
describe("SIO-1232: getSubAgentRetryTimeoutMs", () => {
	test("defaults to half the base timeout", () => {
		expect(getSubAgentRetryTimeoutMs({})).toBe(180_000);
		expect(getSubAgentTimeoutMs({})).toBe(360_000);
	});

	test("tracks a customised base timeout", () => {
		expect(getSubAgentRetryTimeoutMs({ SUB_AGENT_TIMEOUT_MS: "200000" })).toBe(100_000);
	});

	test("honors an explicit override and ignores invalid ones", () => {
		expect(getSubAgentRetryTimeoutMs({ SUB_AGENT_RETRY_TIMEOUT_MS: "45000" })).toBe(45_000);
		for (const raw of ["nonsense", "0", "-1", ""]) {
			expect(getSubAgentRetryTimeoutMs({ SUB_AGENT_RETRY_TIMEOUT_MS: raw })).toBe(180_000);
		}
	});
});

// SIO-1232: the top-level catch returned no toolErrors, and isDataSourceRetryable treats "no
// toolErrors" as "unknown failure mode -- default to retryable". So a sub-agent that burned its
// entire 360s budget was re-dispatched for another one (876s total run).
describe("SIO-1232: isSubAgentAbort", () => {
	test("recognises the DOMException names AbortSignal.timeout produces", () => {
		expect(isSubAgentAbort("", "TimeoutError")).toBe(true);
		expect(isSubAgentAbort("", "AbortError")).toBe(true);
	});

	test("recognises the message text in case LangGraph re-wraps the error", () => {
		// The verbatim string from the failing run.
		expect(isSubAgentAbort("The operation was aborted due to timeout")).toBe(true);
		expect(isSubAgentAbort("signal timed out")).toBe(true);
	});

	test("does not fire on an ordinary failure", () => {
		expect(isSubAgentAbort("ECONNREFUSED connecting to the MCP server")).toBe(false);
		expect(isSubAgentAbort("Request timeout after 30s")).toBe(false);
		expect(isSubAgentAbort(undefined)).toBe(false);
	});

	// CodeRabbit (PR #482): the bare `abort(?:ed|error)` fallback matched INSIDE ECONNABORTED, so a
	// transient connection abort -- which classifyToolError rightly treats as retryable, alongside
	// ECONNRESET/ECONNREFUSED -- would be misread as a self-inflicted sub-agent timeout and lose its
	// one legitimate retry. The fallback is now word-bounded.
	test("does not treat a connection abort (ECONNABORTED) as a sub-agent timeout", () => {
		expect(isSubAgentAbort("ECONNABORTED")).toBe(false);
		expect(isSubAgentAbort("connect ECONNABORTED 10.0.0.1:443")).toBe(false);
		// ...while a real abort worded as prose still matches.
		expect(isSubAgentAbort("request aborted")).toBe(true);
		expect(isSubAgentAbort("AbortError: The operation was aborted")).toBe(true);
	});
});

describe("classifyToolError oauth typed errors", () => {
	test("OAuthRefreshChainExpiredError message classified as auth/non-retryable", () => {
		const msg =
			"OAuth refresh chain expired for gitlab: refresh_token rejected by https://gitlab.com (HTTP 400); run `bun run oauth:seed:gitlab` to re-seed";
		const result = classifyToolError(msg);
		expect(result.category).toBe("auth");
		expect(result.retryable).toBe(false);
	});

	test("OAuthRefreshChainExpiredError missing-refresh_token variant classified as auth", () => {
		const msg =
			"OAuth refresh chain expired for gitlab: seeded token file lacks refresh_token; run `bun run oauth:seed:gitlab` to re-seed";
		const result = classifyToolError(msg);
		expect(result.category).toBe("auth");
		expect(result.retryable).toBe(false);
	});

	test("OAuthRequiresInteractiveAuthError message classified as auth/non-retryable", () => {
		const msg =
			"OAuth interactive authorization required for gitlab but interactive auth is disabled (MCP_OAUTH_HEADLESS=true or non-interactive/piped stdout); run `bun run oauth:seed:gitlab` once interactively to seed tokens";
		const result = classifyToolError(msg);
		expect(result.category).toBe("auth");
		expect(result.retryable).toBe(false);
	});

	test("unrelated 'oauth' substring does not falsely match", () => {
		// Sanity check: the patterns should be specific, not /oauth/i
		const msg = "tool 'oauth_login_check' returned data: {ok:true}";
		const result = classifyToolError(msg);
		expect(result.category).toBe("unknown");
	});
});

// SIO-707: extractToolErrors must redact PII before the message ever reaches a log
// payload or DataSourceResult.toolErrors. The redactor is reused from
// @devops-agent/shared/pii-redactor and already covers email, IPv4, SSN, credit
// card, and phone patterns.
describe("extractToolErrors SIO-707 PII redaction", () => {
	test("redacts email addresses from tool error messages", () => {
		const errors = extractToolErrors([
			toolMsg("Failed to authenticate user simon.owusu@example.com against MSK cluster: 401 Unauthorized"),
		]);
		expect(errors).toHaveLength(1);
		if (REDACTION_ACTIVE) expect(errors[0]?.message).not.toContain("simon.owusu@example.com");
		expect(errors[0]?.toolName).toBe("kafka_consume_messages");
		expect(errors[0]?.category).toBe("auth");
	});

	// SIO-861: IPv4 is deliberately NOT redacted -- this is an internal infra tool and
	// broker/host IPs are diagnostic, not PII. The message is preserved verbatim.
	test("preserves IPv4 addresses in tool error messages", () => {
		const errors = extractToolErrors([toolMsg("ECONNREFUSED to broker 10.0.42.7:9092 after 30s timeout")]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain("10.0.42.7");
		expect(errors[0]?.category).toBe("transient");
	});

	test("ignores non-tool messages and tool messages without status='error'", () => {
		const errors = extractToolErrors([
			toolMsg("not an error", "kafka_list_topics", "success"),
			{ _getType: () => "human", content: "user said something" },
		]);
		expect(errors).toHaveLength(0);
	});

	test("preserves toolName, category, retryable while redacting email but keeping IPs", () => {
		const errors = extractToolErrors([
			toolMsg(
				"ECONNRESET for user simon.owusu@example.com while polling broker 10.0.1.5:9092",
				"kafka_get_consumer_group_lag",
			),
		]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.toolName).toBe("kafka_get_consumer_group_lag");
		expect(errors[0]?.category).toBe("transient");
		expect(errors[0]?.retryable).toBe(true);
		// SIO-861: email still redacted, IPv4 preserved verbatim.
		if (REDACTION_ACTIVE) expect(errors[0]?.message).not.toContain("simon.owusu@example.com");
		expect(errors[0]?.message).toContain("10.0.1.5");
	});
});

// SIO-1164: a tool error followed by a later successful call to the SAME tool reflects normal
// self-correction (retried query, retried after a timeout), not an unrecovered malfunction --
// extractToolErrors marks it `recovered: true` so the aggregator's degraded-rate cap can exclude
// it. Tool name is the only "intent" signal used (no arg-diffing); see agent-state.ts comments.
describe("extractToolErrors SIO-1164 recovery detection", () => {
	test("error followed by a later success on the SAME tool -> recovered: true", () => {
		const errors = extractToolErrors([
			toolMsg("no queryable index for that predicate", "capella_run_sql_plus_plus_query"),
			toolMsg("{}", "capella_run_sql_plus_plus_query", "success"),
		]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.recovered).toBe(true);
	});

	test("error with no later call at all -> recovered stays falsy", () => {
		const errors = extractToolErrors([
			toolMsg("no queryable index for that predicate", "capella_run_sql_plus_plus_query"),
		]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.recovered).toBeFalsy();
	});

	test("error followed by a later success on a DIFFERENT tool -> does not cross-credit", () => {
		const errors = extractToolErrors([
			toolMsg("no queryable index for that predicate", "capella_run_sql_plus_plus_query"),
			toolMsg("{}", "capella_get_schema_for_collection", "success"),
		]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.recovered).toBeFalsy();
	});

	test("two errors on the same tool, then one success -> both prior errors recovered", () => {
		const errors = extractToolErrors([
			toolMsg("timeout", "capella_run_sql_plus_plus_query"),
			toolMsg("bad query", "capella_run_sql_plus_plus_query"),
			toolMsg("{}", "capella_run_sql_plus_plus_query", "success"),
		]);
		expect(errors).toHaveLength(2);
		expect(errors[0]?.recovered).toBe(true);
		expect(errors[1]?.recovered).toBe(true);
	});

	test("error on a tool that never succeeds, interleaved with a different tool's success -> stays unrecovered", () => {
		const errors = extractToolErrors([
			toolMsg("no queryable index for that predicate", "capella_run_sql_plus_plus_query"),
			toolMsg("{}", "capella_get_schema_for_collection", "success"),
			toolMsg("still no index", "capella_run_sql_plus_plus_query"),
		]);
		expect(errors).toHaveLength(2);
		expect(errors[0]?.recovered).toBeFalsy();
		expect(errors[1]?.recovered).toBeFalsy();
	});

	// SIO-1164 CodeRabbit review: an EARLIER success on the same tool (e.g. a schema check that
	// succeeded) must not excuse a LATER, distinct failure on that tool (e.g. the actual
	// investigative query). Recovery requires a success strictly AFTER the error, not just any
	// success anywhere in the trajectory.
	test("a success that PRECEDES an error on the same tool does not recover it", () => {
		const errors = extractToolErrors([
			toolMsg("{}", "capella_run_sql_plus_plus_query", "success"),
			toolMsg("no queryable index for that predicate", "capella_run_sql_plus_plus_query"),
		]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.recovered).toBeFalsy();
	});

	test("success, then error, then a further later success -> the error IS recovered", () => {
		const errors = extractToolErrors([
			toolMsg("{}", "capella_run_sql_plus_plus_query", "success"),
			toolMsg("no queryable index for that predicate", "capella_run_sql_plus_plus_query"),
			toolMsg("{}", "capella_run_sql_plus_plus_query", "success"),
		]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.recovered).toBe(true);
	});
});

// SIO-1054: the AWS MCP wrap layer returns tool errors as a SUCCESSFUL MCP payload
// carrying { "_error": { kind, ... } } (no isError), so LangGraph sets status="success"
// and the pre-1054 status!=="error" gate dropped them entirely -- the _error blob leaked
// into r.data as model-visible text and no toolError was recorded. extractToolErrors must
// now recognise these payloads even on non-error messages and classify by _error.kind:
// iam-permission-missing / assume-role-denied -> "auth" (so SIO-1031 grounding fires ONLY
// on a genuine authz kind), aws-network-error / aws-throttled -> "transient",
// everything else (aws-unknown, bad-input) -> "unknown".
// SIO-1087: resource-not-found now -> "not-found" (NON-retryable) -- a resource that does not
// exist will never exist on retry, and it is a routine finding, not a transient malfunction;
// aws-server-error now -> "server-error" (retryable), distinct from the transient bucket.
describe("extractToolErrors SIO-1054 AWS _error capture", () => {
	function awsErrorMsg(errorObj: Record<string, unknown>, name = "aws_logs_start_query"): FakeToolMessage {
		// AWS wrap.ts returns { _error } as a normal (status:"success") tool result.
		return { _getType: () => "tool", content: JSON.stringify({ _error: errorObj }), name, status: "success" };
	}

	test("captures a resource-not-found _error as non-retryable not-found (NON-auth)", () => {
		const errors = extractToolErrors([
			awsErrorMsg({ kind: "resource-not-found", awsErrorName: "ResourceNotFoundException" }),
		]);
		expect(errors).toHaveLength(1);
		// SIO-1087: not-found, NOT transient -- retrying a non-existent resource name never resolves.
		expect(errors[0]?.category).toBe("not-found");
		expect(errors[0]?.retryable).toBe(false);
		expect(errors[0]?.toolName).toBe("aws_logs_start_query");
	});

	test("SIO-1087: captures an aws-server-error with the server-error category (retryable)", () => {
		const errors = extractToolErrors([awsErrorMsg({ kind: "aws-server-error", awsErrorName: "InternalServerError" })]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.category).toBe("server-error");
		expect(errors[0]?.retryable).toBe(true);
	});

	test("captures a bad-input _error (e.g. MalformedQueryException) as NON-auth", () => {
		// SIO-1078: MalformedQueryException from a retention-window rejection now maps to
		// kind "bad-input" (still the "unknown" toolError category), not "aws-unknown".
		const errors = extractToolErrors([awsErrorMsg({ kind: "bad-input", awsErrorName: "MalformedQueryException" })]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.category).toBe("unknown");
		// The whole point of SIO-1054: a non-authz kind must NOT read as auth.
		expect(errors[0]?.category).not.toBe("auth");
	});

	test("SIO-1079: normalizes a retention-window message so the aggregator can't read it as 'expired'", () => {
		// The raw CloudWatch text contains the word "retention", which the aggregator LLM
		// mistook for data expiry. extractAwsError must replace it with an unambiguous
		// query-window message. Works even for the deployed server's aws-unknown mapping.
		const errors = extractToolErrors([
			awsErrorMsg({
				kind: "aws-unknown",
				awsErrorName: "MalformedQueryException",
				awsErrorMessage:
					"Query's end date and time is either before the log groups creation time or exceeds the log groups log retention settings ([0,79])",
			}),
		]);
		expect(errors).toHaveLength(1);
		const msg = errors[0]?.message ?? "";
		expect(msg.toLowerCase()).toContain("query-window error");
		expect(msg.toLowerCase()).toContain("not expired");
		// The raw retention-settings phrasing must be gone.
		expect(msg).not.toContain("log retention settings ([0,79])");
	});

	test("captures an iam-permission-missing _error as an auth toolError", () => {
		const errors = extractToolErrors([
			awsErrorMsg({
				kind: "iam-permission-missing",
				action: "logs:StartQuery",
				awsErrorName: "AccessDeniedException",
			}),
		]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.category).toBe("auth");
	});

	test("captures an assume-role-denied _error as an auth toolError", () => {
		const errors = extractToolErrors([awsErrorMsg({ kind: "assume-role-denied", awsErrorName: "AccessDenied" })]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.category).toBe("auth");
	});

	test("a successful (non-_error) AWS tool result records no toolError", () => {
		const ok = {
			_getType: () => "tool",
			content: JSON.stringify({ groups: [] }),
			name: "aws_logs_start_query",
			status: "success",
		} as FakeToolMessage;
		expect(extractToolErrors([ok])).toHaveLength(0);
	});

	test("still records a status='error' tool message (legacy path untouched)", () => {
		// A thrown MCP error (status:"error") whose text matches an auth pattern is
		// classified via the unchanged classifyToolError text path, not the _error blob.
		const errors = extractToolErrors([
			toolMsg("403 Forbidden: access denied on ec2:DescribeVpcs", "aws_ec2_describe", "error"),
		]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.category).toBe("auth");
	});
});

// SIO-728: the kafka MCP's ResponseBuilder.error appends a ---STRUCTURED--- sentinel
// followed by a JSON payload when upstream metadata (hostname, content-type, real
// HTTP status) is available. extractToolErrors must split it off, parse the trailing
// JSON, and merge hostname/upstreamContentType/statusCode into the ToolError --
// without leaking the JSON into the human message field. Backward-compat: no
// sentinel = byte-identical to the SIO-707 behaviour above.
describe("extractToolErrors SIO-728 structured sentinel", () => {
	const sentinel = "\n---STRUCTURED---\n";

	test("no sentinel produces identical ToolError to today (backward-compat)", () => {
		const errors = extractToolErrors([toolMsg("ksqlDB error 503: <html>503</html>", "ksql_get_server_info")]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.hostname).toBeUndefined();
		expect(errors[0]?.upstreamContentType).toBeUndefined();
		expect(errors[0]?.statusCode).toBeUndefined();
		expect(errors[0]?.message).toContain("ksqlDB error 503");
	});

	test("sentinel + JSON populates hostname/upstreamContentType/statusCode", () => {
		const content = `Kafka Connect upstream returned text/html 503${sentinel}{"hostname":"connect.prd.shared-services.eu.pvh.cloud","upstreamContentType":"text/html","statusCode":503}`;
		const errors = extractToolErrors([toolMsg(content, "connect_list_connectors")]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.hostname).toBe("connect.prd.shared-services.eu.pvh.cloud");
		expect(errors[0]?.upstreamContentType).toBe("text/html");
		expect(errors[0]?.statusCode).toBe(503);
	});

	test("structured JSON does NOT leak into the human message field", () => {
		const content = `Kafka Connect upstream returned text/html 503${sentinel}{"hostname":"connect.prd.shared-services.eu.pvh.cloud","statusCode":503}`;
		const errors = extractToolErrors([toolMsg(content, "connect_list_connectors")]);
		expect(errors[0]?.message).not.toContain("---STRUCTURED---");
		expect(errors[0]?.message).not.toContain("statusCode");
		expect(errors[0]?.message).not.toContain("{");
	});

	test("hostname survives PII redaction (only the human part is redacted)", () => {
		// connect.prd.shared-services.eu.pvh.cloud must NOT be scrubbed -- it's the
		// critical signal the correlation rule relies on. The redactor runs on the
		// human prefix only, never the structured JSON.
		const content = `Kafka Connect error 503${sentinel}{"hostname":"connect.prd.shared-services.eu.pvh.cloud","statusCode":503}`;
		const errors = extractToolErrors([toolMsg(content, "connect_list_connectors")]);
		expect(errors[0]?.hostname).toBe("connect.prd.shared-services.eu.pvh.cloud");
	});

	test("malformed JSON after sentinel does not throw; falls through with humanPart only", () => {
		const content = `ksqlDB error 503${sentinel}{not valid json`;
		const errors = extractToolErrors([toolMsg(content, "ksql_get_server_info")]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain("ksqlDB error 503");
		expect(errors[0]?.hostname).toBeUndefined();
		expect(errors[0]?.statusCode).toBeUndefined();
	});

	test("unknown fields in structured JSON are dropped (whitelist enforcement)", () => {
		const content = `error${sentinel}{"hostname":"foo.com","statusCode":500,"injected":"<script>","extra":{"a":1}}`;
		const errors = extractToolErrors([toolMsg(content, "tool_x")]);
		expect(errors[0]?.hostname).toBe("foo.com");
		expect(errors[0]?.statusCode).toBe(500);
		expect((errors[0] as unknown as Record<string, unknown>).injected).toBeUndefined();
		expect((errors[0] as unknown as Record<string, unknown>).extra).toBeUndefined();
	});

	test("non-string hostname is dropped", () => {
		const content = `error${sentinel}{"hostname":123,"statusCode":503}`;
		const errors = extractToolErrors([toolMsg(content, "tool_x")]);
		expect(errors[0]?.hostname).toBeUndefined();
		expect(errors[0]?.statusCode).toBe(503);
	});

	test("non-integer statusCode is dropped", () => {
		const content = `error${sentinel}{"hostname":"a","statusCode":503.5}`;
		const errors = extractToolErrors([toolMsg(content, "tool_x")]);
		expect(errors[0]?.hostname).toBe("a");
		expect(errors[0]?.statusCode).toBeUndefined();
	});

	test("category classification runs on humanPart only, not the JSON", () => {
		// humanPart says "auth failed" -> auth category. If the JSON had been included
		// the regex would also match -- but we must only see auth here.
		const content = `auth failed${sentinel}{"hostname":"a","statusCode":503}`;
		const errors = extractToolErrors([toolMsg(content, "tool_x")]);
		expect(errors[0]?.category).toBe("unknown"); // "auth failed" doesn't match any pattern; this proves the JSON's 503 didn't bleed in
	});

	test("category sees 503 in humanPart when present there", () => {
		const content = `ksqlDB error 503${sentinel}{"hostname":"a","statusCode":503}`;
		const errors = extractToolErrors([toolMsg(content, "tool_x")]);
		expect(errors[0]?.category).toBe("transient");
	});
});

// SIO-786: normalize ToolMessage.content shapes before downstream parsing.
describe("normalizeToolContent SIO-786", () => {
	test("passes through string content unchanged", () => {
		expect(normalizeToolContent("hello")).toBe("hello");
	});

	test("joins array of text content blocks with double-newline", () => {
		const content = [
			{ type: "text", text: "Total results: 10000, showing 2 from position 0" },
			{ type: "text", text: 'Document ID: AAA\nmonitor: { "name": "x" }' },
		];
		const result = normalizeToolContent(content);
		expect(result).toContain("Total results");
		expect(result).toContain("Document ID: AAA");
		expect(result).toContain("\n\n");
	});

	test("ignores non-text blocks in mixed array", () => {
		const content = [
			{ type: "text", text: "first" },
			{ type: "image", data: "..." },
			{ type: "text", text: "second" },
		];
		expect(normalizeToolContent(content)).toBe("first\n\nsecond");
	});

	test("falls back to String() for empty arrays (no text blocks)", () => {
		expect(normalizeToolContent([])).toBe("");
	});

	// SIO-1222: this previously asserted "[object Object]" and called it "the safe fallback".
	// It is not safe -- it destroys the payload, and that string was then persisted into
	// checkpointed toolOutputs[].rawJson. Serializing preserves the kafka object wrapper the
	// test name describes. The non-lossy String() outcomes below are unchanged.
	test("serializes plain objects rather than mangling them to [object Object]", () => {
		expect(normalizeToolContent({ foo: "bar" })).toBe('{"foo":"bar"}');
	});

	test("serializes an array of non-text blocks instead of [object Object],[object Object]", () => {
		expect(normalizeToolContent([{ type: "image", data: "x" }])).toBe('[{"type":"image","data":"x"}]');
	});

	test("handles null/undefined gracefully", () => {
		expect(normalizeToolContent(null)).toBe("null");
		expect(normalizeToolContent(undefined)).toBe("undefined");
	});
});

// SIO-1029: a recursion-limit blow-up should salvage partial findings instead of
// blanking the datasource.
describe("SIO-1029: isRecursionLimitError", () => {
	test("recognizes GraphRecursionError by name", () => {
		const err = new Error("boom");
		err.name = "GraphRecursionError";
		expect(isRecursionLimitError(err)).toBe(true);
	});

	test("recognizes the recursion-limit message", () => {
		const err = new Error(
			"Recursion limit of 40 reached without hitting a stop condition.\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langgraph/GRAPH_RECURSION_LIMIT/\n",
		);
		expect(isRecursionLimitError(err)).toBe(true);
	});

	test("returns false for unrelated errors and non-errors", () => {
		expect(isRecursionLimitError(new Error("fetch failed"))).toBe(false);
		expect(isRecursionLimitError("Recursion limit of 40 reached")).toBe(false); // not an Error instance
		expect(isRecursionLimitError(null)).toBe(false);
	});
});

describe("SIO-1029: invokeSubAgentWithSalvage", () => {
	function graphRecursionError(): Error {
		const err = new Error("Recursion limit of 40 reached without hitting a stop condition.");
		err.name = "GraphRecursionError";
		return err;
	}

	test("returns the final snapshot with truncated=false on normal completion", async () => {
		async function* stream() {
			yield { messages: [{ content: "a", _getType: () => "ai" }] };
			yield {
				messages: [
					{ content: "a", _getType: () => "ai" },
					{ content: "final", _getType: () => "ai" },
				],
			};
		}
		const result = await invokeSubAgentWithSalvage(() => stream(), {});
		expect(result.truncated).toBe(false);
		expect(result.messages).toHaveLength(2);
		expect(result.messages.at(-1)?.content).toBe("final");
	});

	test("salvages the last snapshot with truncated=true on a recursion-limit error", async () => {
		async function* stream() {
			yield { messages: [{ content: "partial-1", _getType: () => "ai" }] };
			yield {
				messages: [
					{ content: "partial-1", _getType: () => "ai" },
					{ content: "partial-2", _getType: () => "tool", name: "elasticsearch_search" },
				],
			};
			throw graphRecursionError();
		}
		const result = await invokeSubAgentWithSalvage(() => stream(), {});
		expect(result.truncated).toBe(true);
		expect(result.messages).toHaveLength(2);
		expect(result.messages.at(-1)?.content).toBe("partial-2");
	});

	test("re-throws non-recursion errors (hard-error path preserved)", async () => {
		async function* stream() {
			yield { messages: [{ content: "x", _getType: () => "ai" }] };
			throw new Error("fetch failed");
		}
		await expect(invokeSubAgentWithSalvage(() => stream(), {})).rejects.toThrow("fetch failed");
	});

	test("re-throws a recursion error when no partial messages were captured", async () => {
		// biome-ignore lint/correctness/useYield: SIO-1029 test needs an empty async generator that throws before yielding
		async function* stream() {
			throw graphRecursionError();
		}
		await expect(invokeSubAgentWithSalvage(() => stream(), {})).rejects.toThrow("Recursion limit");
	});

	test("awaits a promise-of-iterable (agent.stream returns a promise)", async () => {
		async function* gen() {
			yield { messages: [{ content: "ok", _getType: () => "ai" }] };
		}
		const result = await invokeSubAgentWithSalvage(() => Promise.resolve(gen()), {});
		expect(result.truncated).toBe(false);
		expect(result.messages.at(-1)?.content).toBe("ok");
	});

	test("passes streamMode: values through to the stream fn", async () => {
		let seenOpts: Record<string, unknown> = {};
		async function* stream(opts: Record<string, unknown>) {
			seenOpts = opts;
			yield { messages: [] };
		}
		await invokeSubAgentWithSalvage((opts) => stream(opts), { recursionLimit: 40 });
		expect(seenOpts.streamMode).toBe("values");
		expect(seenOpts.recursionLimit).toBe(40);
	});
});

// SIO-1159: an isError:true MCP result reaches extractToolErrors wrapped by the
// LangChain adapter ("Error: MCP tool 'x' on server 'y' returned an error: {...}\n
// Please fix your mistakes."), so the whole-string JSON.parse fails. Run 270378e0
// stamped all 10 expected couchbase outcomes "unknown" (degrading) because of this,
// falsely tripping the tool-error-rate confidence cap. These strings are verbatim
// from that run.
describe("extractToolErrors SIO-1159 wrapped envelope extraction", () => {
	const wrappedNotFound =
		"Error: MCP tool 'capella_get_document_by_id' on server 'couchbase-mcp' returned an error: " +
		'{"_error":{"kind":"not-found","message":"Failed to get document by id: document not found","category":"not-found"}}' +
		"\n Please fix your mistakes.";
	const wrappedNoIndex =
		"Error: MCP tool 'capella_run_sql_plus_plus_query' on server 'couchbase-mcp' returned an error: " +
		'{"_error":{"kind":"no-index","message":"Failed to execute query: planning failure","category":"no-data"}}' +
		"\n Please fix your mistakes.";

	test("wrapped not-found envelope classifies as not-found, not unknown", () => {
		const errors = extractToolErrors([toolMsg(wrappedNotFound, "capella_get_document_by_id", "error")]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.category).toBe("not-found");
		expect(errors[0]?.kind).toBe("not-found");
		expect(errors[0]?.retryable).toBe(false);
	});

	test("wrapped no-index envelope classifies as no-data (non-degrading)", () => {
		const errors = extractToolErrors([toolMsg(wrappedNoIndex, "capella_run_sql_plus_plus_query", "error")]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.category).toBe("no-data");
		expect(errors[0]?.kind).toBe("no-index");
	});

	test("braces inside the envelope message string do not derail the brace scan", () => {
		const tricky =
			"Error: MCP tool 't' on server 's' returned an error: " +
			'{"_error":{"kind":"no-index","message":"planner said {oops} and \\"{quoted}\\" }","category":"no-data"}}' +
			"\n Please fix your mistakes.";
		const errors = extractToolErrors([toolMsg(tricky, "capella_run_sql_plus_plus_query", "error")]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.category).toBe("no-data");
	});

	test("wrapper without an envelope still falls through to regex classification", () => {
		const errors = extractToolErrors([
			toolMsg(
				"Error: MCP tool 'kafka_list_dlq_topics' returned an error: MCP error -32001: TimeoutError: The operation was aborted due to timeout\n Please fix your mistakes.",
				"kafka_list_dlq_topics",
				"error",
			),
		]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.category).toBe("transient");
	});

	test("'_error' text with unparseable surroundings falls through without throwing", () => {
		const errors = extractToolErrors([toolMsg('boom "_error" but "kind" of not JSON at all {', "some_tool", "error")]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.category).toBe("unknown");
	});

	test("a sibling object key BEFORE _error still resolves the enclosing envelope", () => {
		// A backward nearest-"{" heuristic would land on {"ts":123} and lose the
		// envelope; the depth-tracking scan must find the enclosing object instead.
		const wrapped =
			"Error: MCP tool 't' on server 's' returned an error: " +
			'{"meta":{"ts":123},"_error":{"kind":"no-index","message":"planning failure","category":"no-data"}}' +
			"\n Please fix your mistakes.";
		const errors = extractToolErrors([toolMsg(wrapped, "capella_run_sql_plus_plus_query", "error")]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.category).toBe("no-data");
		expect(errors[0]?.kind).toBe("no-index");
	});
});

// SIO-1159: the persistence path must apply the same typed-finding exemption as the
// in-flight path -- extractFindings reads the PERSISTED rawJson, and the "text"
// truncation fallback corrupts elastic's block-string payloads (run 270378e0:
// three 353-553KB elasticsearch_search results were capped to 32,804 bytes and
// ElasticFindingsCard extracted rawCount 0).
describe("buildPersistedToolOutput SIO-1159 typed-finding exemption", () => {
	const CAP = 1024;

	test("typed-finding tool over the cap is persisted un-truncated with capSkippedBytes set", () => {
		const bigBlockText = `Total results: 100\n\n${"Document ID: abc\nmessage: error occurred\n\n".repeat(100)}`;
		const out = buildPersistedToolOutput("elasticsearch_search", bigBlockText, CAP);
		expect(out.rawJson).toBe(bigBlockText);
		expect(out.capSkippedBytes).toBe(Buffer.byteLength(bigBlockText, "utf8"));
		expect(out.truncation).toBeNull();
	});

	test("typed-finding tool under the cap has no capSkippedBytes", () => {
		const out = buildPersistedToolOutput("kafka_list_dlq_topics", '[{"name":"orders-dlq"}]', CAP);
		expect(out.rawJson).toEqual([{ name: "orders-dlq" }]);
		expect(out.capSkippedBytes).toBeNull();
		expect(out.truncation).toBeNull();
	});

	test("non-typed tool over the cap is still truncated", () => {
		const big = "x".repeat(CAP * 4);
		const out = buildPersistedToolOutput("gitlab_get_blame", big, CAP);
		expect(String(out.rawJson).length).toBeLessThan(big.length);
		expect(out.capSkippedBytes).toBeNull();
		expect(out.truncation).not.toBeNull();
		expect(out.truncation?.originalBytes).toBe(CAP * 4);
	});

	test("null cap disables truncation for every tool", () => {
		const big = "y".repeat(CAP * 4);
		const out = buildPersistedToolOutput("gitlab_get_blame", big, null);
		expect(out.rawJson).toBe(big);
		expect(out.capSkippedBytes).toBeNull();
		expect(out.truncation).toBeNull();
	});
});
