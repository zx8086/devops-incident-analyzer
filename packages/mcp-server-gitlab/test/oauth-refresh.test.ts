// test/oauth-refresh.test.ts

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OAuthRefreshChainExpiredError } from "@devops-agent/shared";
import { GitLabOAuthProvider } from "../src/gitlab-client/oauth-provider.js";

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
