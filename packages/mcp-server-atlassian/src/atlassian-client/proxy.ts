// src/atlassian-client/proxy.ts

import { buildToolErrorEnvelope, OAuthRequiresInteractiveAuthError, waitForOAuthCallback } from "@devops-agent/shared";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createContextLogger } from "../utils/logger.js";
import { AtlassianOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider.js";

const log = createContextLogger("proxy");

// SIO-1097: proactive-refresh interval tunables (mirror gitlab proxy). The
// keep-alive tick refreshes the OAuth chain before it expires so an idle gap
// longer than Rovo's refresh_token TTL doesn't force an interactive re-seed.
const DEFAULT_PROACTIVE_REFRESH_INTERVAL_MS = 1_800_000;
const MIN_PROACTIVE_REFRESH_INTERVAL_MS = 60_000;
const MAX_PROACTIVE_REFRESH_INTERVAL_MS = 3_600_000;

function parseProactiveRefreshIntervalMs(): number {
	const raw = process.env.OAUTH_PROACTIVE_REFRESH_INTERVAL_MS;
	if (raw === undefined || raw === "") return DEFAULT_PROACTIVE_REFRESH_INTERVAL_MS;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_PROACTIVE_REFRESH_INTERVAL_MS;
	return Math.min(MAX_PROACTIVE_REFRESH_INTERVAL_MS, Math.max(MIN_PROACTIVE_REFRESH_INTERVAL_MS, n));
}

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
	// SIO-1097: kept as a field (not a connect-local) so callTool can ask it to
	// refresh tokens when the SDK throws UnauthorizedError mid-flight, and so
	// connect() can start the proactive-refresh keep-alive.
	private oauthProvider: AtlassianOAuthProvider | null = null;
	// SIO-1097: stop-handle for the proactive refresh interval. Started in
	// connect() once the OAuth provider is live, cleared in disconnect().
	private stopProactiveRefresh: (() => void) | null = null;
	// SIO-1097: serialize every upstream request on the single shared transport.
	// The agent fans out 6 sub-agents in parallel, each firing multiple tool
	// calls at once, plus a 30s health-poll resolveCloudId -- all through one
	// StreamableHTTPClientTransport. Concurrent requests raced the SDK's per-
	// request OAuth refresh and produced intermittent 401/403. A promise-chain
	// queue guarantees at most one in-flight upstream call, so no two auth flows
	// contend. This is the structural equivalent of the pooled clients that
	// couchbase/elastic use with their static credentials.
	private upstreamQueue: Promise<unknown> = Promise.resolve();

	constructor(options: AtlassianMcpProxyOptions) {
		this.options = options;
		// DI: use injected client if provided (for tests)
		if (options.client) {
			this.injectedClient = options.client;
			this.connected = true;
		}
	}

	// SIO-1097: run fn after all previously-enqueued upstream calls settle. The
	// queue never rejects (each link swallows via the returned promise) so one
	// failing call can't wedge the chain for the next caller.
	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.upstreamQueue.then(fn, fn);
		this.upstreamQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private get client(): McpClientLike {
		if (this.injectedClient) return this.injectedClient;
		if (this.sdkClient) return this.sdkClient as unknown as McpClientLike;
		throw new Error("Not connected to Atlassian MCP server. Call connect() first.");
	}

	async connect(): Promise<void> {
		const mcpUrl = new URL(this.options.mcpEndpoint);
		log.info({ url: mcpUrl.toString() }, "Connecting to Atlassian MCP endpoint");

		this.oauthProvider = new AtlassianOAuthProvider({
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
			authProvider: this.oauthProvider,
		});

		try {
			await this.sdkClient.connect(this.transport);
			this.connected = true;
			log.info("Connected to Atlassian MCP server (authenticated)");
		} catch (error) {
			if (error instanceof OAuthRequiresInteractiveAuthError) {
				throw error;
			}
			if (error instanceof UnauthorizedError) {
				log.info("OAuth authorization required -- waiting for browser callback...");

				const { code } = await waitForOAuthCallback({ port: this.options.callbackPort, path: OAUTH_CALLBACK_PATH });
				await this.transport.finishAuth(code);

				// Reconnect with authorized transport
				this.sdkClient = new Client({ name: "atlassian-mcp-proxy", version: "0.1.0" }, { capabilities: {} });
				this.transport = new StreamableHTTPClientTransport(mcpUrl, {
					authProvider: this.oauthProvider,
				});
				await this.sdkClient.connect(this.transport);
				this.connected = true;
				log.info("Connected to Atlassian MCP server after OAuth authorization");
			} else {
				throw error;
			}
		}

		// SIO-1097: now that the chain is alive, start the keep-alive tick so idle
		// gaps longer than Rovo's refresh_token TTL don't kill it. The base-class
		// cross-process file lock around doRefresh makes this safe to run in every
		// process (workspace dev + AgentCore) without racing on the rotating chain.
		const intervalMs = parseProactiveRefreshIntervalMs();
		this.stopProactiveRefresh = this.oauthProvider.startProactiveRefresh(intervalMs);
		log.info({ intervalMs }, "OAuth proactive refresh started");
	}

	async resolveCloudId(): Promise<void> {
		// Rovo's Zod schema requires an object for arguments even when the tool takes no params.
		// Omitting it yields a -32602 "expected object, received undefined" from the server.
		// SIO-1097: serialize on the shared transport (see upstreamQueue) so the 30s
		// health-poll resolveCloudId never contends with in-flight tool calls.
		const response = await this.enqueue(() =>
			this.client.callTool({ name: "getAccessibleAtlassianResources", arguments: {} }),
		);

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

		// SIO-1097: every upstream request runs one-at-a-time via the queue so
		// concurrent sub-agent tool calls never race the SDK's per-request OAuth
		// refresh on the single shared transport.
		try {
			return await this.enqueue(() => this.client.callTool({ name: toolName, arguments: argsWithCloud }));
		} catch (error) {
			if (error instanceof UnauthorizedError) {
				log.info({ tool: toolName }, "UnauthorizedError on tool call, attempting reauth");

				// SIO-1097: defense-in-depth refresh. lockedRefresh() (via the
				// provider) reloads the on-disk chain and POSTs under the cross-
				// process lock, so the one-shot retry replays with a fresh token
				// instead of the stale one. Falls back to the injected reauth for
				// test DI where no provider is wired.
				if (this.oauthProvider) {
					await this.oauthProvider.refreshTokens();
				} else if (this.options.reauth) {
					await this.options.reauth();
				}

				// One-shot retry
				try {
					return await this.enqueue(() => this.client.callTool({ name: toolName, arguments: argsWithCloud }));
				} catch (retryError) {
					if (retryError instanceof UnauthorizedError) {
						log.warn({ tool: toolName }, "Still unauthorized after reauth, returning auth required error");
						// SIO-1087: emit the shared structured envelope so the agent classifies this as
						// kind "auth-expired" (category session, NON-retryable). Previously the bare
						// "ATLASSIAN_AUTH_REQUIRED ... authorization expired" string matched no auth/
						// session regex and fell through to unknown+retryable -- a real auth failure
						// treated as a routine transient error.
						const envelope = buildToolErrorEnvelope({
							kind: "auth-expired",
							message: "ATLASSIAN_AUTH_REQUIRED: Atlassian authorization expired. Please re-authenticate.",
						});
						return {
							isError: true,
							content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
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
		// SIO-1097: stop the keep-alive tick before closing the transport so a late
		// tick doesn't fire a refresh against a closed connection.
		if (this.stopProactiveRefresh) {
			this.stopProactiveRefresh();
			this.stopProactiveRefresh = null;
		}
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
