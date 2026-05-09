// src/oauth/boot-warn.ts

import type { OAuthProviderLogger } from "./base-provider.ts";
import { isHeadless } from "./headless.ts";
import { hasSeededTokens } from "./seeded-tokens.ts";

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
			{ namespace: options.namespace, seeded },
			"MCP_OAUTH_HEADLESS active -- OAuth browser popups disabled; missing tokens will throw OAuthRequiresInteractiveAuthError",
		);
	}
}
