// src/atlassian-client/oauth-provider.ts

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

// SIO-1097: Rovo's OAuth token endpoint, discovered from
// https://mcp.atlassian.com/.well-known/oauth-authorization-server (token_endpoint).
// Pinned as a fallback so doRefresh never depends on a live well-known fetch; the
// discovery attempt refreshes it in case Atlassian moves the endpoint.
const ROVO_TOKEN_ENDPOINT_FALLBACK = "https://cf.mcp.atlassian.com/v1/token";

// SIO-1097: bound both OAuth HTTP requests. A hung token POST would leave
// refreshInFlight pending while holding the cross-process refresh lock, stalling
// every queued upstream call and forcing other processes into lock timeouts. On
// timeout the fetch rejects (AbortError), which settles refreshInFlight via the
// finally in ensureFreshTokens/lockedRefresh and releases the lock; the raw abort
// surfaces as a transient (retryable) error, not a dead-chain re-seed prompt.
const OAUTH_HTTP_TIMEOUT_MS = 10_000;

export interface AtlassianOAuthProviderOptions {
	mcpEndpoint: string;
	callbackPort: number;
	onRedirect: AuthorizationHandler;
	// SIO-702: forwarded to BaseOAuthClientProvider so tests can advance time
	// across the stale-wipe-guard window without sleeping. Production callers
	// omit it and inherit the default Date.now.
	clock?: () => number;
}

export class AtlassianOAuthProvider extends BaseOAuthClientProvider {
	private readonly mcpEndpoint: string;
	private tokenEndpoint: string | null = null;

	constructor({ mcpEndpoint, callbackPort, onRedirect, clock }: AtlassianOAuthProviderOptions) {
		super({
			storageNamespace: "atlassian",
			storageKey: mcpEndpoint,
			callbackPort,
			onRedirect,
			logger: log as unknown as OAuthProviderLogger,
			clock,
		});
		this.mcpEndpoint = mcpEndpoint;
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

	// SIO-1097: refresh-on-read in tokens(). The MCP SDK transport awaits this
	// (auth.js / streamableHttp.js), so an async override is wire-compatible.
	// Routing every read through ensureFreshTokens() means the SDK's own auth()
	// path is not entered in steady state -- which structurally avoids the
	// rotation-race wipe (base-provider.ts SIO-702) that produced intermittent
	// 401/403 under the agent's parallel sub-agent fan-out.
	override tokens(): Promise<OAuthTokens | undefined> {
		return this.ensureFreshTokens();
	}

	// SIO-1097: defense-in-depth refresh forced by proxy.callTool when the SDK
	// throws UnauthorizedError. lockedRefresh() gives (a) in-process single-flight
	// via refreshInFlight, (b) cross-process serialization via the on-disk advisory
	// lock, and (c) reload-from-disk before POSTing so we never replay a stale
	// refresh_token after another process rotated it.
	async refreshTokens(): Promise<OAuthTokens> {
		return this.lockedRefresh();
	}

	// SIO-1097: hook called by ensureFreshTokens()/lockedRefresh() when the
	// access_token is past its expiry skew window. Performs the actual token POST
	// against Rovo's discovered token endpoint using client_secret_post (Atlassian
	// issues a client_secret at DCR, unlike GitLab's public PKCE client).
	protected override async doRefresh(): Promise<OAuthTokens> {
		const refreshToken = this.persisted.tokens?.refresh_token;
		if (!refreshToken) {
			throw new OAuthRefreshChainExpiredError(
				this.storageNamespace,
				`seeded token file lacks refresh_token; run \`bun run oauth:seed:${this.storageNamespace}\` to re-seed`,
			);
		}

		const clientInfo = this.persisted.clientInformation as { client_id?: string; client_secret?: string } | undefined;
		const clientId = clientInfo?.client_id;
		const clientSecret = clientInfo?.client_secret;
		if (!clientId || !clientSecret) {
			throw new OAuthRefreshChainExpiredError(
				this.storageNamespace,
				`seeded token file lacks client_id/client_secret; run \`bun run oauth:seed:${this.storageNamespace}\` to re-seed`,
			);
		}

		const tokenEndpoint = await this.resolveTokenEndpoint();

		const body = new URLSearchParams();
		body.set("grant_type", "refresh_token");
		body.set("refresh_token", refreshToken);
		body.set("client_id", clientId);
		body.set("client_secret", clientSecret);

		const response = await fetch(tokenEndpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
			signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
		});

		if (!response.ok) {
			throw new OAuthRefreshChainExpiredError(
				this.storageNamespace,
				`refresh_token rejected by ${tokenEndpoint} (HTTP ${response.status}); run \`bun run oauth:seed:${this.storageNamespace}\` to re-seed`,
			);
		}

		const parsed = (await response.json().catch(() => null)) as Partial<OAuthTokens> | null;
		if (!parsed || typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
			throw new OAuthRefreshChainExpiredError(
				this.storageNamespace,
				`refresh response from ${tokenEndpoint} missing access_token; run \`bun run oauth:seed:${this.storageNamespace}\` to re-seed`,
			);
		}

		// Atlassian rotates the refresh_token. Persist the new one if returned;
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

	// SIO-1097: resolve Rovo's token_endpoint from the authorization-server
	// well-known once, caching the result. Falls back to the pinned endpoint on
	// any discovery failure so a transient metadata-fetch error never blocks a
	// refresh.
	private async resolveTokenEndpoint(): Promise<string> {
		if (this.tokenEndpoint) return this.tokenEndpoint;
		try {
			const wellKnown = new URL("/.well-known/oauth-authorization-server", this.mcpEndpoint);
			const res = await fetch(wellKnown, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
			});
			if (res.ok) {
				const meta = (await res.json().catch(() => null)) as { token_endpoint?: string } | null;
				if (meta?.token_endpoint) {
					this.tokenEndpoint = meta.token_endpoint;
					return this.tokenEndpoint;
				}
			}
		} catch {
			// discovery failed -- fall through to the pinned endpoint
		}
		this.tokenEndpoint = ROVO_TOKEN_ENDPOINT_FALLBACK;
		return this.tokenEndpoint;
	}
}
