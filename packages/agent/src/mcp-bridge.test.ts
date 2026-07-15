// packages/agent/src/mcp-bridge.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	_connectTimeoutForTest as connectTimeoutFor,
	_getHealthPollTimerForTest as getHealthPollTimer,
	serializeMcpConnectError,
	_startHealthPollingForTest as startHealthPolling,
	stopHealthPolling,
	_toolTimeoutForTest as toolTimeoutFor,
	_withTimeoutForTest as withTimeout,
} from "./mcp-bridge.ts";

// SIO-705: pino's default JSON serializer drops non-enumerable Error fields.
// The styles-v3 production run logged `Failed to connect to MCP server` with
// `error:{}` because `result.reason` (an Error instance) was passed directly
// as a pino property. The serializer below extracts `.message` plus any
// AggregateError children and `cause` chain so transport-layer detail isn't
// lost.
describe("serializeMcpConnectError (SIO-705)", () => {
	test("extracts message and name from a plain Error", () => {
		const out = serializeMcpConnectError(new Error("connection refused"), "http://localhost:9080/mcp");
		expect(out.error).toBe("connection refused");
		expect(out.errorName).toBe("Error");
		expect(out.url).toBe("http://localhost:9080/mcp");
	});

	test("preserves the subclass name", () => {
		class TimeoutError extends Error {
			override name = "TimeoutError";
		}
		const out = serializeMcpConnectError(new TimeoutError("op timed out"), "http://x/mcp");
		expect(out.error).toBe("op timed out");
		expect(out.errorName).toBe("TimeoutError");
	});

	test("flattens AggregateError children into cause", () => {
		const agg = new AggregateError(
			[new Error("ENOTFOUND localhost"), new Error("ECONNREFUSED 127.0.0.1:9083")],
			"All connection attempts failed",
		);
		const out = serializeMcpConnectError(agg, "http://localhost:9083/mcp");
		expect(out.error).toBe("All connection attempts failed");
		expect(out.cause).toContain("ENOTFOUND");
		expect(out.cause).toContain("ECONNREFUSED");
	});

	test("walks the cause chain on standard Error", () => {
		const inner = new Error("socket hang up");
		const outer = new Error("fetch failed", { cause: inner });
		const out = serializeMcpConnectError(outer, "http://x/mcp");
		expect(out.error).toBe("fetch failed");
		expect(out.cause).toBe("socket hang up");
	});

	test("falls back to String() for non-Error rejections", () => {
		const out = serializeMcpConnectError("plain string reason", "http://x/mcp");
		expect(out.error).toBe("plain string reason");
		expect(out.errorName).toBeUndefined();
	});

	test("survives an Error with empty message by using the name", () => {
		const e = new Error();
		e.name = "AbortError";
		const out = serializeMcpConnectError(e, "http://x/mcp");
		expect(out.error).toBe("AbortError");
	});
});

describe("withTimeout (SIO-680/682)", () => {
	test("resolves with value when promise settles before timeout", async () => {
		const result = await withTimeout(Promise.resolve(42), 100, "fast-call");
		expect(result).toBe(42);
	});

	test("rejects with descriptive error when promise never settles", async () => {
		const neverResolves = new Promise<number>(() => {});
		await expect(withTimeout(neverResolves, 50, "stuck-call")).rejects.toThrow(/stuck-call timed out after 50ms/);
	});

	test("propagates the original error when promise rejects before timeout", async () => {
		const fails = Promise.reject(new Error("connection refused"));
		await expect(withTimeout(fails, 1000, "failing-call")).rejects.toThrow(/connection refused/);
	});
});

// SIO-774: AgentCore-backed MCP servers (kafka-mcp, aws-mcp) ride a SigV4 proxy
// whose cold-start retry ladder runs to ~30s. The bridge's connect timeout has
// to outlast that budget so the proxy's retry can succeed before the bridge bails.
// Non-AgentCore servers have no cold-start cost and keep the 10s default.
describe("connectTimeoutFor (SIO-774)", () => {
	test("kafka-mcp gets AgentCore-sized timeout", () => {
		expect(connectTimeoutFor("kafka-mcp")).toBe(35_000);
	});

	test("aws-mcp gets AgentCore-sized timeout", () => {
		expect(connectTimeoutFor("aws-mcp")).toBe(35_000);
	});

	test("non-AgentCore servers stay on the 10s default", () => {
		expect(connectTimeoutFor("elastic-mcp")).toBe(10_000);
		expect(connectTimeoutFor("couchbase-mcp")).toBe(10_000);
		expect(connectTimeoutFor("konnect-mcp")).toBe(10_000);
		expect(connectTimeoutFor("gitlab-mcp")).toBe(10_000);
		expect(connectTimeoutFor("atlassian-mcp")).toBe(10_000);
	});

	test("unknown server falls back to default", () => {
		expect(connectTimeoutFor("not-a-real-server")).toBe(10_000);
	});
});

describe("toolTimeoutFor (SIO-893)", () => {
	// SIO-1112: env is injectable, so each test passes an isolated object with only the
	// keys it needs. No process.env mutation -> no save/restore hooks, and Bun's auto-loaded
	// repo .env can't leak in (retires the reference_bun_env_leaks_into_config_tests flake).

	test("servers without a per-server timeout get no override (adapter default)", () => {
		expect(toolTimeoutFor("elastic-mcp", {})).toBeUndefined();
		expect(toolTimeoutFor("gitlab-mcp", {})).toBeUndefined();
	});

	// SIO-1115: kafka-mcp gets a deterministic 30s per-call timeout (tracks the
	// server-side admin-RPC budget) instead of the 60s adapter default.
	test("kafka-mcp defaults to 30s", () => {
		expect(toolTimeoutFor("kafka-mcp", {})).toBe(30_000);
	});

	test("explicit KAFKA_TOOL_TIMEOUT_MS wins over the default", () => {
		expect(toolTimeoutFor("kafka-mcp", { KAFKA_TOOL_TIMEOUT_MS: "45000" })).toBe(45_000);
	});

	test("a non-positive kafka override is ignored (falls back to 30s)", () => {
		expect(toolTimeoutFor("kafka-mcp", { KAFKA_TOOL_TIMEOUT_MS: "0" })).toBe(30_000);
	});

	// SIO-1111: atlassian-mcp serializes upstream calls (SIO-1097); the queued
	// tail exceeded the 60s adapter default under fan-out, so it gets 120s.
	test("atlassian-mcp defaults to 120s", () => {
		expect(toolTimeoutFor("atlassian-mcp", {})).toBe(120_000);
	});

	test("explicit ATLASSIAN_TOOL_TIMEOUT_MS wins over the default", () => {
		expect(toolTimeoutFor("atlassian-mcp", { ATLASSIAN_TOOL_TIMEOUT_MS: "45000" })).toBe(45_000);
	});

	test("a non-positive atlassian override is ignored (falls back to 120s)", () => {
		expect(toolTimeoutFor("atlassian-mcp", { ATLASSIAN_TOOL_TIMEOUT_MS: "0" })).toBe(120_000);
	});

	// SIO-1112: a sub-millisecond override floors to 0 and would silently disable the
	// timeout, so the schema requires >= 1 and falls back to the default instead.
	test("a sub-millisecond atlassian override is ignored (falls back to 120s)", () => {
		expect(toolTimeoutFor("atlassian-mcp", { ATLASSIAN_TOOL_TIMEOUT_MS: "0.5" })).toBe(120_000);
	});

	// SIO-1112: a valid fractional override (>= 1) is accepted and floored to integer ms.
	test("a positive fractional atlassian override is floored to milliseconds", () => {
		expect(toolTimeoutFor("atlassian-mcp", { ATLASSIAN_TOOL_TIMEOUT_MS: "45000.9" })).toBe(45_000);
	});

	test("elastic-iac defaults to poll budget + margin", () => {
		// SIO-989: the drift poll budget default dropped 300s -> 90s, so the derived tool timeout is 120s.
		expect(toolTimeoutFor("elastic-iac-mcp", {})).toBe(90_000 + 30_000);
	});

	test("elastic-iac tracks the configured poll budget + margin", () => {
		expect(toolTimeoutFor("elastic-iac-mcp", { ELASTIC_IAC_DRIFT_POLL_BUDGET_MS: "120000" })).toBe(120_000 + 30_000);
	});

	test("explicit ELASTIC_IAC_TOOL_TIMEOUT_MS wins over the budget-derived value", () => {
		expect(
			toolTimeoutFor("elastic-iac-mcp", {
				ELASTIC_IAC_TOOL_TIMEOUT_MS: "90000",
				ELASTIC_IAC_DRIFT_POLL_BUDGET_MS: "300000",
			}),
		).toBe(90_000);
	});

	test("a non-positive override is ignored (falls back to budget + margin)", () => {
		expect(toolTimeoutFor("elastic-iac-mcp", { ELASTIC_IAC_TOOL_TIMEOUT_MS: "0" })).toBe(90_000 + 30_000);
	});

	// SIO-1112: the drift-budget path moved from `Number(x) || DEFAULT` (which leaked a
	// negative through to a negative timeout) to the positive-integer schema, so a
	// negative budget now correctly falls back to the default.
	test("a negative drift poll budget is ignored (falls back to budget + margin)", () => {
		expect(toolTimeoutFor("elastic-iac-mcp", { ELASTIC_IAC_DRIFT_POLL_BUDGET_MS: "-5" })).toBe(90_000 + 30_000);
	});
});

// SIO-1113: the health-poll timer is a globalThis singleton so Vite HMR reloads
// cannot stack intervals. These tests own the singleton (stop before + after each) so
// no live interval leaks between tests.
describe("health polling singleton (SIO-1113)", () => {
	beforeEach(() => stopHealthPolling());
	afterEach(() => stopHealthPolling());

	test("startHealthPolling twice arms exactly one timer", () => {
		expect(getHealthPollTimer()).toBeNull();
		startHealthPolling();
		const first = getHealthPollTimer();
		expect(first).not.toBeNull();
		startHealthPolling(); // an HMR-reloaded module instance calling start again
		expect(getHealthPollTimer()).toBe(first); // same timer, not a second one
	});

	test("stopHealthPolling clears the singleton and is idempotent", () => {
		startHealthPolling();
		expect(getHealthPollTimer()).not.toBeNull();
		stopHealthPolling();
		expect(getHealthPollTimer()).toBeNull();
		stopHealthPolling(); // safe to call with no timer
		expect(getHealthPollTimer()).toBeNull();
	});
});
