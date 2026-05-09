// src/oauth/base-provider.ts

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { OAuthRequiresInteractiveAuthError } from "./errors.ts";
import { isHeadless } from "./headless.ts";

export const OAUTH_CALLBACK_PATH = "/oauth/callback";

export interface PersistedOAuthState {
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
}

export type AuthorizationHandler = (url: URL) => void | Promise<void>;

export interface OAuthProviderLogger {
	info(obj: Record<string, unknown>, msg: string): void;
	warn(obj: Record<string, unknown>, msg: string): void;
	error(obj: Record<string, unknown>, msg: string): void;
}

export interface BaseOAuthProviderOptions {
	storageNamespace: string;
	storageKey: string;
	callbackPort: number;
	onRedirect: AuthorizationHandler;
	logger?: OAuthProviderLogger;
}

const NOOP_LOGGER: OAuthProviderLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

function sanitizeKey(key: string): string {
	return key.replace(/[^a-zA-Z0-9.-]/g, "_");
}

function getStorageDir(namespace: string): string {
	const dir = join(homedir(), ".mcp-auth", namespace);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	return dir;
}

function getStoragePath(namespace: string, key: string): string {
	return join(getStorageDir(namespace), `${sanitizeKey(key)}.json`);
}

function loadState(namespace: string, key: string, logger: OAuthProviderLogger): PersistedOAuthState {
	const path = getStoragePath(namespace, key);
	try {
		if (existsSync(path)) {
			return JSON.parse(readFileSync(path, "utf-8")) as PersistedOAuthState;
		}
	} catch (error) {
		logger.warn(
			{ namespace, error: error instanceof Error ? error.message : String(error) },
			"Failed to load OAuth state, starting fresh",
		);
	}
	return {};
}

// writeFileSync's mode option only applies on file creation; chmodSync after
// write enforces 0o600 on pre-existing files written by an older version.
function saveState(namespace: string, key: string, state: PersistedOAuthState): void {
	const path = getStoragePath(namespace, key);
	writeFileSync(path, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
	chmodSync(path, 0o600);
}

export abstract class BaseOAuthClientProvider implements OAuthClientProvider {
	protected readonly storageNamespace: string;
	protected readonly storageKey: string;
	protected readonly callbackPort: number;
	protected readonly onRedirect: AuthorizationHandler;
	protected readonly logger: OAuthProviderLogger;
	protected persisted: PersistedOAuthState;

	constructor(options: BaseOAuthProviderOptions) {
		this.storageNamespace = options.storageNamespace;
		this.storageKey = options.storageKey;
		this.callbackPort = options.callbackPort;
		this.onRedirect = options.onRedirect;
		this.logger = options.logger ?? NOOP_LOGGER;
		this.persisted = loadState(options.storageNamespace, options.storageKey, this.logger);
	}

	abstract get clientMetadata(): OAuthClientMetadata;

	get redirectUrl(): string {
		return `http://localhost:${this.callbackPort}${OAUTH_CALLBACK_PATH}`;
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		const persisted = this.persisted.clientInformation;
		if (!persisted) return undefined;

		// Stale-registration migration: if a registration exists with a different
		// auth method than this provider expects (e.g. legacy GitLab registrations
		// stored as `client_secret_post` while we now want `none`), discard it so
		// the SDK re-registers with the correct metadata. Only triggers when the
		// persisted record actually carried a method -- absent => trust it.
		// `OAuthClientInformationMixed` is a union; the full-DCR branch carries
		// `token_endpoint_auth_method` but the minimal-id branch does not.
		const persistedMethod = (persisted as { token_endpoint_auth_method?: string }).token_endpoint_auth_method;
		const expectedMethod = this.clientMetadata.token_endpoint_auth_method;
		if (persistedMethod !== undefined && persistedMethod !== expectedMethod) {
			this.logger.warn(
				{ namespace: this.storageNamespace, persisted: persistedMethod, expected: expectedMethod },
				"persisted client registration auth_method mismatch -- discarding",
			);
			this.persisted.clientInformation = undefined;
			saveState(this.storageNamespace, this.storageKey, this.persisted);
			return undefined;
		}
		return persisted;
	}

	saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
		this.persisted.clientInformation = clientInformation;
		saveState(this.storageNamespace, this.storageKey, this.persisted);
		this.logger.info({ namespace: this.storageNamespace }, "OAuth client registration saved");
	}

	tokens(): OAuthTokens | undefined {
		return this.persisted.tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.persisted.tokens = tokens;
		// Hygiene: a verifier is only valid for the in-flight authorization request.
		// Once tokens are persisted the verifier is spent; clearing it prevents
		// stale verifiers from accumulating across abandoned flows.
		this.persisted.codeVerifier = undefined;
		saveState(this.storageNamespace, this.storageKey, this.persisted);
		this.logger.info({ namespace: this.storageNamespace }, "OAuth tokens saved");
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		if (isHeadless()) {
			this.logger.error(
				{ namespace: this.storageNamespace, url: authorizationUrl.toString() },
				`OAuth interactive authorization required but MCP_OAUTH_HEADLESS=true; run \`bun run oauth:seed:${this.storageNamespace}\``,
			);
			throw new OAuthRequiresInteractiveAuthError(this.storageNamespace, authorizationUrl);
		}
		this.logger.info(
			{ namespace: this.storageNamespace, url: authorizationUrl.toString() },
			"OAuth authorization required",
		);
		await this.onRedirect(authorizationUrl);
	}

	saveCodeVerifier(codeVerifier: string): void {
		this.persisted.codeVerifier = codeVerifier;
		saveState(this.storageNamespace, this.storageKey, this.persisted);
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
		saveState(this.storageNamespace, this.storageKey, this.persisted);
		this.logger.info({ namespace: this.storageNamespace, scope }, "OAuth credentials invalidated");
	}

	hasValidTokens(): boolean {
		return this.persisted.tokens?.access_token !== undefined;
	}
}
