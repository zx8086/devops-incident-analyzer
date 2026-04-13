// src/gitlab-client/proxy.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createContextLogger } from "../utils/logger.js";

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

		this.transport = new StreamableHTTPClientTransport(mcpUrl, {
			requestInit: {
				headers: {
					Authorization: `Bearer ${this.config.personalAccessToken}`,
				},
			},
		});

		await this.client.connect(this.transport);
		this.connected = true;
		log.info("Connected to GitLab MCP server");
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

	async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.connected) {
			throw new Error("Not connected to GitLab MCP server. Call connect() first.");
		}

		log.debug({ tool: toolName }, "Forwarding tool call to GitLab MCP");

		const result = await this.client.callTool({ name: toolName, arguments: args });
		return result;
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
