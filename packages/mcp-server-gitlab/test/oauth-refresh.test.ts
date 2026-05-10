// test/oauth-refresh.test.ts

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OAuthRefreshChainExpiredError } from "@devops-agent/shared";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { GitLabOAuthProvider } from "../src/gitlab-client/oauth-provider.js";
import { GitLabMcpProxy, type McpClientLike } from "../src/gitlab-client/proxy.js";

// Use a synthetic instance URL so the on-disk token file lives at a path that
// will never collide with a developer's real seeded gitlab.com tokens.
// homedir() on macOS does not honor process.env.HOME (it reads the system
// password DB), so we cannot redirect to /tmp; instead we write to a deliberately
// namespaced file under the real ~/.mcp-auth/gitlab/ and clean it up.
const INSTANCE_URL = "https://gitlab.refresh-test.invalid";
const SANITIZED_KEY = "https___gitlab.refresh-test.invalid";
const STORAGE_DIR = join(homedir(), ".mcp-auth", "gitlab");
const TOKEN_FILE = join(STORAGE_DIR, `${SANITIZED_KEY}.json`);

let originalFetch: typeof fetch;

function seedTokenFile(payload: Record<string, unknown>): void {
	mkdirSync(STORAGE_DIR, { recursive: true });
	writeFileSync(TOKEN_FILE, JSON.stringify(payload), "utf-8");
}

function makeProvider(): GitLabOAuthProvider {
	return new GitLabOAuthProvider(INSTANCE_URL, 9184, async () => {
		throw new Error("popup should not fire in refresh tests");
	});
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
	if (existsSync(TOKEN_FILE)) rmSync(TOKEN_FILE);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (existsSync(TOKEN_FILE)) rmSync(TOKEN_FILE);
});

describe("GitLabOAuthProvider.refreshTokens", () => {
	test("posts grant_type=refresh_token and persists rotated tokens", async () => {
		seedTokenFile({
			tokens: { access_token: "old-access", refresh_token: "still-good", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe(`${INSTANCE_URL}/oauth/token`);
			expect(init?.method).toBe("POST");
			const body = init?.body as URLSearchParams;
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("refresh_token")).toBe("still-good");
			expect(body.get("client_id")).toBe("abc123");
			return new Response(
				JSON.stringify({
					access_token: "new-access",
					refresh_token: "rotated",
					token_type: "Bearer",
					expires_in: 7200,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const provider = makeProvider();
		const tokens = await provider.refreshTokens();

		expect(tokens.access_token).toBe("new-access");
		expect(tokens.refresh_token).toBe("rotated");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const onDisk = JSON.parse(readFileSync(TOKEN_FILE, "utf-8")) as {
			tokens: { access_token: string; refresh_token: string };
		};
		expect(onDisk.tokens.access_token).toBe("new-access");
		expect(onDisk.tokens.refresh_token).toBe("rotated");
	});

	test("throws OAuthRefreshChainExpiredError when refresh_token is missing on disk", async () => {
		seedTokenFile({
			tokens: { access_token: "old-access", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		globalThis.fetch = mock(async () => {
			throw new Error("fetch should not be called when refresh_token is missing");
		}) as unknown as typeof fetch;

		const provider = makeProvider();
		await expect(provider.refreshTokens()).rejects.toBeInstanceOf(OAuthRefreshChainExpiredError);
	});

	test("throws OAuthRefreshChainExpiredError on 400 invalid_grant", async () => {
		seedTokenFile({
			tokens: { access_token: "old-access", refresh_token: "dead", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ error: "invalid_grant" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		const provider = makeProvider();
		await expect(provider.refreshTokens()).rejects.toBeInstanceOf(OAuthRefreshChainExpiredError);

		const onDisk = JSON.parse(readFileSync(TOKEN_FILE, "utf-8")) as {
			tokens: { access_token: string };
		};
		expect(onDisk.tokens.access_token).toBe("old-access");
	});

	test("dedupes concurrent callers into a single fetch", async () => {
		seedTokenFile({
			tokens: { access_token: "old", refresh_token: "good", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		let inFlight = 0;
		let maxObserved = 0;
		const fetchMock = mock(async () => {
			inFlight++;
			maxObserved = Math.max(maxObserved, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 30));
			inFlight--;
			return new Response(
				JSON.stringify({ access_token: "new", refresh_token: "good", token_type: "Bearer", expires_in: 7200 }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const provider = makeProvider();
		const results = await Promise.all([
			provider.refreshTokens(),
			provider.refreshTokens(),
			provider.refreshTokens(),
			provider.refreshTokens(),
			provider.refreshTokens(),
		]);

		expect(results).toHaveLength(5);
		for (const r of results) expect(r.access_token).toBe("new");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(maxObserved).toBe(1);
	});

	test("rethrows network errors as-is so transient classifier handles them", async () => {
		seedTokenFile({
			tokens: { access_token: "old", refresh_token: "good", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		globalThis.fetch = mock(async () => {
			throw new TypeError("fetch failed (ECONNRESET)");
		}) as unknown as typeof fetch;

		const provider = makeProvider();
		await expect(provider.refreshTokens()).rejects.toThrow(/ECONNRESET/);
		await expect(provider.refreshTokens()).rejects.not.toBeInstanceOf(OAuthRefreshChainExpiredError);
	});
});

describe("GitLabMcpProxy.callTool refresh path", () => {
	const baseConfig = {
		instanceUrl: INSTANCE_URL,
		personalAccessToken: "pat",
		timeout: 30000,
		oauthCallbackPort: 9184,
	};

	function makeRefreshingClient(opts: { failures: number; onCall?: () => void }): McpClientLike {
		let remaining = opts.failures;
		return {
			listTools: async () => ({ tools: [] }),
			callTool: async () => {
				opts.onCall?.();
				if (remaining > 0) {
					remaining--;
					throw new UnauthorizedError("token expired");
				}
				return { ok: true };
			},
		};
	}

	test("refreshes once and retries on UnauthorizedError, then succeeds", async () => {
		seedTokenFile({
			tokens: { access_token: "old", refresh_token: "good", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		const fetchMock = mock(
			async () =>
				new Response(
					JSON.stringify({ access_token: "fresh", refresh_token: "good", token_type: "Bearer", expires_in: 7200 }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const calls: number[] = [];
		const client = makeRefreshingClient({ failures: 1, onCall: () => calls.push(Date.now()) });
		const proxy = new GitLabMcpProxy({ config: baseConfig, client });
		await proxy.connect();

		const result = await proxy.callTool("gitlab_search", { q: "test" });

		expect(result).toEqual({ ok: true });
		expect(calls).toHaveLength(2);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const onDisk = JSON.parse(readFileSync(TOKEN_FILE, "utf-8")) as {
			tokens: { access_token: string };
		};
		expect(onDisk.tokens.access_token).toBe("fresh");
	});

	test("propagates OAuthRefreshChainExpiredError when refresh fails (headless mode)", async () => {
		seedTokenFile({
			tokens: { access_token: "old", refresh_token: "dead", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ error: "invalid_grant" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		const prev = process.env.MCP_OAUTH_HEADLESS;
		process.env.MCP_OAUTH_HEADLESS = "true";
		try {
			const client = makeRefreshingClient({ failures: 1 });
			const proxy = new GitLabMcpProxy({ config: baseConfig, client });
			await proxy.connect();

			await expect(proxy.callTool("gitlab_search", { q: "test" })).rejects.toBeInstanceOf(
				OAuthRefreshChainExpiredError,
			);

			const onDisk = JSON.parse(readFileSync(TOKEN_FILE, "utf-8")) as {
				tokens: { access_token: string };
			};
			expect(onDisk.tokens.access_token).toBe("old");
		} finally {
			process.env.MCP_OAUTH_HEADLESS = prev;
		}
	});

	test("does not retry a second 401 (refresh succeeded but token still rejected)", async () => {
		seedTokenFile({
			tokens: { access_token: "old", refresh_token: "good", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({ access_token: "fresh", refresh_token: "good", token_type: "Bearer", expires_in: 7200 }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const client = makeRefreshingClient({ failures: 2 });
		const proxy = new GitLabMcpProxy({ config: baseConfig, client });
		await proxy.connect();

		await expect(proxy.callTool("gitlab_search", { q: "test" })).rejects.toBeInstanceOf(UnauthorizedError);
	});

	test("happy path: no UnauthorizedError, no refresh fired", async () => {
		seedTokenFile({
			tokens: { access_token: "fresh", refresh_token: "good", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		const fetchMock = mock(async () => {
			throw new Error("fetch should not be called when token is valid");
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const client: McpClientLike = {
			listTools: async () => ({ tools: [] }),
			callTool: async () => ({ ok: true }),
		};
		const proxy = new GitLabMcpProxy({ config: baseConfig, client });
		await proxy.connect();

		const result = await proxy.callTool("gitlab_search", { q: "test" });
		expect(result).toEqual({ ok: true });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// SIO-702: the canonical regression for the rotation-race wipe. The bug being
// reproduced: N parallel SDK auth() flows each fire their own refreshAuthorization,
// the first wins, the rest get 400 invalid_grant after GitLab rotates the
// refresh_token, and the SDK calls invalidateCredentials('tokens') -- wiping
// the freshly-saved tokens. The fix routes every read through ensureFreshTokens()
// in the base provider, which guarantees a single in-flight POST.
describe("tokens() refresh-on-read race (SIO-702)", () => {
	function seedExpired(): void {
		// tokenObtainedAt at epoch 0 + small expires_in -> isExpired() returns true
		// for every realistic clock value.
		seedTokenFile({
			tokens: {
				access_token: "expired",
				refresh_token: "good",
				token_type: "Bearer",
				expires_in: 1,
			},
			tokenObtainedAt: 0,
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
	}

	test("10 concurrent tokens() reads on an expired token trigger exactly one /oauth/token POST", async () => {
		seedExpired();
		let fetchInFlight = 0;
		let maxObserved = 0;
		const fetchMock = mock(async () => {
			fetchInFlight++;
			maxObserved = Math.max(maxObserved, fetchInFlight);
			await new Promise((r) => setTimeout(r, 30));
			fetchInFlight--;
			return new Response(
				JSON.stringify({
					access_token: "fresh",
					refresh_token: "rotated",
					token_type: "Bearer",
					expires_in: 7200,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const provider = new GitLabOAuthProvider(INSTANCE_URL, 9184, async () => {
			throw new Error("popup should not fire");
		});
		const results = await Promise.all(Array.from({ length: 10 }, () => provider.tokens()));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(maxObserved).toBe(1);
		for (const r of results) expect(r?.access_token).toBe("fresh");
	});

	test("10 concurrent tokens() reads with invalid_grant fail once and never wipe credentials", async () => {
		seedExpired();
		const fetchMock = mock(
			async () =>
				new Response(JSON.stringify({ error: "invalid_grant" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const provider = new GitLabOAuthProvider(INSTANCE_URL, 9184, async () => {
			throw new Error("popup should not fire");
		});
		const settled = await Promise.allSettled(Array.from({ length: 10 }, () => provider.tokens()));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const rejections = settled.filter((s) => s.status === "rejected");
		expect(rejections).toHaveLength(10);
		for (const s of rejections) {
			if (s.status === "rejected") {
				expect(s.reason).toBeInstanceOf(OAuthRefreshChainExpiredError);
			}
		}
		// File on disk should retain the old tokens -- no wipe under invalid_grant
		// from the single POST. (The SDK is what calls invalidateCredentials; here
		// we test the provider in isolation, so the absence of any wipe is purely
		// from refreshTokens() not touching invalidateCredentials.)
		const onDisk = JSON.parse(readFileSync(TOKEN_FILE, "utf-8")) as {
			tokens: { access_token: string };
		};
		expect(onDisk.tokens.access_token).toBe("expired");
	});

	test("stale-wipe regression: invalidateCredentials('tokens') after a fresh save is ignored", async () => {
		seedExpired();
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({ access_token: "fresh", refresh_token: "rotated", token_type: "Bearer", expires_in: 7200 }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const provider = new GitLabOAuthProvider(INSTANCE_URL, 9184, async () => {
			throw new Error("popup should not fire");
		});
		// Trigger a refresh through the public read path.
		const fresh = await provider.tokens();
		expect(fresh?.access_token).toBe("fresh");

		// Simulate the SDK's reaction to a losing-racer's late 400 invalid_grant:
		// it calls invalidateCredentials('tokens') *after* we already saved fresh
		// tokens. The base-class stale-wipe guard must skip the wipe.
		provider.invalidateCredentials("tokens");

		const onDisk = JSON.parse(readFileSync(TOKEN_FILE, "utf-8")) as {
			tokens?: { access_token?: string };
		};
		expect(onDisk.tokens?.access_token).toBe("fresh");
	});

	test("returns persisted tokens unchanged when within skew (no /oauth/token POST)", async () => {
		// Save with an obtainedAt close to now so isExpired() returns false.
		seedTokenFile({
			tokens: {
				access_token: "still-valid",
				refresh_token: "good",
				token_type: "Bearer",
				expires_in: 7200,
			},
			tokenObtainedAt: Date.now(),
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		const fetchMock = mock(async () => {
			throw new Error("fetch must not be called when token is fresh");
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const provider = new GitLabOAuthProvider(INSTANCE_URL, 9184, async () => {
			throw new Error("popup should not fire");
		});
		const t = await provider.tokens();

		expect(t?.access_token).toBe("still-valid");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
