// src/__tests__/oauth/doctor.test.ts

import { describe, expect, test } from "bun:test";
import type { PersistedOAuthState } from "../../oauth/base-provider.ts";
import { diagnoseOAuth, formatDiagnosis } from "../../oauth/doctor.ts";

function healthyState(): PersistedOAuthState {
	return {
		clientInformation: {
			client_id: "abcd1234567890abcd1234567890abcd",
			token_endpoint_auth_method: "none",
		} as PersistedOAuthState["clientInformation"],
		tokens: {
			access_token: "tok-abcdefghijklmnopqrstuvwxyz",
			refresh_token: "ref-abcdefghijklmnopqrstuvwxyz",
			token_type: "Bearer",
			expires_in: 7200,
			scope: "mcp",
		},
		// 1h ago -> ~1h remaining on a 2h token
		tokenObtainedAt: Date.now() - 3_600_000,
	};
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("diagnoseOAuth", () => {
	test("fails fast with no token file", async () => {
		const result = await diagnoseOAuth({
			namespace: "gitlab",
			key: "https://gitlab.com",
			instanceUrl: "https://gitlab.com",
			loadStateFn: () => null,
		});
		expect(result.healthy).toBe(false);
		expect(result.checks).toHaveLength(1);
		expect(result.checks[0]?.status).toBe("fail");
		expect(result.checks[0]?.detail).toContain("no readable token");
	});

	test("healthy token + live probes all pass; never leaks the raw token", async () => {
		const seenAuthHeaders: string[] = [];
		const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
			const auth = (init?.headers as Record<string, string>)?.Authorization;
			if (auth) seenAuthHeaders.push(auth);
			const u = url.toString();
			if (u.endsWith("/oauth/token/info")) {
				return jsonResponse(200, { scope: ["mcp"], expires_in_seconds: 4630 });
			}
			if (u.endsWith("/api/v4/mcp")) {
				return jsonResponse(200, { jsonrpc: "2.0", id: 1, result: {} });
			}
			if (u.endsWith("/api/v4/user")) {
				return jsonResponse(200, { id: 1, username: "svc" });
			}
			return jsonResponse(404, {});
		}) as unknown as typeof fetch;

		const result = await diagnoseOAuth({
			namespace: "gitlab",
			key: "https://gitlab.com",
			instanceUrl: "https://gitlab.com",
			mcpProbePath: "/api/v4/mcp",
			tokenInfoPath: "/oauth/token/info",
			personalAccessToken: "glpat-secret",
			loadStateFn: () => healthyState(),
			fetchFn,
		});

		expect(result.healthy).toBe(true);
		const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
		expect(byName["token file"]?.status).toBe("pass");
		expect(byName["live token introspection"]?.status).toBe("pass");
		expect(byName["mcp endpoint reachability"]?.status).toBe("pass");
		expect(byName["personal access token (code-analysis tools)"]?.status).toBe("pass");
		expect(byName.note?.status).toBe("info");

		// No check detail may contain the full access_token or refresh_token.
		for (const check of result.checks) {
			expect(check.detail).not.toContain("tok-abcdefghijklmnopqrstuvwxyz");
			expect(check.detail).not.toContain("ref-abcdefghijklmnopqrstuvwxyz");
			expect(check.detail).not.toContain("glpat-secret");
		}
	});

	test("rejected live token marks the run unhealthy", async () => {
		const fetchFn = (async (url: string | URL | Request) => {
			if (url.toString().endsWith("/oauth/token/info")) return jsonResponse(401, {});
			return jsonResponse(200, {});
		}) as unknown as typeof fetch;

		const result = await diagnoseOAuth({
			namespace: "gitlab",
			key: "https://gitlab.com",
			instanceUrl: "https://gitlab.com",
			tokenInfoPath: "/oauth/token/info",
			loadStateFn: () => healthyState(),
			fetchFn,
		});

		expect(result.healthy).toBe(false);
		const introspection = result.checks.find((c) => c.name === "live token introspection");
		expect(introspection?.status).toBe("fail");
	});

	test("omits the GitLab PAT note when tokenInfoPath is absent (Atlassian path)", async () => {
		const fetchFn = (async () => jsonResponse(200, {})) as unknown as typeof fetch;
		const result = await diagnoseOAuth({
			namespace: "atlassian",
			key: "http://localhost:9085/mcp",
			instanceUrl: "http://localhost:9085",
			mcpProbePath: "/mcp",
			loadStateFn: () => healthyState(),
			fetchFn,
		});
		expect(result.checks.find((c) => c.name === "note")).toBeUndefined();
	});

	test("formatDiagnosis renders a plain-text verdict with no emojis", () => {
		const text = formatDiagnosis({
			namespace: "gitlab",
			tokenFilePath: "/x/y.json",
			healthy: true,
			checks: [{ name: "token file", status: "pass", detail: "ok" }],
		});
		expect(text).toContain("Verdict: HEALTHY");
		expect(text).toContain("[PASS] token file");
		// No-emoji policy: every rendered codepoint stays in the ASCII range.
		expect([...text].every((ch) => (ch.codePointAt(0) ?? 0) < 128)).toBe(true);
	});
});
