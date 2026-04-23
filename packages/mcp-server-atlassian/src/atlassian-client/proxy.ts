// src/atlassian-client/proxy.ts

import { waitForOAuthCallback } from "@devops-agent/shared";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createContextLogger } from "../utils/logger.js";
import { AtlassianOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider.js";

const log = createContextLogger("proxy");

export interface ProxyToolInfo {
	name: string;
	description: string;
	inputSchema: Tool["inputSchema"];
}

export interface McpClientLike {
	listTools: () => Promise<{ tools: Tool[] }>;
	callTool: (req: { name: string; arguments?: Record<string, unknown> }) => Promise<{ content: unknown[] }>;
}

export interface AtlassianMcpProxyOptions {
	mcpEndpoint: string;
	callbackPort: number;
	siteName: string | undefined;
	timeout?: number;
	client?: McpClientLike;
	reauth?: () => Promise<void>;
}

interface AtlassianResource {
	id: string;
	name: string;
}

export class AtlassianMcpProxy {
	private readonly options: AtlassianMcpProxyOptions;
	private sdkClient: Client | null = null;
	private transport: StreamableHTTPClientTransport | null = null;
	private injectedClient: McpClientLike | null = null;
	private cloudId: string | null = null;
	private connected = false;

	constructor(options: AtlassianMcpProxyOptions) {
		this.options = options;
		// DI: use injected client if provided (for tests)
		if (options.client) {
			this.injectedClient = options.client;
			this.connected = true;
		}
	}

	private get client(): McpClientLike {
		if (this.injectedClient) return this.injectedClient;
		if (this.sdkClient) return this.sdkClient as unknown as McpClientLike;
		throw new Error("Not connected to Atlassian MCP server. Call connect() first.");
	}

	async connect(): Promise<void> {
		const mcpUrl = new URL(this.options.mcpEndpoint);
		log.info({ url: mcpUrl.toString() }, "Connecting to Atlassian MCP endpoint");

		const oauthProvider = new AtlassianOAuthProvider({
			mcpEndpoint: this.options.mcpEndpoint,
			callbackPort: this.options.callbackPort,
			onRedirect: async (authUrl) => {
				log.info("Opening browser for Atlassian OAuth authorization...");
				console.log(`\n  Authorize in your browser:\n  ${authUrl.toString()}\n`);
				try {
					const platform = process.platform;
					const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
					Bun.spawn([cmd, authUrl.toString()]);
				} catch {
					log.warn("Could not open browser automatically. Please open the URL above manually.");
				}
			},
		});

		this.sdkClient = new Client({ name: "atlassian-mcp-proxy", version: "0.1.0" }, { capabilities: {} });

		this.transport = new StreamableHTTPClientTransport(mcpUrl, {
			authProvider: oauthProvider,
		});

		try {
			await this.sdkClient.connect(this.transport);
			this.connected = true;
			log.info("Connected to Atlassian MCP server (authenticated)");
		} catch (error) {
			if (error instanceof UnauthorizedError) {
				log.info("OAuth authorization required -- waiting for browser callback...");

				const { code } = await waitForOAuthCallback({ port: this.options.callbackPort, path: OAUTH_CALLBACK_PATH });
				await this.transport.finishAuth(code);

				// Reconnect with authorized transport
				this.sdkClient = new Client({ name: "atlassian-mcp-proxy", version: "0.1.0" }, { capabilities: {} });
				this.transport = new StreamableHTTPClientTransport(mcpUrl, {
					authProvider: oauthProvider,
				});
				await this.sdkClient.connect(this.transport);
				this.connected = true;
				log.info("Connected to Atlassian MCP server after OAuth authorization");
			} else {
				throw error;
			}
		}
	}

	async resolveCloudId(): Promise<void> {
		// Rovo's Zod schema requires an object for arguments even when the tool takes no params.
		// Omitting it yields a -32602 "expected object, received undefined" from the server.
		const response = await this.client.callTool({ name: "getAccessibleAtlassianResources", arguments: {} });

		const textContent = response.content.find(
			(c): c is { type: string; text: string } =>
				typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
		);

		if (!textContent) {
			throw new Error("No accessible resources: getAccessibleAtlassianResources returned no text content");
		}

		let resources: AtlassianResource[];
		try {
			resources = JSON.parse(textContent.text) as AtlassianResource[];
		} catch {
			throw new Error("No accessible resources: failed to parse getAccessibleAtlassianResources response");
		}

		if (!Array.isArray(resources) || resources.length === 0) {
			throw new Error("No accessible resources: Atlassian returned an empty resource list");
		}

		const { siteName } = this.options;
		if (siteName) {
			const match = resources.find((r) => r.name === siteName);
			if (!match) {
				throw new Error(`No accessible resources: site "${siteName}" not found in Atlassian resources`);
			}
			this.cloudId = match.id;
			log.info({ cloudId: this.cloudId, siteName }, "Resolved cloudId by siteName");
		} else {
			// resources.length > 0 is guaranteed by the empty check above
			// biome-ignore lint/style/noNonNullAssertion: guarded by length check
			const first = resources[0]!;
			this.cloudId = first.id;
			log.info({ cloudId: this.cloudId, site: first.name }, "Resolved cloudId (first resource)");
		}
	}

	getCloudId(): string {
		if (!this.cloudId) {
			throw new Error("cloudId not resolved. Call resolveCloudId() first.");
		}
		return this.cloudId;
	}

	async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
		const argsWithCloud: Record<string, unknown> = this.cloudId ? { ...args, cloudId: this.cloudId } : { ...args };

		try {
			return await this.client.callTool({ name: toolName, arguments: argsWithCloud });
		} catch (error) {
			if (error instanceof UnauthorizedError) {
				log.info({ tool: toolName }, "UnauthorizedError on tool call, attempting reauth");

				if (this.options.reauth) {
					await this.options.reauth();
				}

				// One-shot retry
				try {
					return await this.client.callTool({ name: toolName, arguments: argsWithCloud });
				} catch (retryError) {
					if (retryError instanceof UnauthorizedError) {
						log.warn({ tool: toolName }, "Still unauthorized after reauth, returning auth required error");
						return {
							isError: true,
							content: [
								{
									type: "text",
									text: "ATLASSIAN_AUTH_REQUIRED: Atlassian authorization expired. Please re-authenticate.",
								},
							],
						};
					}
					throw retryError;
				}
			}
			throw error;
		}
	}

	async listTools(): Promise<ProxyToolInfo[]> {
		const response = await this.client.listTools();
		const tools: ProxyToolInfo[] = response.tools.map((tool) => ({
			name: tool.name,
			description: tool.description ?? `${tool.name} tool`,
			inputSchema: tool.inputSchema,
		}));

		log.info({ toolCount: tools.length }, "Discovered remote Atlassian MCP tools");
		return tools;
	}

	async disconnect(): Promise<void> {
		if (this.transport) {
			await this.transport.close();
			this.transport = null;
		}
		this.connected = false;
		log.info("Disconnected from Atlassian MCP server");
	}

	isConnected(): boolean {
		return this.connected;
	}
}
