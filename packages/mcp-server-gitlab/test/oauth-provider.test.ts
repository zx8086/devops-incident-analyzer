// test/oauth-provider.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GitLabOAuthProvider, OAUTH_CALLBACK_PATH } from "../src/gitlab-client/oauth-provider.js";

const STORAGE_DIR = join(homedir(), ".mcp-auth", "gitlab");

function cleanup() {
	if (existsSync(STORAGE_DIR)) rmSync(STORAGE_DIR, { recursive: true, force: true });
}

describe("GitLabOAuthProvider", () => {
	afterEach(cleanup);

	test("clientMetadata uses public-client + PKCE per RFC 8252", () => {
		const provider = new GitLabOAuthProvider("https://gitlab.com", 9184, () => {});
		const metadata = provider.clientMetadata;
		// SIO-685 root cause: GitLab DCR registers public clients (no client_secret).
		expect(metadata.token_endpoint_auth_method).toBe("none");
	});

	test("clientMetadata pins scope=mcp (GitLab MR !208967)", () => {
		const provider = new GitLabOAuthProvider("https://gitlab.com", 9184, () => {});
		expect(provider.clientMetadata.scope).toBe("mcp");
	});

	test("clientMetadata declares both authorization_code and refresh_token grants", () => {
		const provider = new GitLabOAuthProvider("https://gitlab.com", 9184, () => {});
		const grants = provider.clientMetadata.grant_types;
		expect(grants).toContain("authorization_code");
		expect(grants).toContain("refresh_token");
	});

	test("redirectUrl uses the injected callback port", () => {
		const provider = new GitLabOAuthProvider("https://gitlab.com", 9555, () => {});
		expect(provider.redirectUrl).toBe(`http://localhost:9555${OAUTH_CALLBACK_PATH}`);
	});

	test("client_name identifies the GitLab proxy", () => {
		const provider = new GitLabOAuthProvider("https://gitlab.com", 9184, () => {});
		expect(provider.clientMetadata.client_name).toContain("GitLab");
	});

	test("redirect_uris matches the redirectUrl getter", () => {
		const provider = new GitLabOAuthProvider("https://gitlab.com", 9184, () => {});
		expect(provider.clientMetadata.redirect_uris).toContain(provider.redirectUrl);
	});
});
