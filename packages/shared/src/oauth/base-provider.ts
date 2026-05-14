// src/oauth/base-provider.ts

import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { OAuthRefreshLockTimeoutError, OAuthRequiresInteractiveAuthError } from "./errors.ts";
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

// SIO-747: cross-process refresh lock tunables. The in-process refreshInFlight
// Promise dedupes within a process; this lock dedupes across processes that
// share the same on-disk token file (workspace dev + Claude Desktop stdio +
// production AgentCore all key off ~/.mcp-auth/<ns>/<sanitized-key>.json).
// 10s upper bound on contention is well above a healthy /oauth/token RTT
// (~300-800ms on gitlab.com) plus the loser's reload + skip-or-POST decision.
export const REFRESH_LOCK_TIMEOUT_MS = 10_000;
// Initial backoff before retrying acquire after EEXIST. Jittered up to 2x.
export const REFRESH_LOCK_RETRY_BASE_MS = 50;
// Cap so backoff doesn't grow unbounded across the 10s window.
export const REFRESH_LOCK_RETRY_CAP_MS = 1_000;
// A held lock older than this is treated as orphaned (the holder process
// crashed mid-refresh without releasing). 2x the timeout is safe: a healthy
// holder cannot legitimately exceed the timeout itself, and a SIGKILL'd holder
// can no longer write or release.
export const REFRESH_LOCK_STALE_THRESHOLD_MS = 2 * REFRESH_LOCK_TIMEOUT_MS;

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

	// SIO-702 + SIO-747: single-flight refresh-on-read. All in-process callers
	// (the SDK transport via tokens(), our proxy retry via refreshTokens())
	// share one in-flight Promise (refreshInFlight); the cross-process file
	// lock (acquireRefreshLock) ensures only one *process* POSTs at a time.
	// Returns undefined when nothing is persisted (caller decides whether to
	// start a new authorization).
	protected async ensureFreshTokens(): Promise<OAuthTokens | undefined> {
		const persisted = this.persisted.tokens;
		if (!persisted) return undefined;
		if (!this.isExpired(persisted)) return persisted;

		if (this.refreshInFlight) return this.refreshInFlight;

		this.refreshInFlight = this.lockedRefreshIfStillExpired().finally(() => {
			this.refreshInFlight = null;
		});
		return this.refreshInFlight;
	}

	// SIO-747: invoked under in-process single-flight, this acquires the cross-
	// process lock, reloads from disk, and re-checks expiry. If another process
	// already rotated the chain while we were waiting, return that fresh token
	// without POSTing. Otherwise POST under the lock so concurrent processes
	// serialize on the same refresh_token chain.
	private async lockedRefreshIfStillExpired(): Promise<OAuthTokens> {
		const release = await this.acquireRefreshLock();
		try {
			this.reloadPersisted();
			const reloaded = this.persisted.tokens;
			if (reloaded && !this.isExpired(reloaded)) return reloaded;
			return await this.doRefresh();
		} finally {
			release();
		}
	}

	// SIO-747: defense-in-depth path for the proxy's 401-retry. Unlike
	// ensureFreshTokens which trusts isExpired(), the caller of this method
	// has direct evidence the in-memory access_token is rejected upstream.
	// Inside the lock we still reload to (a) POST the *current* on-disk
	// refresh_token rather than a stale in-memory copy, and (b) skip the POST
	// entirely if another process rotated since we entered -- the new token
	// might already work.
	protected async lockedRefresh(): Promise<OAuthTokens> {
		if (this.refreshInFlight) return this.refreshInFlight;

		const previousAccessToken = this.persisted.tokens?.access_token;
		this.refreshInFlight = (async () => {
			const release = await this.acquireRefreshLock();
			try {
				this.reloadPersisted();
				const reloaded = this.persisted.tokens;
				if (reloaded?.access_token && reloaded.access_token !== previousAccessToken) {
					return reloaded;
				}
				return await this.doRefresh();
			} finally {
				release();
			}
		})().finally(() => {
			this.refreshInFlight = null;
		});
		return this.refreshInFlight;
	}

	// SIO-747: re-read tokens + tokenObtainedAt from disk. Restricted to those
	// two fields so we don't clobber an in-flight DCR clientInformation write
	// from a concurrent process (DCR runs at most once per provider lifetime,
	// but the carve-out costs nothing and removes a footgun).
	private reloadPersisted(): void {
		const fresh = loadState(this.storageNamespace, this.storageKey, this.logger);
		this.persisted.tokens = fresh.tokens;
		this.persisted.tokenObtainedAt = fresh.tokenObtainedAt;
	}

	// SIO-747: cross-process advisory lock backed by openSync('wx'). Atomic on
	// local filesystems (APFS, ext4); ~/.mcp-auth is local-home by design so
	// NFS quirks don't apply. Stale-lock reclamation handles SIGKILL'd holders.
	// Protected (not private) so the SIO-747 contention/timeout tests can drive
	// it directly without reflection casts.
	protected async acquireRefreshLock(): Promise<() => void> {
		const lockPath = `${getStoragePath(this.storageNamespace, this.storageKey)}.lock`;
		const startedAt = this.clock();
		let attempt = 0;
		let staleReclaimAttempted = false;

		while (true) {
			try {
				const fd = openSync(lockPath, "wx", 0o600);
				const payload = JSON.stringify({ pid: process.pid, acquiredAt: this.clock() });
				writeFileSync(fd, payload, "utf-8");
				closeSync(fd);
				return () => {
					try {
						unlinkSync(lockPath);
					} catch {
						// Already gone (stale-reclaimed by another waiter, or release races
						// a stale-reclaimer). Idempotent release is the contract.
					}
				};
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST") throw error;

				if (!staleReclaimAttempted && this.tryReclaimStaleLock(lockPath)) {
					staleReclaimAttempted = true;
					continue;
				}

				const elapsed = this.clock() - startedAt;
				if (elapsed >= REFRESH_LOCK_TIMEOUT_MS) {
					throw new OAuthRefreshLockTimeoutError(this.storageNamespace, lockPath, REFRESH_LOCK_TIMEOUT_MS);
				}

				const backoff = Math.min(REFRESH_LOCK_RETRY_CAP_MS, REFRESH_LOCK_RETRY_BASE_MS * 2 ** attempt);
				const jitter = Math.random() * backoff;
				const remaining = REFRESH_LOCK_TIMEOUT_MS - elapsed;
				await new Promise<void>((resolve) => setTimeout(resolve, Math.min(jitter, remaining)));
				attempt++;
			}
		}
	}

	// SIO-747: read the lock file; if the holder PID is no longer alive
	// (process.kill(pid, 0) throws ESRCH) or acquiredAt is older than
	// REFRESH_LOCK_STALE_THRESHOLD_MS, unlink it and let the caller retry.
	// Returns true if a stale lock was reclaimed.
	private tryReclaimStaleLock(lockPath: string): boolean {
		let raw: string;
		try {
			raw = readFileSync(lockPath, "utf-8");
		} catch {
			// The lock disappeared between our EEXIST and our read -- treat as a
			// reclaim opportunity so the caller retries the openSync immediately.
			return true;
		}

		let parsed: { pid?: number; acquiredAt?: number };
		try {
			parsed = JSON.parse(raw) as { pid?: number; acquiredAt?: number };
		} catch {
			// Malformed lock file (truncated mid-write by a crashed holder).
			// Reclaim it.
			parsed = {};
		}

		const pidIsAlive = typeof parsed.pid === "number" && this.isProcessAlive(parsed.pid);
		const ageMs = typeof parsed.acquiredAt === "number" ? this.clock() - parsed.acquiredAt : Number.POSITIVE_INFINITY;

		if (pidIsAlive && ageMs < REFRESH_LOCK_STALE_THRESHOLD_MS) {
			return false;
		}

		try {
			unlinkSync(lockPath);
		} catch {
			// Another waiter raced us to the reclaim. The next openSync iteration
			// will either succeed or hit a fresh EEXIST owned by a new holder.
		}
		this.logger.warn(
			{
				namespace: this.storageNamespace,
				lockPath,
				holderPid: parsed.pid,
				holderAgeMs: Number.isFinite(ageMs) ? ageMs : null,
				holderAlive: pidIsAlive,
			},
			"OAuth refresh lock reclaimed (stale holder)",
		);
		return true;
	}

	// process.kill(pid, 0) returns true if the process exists; throws ESRCH
	// otherwise. Permissions errors (EPERM) imply the process exists but is
	// owned by another user -- we treat that as alive (do not reclaim).
	private isProcessAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return code !== "ESRCH";
		}
	}

	// SIO-747: proactive refresh keep-alive. The lazy ensureFreshTokens() path
	// only fires when a tool call happens; if the agent sits idle longer than
	// the OAuth provider's refresh_token TTL (~2h on gitlab.com for the public
	// DCR `mcp` scope), the chain is dead by the next tool call and the user
	// must re-seed interactively. A periodic tick keeps the chain alive without
	// any tool traffic. Shares the existing single-flight lock so concurrent
	// real tool calls join the tick's refresh.
	//
	// Returns a stop function. Subclasses wire this from the MCP server's
	// initDatasource and store the handle for cleanup at disconnect/shutdown.
	startProactiveRefresh(intervalMs: number): () => void {
		const id = setInterval(async () => {
			try {
				await this.ensureFreshTokens();
				this.logger.info({ namespace: this.storageNamespace, intervalMs }, "OAuth proactive refresh tick succeeded");
			} catch (error) {
				// On a terminal refresh failure (the chain is dead), stop the
				// interval -- hammering /oauth/token won't revive it, and the
				// next real tool call will surface the same error to the caller.
				clearInterval(id);
				this.logger.error(
					{
						namespace: this.storageNamespace,
						error: error instanceof Error ? error.message : String(error),
						remediation: `bun run oauth:seed:${this.storageNamespace}`,
					},
					"OAuth proactive refresh failed terminally; interval stopped, re-seed required",
				);
			}
		}, intervalMs);
		// Don't keep the event loop alive solely for this timer -- if the MCP
		// server has shut down everything else, the process should exit.
		if (typeof id === "object" && id !== null && "unref" in id && typeof id.unref === "function") {
			id.unref();
		}
		return () => clearInterval(id);
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
