// src/gitlab-client/oauth-provider.ts

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

const OAUTH_CALLBACK_PORT = 9184;
const OAUTH_CALLBACK_PATH = "/oauth/callback";
const OAUTH_CALLBACK_URL = `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;

export { OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORT };

interface PersistedOAuthState {
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
}

function getStorageDir(): string {
	const dir = join(homedir(), ".mcp-auth", "gitlab");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function getStoragePath(instanceUrl: string): string {
	const sanitized = instanceUrl.replace(/[^a-zA-Z0-9.-]/g, "_");
	return join(getStorageDir(), `${sanitized}.json`);
}

function loadState(instanceUrl: string): PersistedOAuthState {
	const path = getStoragePath(instanceUrl);
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

function saveState(instanceUrl: string, state: PersistedOAuthState): void {
	const path = getStoragePath(instanceUrl);
	writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

export type AuthorizationHandler = (url: URL) => void | Promise<void>;

export class GitLabOAuthProvider implements OAuthClientProvider {
	private readonly instanceUrl: string;
	private persisted: PersistedOAuthState;
	private onRedirect: AuthorizationHandler;

	constructor(instanceUrl: string, onRedirect: AuthorizationHandler) {
		this.instanceUrl = instanceUrl;
		this.persisted = loadState(instanceUrl);
		this.onRedirect = onRedirect;
	}

	get redirectUrl(): string {
		return OAUTH_CALLBACK_URL;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "DevOps Incident Analyzer - GitLab MCP Proxy",
			redirect_uris: [OAUTH_CALLBACK_URL],
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
		saveState(this.instanceUrl, this.persisted);
		log.info("OAuth client registration saved");
	}

	tokens(): OAuthTokens | undefined {
		return this.persisted.tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.persisted.tokens = tokens;
		saveState(this.instanceUrl, this.persisted);
		log.info("OAuth tokens saved");
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		log.info({ url: authorizationUrl.toString() }, "OAuth authorization required");
		await this.onRedirect(authorizationUrl);
	}

	saveCodeVerifier(codeVerifier: string): void {
		this.persisted.codeVerifier = codeVerifier;
		saveState(this.instanceUrl, this.persisted);
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
		saveState(this.instanceUrl, this.persisted);
		log.info({ scope }, "OAuth credentials invalidated");
	}

	hasValidTokens(): boolean {
		return this.persisted.tokens?.access_token !== undefined;
	}
}
