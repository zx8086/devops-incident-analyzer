// src/gitlab-client/proxy.ts

import { OAuthRequiresInteractiveAuthError, waitForOAuthCallback } from "@devops-agent/shared";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createContextLogger } from "../utils/logger.js";
import { GitLabOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider.js";

const log = createContextLogger("proxy");

// SIO-747: keep-alive tick interval. Default 30 min (4x headroom against
// gitlab.com's ~2h refresh_token inactivity TTL on the public-DCR mcp scope).
// Clamped to [60_000, 3_600_000] so misconfiguration can't burn the rate limit
// (lower bound) or render the keep-alive useless (upper bound).
const DEFAULT_PROACTIVE_REFRESH_INTERVAL_MS = 1_800_000;
const MIN_PROACTIVE_REFRESH_INTERVAL_MS = 60_000;
const MAX_PROACTIVE_REFRESH_INTERVAL_MS = 3_600_000;

function parseProactiveRefreshIntervalMs(): number {
	const raw = process.env.OAUTH_PROACTIVE_REFRESH_INTERVAL_MS;
	if (raw === undefined || raw === "") return DEFAULT_PROACTIVE_REFRESH_INTERVAL_MS;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_PROACTIVE_REFRESH_INTERVAL_MS;
	return Math.min(MAX_PROACTIVE_REFRESH_INTERVAL_MS, Math.max(MIN_PROACTIVE_REFRESH_INTERVAL_MS, n));
}

export interface GitLabProxyConfig {
	instanceUrl: string;
	personalAccessToken: string;
	timeout: number;
	oauthCallbackPort: number;
}

export interface ProxyToolInfo {
	name: string;
	description: string;
	inputSchema: Tool["inputSchema"];
}

export interface McpClientLike {
	listTools: () => Promise<{ tools: Tool[] }>;
	callTool: (
		req: { name: string; arguments?: Record<string, unknown> },
		schema?: unknown,
		options?: { timeout?: number },
	) => Promise<unknown>;
}

export interface GitLabMcpProxyOptions {
	config: GitLabProxyConfig;
	// DI seam for tests; production uses the SDK Client.
	client?: McpClientLike;
}

export class GitLabMcpProxy {
	private sdkClient: Client | null = null;
	private injectedClient: McpClientLike | null = null;
	private transport: StreamableHTTPClientTransport | null = null;
	private connected = false;
	private readonly config: GitLabProxyConfig;
	// SIO-698: kept as a field (not a connect-local) so callTool can ask it
	// to refresh tokens when the SDK throws UnauthorizedError mid-flight.
	private oauthProvider: GitLabOAuthProvider | null = null;
	// SIO-747: stop-handle for the proactive refresh interval. Started in
	// connect() once the OAuth provider is live, cleared in disconnect().
	private stopProactiveRefresh: (() => void) | null = null;

	constructor(optionsOrConfig: GitLabMcpProxyOptions | GitLabProxyConfig) {
		// Backwards-compatible: accept either the new options bag or the legacy config.
		if ("config" in optionsOrConfig) {
			this.config = optionsOrConfig.config;
			if (optionsOrConfig.client) {
				this.injectedClient = optionsOrConfig.client;
				this.connected = true;
			}
		} else {
			this.config = optionsOrConfig;
		}
	}

	private get client(): McpClientLike {
		if (this.injectedClient) return this.injectedClient;
		if (this.sdkClient) return this.sdkClient as unknown as McpClientLike;
		throw new Error("Not connected to GitLab MCP server. Call connect() first.");
	}

	async connect(): Promise<void> {
		// SIO-698: build the OAuth provider unconditionally so callTool can ask
		// it to refresh tokens on 401 even when tests inject an McpClientLike
		// (the injected-client path does not exercise the SDK transport, but
		// the provider's refresh flow still needs reachability from callTool).
		this.oauthProvider = new GitLabOAuthProvider(
			this.config.instanceUrl,
			this.config.oauthCallbackPort,
			async (authUrl) => {
				log.info("Opening browser for GitLab OAuth authorization...");
				console.log(`\n  Authorize in your browser:\n  ${authUrl.toString()}\n`);
				try {
					const platform = process.platform;
					const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
					Bun.spawn([cmd, authUrl.toString()]);
				} catch {
					log.warn("Could not open browser automatically. Please open the URL above manually.");
				}
			},
		);

		if (this.injectedClient) {
			this.connected = true;
			return;
		}

		const mcpUrl = new URL("/api/v4/mcp", this.config.instanceUrl);
		log.info({ url: mcpUrl.toString() }, "Connecting to GitLab MCP endpoint");

		this.sdkClient = new Client({ name: "gitlab-mcp-proxy", version: "0.1.0" }, { capabilities: {} });
		this.transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: this.oauthProvider });

		try {
			await this.sdkClient.connect(this.transport);
			this.connected = true;
			log.info("Connected to GitLab MCP server (authenticated)");
		} catch (error) {
			if (error instanceof OAuthRequiresInteractiveAuthError) {
				// Surface the typed error so callers (eval, AgentCore) can classify
				// gitlab as a non-retryable auth failure without spawning a popup.
				throw error;
			}
			if (error instanceof UnauthorizedError) {
				log.info("OAuth authorization required -- waiting for browser callback...");

				const { code } = await waitForOAuthCallback({
					port: this.config.oauthCallbackPort,
					path: OAUTH_CALLBACK_PATH,
				});
				await this.transport.finishAuth(code);

				// Reconnect with the authorized transport
				this.sdkClient = new Client({ name: "gitlab-mcp-proxy", version: "0.1.0" }, { capabilities: {} });
				this.transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: this.oauthProvider });
				await this.sdkClient.connect(this.transport);
				this.connected = true;
				log.info("Connected to GitLab MCP server after OAuth authorization");
			} else {
				throw error;
			}
		}

		// SIO-747: now that the chain is alive, start the keep-alive tick so
		// idle gaps longer than GitLab's refresh_token TTL don't kill it.
		// Default 30 min on gitlab.com (~2h public-DCR mcp-scope TTL, 4x headroom).
		const intervalMs = parseProactiveRefreshIntervalMs();
		this.stopProactiveRefresh = this.oauthProvider.startProactiveRefresh(intervalMs);
		log.info({ intervalMs }, "OAuth proactive refresh started");
	}

	async listTools(): Promise<ProxyToolInfo[]> {
		if (!this.connected) {
			throw new Error("Not connected to GitLab MCP server. Call connect() first.");
		}

		const response = await this.client.listTools();
		const tools: ProxyToolInfo[] = response.tools.map((tool) => ({
			name: tool.name,
			description: tool.description || `${tool.name} tool`,
			inputSchema: tool.inputSchema,
		}));

		log.info({ toolCount: tools.length }, "Discovered remote GitLab MCP tools");
		return tools;
	}

	async callTool(toolName: string, args: Record<string, unknown>, options?: { timeout?: number }): Promise<unknown> {
		if (!this.connected) {
			throw new Error("Not connected to GitLab MCP server. Call connect() first.");
		}

		log.debug({ tool: toolName }, "Forwarding tool call to GitLab MCP");
		try {
			return await this.client.callTool({ name: toolName, arguments: args }, undefined, options);
		} catch (error) {
			// SIO-698: defense-in-depth refresh on 401. The SDK transport already
			// runs an internal refresh-on-401 via auth(); we re-run it here for
			// (a) observability via the log line below, and (b) to convert refresh
			// failure into our typed OAuthRefreshChainExpiredError, which the
			// agent's auth-error classifier maps to non-retryable with a re-seed
			// hint. The retry is single-shot: a second 401 means the new token is
			// also rejected and another refresh would not help.
			if (!(error instanceof UnauthorizedError) || !this.oauthProvider) {
				throw error;
			}
			log.info(
				{ tool: toolName, instanceUrl: this.config.instanceUrl },
				"Tool call returned 401; attempting silent token refresh",
			);
			await this.oauthProvider.refreshTokens();
			return this.client.callTool({ name: toolName, arguments: args }, undefined, options);
		}
	}

	async disconnect(): Promise<void> {
		// SIO-747: stop the keep-alive tick before closing the transport so a
		// late tick doesn't fire a refresh against a closed connection.
		if (this.stopProactiveRefresh) {
			this.stopProactiveRefresh();
			this.stopProactiveRefresh = null;
		}
		if (this.transport) {
			await this.transport.close();
			this.transport = null;
		}
		this.connected = false;
		log.info("Disconnected from GitLab MCP server");
	}

	isConnected(): boolean {
		return this.connected;
	}
}
