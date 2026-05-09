// src/oauth/errors.ts

export class OAuthRequiresInteractiveAuthError extends Error {
	readonly namespace: string;
	readonly authorizationUrl: URL;

	constructor(namespace: string, authorizationUrl: URL) {
		super(
			`OAuth interactive authorization required for ${namespace} but MCP_OAUTH_HEADLESS=true; ` +
				`run \`bun run oauth:seed:${namespace}\` once interactively to seed tokens`,
		);
		this.name = "OAuthRequiresInteractiveAuthError";
		this.namespace = namespace;
		this.authorizationUrl = authorizationUrl;
	}
}
