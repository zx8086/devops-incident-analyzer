// src/atlassian-client/oauth-provider.ts

import {
	type AuthorizationHandler,
	BaseOAuthClientProvider,
	OAUTH_CALLBACK_PATH,
	type OAuthProviderLogger,
} from "@devops-agent/shared";
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createContextLogger } from "../utils/logger.js";

const log = createContextLogger("oauth");

export type { AuthorizationHandler };
export { OAUTH_CALLBACK_PATH };

export interface AtlassianOAuthProviderOptions {
	mcpEndpoint: string;
	callbackPort: number;
	onRedirect: AuthorizationHandler;
}

export class AtlassianOAuthProvider extends BaseOAuthClientProvider {
	constructor({ mcpEndpoint, callbackPort, onRedirect }: AtlassianOAuthProviderOptions) {
		super({
			storageNamespace: "atlassian",
			storageKey: mcpEndpoint,
			callbackPort,
			onRedirect,
			logger: log as unknown as OAuthProviderLogger,
		});
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "DevOps Incident Analyzer - Atlassian MCP Proxy",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "client_secret_post",
		};
	}
}
