// test/oauth-provider.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AtlassianOAuthProvider, OAUTH_CALLBACK_PATH } from "../src/atlassian-client/oauth-provider.js";

const STORAGE_DIR = join(homedir(), ".mcp-auth", "atlassian");
// Use a synthetic test endpoint so cleanup never touches the real
// `https___mcp.atlassian.com_v1_mcp.json` a developer might have on disk.
const TEST_ENDPOINT = "https://mcp.atlassian.test.invalid/v1/mcp";
const TEST_FILE = join(STORAGE_DIR, "https___mcp.atlassian.test.invalid_v1_mcp.json");

function cleanup() {
	if (existsSync(TEST_FILE)) rmSync(TEST_FILE);
}

describe("AtlassianOAuthProvider", () => {
	afterEach(cleanup);

	test("redirectUrl uses configured callback port", () => {
		const provider = new AtlassianOAuthProvider({
			mcpEndpoint: TEST_ENDPOINT,
			callbackPort: 9185,
			onRedirect: () => {},
		});
		expect(provider.redirectUrl).toBe(`http://localhost:9185${OAUTH_CALLBACK_PATH}`);
	});

	test("clientMetadata includes Atlassian-specific client_name", () => {
		const provider = new AtlassianOAuthProvider({
			mcpEndpoint: TEST_ENDPOINT,
			callbackPort: 9185,
			onRedirect: () => {},
		});
		const metadata = provider.clientMetadata;
		expect(metadata.client_name).toContain("Atlassian");
		expect(metadata.redirect_uris).toContain(provider.redirectUrl);
		expect(metadata.grant_types).toContain("authorization_code");
		expect(metadata.response_types).toContain("code");
	});

	test("saveTokens persists to sanitized file path", () => {
		const provider = new AtlassianOAuthProvider({
			mcpEndpoint: TEST_ENDPOINT,
			callbackPort: 9185,
			onRedirect: () => {},
		});
		provider.saveTokens({ access_token: "tkn", token_type: "bearer" });
		expect(existsSync(TEST_FILE)).toBe(true);
		const parsed = JSON.parse(readFileSync(TEST_FILE, "utf-8"));
		expect(parsed.tokens.access_token).toBe("tkn");
	});

	test("invalidateCredentials('tokens') clears tokens only", async () => {
		// SIO-702: stale-wipe guard ignores invalidate('tokens') within ~5s of a
		// saveTokens() to defeat the GitLab rotation race. Inject an advancing
		// clock so the second tick (used by invalidateCredentials) is past the
		// guard window relative to the first tick (saveTokens recorded it).
		const start = 1_000_000;
		let now = start;
		const provider = new AtlassianOAuthProvider({
			mcpEndpoint: TEST_ENDPOINT,
			callbackPort: 9185,
			onRedirect: () => {},
			clock: () => now,
		});
		provider.saveClientInformation({ client_id: "c1" });
		provider.saveTokens({ access_token: "tkn", token_type: "bearer" });
		now += 10_000; // past STALE_INVALIDATION_WINDOW_MS
		provider.invalidateCredentials("tokens");
		expect(await provider.tokens()).toBeUndefined();
		expect(provider.clientInformation()?.client_id).toBe("c1");
	});
});
