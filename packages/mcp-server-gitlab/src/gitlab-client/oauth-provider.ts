// src/gitlab-client/oauth-provider.ts

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

export class GitLabOAuthProvider extends BaseOAuthClientProvider {
	constructor(instanceUrl: string, callbackPort: number, onRedirect: AuthorizationHandler) {
		super({
			storageNamespace: "gitlab",
			storageKey: instanceUrl,
			callbackPort,
			onRedirect,
			logger: log as unknown as OAuthProviderLogger,
		});
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "DevOps Incident Analyzer - GitLab MCP Proxy",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			// GitLab's /api/v4/mcp DCR registers public clients per RFC 8252; using
			// "client_secret_post" causes silent token-exchange failure (SIO-685)
			// because no secret is issued. PKCE alone proves possession.
			token_endpoint_auth_method: "none",
			// GitLab MR !208967 made `mcp` the default DCR scope; pinning it is
			// belt-and-braces and gives us visibility if defaults change again.
			scope: "mcp",
		};
	}
}
