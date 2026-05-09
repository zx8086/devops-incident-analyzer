#!/usr/bin/env bun
// src/cli/seed-oauth.ts

import { seedOAuth } from "@devops-agent/shared";
import { AtlassianOAuthProvider } from "../atlassian-client/oauth-provider.js";
import { loadConfiguration } from "../config/index.js";

// See packages/mcp-server-gitlab/src/cli/seed-oauth.ts for the rationale; the
// seeder must always run interactively even if MCP_OAUTH_HEADLESS is set.
delete process.env.MCP_OAUTH_HEADLESS;

async function main() {
	const config = await loadConfiguration();
	const mcpUrl = new URL(config.atlassian.mcpEndpoint);

	const provider = new AtlassianOAuthProvider({
		mcpEndpoint: config.atlassian.mcpEndpoint,
		callbackPort: config.atlassian.oauthCallbackPort,
		onRedirect: (authUrl) => {
			console.log(`\n  Authorize in your browser:\n  ${authUrl.toString()}\n`);
			const platform = process.platform;
			const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
			try {
				Bun.spawn([cmd, authUrl.toString()]);
			} catch {
				console.warn("Could not open browser automatically. Please open the URL above manually.");
			}
		},
	});

	console.log(`Seeding Atlassian OAuth tokens (endpoint=${config.atlassian.mcpEndpoint})`);
	await seedOAuth({
		provider,
		mcpUrl,
		callbackPort: config.atlassian.oauthCallbackPort,
		clientName: "atlassian-mcp-seed",
	});
	console.log("Done. Tokens persisted to ~/.mcp-auth/atlassian/.");
}

main().catch((error) => {
	console.error("Seed failed:", error instanceof Error ? error.message : String(error));
	process.exit(1);
});
