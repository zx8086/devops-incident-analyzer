// src/oauth/index.ts

export {
	type AuthorizationHandler,
	BaseOAuthClientProvider,
	type BaseOAuthProviderOptions,
	OAUTH_CALLBACK_PATH,
	type OAuthProviderLogger,
	type PersistedOAuthState,
	STALE_INVALIDATION_WINDOW_MS,
	TOKEN_EXPIRY_SKEW_MS,
} from "./base-provider.ts";
export { type WarnIfOAuthNotSeededOptions, warnIfOAuthNotSeeded } from "./boot-warn.ts";
export {
	OAuthRefreshChainExpiredError,
	OAuthRefreshLockTimeoutError,
	OAuthRequiresInteractiveAuthError,
} from "./errors.ts";
export { isHeadless } from "./headless.ts";
export { type SeedOAuthOptions, seedOAuth } from "./seed.ts";
export { hasSeededTokens } from "./seeded-tokens.ts";
