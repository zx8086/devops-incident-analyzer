#!/usr/bin/env bun
// src/cli/doctor-oauth.ts

import { diagnoseOAuth, formatDiagnosis } from "@devops-agent/shared";
import { loadConfiguration } from "../config/index.js";

// SIO-894: read-only OAuth health check for the Atlassian MCP proxy. Atlassian
// has no /oauth/token/info or PAT path (OAuth-only via Rovo), so the doctor
// inspects the token file and probes an MCP `initialize` against the configured
// endpoint. The storage key is the mcpEndpoint (AtlassianOAuthProvider keys off
// it, unlike GitLab which keys off instanceUrl).

async function main() {
	const config = await loadConfiguration();
	const endpoint = new URL(config.atlassian.mcpEndpoint);
	const result = await diagnoseOAuth({
		namespace: "atlassian",
		key: config.atlassian.mcpEndpoint,
		instanceUrl: endpoint.origin,
		mcpProbePath: endpoint.pathname,
	});

	console.log(formatDiagnosis(result));
	process.exit(result.healthy ? 0 : 1);
}

main().catch((error) => {
	console.error("Doctor failed:", error instanceof Error ? error.message : String(error));
	process.exit(1);
});
