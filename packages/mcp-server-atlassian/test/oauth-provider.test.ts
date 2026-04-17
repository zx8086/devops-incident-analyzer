// test/oauth-provider.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AtlassianOAuthProvider, OAUTH_CALLBACK_PATH } from "../src/atlassian-client/oauth-provider.js";

const STORAGE_DIR = join(homedir(), ".mcp-auth", "atlassian");

function cleanup() {
	if (existsSync(STORAGE_DIR)) rmSync(STORAGE_DIR, { recursive: true, force: true });
}

describe("AtlassianOAuthProvider", () => {
	afterEach(cleanup);

	test("redirectUrl uses configured callback port", () => {
		const provider = new AtlassianOAuthProvider({
			mcpEndpoint: "https://mcp.atlassian.com/v1/mcp",
			callbackPort: 9185,
			onRedirect: () => {},
		});
		expect(provider.redirectUrl).toBe(`http://localhost:9185${OAUTH_CALLBACK_PATH}`);
	});

	test("clientMetadata includes Atlassian-specific client_name", () => {
		const provider = new AtlassianOAuthProvider({
			mcpEndpoint: "https://mcp.atlassian.com/v1/mcp",
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
			mcpEndpoint: "https://mcp.atlassian.com/v1/mcp",
			callbackPort: 9185,
			onRedirect: () => {},
		});
		provider.saveTokens({ access_token: "tkn", token_type: "bearer" });
		const sanitized = "https://mcp.atlassian.com/v1/mcp".replace(/[^a-zA-Z0-9.-]/g, "_");
		const path = join(STORAGE_DIR, `${sanitized}.json`);
		expect(existsSync(path)).toBe(true);
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.tokens.access_token).toBe("tkn");
	});

	test("invalidateCredentials('tokens') clears tokens only", () => {
		const provider = new AtlassianOAuthProvider({
			mcpEndpoint: "https://mcp.atlassian.com/v1/mcp",
			callbackPort: 9185,
			onRedirect: () => {},
		});
		provider.saveClientInformation({ client_id: "c1" });
		provider.saveTokens({ access_token: "tkn", token_type: "bearer" });
		provider.invalidateCredentials("tokens");
		expect(provider.tokens()).toBeUndefined();
		expect(provider.clientInformation()?.client_id).toBe("c1");
	});
});
