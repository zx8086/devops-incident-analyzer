// src/atlassian-client/oauth-provider.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { createContextLogger } from "../utils/logger.js";

const log = createContextLogger("oauth");

export const OAUTH_CALLBACK_PATH = "/oauth/callback";

interface PersistedOAuthState {
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
}

export type AuthorizationHandler = (url: URL) => void | Promise<void>;

export interface AtlassianOAuthProviderOptions {
	mcpEndpoint: string;
	callbackPort: number;
	onRedirect: AuthorizationHandler;
}

function getStorageDir(): string {
	const dir = join(homedir(), ".mcp-auth", "atlassian");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	return dir;
}

function getStoragePath(mcpEndpoint: string): string {
	const sanitized = mcpEndpoint.replace(/[^a-zA-Z0-9.-]/g, "_");
	return join(getStorageDir(), `${sanitized}.json`);
}

function loadState(mcpEndpoint: string): PersistedOAuthState {
	const path = getStoragePath(mcpEndpoint);
	try {
		if (existsSync(path)) {
			return JSON.parse(readFileSync(path, "utf-8")) as PersistedOAuthState;
		}
	} catch (error) {
		log.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Failed to load OAuth state, starting fresh",
		);
	}
	return {};
}

function saveState(mcpEndpoint: string, state: PersistedOAuthState): void {
	const path = getStoragePath(mcpEndpoint);
	writeFileSync(path, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export class AtlassianOAuthProvider implements OAuthClientProvider {
	private readonly mcpEndpoint: string;
	private readonly callbackPort: number;
	private persisted: PersistedOAuthState;
	private onRedirect: AuthorizationHandler;

	constructor({ mcpEndpoint, callbackPort, onRedirect }: AtlassianOAuthProviderOptions) {
		this.mcpEndpoint = mcpEndpoint;
		this.callbackPort = callbackPort;
		this.persisted = loadState(mcpEndpoint);
		this.onRedirect = onRedirect;
	}

	get redirectUrl(): string {
		return `http://localhost:${this.callbackPort}${OAUTH_CALLBACK_PATH}`;
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

	clientInformation(): OAuthClientInformationMixed | undefined {
		return this.persisted.clientInformation;
	}

	saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
		this.persisted.clientInformation = clientInformation;
		saveState(this.mcpEndpoint, this.persisted);
		log.info("OAuth client registration saved");
	}

	tokens(): OAuthTokens | undefined {
		return this.persisted.tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.persisted.tokens = tokens;
		saveState(this.mcpEndpoint, this.persisted);
		log.info("OAuth tokens saved");
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		log.info({ url: authorizationUrl.toString() }, "OAuth authorization required");
		await this.onRedirect(authorizationUrl);
	}

	saveCodeVerifier(codeVerifier: string): void {
		this.persisted.codeVerifier = codeVerifier;
		saveState(this.mcpEndpoint, this.persisted);
	}

	codeVerifier(): string {
		if (!this.persisted.codeVerifier) {
			throw new Error("No PKCE code verifier saved");
		}
		return this.persisted.codeVerifier;
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		if (scope === "all" || scope === "tokens") {
			this.persisted.tokens = undefined;
		}
		if (scope === "all" || scope === "client") {
			this.persisted.clientInformation = undefined;
		}
		if (scope === "all" || scope === "verifier") {
			this.persisted.codeVerifier = undefined;
		}
		saveState(this.mcpEndpoint, this.persisted);
		log.info({ scope }, "OAuth credentials invalidated");
	}

	hasValidTokens(): boolean {
		return this.persisted.tokens?.access_token !== undefined;
	}
}
