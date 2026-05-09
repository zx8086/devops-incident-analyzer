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

const OAUTH_CALLBACK_PORT = 9184;

export type { AuthorizationHandler };
export { OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORT };

export class GitLabOAuthProvider extends BaseOAuthClientProvider {
	constructor(instanceUrl: string, onRedirect: AuthorizationHandler) {
		super({
			storageNamespace: "gitlab",
			storageKey: instanceUrl,
			callbackPort: OAUTH_CALLBACK_PORT,
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
			token_endpoint_auth_method: "client_secret_post",
		};
	}
}
