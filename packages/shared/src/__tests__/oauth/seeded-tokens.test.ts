// src/__tests__/oauth/seeded-tokens.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { BaseOAuthClientProvider } from "../../oauth/base-provider.ts";
import { hasSeededTokens } from "../../oauth/seeded-tokens.ts";

const TEST_NAMESPACE = "__seeded-tokens-test__";
const STORAGE_DIR = join(homedir(), ".mcp-auth", TEST_NAMESPACE);

function cleanup() {
	if (existsSync(STORAGE_DIR)) rmSync(STORAGE_DIR, { recursive: true, force: true });
}

function writeRaw(filename: string, content: string): void {
	mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
	writeFileSync(join(STORAGE_DIR, filename), content, { encoding: "utf-8", mode: 0o600 });
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

describe("hasSeededTokens", () => {
	beforeEach(cleanup);
	afterEach(cleanup);

	test("returns false when namespace dir does not exist", () => {
		expect(hasSeededTokens(TEST_NAMESPACE, "any-key")).toBe(false);
	});

	test("returns false when token file does not exist", () => {
		mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
		expect(hasSeededTokens(TEST_NAMESPACE, "missing-key")).toBe(false);
	});

	test("returns false when token file is malformed JSON", () => {
		writeRaw("bad-key.json", "{not-valid-json");
		expect(hasSeededTokens(TEST_NAMESPACE, "bad-key")).toBe(false);
	});

	test("returns false when JSON has no tokens key", () => {
		writeRaw("no-tokens.json", JSON.stringify({ clientInformation: { client_id: "x" } }));
		expect(hasSeededTokens(TEST_NAMESPACE, "no-tokens")).toBe(false);
	});

	test("returns false when tokens.access_token is empty string", () => {
		writeRaw("empty-token.json", JSON.stringify({ tokens: { access_token: "" } }));
		expect(hasSeededTokens(TEST_NAMESPACE, "empty-token")).toBe(false);
	});

	test("returns false when tokens.access_token is missing", () => {
		writeRaw("no-access.json", JSON.stringify({ tokens: { token_type: "bearer" } }));
		expect(hasSeededTokens(TEST_NAMESPACE, "no-access")).toBe(false);
	});

	test("returns true when tokens.access_token is a non-empty string", () => {
		writeRaw("ok.json", JSON.stringify({ tokens: { access_token: "abc-123", token_type: "bearer" } }));
		expect(hasSeededTokens(TEST_NAMESPACE, "ok")).toBe(true);
	});

	// Load-bearing test: writer (BaseOAuthClientProvider.saveTokens) and reader
	// (hasSeededTokens) must agree on path. The whole point of the
	// getOAuthStoragePath refactor is to prevent them drifting.
	test("agrees with BaseOAuthClientProvider writer for non-trivial keys", () => {
		const key = "https://gitlab.com/api/v4/oauth-mcp";
		const provider = new TestProvider({
			storageNamespace: TEST_NAMESPACE,
			storageKey: key,
			callbackPort: 9999,
			onRedirect: () => {},
		});
		expect(hasSeededTokens(TEST_NAMESPACE, key)).toBe(false);
		provider.saveTokens({ access_token: "round-trip-token", token_type: "bearer" });
		expect(hasSeededTokens(TEST_NAMESPACE, key)).toBe(true);
	});
});
