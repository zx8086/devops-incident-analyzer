// src/oauth/boot-warn.ts

import { existsSync, readFileSync } from "node:fs";
import { getOAuthStoragePath, type OAuthProviderLogger, type PersistedOAuthState } from "./base-provider.ts";
import { isHeadless } from "./headless.ts";
import { hasSeededTokens } from "./seeded-tokens.ts";

// SIO-894: surface seeded-token health (scope + hours until access-token expiry)
// in the boot log so a trace shows whether OAuth is the problem at startup,
// without running oauth:doctor. Read-only and best-effort: any parse failure
// yields an empty summary rather than blocking boot.
function tokenSummary(namespace: string, key: string): Record<string, unknown> {
	const path = getOAuthStoragePath(namespace, key);
	if (!existsSync(path)) return {};
	try {
		const state = JSON.parse(readFileSync(path, "utf-8")) as PersistedOAuthState;
		const summary: Record<string, unknown> = {};
		if (state.tokens?.scope) summary.tokenScope = state.tokens.scope;
		if (typeof state.tokenObtainedAt === "number" && typeof state.tokens?.expires_in === "number") {
			const remainingMs = state.tokenObtainedAt + state.tokens.expires_in * 1000 - Date.now();
			summary.accessTokenExpiresInHours = Math.round((remainingMs / 3_600_000) * 100) / 100;
		}
		return summary;
	} catch {
		return {};
	}
}

export interface WarnIfOAuthNotSeededOptions {
	namespace: string;
	key: string;
	endpointLabel: string;
	seedCommand: string;
	logger: OAuthProviderLogger;
	hasSeededTokensFn?: typeof hasSeededTokens;
	isHeadlessFn?: typeof isHeadless;
}

// Boot-time check for OAuth-backed MCP servers (gitlab, atlassian). Emits a
// prominent WARN if no seeded tokens exist AND MCP_OAUTH_HEADLESS is not set
// -- the SIO-693 misconfig that loops on browser popups during eval. Emits a
// quieter INFO line confirming the headless setup when it IS on, so operators
// can verify both the flag and the seeded state at a glance (the verification
// missing in SIO-690).
//
// Test seams (hasSeededTokensFn, isHeadlessFn) override the real
// implementations so unit tests don't have to touch ~/.mcp-auth or env.
export function warnIfOAuthNotSeeded(options: WarnIfOAuthNotSeededOptions): void {
	const seededFn = options.hasSeededTokensFn ?? hasSeededTokens;
	const headlessFn = options.isHeadlessFn ?? isHeadless;

	const seeded = seededFn(options.namespace, options.key);
	const headless = headlessFn();

	if (!seeded && !headless) {
		const subject = options.namespace.toUpperCase();
		options.logger.warn(
			{
				namespace: options.namespace,
				[options.endpointLabel]: options.key,
				remediation: options.seedCommand,
				docs: ".env.example MCP_OAUTH_HEADLESS",
			},
			`!!! ${subject} OAUTH NOT SEEDED AND MCP_OAUTH_HEADLESS IS NOT SET -- ` +
				`first request will pop a browser. Run \`${options.seedCommand}\` to seed ` +
				"tokens, OR set MCP_OAUTH_HEADLESS=true in .env to fail fast on auth.",
		);
		return;
	}

	if (headless) {
		options.logger.info(
			{ namespace: options.namespace, seeded, ...(seeded ? tokenSummary(options.namespace, options.key) : {}) },
			"MCP_OAUTH_HEADLESS active -- OAuth browser popups disabled; missing tokens will throw OAuthRequiresInteractiveAuthError",
		);
	}
}
