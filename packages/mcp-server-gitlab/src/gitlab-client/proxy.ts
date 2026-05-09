// src/gitlab-client/proxy.ts

import { OAuthRequiresInteractiveAuthError, waitForOAuthCallback } from "@devops-agent/shared";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createContextLogger } from "../utils/logger.js";
import { GitLabOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider.js";

const log = createContextLogger("proxy");

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
		if (this.injectedClient) {
			this.connected = true;
			return;
		}

		const mcpUrl = new URL("/api/v4/mcp", this.config.instanceUrl);
		log.info({ url: mcpUrl.toString() }, "Connecting to GitLab MCP endpoint");

		const oauthProvider = new GitLabOAuthProvider(
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

		this.sdkClient = new Client({ name: "gitlab-mcp-proxy", version: "0.1.0" }, { capabilities: {} });
		this.transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: oauthProvider });

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
				this.transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: oauthProvider });
				await this.sdkClient.connect(this.transport);
				this.connected = true;
				log.info("Connected to GitLab MCP server after OAuth authorization");
			} else {
				throw error;
			}
		}
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
		return this.client.callTool({ name: toolName, arguments: args }, undefined, options);
	}

	async disconnect(): Promise<void> {
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
