// src/gitlab-client/proxy.ts

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createContextLogger } from "../utils/logger.js";
import { waitForOAuthCallback } from "@devops-agent/shared";
import { GitLabOAuthProvider, OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORT } from "./oauth-provider.js";

const log = createContextLogger("proxy");

export interface GitLabProxyConfig {
	instanceUrl: string;
	personalAccessToken: string;
	timeout: number;
}

export interface ProxyToolInfo {
	name: string;
	description: string;
	inputSchema: Tool["inputSchema"];
}

export class GitLabMcpProxy {
	private client: Client;
	private transport: StreamableHTTPClientTransport | null = null;
	private connected = false;
	private readonly config: GitLabProxyConfig;

	constructor(config: GitLabProxyConfig) {
		this.config = config;
		this.client = new Client({ name: "gitlab-mcp-proxy", version: "0.1.0" }, { capabilities: {} });
	}

	async connect(): Promise<void> {
		const mcpUrl = new URL("/api/v4/mcp", this.config.instanceUrl);
		log.info({ url: mcpUrl.toString() }, "Connecting to GitLab MCP endpoint");

		const oauthProvider = new GitLabOAuthProvider(this.config.instanceUrl, async (authUrl) => {
			log.info("Opening browser for GitLab OAuth authorization...");
			console.log(`\n  Authorize in your browser:\n  ${authUrl.toString()}\n`);
			try {
				// Open browser using Bun.spawn
				const platform = process.platform;
				const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
				Bun.spawn([cmd, authUrl.toString()]);
			} catch {
				log.warn("Could not open browser automatically. Please open the URL above manually.");
			}
		});

		this.transport = new StreamableHTTPClientTransport(mcpUrl, {
			authProvider: oauthProvider,
		});

		try {
			await this.client.connect(this.transport);
			this.connected = true;
			log.info("Connected to GitLab MCP server (authenticated)");
		} catch (error) {
			if (error instanceof UnauthorizedError) {
				log.info("OAuth authorization required -- waiting for browser callback...");

				const { code } = await waitForOAuthCallback({ port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH });
				await this.transport.finishAuth(code);

				// Reconnect with the authorized transport
				this.client = new Client({ name: "gitlab-mcp-proxy", version: "0.1.0" }, { capabilities: {} });
				this.transport = new StreamableHTTPClientTransport(mcpUrl, {
					authProvider: oauthProvider,
				});
				await this.client.connect(this.transport);
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
