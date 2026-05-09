// src/__tests__/oauth/base-provider.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { BaseOAuthClientProvider } from "../../oauth/base-provider.ts";
import { OAuthRequiresInteractiveAuthError } from "../../oauth/errors.ts";

const TEST_NAMESPACE = "__base-provider-test__";
const STORAGE_DIR = join(homedir(), ".mcp-auth", TEST_NAMESPACE);

function cleanup() {
	if (existsSync(STORAGE_DIR)) rmSync(STORAGE_DIR, { recursive: true, force: true });
}

class TestProvider extends BaseOAuthClientProvider {
	override get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "test",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}
}

function makeProvider(overrides: Partial<{ key: string; port: number; onRedirect: (u: URL) => void }> = {}) {
	return new TestProvider({
		storageNamespace: TEST_NAMESPACE,
		storageKey: overrides.key ?? "test-key",
		callbackPort: overrides.port ?? 9999,
		onRedirect: overrides.onRedirect ?? (() => {}),
	});
}

describe("BaseOAuthClientProvider", () => {
	beforeEach(cleanup);
	afterEach(cleanup);
	afterEach(() => {
		delete process.env.MCP_OAUTH_HEADLESS;
	});

	test("redirectUrl uses configured callback port", () => {
		const provider = makeProvider({ port: 9876 });
		expect(provider.redirectUrl).toBe("http://localhost:9876/oauth/callback");
	});

	test("saveTokens persists to sanitized file path with mode 0o600", () => {
		const provider = makeProvider({ key: "https://example.com/v1/mcp" });
		provider.saveTokens({ access_token: "tkn", token_type: "bearer" });

		const sanitized = "https___example.com_v1_mcp";
		const path = join(STORAGE_DIR, `${sanitized}.json`);
		expect(existsSync(path)).toBe(true);

		const mode = statSync(path).mode & 0o777;
		expect(mode).toBe(0o600);

		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.tokens.access_token).toBe("tkn");
	});

	test("file mode is enforced via chmod even on pre-existing world-readable files", () => {
		const sanitized = "preexisting";
		const path = join(STORAGE_DIR, `${sanitized}.json`);
		// Simulate a file written by an older buggy version with mode 0o644.
		require("node:fs").mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
		writeFileSync(path, "{}", { encoding: "utf-8", mode: 0o644 });
		expect(statSync(path).mode & 0o777).toBe(0o644);

		const provider = makeProvider({ key: sanitized });
		provider.saveTokens({ access_token: "tkn", token_type: "bearer" });

		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("persistence round-trip: tokens survive across instances keyed by storageKey", () => {
		const a = makeProvider({ key: "round-trip" });
		a.saveTokens({ access_token: "first", token_type: "bearer" });

		const b = makeProvider({ key: "round-trip" });
		expect(b.tokens()?.access_token).toBe("first");
	});

	test("invalidateCredentials matrix", () => {
		const provider = makeProvider();
		provider.saveClientInformation({ client_id: "c1" });
		provider.saveTokens({ access_token: "tkn", token_type: "bearer" });
		provider.saveCodeVerifier("verifier-1");

		provider.invalidateCredentials("tokens");
		expect(provider.tokens()).toBeUndefined();
		expect(provider.clientInformation()?.client_id).toBe("c1");

		provider.invalidateCredentials("verifier");
		expect(() => provider.codeVerifier()).toThrow();

		provider.invalidateCredentials("client");
		expect(provider.clientInformation()).toBeUndefined();

		provider.saveTokens({ access_token: "x", token_type: "bearer" });
		provider.invalidateCredentials("all");
		expect(provider.tokens()).toBeUndefined();
	});

	test("redirectToAuthorization invokes onRedirect when not headless", async () => {
		let invokedWith: URL | undefined;
		const provider = makeProvider({
			onRedirect: (url) => {
				invokedWith = url;
			},
		});

		await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
		expect(invokedWith?.toString()).toBe("https://auth.example.com/authorize");
	});

	test("redirectToAuthorization throws OAuthRequiresInteractiveAuthError when MCP_OAUTH_HEADLESS=true", async () => {
		process.env.MCP_OAUTH_HEADLESS = "true";
		const provider = makeProvider();

		try {
			await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(OAuthRequiresInteractiveAuthError);
			const e = error as OAuthRequiresInteractiveAuthError;
			expect(e.namespace).toBe(TEST_NAMESPACE);
			expect(e.authorizationUrl.toString()).toBe("https://auth.example.com/authorize");
		}
	});

	test("clientInformation discards stale registration when auth_method mismatches", () => {
		const provider = makeProvider();
		// Persist a registration as if from an older codebase using client_secret_post.
		provider.saveClientInformation({
			client_id: "stale",
			token_endpoint_auth_method: "client_secret_post",
		} as Parameters<typeof provider.saveClientInformation>[0]);

		// New code expects "none" — the persisted record should be discarded silently.
		expect(provider.clientInformation()).toBeUndefined();

		// And the on-disk file should reflect the discard.
		const path = join(STORAGE_DIR, "test-key.json");
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.clientInformation).toBeUndefined();
	});

	test("clientInformation preserves persisted record when auth_method is absent (legacy fixtures)", () => {
		const provider = makeProvider();
		// Older test fixtures and persisted DCR responses may not carry an explicit
		// token_endpoint_auth_method. The migration path must trust those records.
		provider.saveClientInformation({ client_id: "legacy" });
		expect(provider.clientInformation()?.client_id).toBe("legacy");
	});

	test("saveTokens clears persisted codeVerifier (one-shot per flow)", () => {
		const provider = makeProvider();
		provider.saveCodeVerifier("verifier-2");
		expect(() => provider.codeVerifier()).not.toThrow();

		provider.saveTokens({ access_token: "tkn", token_type: "bearer" });
		expect(() => provider.codeVerifier()).toThrow();
	});

	test("sanitization: filename matches the byte-identical Atlassian shape", () => {
		// Regression guard: this snapshot ties the sanitization regex to the existing
		// on-disk filename users have for `https://mcp.atlassian.com/v1/mcp`. Any
		// regex change here would log existing users out by re-keying their state.
		const provider = makeProvider({ key: "https://mcp.atlassian.com/v1/mcp" });
		provider.saveTokens({ access_token: "tkn", token_type: "bearer" });

		const expectedPath = join(STORAGE_DIR, "https___mcp.atlassian.com_v1_mcp.json");
		expect(existsSync(expectedPath)).toBe(true);
	});
});
