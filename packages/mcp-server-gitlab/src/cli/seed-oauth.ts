#!/usr/bin/env bun
// src/cli/seed-oauth.ts

import { seedOAuth } from "@devops-agent/shared";
import { loadConfiguration } from "../config/index.js";
import { GitLabOAuthProvider } from "../gitlab-client/oauth-provider.js";

// The seeder must always run interactively even if MCP_OAUTH_HEADLESS is set
// in the calling shell; otherwise the provider would throw before the popup
// fires. Operators run this CLI specifically to seed tokens for headless
// downstream contexts (eval, AgentCore).
delete process.env.MCP_OAUTH_HEADLESS;

async function main() {
	const config = await loadConfiguration();
	const mcpUrl = new URL("/api/v4/mcp", config.gitlab.instanceUrl);

	const provider = new GitLabOAuthProvider(config.gitlab.instanceUrl, config.gitlab.oauthCallbackPort, (authUrl) => {
		console.log(`\n  Authorize in your browser:\n  ${authUrl.toString()}\n`);
		const platform = process.platform;
		const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
		try {
			Bun.spawn([cmd, authUrl.toString()]);
		} catch {
			console.warn("Could not open browser automatically. Please open the URL above manually.");
		}
	});

	console.log(`Seeding GitLab OAuth tokens (instance=${config.gitlab.instanceUrl})`);
	await seedOAuth({
		provider,
		mcpUrl,
		callbackPort: config.gitlab.oauthCallbackPort,
		clientName: "gitlab-mcp-seed",
	});
	console.log("Done. Tokens persisted to ~/.mcp-auth/gitlab/.");
}

main().catch((error) => {
	console.error("Seed failed:", error instanceof Error ? error.message : String(error));
	process.exit(1);
});
