// packages/agent/src/mcp-bridge.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { jsonRpcRetryDeadlineMs } from "@devops-agent/shared";
import { landingZoneGitLabImportEnabled } from "./landing-zone/gitlab-import.ts";
import * as mcpBridge from "./mcp-bridge.ts";
import {
	_connectTimeoutForTest as connectTimeoutFor,
	_getHealthPollTickForTest as getHealthPollTick,
	_getHealthPollTimerForTest as getHealthPollTimer,
	isClosedModuleRunnerError,
	mcpEvents,
	serializeMcpConnectError,
	_startHealthPollingForTest as startHealthPolling,
	stopHealthPolling,
	_toolTimeoutForTest as toolTimeoutFor,
	_withTimeoutForTest as withTimeout,
} from "./mcp-bridge.ts";

test("a connected-state transition emits once for scheduler readiness", () => {
	const markConnected = (mcpBridge as unknown as Record<string, unknown>)._markServerConnectedForTest;
	expect(markConnected).toBeFunction();
	let events = 0;
	const listener = () => events++;
	mcpEvents.on("mcp_connected", listener);
	try {
		(markConnected as (server: string) => void)("scheduler-readiness-test-mcp");
		(markConnected as (server: string) => void)("scheduler-readiness-test-mcp");
		expect(events).toBe(1);
	} finally {
		mcpEvents.off("mcp_connected", listener);
	}
});

describe("MCP replacement readiness", () => {
	const bridgeTestApi = mcpBridge as unknown as Record<string, unknown>;
	const seedReplacement = bridgeTestApi._seedServerForReplacementTest as
		| ((server: string, tools: Array<{ name: string; description: string }>, identity: Record<string, unknown>) => void)
		| undefined;
	const replaceServer = bridgeTestApi._replaceServerForTest as
		| ((
				server: string,
				url: string,
				identity: Record<string, unknown>,
				loadTools: () => Promise<Array<{ name: string; description: string }>>,
		  ) => Promise<boolean>)
		| undefined;
	const resetReplacement = bridgeTestApi._resetReplacementStateForTest as (() => void) | undefined;
	const expectedIdentity = bridgeTestApi._getExpectedIdentityForTest as
		| ((server: string) => Record<string, unknown> | undefined)
		| undefined;
	const oldIdentity = {
		instanceId: "old-instance",
		role: "landing-zone-iac-mcp",
		version: "1.0.0",
		bootedAt: "2026-09-22T10:00:00.000Z",
		pid: 1,
		mode: "http",
		upstreamFingerprint: "old",
	};
	const newIdentity = { ...oldIdentity, instanceId: "new-instance", upstreamFingerprint: "new" };

	test("a successful connected replacement refreshes tools and emits scheduler readiness", async () => {
		expect(seedReplacement).toBeFunction();
		expect(replaceServer).toBeFunction();
		resetReplacement?.();
		seedReplacement?.("landing-zone-iac-mcp", [{ name: "stale-tool", description: "stale" }], oldIdentity);
		const readyEvents: unknown[] = [];
		const replacedEvents: unknown[] = [];
		const readyListener = (event: unknown) => readyEvents.push(event);
		const replacedListener = (event: unknown) => replacedEvents.push(event);
		mcpEvents.on("mcp_connected", readyListener);
		mcpEvents.on("mcp_replaced", replacedListener);
		try {
			const requiredTools = [
				"lz_list_repositories",
				"lz_list_historical_merge_requests",
				"lz_read_merge_request",
				"lz_list_merge_request_pipelines",
				"lz_list_project_deployments",
			];
			const success = await replaceServer?.(
				"landing-zone-iac-mcp",
				"http://localhost:9999/mcp",
				newIdentity,
				async () => requiredTools.map((name) => ({ name, description: `${name} test tool` })),
			);
			expect(success).toBe(true);
			const replacementToolNames = mcpBridge.getToolsForDataSource("landing-zone-iac").map((tool) => tool.name);
			expect(replacementToolNames).toEqual(requiredTools);
			expect(landingZoneGitLabImportEnabled(true, replacementToolNames)).toBe(true);
			expect(readyEvents).toEqual([{ type: "mcp_connected", server: "landing-zone-iac-mcp", transition: "reconnect" }]);
			expect(replacedEvents).toHaveLength(1);
			expect(expectedIdentity?.("landing-zone-iac-mcp")?.instanceId).toBe("new-instance");
		} finally {
			mcpEvents.off("mcp_connected", readyListener);
			mcpEvents.off("mcp_replaced", replacedListener);
			resetReplacement?.();
		}
	});

	test("a failed connected replacement preserves tools and identity without emitting readiness", async () => {
		expect(seedReplacement).toBeFunction();
		expect(replaceServer).toBeFunction();
		resetReplacement?.();
		seedReplacement?.("landing-zone-iac-mcp", [{ name: "stale-tool", description: "stale" }], oldIdentity);
		const events: unknown[] = [];
		const readyListener = (event: unknown) => events.push(event);
		const replacedListener = (event: unknown) => events.push(event);
		mcpEvents.on("mcp_connected", readyListener);
		mcpEvents.on("mcp_replaced", replacedListener);
		try {
			const success = await replaceServer?.(
				"landing-zone-iac-mcp",
				"http://localhost:9999/mcp",
				newIdentity,
				async () => {
					throw new Error("replacement unavailable");
				},
			);
			expect(success).toBe(false);
			expect(mcpBridge.getAllTools().map((tool) => tool.name)).toEqual(["stale-tool"]);
			expect(events).toEqual([]);
			expect(expectedIdentity?.("landing-zone-iac-mcp")?.instanceId).toBe("old-instance");
		} finally {
			mcpEvents.off("mcp_connected", readyListener);
			mcpEvents.off("mcp_replaced", replacedListener);
			resetReplacement?.();
		}
	});
});

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
// that retries cold-start errors until jsonRpcRetryDeadlineMs() (60s since SIO-868).
// The bridge's connect timeout has to outlast that deadline so the proxy's retry can
// succeed before the bridge bails. SIO-1871: the timeout had been a copied 35s
// constant that SIO-868 left below the deadline; these tests pin the relation, not a
// number. Non-AgentCore servers have no cold-start cost and keep the 10s default.
describe("connectTimeoutFor (SIO-774, SIO-1871)", () => {
	const DEADLINE_ENV = "AGENTCORE_JSONRPC_RETRY_DEADLINE_MS";
	let savedDeadline: string | undefined;
	beforeEach(() => {
		savedDeadline = process.env[DEADLINE_ENV];
		delete process.env[DEADLINE_ENV];
	});
	afterEach(() => {
		if (savedDeadline === undefined) delete process.env[DEADLINE_ENV];
		else process.env[DEADLINE_ENV] = savedDeadline;
	});

	test.each(["kafka-mcp", "aws-mcp"])("%s timeout exceeds the default proxy retry deadline", (server) => {
		expect(jsonRpcRetryDeadlineMs()).toBe(60_000);
		expect(connectTimeoutFor(server)).toBeGreaterThan(jsonRpcRetryDeadlineMs());
	});

	test.each(["kafka-mcp", "aws-mcp"])("%s timeout follows an overridden proxy deadline", (server) => {
		process.env[DEADLINE_ENV] = "120000";
		expect(jsonRpcRetryDeadlineMs()).toBe(120_000);
		expect(connectTimeoutFor(server)).toBeGreaterThan(120_000);
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

	// A dev-server restart can close the Vite module runner WITHOUT running
	// hot.dispose, leaving the singleton timer bound to a dead module graph whose
	// reconnect import()s fail with "Vite module runner has been closed" forever.
	// The timer therefore dispatches through a globalThis tick slot that every
	// startHealthPolling() call repoints at the calling module instance.
	test("a later startHealthPolling call takes over dispatch without re-arming the timer", () => {
		startHealthPolling();
		const timer = getHealthPollTimer();
		const firstTick = getHealthPollTick();
		expect(firstTick).not.toBeNull();
		startHealthPolling(); // a fresh module graph re-bootstrapping after a runner swap
		expect(getHealthPollTimer()).toBe(timer); // same timer -- no stacking
		expect(getHealthPollTick()).not.toBe(firstTick); // dispatch repointed at the new caller
	});

	test("stopHealthPolling clears the tick slot alongside the timer", () => {
		startHealthPolling();
		expect(getHealthPollTick()).not.toBeNull();
		stopHealthPolling();
		expect(getHealthPollTick()).toBeNull();
	});
});

// Terminal-error classification for the reconnect self-heal: a closed-runner
// import failure stops the dead graph's poll loop instead of warning every 30s.
describe("isClosedModuleRunnerError", () => {
	test("matches the Vite closed-runner import failure", () => {
		expect(isClosedModuleRunnerError(new Error("Vite module runner has been closed."))).toBe(true);
		expect(isClosedModuleRunnerError(new Error("Vite module runner has been closed"))).toBe(true);
	});

	test("rejects ordinary connect errors and non-Errors", () => {
		expect(isClosedModuleRunnerError(new Error("fetch failed"))).toBe(false);
		expect(isClosedModuleRunnerError("Vite module runner has been closed")).toBe(false);
		expect(isClosedModuleRunnerError(undefined)).toBe(false);
	});
});
