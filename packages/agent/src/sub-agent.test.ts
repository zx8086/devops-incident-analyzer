// packages/agent/src/sub-agent.test.ts
import { describe, expect, test } from "bun:test";
import { classifyToolError, getSubAgentRecursionLimit, getSubAgentTimeoutMs } from "./sub-agent.ts";

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
