// src/gitlab-client/oauth-provider.ts

import {
	type AuthorizationHandler,
	BaseOAuthClientProvider,
	OAUTH_CALLBACK_PATH,
	type OAuthProviderLogger,
	OAuthRefreshChainExpiredError,
} from "@devops-agent/shared";
import type { OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createContextLogger } from "../utils/logger.js";

const log = createContextLogger("oauth");

export type { AuthorizationHandler };
export { OAUTH_CALLBACK_PATH };

export class GitLabOAuthProvider extends BaseOAuthClientProvider {
	private readonly instanceUrl: string;

	constructor(instanceUrl: string, callbackPort: number, onRedirect: AuthorizationHandler) {
		super({
			storageNamespace: "gitlab",
			storageKey: instanceUrl,
			callbackPort,
			onRedirect,
			logger: log as unknown as OAuthProviderLogger,
		});
		this.instanceUrl = instanceUrl;
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

	// SIO-702: refresh-on-read in tokens(). The MCP SDK transport awaits this
	// (auth.js:272 / streamableHttp.js:61), so an async override is wire-compatible.
	// Routing every read through ensureFreshTokens() means the SDK's own auth()
	// path is not entered in steady state -- which structurally avoids the
	// rotation-race wipe described in SIO-702. The base class's single-flight
	// dedupe guarantees only one /oauth/token POST fires per refresh window.
	override tokens(): Promise<OAuthTokens | undefined> {
		return this.ensureFreshTokens();
	}

	// SIO-702 + SIO-747: defense-in-depth refresh forced by proxy.callTool when
	// the SDK throws UnauthorizedError (proxy.ts:182). The base-class
	// lockedRefresh() ensures (a) in-process single-flight via refreshInFlight,
	// (b) cross-process serialization via the on-disk advisory lock, and
	// (c) reload-from-disk before POSTing so we never replay a stale
	// refresh_token after another process rotated it.
	async refreshTokens(): Promise<OAuthTokens> {
		return this.lockedRefresh();
	}

	// SIO-702: hook called by ensureFreshTokens() when the access_token is past
	// its expiry skew window. Performs the actual /oauth/token POST. This used to
	// live in a private doRefresh() owned by GitLab; lifting the single-flight
	// lock into the base class meant moving the body here as the override.
	protected override async doRefresh(): Promise<OAuthTokens> {
		const refreshToken = this.persisted.tokens?.refresh_token;
		if (!refreshToken) {
			throw new OAuthRefreshChainExpiredError(
				this.storageNamespace,
				`seeded token file lacks refresh_token; run \`bun run oauth:seed:${this.storageNamespace}\` to re-seed`,
			);
		}

		const clientId = (this.persisted.clientInformation as { client_id?: string } | undefined)?.client_id;
		if (!clientId) {
			throw new OAuthRefreshChainExpiredError(
				this.storageNamespace,
				`seeded token file lacks client_id; run \`bun run oauth:seed:${this.storageNamespace}\` to re-seed`,
			);
		}

		const body = new URLSearchParams();
		body.set("grant_type", "refresh_token");
		body.set("refresh_token", refreshToken);
		body.set("client_id", clientId);

		const response = await fetch(`${this.instanceUrl}/oauth/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		});

		if (!response.ok) {
			throw new OAuthRefreshChainExpiredError(
				this.storageNamespace,
				`refresh_token rejected by ${this.instanceUrl} (HTTP ${response.status}); run \`bun run oauth:seed:${this.storageNamespace}\` to re-seed`,
			);
		}

		const parsed = (await response.json().catch(() => null)) as Partial<OAuthTokens> | null;
		if (!parsed || typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
			throw new OAuthRefreshChainExpiredError(
				this.storageNamespace,
				`refresh response from ${this.instanceUrl} missing access_token; run \`bun run oauth:seed:${this.storageNamespace}\` to re-seed`,
			);
		}

		// GitLab may rotate the refresh_token. If a new one came back, persist it;
		// otherwise keep the old one so the chain stays intact.
		const merged: OAuthTokens = {
			access_token: parsed.access_token,
			token_type: parsed.token_type ?? this.persisted.tokens?.token_type ?? "Bearer",
			...(parsed.refresh_token ? { refresh_token: parsed.refresh_token } : { refresh_token: refreshToken }),
			...(parsed.expires_in !== undefined ? { expires_in: parsed.expires_in } : {}),
			...(parsed.scope ? { scope: parsed.scope } : {}),
		};

		this.saveTokens(merged);
		return merged;
	}
}
