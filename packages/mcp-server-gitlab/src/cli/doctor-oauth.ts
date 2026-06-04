#!/usr/bin/env bun
// src/cli/doctor-oauth.ts

import { diagnoseOAuth, formatDiagnosis } from "@devops-agent/shared";
import { loadConfiguration } from "../config/index.js";

// SIO-894: read-only OAuth health check for the GitLab MCP proxy. Prints a
// verdict (token file, live introspection, /api/v4/mcp reachability, PAT probe)
// without opening a browser, so "I can't login" resolves to which of
// {OAuth, PAT, instance URL, scope, expiry} is actually wrong.

async function main() {
	const config = await loadConfiguration();
	const result = await diagnoseOAuth({
		namespace: "gitlab",
		key: config.gitlab.instanceUrl,
		instanceUrl: config.gitlab.instanceUrl,
		mcpProbePath: "/api/v4/mcp",
		tokenInfoPath: "/oauth/token/info",
		personalAccessToken: config.gitlab.personalAccessToken,
	});

	console.log(formatDiagnosis(result));
	process.exit(result.healthy ? 0 : 1);
}

main().catch((error) => {
	console.error("Doctor failed:", error instanceof Error ? error.message : String(error));
	process.exit(1);
});
