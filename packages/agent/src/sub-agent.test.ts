// packages/agent/src/sub-agent.test.ts
import { describe, expect, test } from "bun:test";
import { classifyToolError, extractToolErrors, getSubAgentRecursionLimit, getSubAgentTimeoutMs } from "./sub-agent.ts";

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
	test("returns 40 for elastic when env unset", () => {
		expect(getSubAgentRecursionLimit("elastic", {})).toBe(40);
	});

	test("returns undefined for non-elastic data sources", () => {
		for (const ds of ["kafka", "couchbase", "konnect", "gitlab", "atlassian"]) {
			expect(getSubAgentRecursionLimit(ds, { SUBAGENT_ELASTIC_RECURSION_LIMIT: "60" })).toBeUndefined();
		}
	});

	test("honors SUBAGENT_ELASTIC_RECURSION_LIMIT override for elastic", () => {
		expect(getSubAgentRecursionLimit("elastic", { SUBAGENT_ELASTIC_RECURSION_LIMIT: "60" })).toBe(60);
	});

	test("falls back to default on invalid env values", () => {
		// non-numeric, zero, negative, empty -- all clamp back to 40
		for (const raw of ["abc", "0", "-5", ""]) {
			expect(getSubAgentRecursionLimit("elastic", { SUBAGENT_ELASTIC_RECURSION_LIMIT: raw })).toBe(40);
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
			"OAuth interactive authorization required for gitlab but MCP_OAUTH_HEADLESS=true; run `bun run oauth:seed:gitlab`";
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
		expect(errors[0]?.message).not.toContain("simon.owusu@example.com");
		expect(errors[0]?.toolName).toBe("kafka_consume_messages");
		expect(errors[0]?.category).toBe("auth");
	});

	test("redacts IPv4 addresses from tool error messages", () => {
		const errors = extractToolErrors([toolMsg("ECONNREFUSED to broker 10.0.42.7:9092 after 30s timeout")]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).not.toContain("10.0.42.7");
		expect(errors[0]?.category).toBe("transient");
	});

	test("ignores non-tool messages and tool messages without status='error'", () => {
		const errors = extractToolErrors([
			toolMsg("not an error", "kafka_list_topics", "success"),
			{ _getType: () => "human", content: "user said something" },
		]);
		expect(errors).toHaveLength(0);
	});

	test("preserves toolName, category, retryable while redacting message", () => {
		const errors = extractToolErrors([
			toolMsg("ECONNRESET while polling broker 10.0.1.5:9092", "kafka_get_consumer_group_lag"),
		]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.toolName).toBe("kafka_get_consumer_group_lag");
		expect(errors[0]?.category).toBe("transient");
		expect(errors[0]?.retryable).toBe(true);
		expect(errors[0]?.message).not.toContain("10.0.1.5");
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
