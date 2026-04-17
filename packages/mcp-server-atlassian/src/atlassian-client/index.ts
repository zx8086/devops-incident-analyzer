// src/atlassian-client/index.ts

export type { OAuthCallbackResult } from "./oauth-callback.js";
export { waitForOAuthCallback } from "./oauth-callback.js";
export type { AtlassianOAuthProviderOptions, AuthorizationHandler } from "./oauth-provider.js";
export { AtlassianOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider.js";
export type { AtlassianMcpProxyOptions, McpClientLike, ProxyToolInfo } from "./proxy.js";
export { AtlassianMcpProxy } from "./proxy.js";
