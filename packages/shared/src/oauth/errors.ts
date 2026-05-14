// src/oauth/errors.ts

export class OAuthRequiresInteractiveAuthError extends Error {
	readonly namespace: string;
	readonly authorizationUrl: URL;

	constructor(namespace: string, authorizationUrl: URL) {
		super(
			`OAuth interactive authorization required for ${namespace} but MCP_OAUTH_HEADLESS=true; ` +
				`run \`bun run oauth:seed:${namespace}\` once interactively to seed tokens`,
		);
		this.name = "OAuthRequiresInteractiveAuthError";
		this.namespace = namespace;
		this.authorizationUrl = authorizationUrl;
	}
}

export class OAuthRefreshChainExpiredError extends Error {
	readonly namespace: string;
	readonly hint: string;

	constructor(namespace: string, hint: string) {
		super(`OAuth refresh chain expired for ${namespace}: ${hint}`);
		this.name = "OAuthRefreshChainExpiredError";
		this.namespace = namespace;
		this.hint = hint;
	}
}

// SIO-747: thrown by acquireRefreshLock when the cross-process lock cannot be
// acquired within the timeout. Distinct from OAuthRefreshChainExpiredError --
// a lock timeout is recoverable on the next tick (another process is mid-
// refresh, or a stale lock will reclaim shortly), whereas chain expiry needs
// a human re-seed. The message deliberately avoids the words classified as
// "auth" by sub-agent.ts (see the ERROR_PATTERNS list there) so the agent's
// retry classifier treats this as transient, not terminal.
export class OAuthRefreshLockTimeoutError extends Error {
	readonly namespace: string;
	readonly lockPath: string;
	readonly timeoutMs: number;

	constructor(namespace: string, lockPath: string, timeoutMs: number) {
		super(
			`OAuth refresh lock contention timeout for ${namespace} after ${timeoutMs}ms ` +
				`(another process holds ${lockPath}); next refresh attempt will retry`,
		);
		this.name = "OAuthRefreshLockTimeoutError";
		this.namespace = namespace;
		this.lockPath = lockPath;
		this.timeoutMs = timeoutMs;
	}
}
