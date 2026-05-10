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

// SIO-702: skew used by ensureFreshTokens to refresh proactively before the
// access_token expires. 60s comfortably absorbs clock drift and request RTT
// without burning through token lifetime; longer windows just refresh more
// often without buying anything.
export const TOKEN_EXPIRY_SKEW_MS = 60_000;

// SIO-702: window during which a recent saveTokens() suppresses a wipe from
// invalidateCredentials('tokens'). The wipe is the SDK's response to a 400
// invalid_grant, which under N parallel auth() calls comes from a losing-racer
// reusing a now-rotated refresh_token (RFC 6749 section 10.4 mandates rotation
// for public clients like GitLab). 5s is the practical upper bound for an
// /oauth/token round-trip plus retry stacking; outside this window the wipe is
// a real auth failure and we honor it.
export const STALE_INVALIDATION_WINDOW_MS = 5_000;

export interface PersistedOAuthState {
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	// SIO-702: epoch ms recorded when tokens were saved. Used with expires_in to
	// compute expiry. Missing on legacy files -> ensureFreshTokens treats as
	// expired and refreshes once on first read (self-healing).
	tokenObtainedAt?: number;
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
	// SIO-702: injectable for tests that need to advance time across the
	// STALE_INVALIDATION_WINDOW_MS boundary without real waits.
	clock?: () => number;
}

const NOOP_LOGGER: OAuthProviderLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

function sanitizeKey(key: string): string {
	return key.replace(/[^a-zA-Z0-9.-]/g, "_");
}

// Exported for read-only consumers (e.g. boot-time presence checks) that must
// not mkdir. Writers go through getStoragePath which ensures the directory.
export function getOAuthStoragePath(namespace: string, key: string): string {
	return join(homedir(), ".mcp-auth", namespace, `${sanitizeKey(key)}.json`);
}

function ensureStorageDir(namespace: string): void {
	const dir = join(homedir(), ".mcp-auth", namespace);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
}

function getStoragePath(namespace: string, key: string): string {
	ensureStorageDir(namespace);
	return getOAuthStoragePath(namespace, key);
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
	protected readonly clock: () => number;
	protected persisted: PersistedOAuthState;
	// SIO-702: lifted here from GitLabOAuthProvider so any subclass that opts
	// into refresh-on-read via ensureFreshTokens() shares the same single-flight
	// dedupe -- including a future Atlassian opt-in if Atlassian ever rotates.
	protected refreshInFlight: Promise<OAuthTokens> | null = null;
	// SIO-702: epoch ms of the last successful saveTokens(). Drives the
	// stale-wipe guard in invalidateCredentials('tokens').
	protected lastSaveAt = 0;

	constructor(options: BaseOAuthProviderOptions) {
		this.storageNamespace = options.storageNamespace;
		this.storageKey = options.storageKey;
		this.callbackPort = options.callbackPort;
		this.onRedirect = options.onRedirect;
		this.logger = options.logger ?? NOOP_LOGGER;
		this.clock = options.clock ?? Date.now;
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

	tokens(): OAuthTokens | undefined | Promise<OAuthTokens | undefined> {
		return this.persisted.tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		const now = this.clock();
		this.persisted.tokens = tokens;
		this.persisted.tokenObtainedAt = now;
		this.lastSaveAt = now;
		// Hygiene: a verifier is only valid for the in-flight authorization request.
		// Once tokens are persisted the verifier is spent; clearing it prevents
		// stale verifiers from accumulating across abandoned flows.
		this.persisted.codeVerifier = undefined;
		saveState(this.storageNamespace, this.storageKey, this.persisted);
		this.logger.info({ namespace: this.storageNamespace }, "OAuth tokens saved");
	}

	// SIO-702: subclasses that opt into refresh-on-read in tokens() override this
	// to perform the actual /oauth/token POST. The default throws so that the
	// abstract-method intent is enforced at runtime; Atlassian (which keeps a
	// synchronous tokens()) never reaches this path. Kept non-abstract so
	// providers can extend BaseOAuthClientProvider without forced churn.
	protected async doRefresh(): Promise<OAuthTokens> {
		throw new Error(
			`doRefresh() not implemented for ${this.storageNamespace}; subclass must override before calling ensureFreshTokens()`,
		);
	}

	// SIO-702: single-flight refresh-on-read. All callers (the SDK transport via
	// tokens(), our proxy retry via refreshTokens()) share one in-flight POST,
	// which makes the rotation race impossible because there is only ever one
	// refresher. Returns undefined when nothing is persisted (caller decides
	// whether to start a new authorization).
	protected async ensureFreshTokens(): Promise<OAuthTokens | undefined> {
		const persisted = this.persisted.tokens;
		if (!persisted) return undefined;
		if (!this.isExpired(persisted)) return persisted;

		if (this.refreshInFlight) return this.refreshInFlight;

		this.refreshInFlight = this.doRefresh().finally(() => {
			this.refreshInFlight = null;
		});
		return this.refreshInFlight;
	}

	// Treat tokens as expired when there is no obtainedAt timestamp on disk
	// (legacy file written before SIO-702) -- one self-healing refresh restores
	// the timestamp. expires_in is seconds-from-issue, so multiply by 1000.
	protected isExpired(tokens: OAuthTokens): boolean {
		const obtainedAt = this.persisted.tokenObtainedAt;
		if (typeof obtainedAt !== "number") return true;
		if (typeof tokens.expires_in !== "number") return true;
		const expiresAt = obtainedAt + tokens.expires_in * 1000;
		return this.clock() + TOKEN_EXPIRY_SKEW_MS >= expiresAt;
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
		// SIO-702: under N parallel auth() flows a losing-racer's 400 invalid_grant
		// arrives after another caller already saved fresh tokens; the SDK then
		// asks us to wipe those fresh tokens. Skip the wipe when we just saved.
		// 'all' bypasses the guard intentionally -- it implies a deeper failure
		// (InvalidClientError / UnauthorizedClientError) where the client itself
		// is wrong and starting from scratch is the correct response.
		if (scope === "tokens") {
			const elapsed = this.clock() - this.lastSaveAt;
			if (this.lastSaveAt > 0 && elapsed < STALE_INVALIDATION_WINDOW_MS) {
				this.logger.warn(
					{ namespace: this.storageNamespace, elapsedMs: elapsed },
					"OAuth credentials invalidate('tokens') ignored: tokens were saved within the stale-wipe guard window (likely a losing-racer's 400 invalid_grant)",
				);
				return;
			}
		}
		if (scope === "all" || scope === "tokens") {
			this.persisted.tokens = undefined;
			this.persisted.tokenObtainedAt = undefined;
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
