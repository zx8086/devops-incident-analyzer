// agent/src/mcp-bridge.ts

import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { getLogger } from "@devops-agent/observability";
import type { IdentityCard, McpRole, ReadinessSnapshot } from "@devops-agent/shared";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { context, propagation } from "@opentelemetry/api";
import { z } from "zod";
import { wrapAwsToolsWithEstate } from "./aws-tool-estate-wrapper.ts";
import { wrapElasticToolsWithDeployment } from "./elastic-tool-deployment-wrapper.ts";

const logger = getLogger("mcp-bridge");

// SIO-649: Per-call deployment context. The elastic sub-agent's fan-out loop enters this
// context before invoking its tools, and beforeToolCall reads it to stamp the MCP request
// with X-Elastic-Deployment. One static beforeToolCall handles dynamic routing.
const deploymentStorage = new AsyncLocalStorage<{ deploymentId: string }>();

export function withElasticDeployment<T>(deploymentId: string, fn: () => Promise<T>): Promise<T> {
	return deploymentStorage.run({ deploymentId }, fn);
}

function currentElasticDeployment(): string | undefined {
	return deploymentStorage.getStore()?.deploymentId;
}

// SIO-828: AWS estates carry per-fan-out context too, but via tool *args* (estate
// is a required Zod-enum field on every AWS tool), not headers. The sub-agent
// enters a withAwsEstate scope before invoking its tools, and getToolsForDataSource
// wraps each AWS tool so .invoke(args) injects estate from ALS and the schema
// shown to the LLM omits the field entirely. LLM never sees or chooses it.
const awsEstateStorage = new AsyncLocalStorage<{ estate: string }>();

export function withAwsEstate<T>(estate: string, fn: () => Promise<T>): Promise<T> {
	return awsEstateStorage.run({ estate }, fn);
}

export function currentAwsEstate(): string | undefined {
	return awsEstateStorage.getStore()?.estate;
}

export interface McpClientConfig {
	elasticUrl?: string;
	kafkaUrl?: string;
	capellaUrl?: string;
	konnectUrl?: string;
	gitlabUrl?: string;
	atlassianUrl?: string;
	awsUrl?: string;
	// Unified Elastic IaC maker server (terraform + git + gitlab + elastic reads).
	elasticIacUrl?: string;
	// SIO-967: read-only knowledge-graph query server. Mounted IN-PROCESS in the web
	// app (lbug exclusive file lock) and reached over localhost like any other server.
	knowledgeGraphUrl?: string;
}

// SIO-705: pino's default JSON serializer drops non-enumerable fields on Error
// instances (`message`, `stack`), so logging `{error: errorInstance}` produced
// the empty `error:{}` payload that hid the actual failure cause when an MCP
// server failed to connect at boot. The shared shape mirrors the pattern used
// by reconnectServer and the sub-agent runner.
export function serializeMcpConnectError(
	reason: unknown,
	url: string,
): { url: string; error: string; errorName?: string; cause?: string } {
	if (reason instanceof Error) {
		const out: { url: string; error: string; errorName?: string; cause?: string } = {
			url,
			error: reason.message || reason.name || "unknown error",
			errorName: reason.name,
		};
		// Surface AggregateError children (Node fetch wraps DNS/socket failures) and
		// chained `cause` so transport-layer details aren't lost a level deep.
		const candidates: unknown[] = [];
		if ("cause" in reason && reason.cause !== undefined) candidates.push(reason.cause);
		if (reason instanceof AggregateError) candidates.push(...reason.errors);
		const causeMessages = candidates
			.map((c) => (c instanceof Error ? c.message : typeof c === "string" ? c : ""))
			.filter(Boolean);
		if (causeMessages.length > 0) out.cause = causeMessages.join("; ");
		return out;
	}
	return { url, error: typeof reason === "string" ? reason : JSON.stringify(reason) };
}

// SIO-595: All MCP servers use Streamable HTTP transport at /mcp
let allTools: StructuredToolInterface[] = [];
let connectedServers: Set<string> = new Set();
let toolsByServer: Map<string, StructuredToolInterface[]> = new Map();

// SIO-608: Health polling state
let serverUrls: Map<string, string> = new Map();
let isPolling = false;
const HEALTH_POLL_INTERVAL_MS = 30_000;

// SIO-1113: the poll timer is a PROCESS-wide singleton keyed on globalThis, not a
// module-scope var. Under Vite HMR each reload creates a fresh module instance with
// its own `let healthPollTimer = null`, so a module-scope guard would let every reload
// stack another interval; the orphaned loops then fail reconnects against the closed
// module runner and re-detect the same replacement forever. A globalThis key survives
// across module graphs so start/stop always see the one live timer.
const HEALTH_POLL_KEY = Symbol.for("devops-agent.mcp-bridge.healthPollTimer");
type HealthPollTimer = ReturnType<typeof setInterval>;
function getHealthPollTimer(): HealthPollTimer | null {
	return ((globalThis as Record<symbol, unknown>)[HEALTH_POLL_KEY] as HealthPollTimer | undefined) ?? null;
}
function setHealthPollTimer(timer: HealthPollTimer | null): void {
	(globalThis as Record<symbol, unknown>)[HEALTH_POLL_KEY] = timer ?? undefined;
}

// SIO-774: AgentCore-backed servers cold-start through a SigV4 proxy whose
// JSON-RPC retry ladder runs to ~30s (see agentcore-proxy.ts JSONRPC_RETRY_DEADLINE_MS).
// Bridge connect timeout must exceed that so the proxy's retry succeeds before
// the bridge bails. Non-AgentCore servers have no cold-start cost and stay on 10s.
const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 10_000;
const AGENTCORE_MCP_CONNECT_TIMEOUT_MS = 35_000;
const PER_SERVER_CONNECT_TIMEOUTS: Record<string, number> = {
	"kafka-mcp": AGENTCORE_MCP_CONNECT_TIMEOUT_MS,
	"aws-mcp": AGENTCORE_MCP_CONNECT_TIMEOUT_MS,
};

function connectTimeoutFor(serverName: string): number {
	return PER_SERVER_CONNECT_TIMEOUTS[serverName] ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
}

// SIO-893: per-server tool-call timeout. The @langchain/mcp-adapters default tool
// timeout is 60s, which is shorter than elastic-iac's drift-check round trip: the
// gitlab_get_drift_check_result tool polls a CI pipeline internally for up to
// ELASTIC_IAC_DRIFT_POLL_BUDGET_MS (SIO-989: now 90s, was 5 min). At 60s the client
// aborts the call before the tool's own poll finishes -> every stack reports a false
// planError. Give elastic-iac a tool timeout just above its internal poll budget so the
// tool's poll is the binding constraint, not the transport. (NOTE: a cold k8s runner
// takes ~130s+ to queue + install Bun/Terraform + plan, so at the 90s budget a cold
// drift-check can return non-terminal -- the SIO-989 cap accepts that tradeoff.)
// Env-tunable; read lazily (no module-scope Bun.env -- web app imports this under Vite SSR).
const DRIFT_POLL_BUDGET_DEFAULT_MS = 90_000;
const ELASTIC_IAC_TOOL_TIMEOUT_MARGIN_MS = 30_000;

// SIO-1111: atlassian-mcp serializes every upstream Rovo call on one OAuth
// transport (SIO-1097 upstreamQueue). Under 6-way sub-agent fan-out the last
// queued call waits ~(depth-1) x call latency, which routinely exceeded the 60s
// adapter default (observed -32001 failures). 120s covers queue depth 4 at the
// 30s per-call upstream cap (ATLASSIAN_TIMEOUT) while staying at 1/3 of the
// 360s sub-agent budget.
const ATLASSIAN_TOOL_TIMEOUT_DEFAULT_MS = 120_000;

// SIO-1112: positive-integer millisecond schema for the per-server timeout overrides.
// Coerce + floor mirrors graph-budget.ts: a sub-millisecond value like "0.5" passes a
// plain > 0 check and then floors to 0, silently disabling the timeout, so require >= 1
// before flooring. Absent/empty/invalid -> undefined (caller falls back to its default).
const positiveTimeoutMsSchema = z.coerce
	.number()
	.min(1)
	.transform((n) => Math.floor(n));

function parseTimeoutOverride(raw: string | undefined): number | undefined {
	if (raw == null || raw === "") return undefined;
	const parsed = positiveTimeoutMsSchema.safeParse(raw);
	return parsed.success ? parsed.data : undefined;
}

// SIO-1112: env is injectable (default process.env) so tests pass isolated objects
// instead of mutating global env -- matches getSubAgentTimeoutMs / graph-budget.ts.
function toolTimeoutFor(serverName: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
	if (serverName === "atlassian-mcp") {
		return parseTimeoutOverride(env.ATLASSIAN_TOOL_TIMEOUT_MS) ?? ATLASSIAN_TOOL_TIMEOUT_DEFAULT_MS;
	}
	if (serverName !== "elastic-iac-mcp") return undefined; // others use the adapter default
	const override = parseTimeoutOverride(env.ELASTIC_IAC_TOOL_TIMEOUT_MS);
	if (override !== undefined) return override;
	const pollBudget = parseTimeoutOverride(env.ELASTIC_IAC_DRIFT_POLL_BUDGET_MS) ?? DRIFT_POLL_BUDGET_DEFAULT_MS;
	return pollBudget + ELASTIC_IAC_TOOL_TIMEOUT_MARGIN_MS;
}

// SIO-680/682: Generic timeout wrapper. Races the input promise against
// AbortSignal.timeout(ms); rejects with a descriptive error if the promise
// hasn't settled by deadline.
//
// KNOWN LIMITATION: when the timeout fires, the underlying operation is NOT
// cancelled -- the in-flight HTTP request inside MultiServerMCPClient.getTools()
// keeps running until it resolves on its own (the SDK in @langchain/mcp-adapters
// v1.1.3 doesn't accept an AbortSignal parameter). The leaked promise is reclaimed
// when the agent process exits. In production the next health-poll cycle attempts
// a fresh connect via reconnectServer, so the leak is bounded by the poll interval.
//
// Re-exported as _withTimeoutForTest at the bottom of the file for unit testing.
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	const timeoutPromise = new Promise<never>((_, reject) => {
		const signal = AbortSignal.timeout(ms);
		signal.addEventListener("abort", () => {
			reject(new Error(`${label} timed out after ${ms}ms`));
		});
	});
	return Promise.race([promise, timeoutPromise]);
}

function injectTraceHeaders(): { headers: Record<string, string> } | undefined {
	const headers: Record<string, string> = {};
	propagation.inject(context.active(), headers);
	return Object.keys(headers).length > 0 ? { headers } : undefined;
}

// SIO-649: Elastic-specific hook that adds X-Elastic-Deployment alongside trace headers when
// the caller is inside a withElasticDeployment() scope. Non-elastic MCP clients keep using
// injectTraceHeaders and never see this header.
function injectElasticHeaders(): { headers: Record<string, string> } | undefined {
	const headers: Record<string, string> = {};
	propagation.inject(context.active(), headers);
	const deploymentId = currentElasticDeployment();
	if (deploymentId) headers["x-elastic-deployment"] = deploymentId;
	return Object.keys(headers).length > 0 ? { headers } : undefined;
}

export async function createMcpClient(config: McpClientConfig): Promise<void> {
	const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");

	const serverEntries: Array<{ name: string; url: string }> = [];

	if (config.elasticUrl) {
		serverEntries.push({ name: "elastic-mcp", url: `${config.elasticUrl}/mcp` });
	}
	if (config.kafkaUrl) {
		serverEntries.push({ name: "kafka-mcp", url: `${config.kafkaUrl}/mcp` });
	}
	if (config.capellaUrl) {
		serverEntries.push({ name: "couchbase-mcp", url: `${config.capellaUrl}/mcp` });
	}
	if (config.konnectUrl) {
		serverEntries.push({ name: "konnect-mcp", url: `${config.konnectUrl}/mcp` });
	}
	if (config.gitlabUrl) {
		serverEntries.push({ name: "gitlab-mcp", url: `${config.gitlabUrl}/mcp` });
	}
	if (config.atlassianUrl) {
		serverEntries.push({ name: "atlassian-mcp", url: `${config.atlassianUrl}/mcp` });
	}
	if (config.awsUrl) {
		serverEntries.push({ name: "aws-mcp", url: `${config.awsUrl}/mcp` });
	}
	if (config.elasticIacUrl) {
		serverEntries.push({ name: "elastic-iac-mcp", url: `${config.elasticIacUrl}/mcp` });
	}
	if (config.knowledgeGraphUrl) {
		serverEntries.push({ name: "knowledge-graph-mcp", url: `${config.knowledgeGraphUrl}/mcp` });
	}

	if (serverEntries.length === 0) {
		logger.warn("No MCP server URLs configured. Agent will have no tools.");
		return;
	}

	// SIO-608: Store URLs for health polling (base URL without /mcp suffix)
	serverUrls = new Map(serverEntries.map(({ name, url }) => [name, url]));

	// Connect to each server independently so one failure doesn't block the rest
	const results = await Promise.allSettled(
		serverEntries.map(async ({ name, url }) => {
			// SIO-602: Inject W3C traceparent for OTEL span correlation with MCP servers.
			// SIO-649: Elastic also gets X-Elastic-Deployment via injectElasticHeaders.
			// SIO-1086: `beforeToolCall` is a TOP-LEVEL client-config option in
			// @langchain/mcp-adapters@1.1.3 (clientConfigSchema `.and(toolHooksSchema)`),
			// NOT a per-server (connectionSchema) field. The previous code set it INSIDE
			// mcpServers[name], where the per-server Zod parse silently stripped it -- so
			// the hook was NEVER wired and NO elastic query ever carried x-elastic-deployment
			// (every deployment-scoped search fell back to the default deployment, reporting
			// services present only outside it as "absent"). One client per server here, so
			// top-level == per-server scope. The old `as never` cast was masking exactly this
			// shape mismatch; it is no longer needed.
			const beforeToolCall = name === "elastic-mcp" ? injectElasticHeaders : injectTraceHeaders;
			// SIO-893: elastic-iac drift tools poll a CI pipeline well past the 60s
			// adapter default; set a per-server tool timeout above their internal budget.
			const toolTimeout = toolTimeoutFor(name);
			const client = new MultiServerMCPClient({
				beforeToolCall: () => beforeToolCall(),
				mcpServers: {
					[name]: {
						transport: "http",
						url,
						...(toolTimeout !== undefined && { defaultToolTimeout: toolTimeout }),
					},
				},
			});
			const tools = await withTimeout(client.getTools(), connectTimeoutFor(name), `MCP connect to '${name}' (${url})`);
			return { name, tools };
		}),
	);

	const tools: StructuredToolInterface[] = [];
	connectedServers = new Set();
	toolsByServer = new Map();

	for (const [i, result] of results.entries()) {
		const entry = serverEntries[i] as { name: string; url: string };
		if (result.status === "fulfilled") {
			// Patch tools with empty descriptions to prevent Bedrock validation errors
			for (const tool of result.value.tools) {
				if (!tool.description) {
					logger.warn({ serverName: entry.name, toolName: tool.name }, "Tool has empty description, patching");
					tool.description = `${tool.name} tool`;
				}
			}
			tools.push(...result.value.tools);
			connectedServers.add(result.value.name);
			toolsByServer.set(result.value.name, result.value.tools);
			logger.info({ serverName: entry.name, toolCount: result.value.tools.length }, "MCP server connected");
		} else {
			// SIO-705: pino's default JSON serializer drops non-enumerable Error fields,
			// so passing the raw rejection logged as `error:{}` and hid the actual
			// failure cause. Use the shared serializer below.
			logger.warn(
				{ serverName: entry.name, ...serializeMcpConnectError(result.reason, entry.url) },
				"Failed to connect to MCP server, skipping",
			);
		}
	}

	allTools = tools;
	logger.info({ toolCount: allTools.length, servers: [...connectedServers] }, "MCP tools loaded");

	// SIO-780: boot-strict identity check (B1). Refuse to start the agent if any
	// connected MCP returns a /identity card with a role that does not match the
	// expected MCP_SERVER_TO_ROLE entry. Operators see a precise error message
	// naming the env var to fix; no silent misrouting. Servers whose /identity is
	// unreachable at boot are logged-warn and skipped (defense-in-depth during
	// rollout windows).
	for (const { name, url } of serverEntries) {
		if (!connectedServers.has(name)) continue;
		const baseUrl = url.replace(/\/mcp$/, "");
		let card: IdentityCard;
		try {
			const r = await fetch(`${baseUrl}/identity`, { signal: AbortSignal.timeout(2_000) });
			if (!r.ok) {
				logger.warn(
					{ serverName: name, status: r.status },
					"MCP server /identity unavailable at boot -- skipping strict check",
				);
				continue;
			}
			card = (await r.json()) as IdentityCard;
		} catch (err) {
			logger.warn(
				{ serverName: name, error: probeErrorMessage(err) },
				"MCP server /identity probe failed at boot -- skipping strict check",
			);
			continue;
		}
		const expectedRole = MCP_SERVER_TO_ROLE[name];
		if (!expectedRole) continue;
		if (card.role !== expectedRole) {
			throw new McpRoleMismatchError(
				`${name} (${url}) returned identity card with role="${card.role}", expected "${expectedRole}". ` +
					`Check ${name.toUpperCase().replace(/-/g, "_")}_URL env var.`,
			);
		}
		expectedIdentity.set(name, card);
	}

	// SIO-608: Start periodic health polling
	startHealthPolling();
}

export function getConnectedServers(): string[] {
	return [...connectedServers];
}

// Exported for wiring tests (packages/agent/src/wiring-aws.test.ts).
export const DATASOURCE_TO_MCP_SERVER: Record<string, string> = {
	elastic: "elastic-mcp",
	kafka: "kafka-mcp",
	couchbase: "couchbase-mcp",
	konnect: "konnect-mcp",
	gitlab: "gitlab-mcp",
	atlassian: "atlassian-mcp",
	aws: "aws-mcp",
	"elastic-iac": "elastic-iac-mcp",
	"knowledge-graph": "knowledge-graph-mcp",
};

export class McpRoleMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpRoleMismatchError";
	}
}

// SIO-780: expected role per logical server name. Proxy roles for kafka and aws
// reflect today's deployment topology (both run via AgentCore SigV4 proxies).
// Mismatches between the card returned by /identity and this map -> boot-strict
// throw at agent startup.
export const MCP_SERVER_TO_ROLE: Record<string, McpRole> = {
	"elastic-mcp": "elastic-mcp",
	"kafka-mcp": "kafka-proxy",
	"couchbase-mcp": "couchbase-mcp",
	"konnect-mcp": "konnect-mcp",
	"gitlab-mcp": "gitlab-mcp",
	"atlassian-mcp": "atlassian-mcp",
	"aws-mcp": "aws-proxy",
	"elastic-iac-mcp": "elastic-iac-mcp",
	"knowledge-graph-mcp": "knowledge-graph-mcp",
};

export function getToolsForDataSource(dataSourceId: string): StructuredToolInterface[] {
	const serverName = DATASOURCE_TO_MCP_SERVER[dataSourceId];
	if (!serverName) return allTools;

	const raw = toolsByServer.get(serverName) ?? [];

	// SIO-828: hide the `estate` arg from the LLM and inject it from ALS at call time.
	// The aws_list_estates introspection tool has no `estate` arg; the wrapper's
	// schema-strip is idempotent for it (delete on missing key is a no-op).
	if (dataSourceId === "aws") {
		return wrapAwsToolsWithEstate(raw);
	}

	// SIO-649: hide the `deployment` arg from the LLM so the per-deployment fan-out
	// header (withElasticDeployment -> injectElasticHeaders) is the sole authority and
	// the model can't broaden a single-deployment selection back to all deployments.
	if (dataSourceId === "elastic") {
		return wrapElasticToolsWithDeployment(raw);
	}

	return raw;
}

export function getAllTools(): StructuredToolInterface[] {
	return allTools;
}

// SIO-780: three-tier probe replacing the single /health check. Tier 1 hits
// /health (2s) for liveness, Tier 2 hits /identity (1s) to detect replaced or
// misidentified instances, Tier 3 hits /ready (5s) for upstream readiness.
// Total worst-case budget 8s -- well inside the 35s AgentCore connect window.
type ProbeState = "ready" | "unready" | "down" | "replaced" | "misidentified";

type ProbeResult =
	| { state: "ready"; card: IdentityCard }
	| { state: "unready"; card: IdentityCard; snapshot: ReadinessSnapshot }
	| { state: "down"; reason: string }
	| { state: "replaced"; reason: string; card: IdentityCard }
	| { state: "misidentified"; reason: string; card: IdentityCard };

const expectedIdentity = new Map<string, IdentityCard>();
const lastProbeState = new Map<string, ProbeState>();

// SIO-782: debounce the "MCP server upstream degraded" warn. A single unready
// cycle is usually probe-timeout noise against a cold AgentCore runtime; only
// emit once the server has been unready for UNREADY_WARN_THRESHOLD consecutive
// cycles (HEALTH_POLL_INTERVAL_MS * threshold = sustained-degradation budget).
// Reset on any transition out of unready.
const unreadyStreak = new Map<string, number>();
const UNREADY_WARN_THRESHOLD = 3;

// SIO-780: per-process event bus for proxied server lifecycle events.
// Frontend consumes via /api/events SSE endpoint (apps/web).
export const mcpEvents = new EventEmitter();

export interface McpReplacedEvent {
	type: "mcp_replaced";
	server: string;
	oldInstanceId: string | null;
	newInstanceId: string;
	toolCountDelta: number;
}

function probeErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function probeServer(name: string, url: string): Promise<ProbeResult> {
	const baseUrl = url.replace(/\/mcp$/, "");

	// Tier 1: liveness (2s budget)
	try {
		const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
		if (!r.ok) return { state: "down", reason: `health returned ${r.status}` };
	} catch (err) {
		return { state: "down", reason: `health unreachable: ${probeErrorMessage(err)}` };
	}

	// Tier 2: identity (1s budget)
	let card: IdentityCard;
	try {
		const r = await fetch(`${baseUrl}/identity`, { signal: AbortSignal.timeout(1_000) });
		if (!r.ok) return { state: "down", reason: `identity returned ${r.status}` };
		card = (await r.json()) as IdentityCard;
	} catch (err) {
		return { state: "down", reason: `identity unreachable: ${probeErrorMessage(err)}` };
	}

	// Seed on first probe; subsequent probes compare against the seeded card.
	// Order: role mismatch (misidentified) > instanceId (replaced) > upstream fingerprint (replaced).
	const expected = expectedIdentity.get(name);
	if (!expected) {
		expectedIdentity.set(name, card);
	} else {
		if (card.role !== expected.role) {
			return {
				state: "misidentified",
				reason: `role mismatch: expected ${expected.role}, got ${card.role}`,
				card,
			};
		}
		if (card.instanceId !== expected.instanceId) {
			return { state: "replaced", reason: "instanceId changed", card };
		}
		if (card.upstreamFingerprint !== expected.upstreamFingerprint) {
			return { state: "replaced", reason: "upstream config fingerprint changed", card };
		}
	}

	// Tier 3: readiness. SIO-782: budget tracks the per-server connect timeout so
	// AgentCore-hosted proxies (kafka/aws, 35s envelope from SIO-774) outlive the
	// proxy's own 20s upstream probe instead of timing out at a fixed 5s and
	// synthesising a false-positive unready. 404 means Phase B not yet deployed
	// for this server -- treat as ready.
	try {
		const r = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(connectTimeoutFor(name)) });
		if (r.status === 404) return { state: "ready", card };
		if (!r.ok) {
			const snapshot = (await r.json().catch(() => ({}))) as ReadinessSnapshot;
			return { state: "unready", card, snapshot };
		}
		return { state: "ready", card };
	} catch (err) {
		// SIO-782: tag synthetic snapshots so pollServerHealth can distinguish
		// agent-side probe timeouts from proxy-side 503s with real components.
		return {
			state: "unready",
			card,
			snapshot: {
				ready: false,
				components: {},
				cachedAt: new Date().toISOString(),
				errors: { _probe: probeErrorMessage(err), _probeTimeout: "true" },
			},
		};
	}
}

// Test escape hatches. Underscore prefix marks these as internal -- do not import from production code.
export const _probeServerForTest = probeServer;
export function _resetExpectedIdentityForTest(): void {
	expectedIdentity.clear();
	lastProbeState.clear();
}

// Read-only snapshot of the most recent probe state per server, for the dashboard endpoint (Task C4).
export function getServerStates(): Record<string, ProbeState> {
	return Object.fromEntries(lastProbeState.entries());
}

// SIO-608: Reconnect a single server that was previously down
async function reconnectServer(name: string, mcpUrl: string): Promise<void> {
	try {
		const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");
		// SIO-649: Keep elastic reconnects on injectElasticHeaders so deployment routing survives.
		// SIO-1086: beforeToolCall is a TOP-LEVEL config field, not per-server (see createMcpClient).
		const beforeToolCall = name === "elastic-mcp" ? injectElasticHeaders : injectTraceHeaders;
		// SIO-893/SIO-1086: mirror createMcpClient and preserve the per-server tool timeout on
		// reconnect too -- without it, elastic-iac drift tools (which poll CI well past the 60s
		// adapter default) fall back to that default and start timing out after any reconnect.
		const toolTimeout = toolTimeoutFor(name);
		const client = new MultiServerMCPClient({
			beforeToolCall: () => beforeToolCall(),
			mcpServers: {
				[name]: {
					transport: "http",
					url: mcpUrl,
					...(toolTimeout !== undefined && { defaultToolTimeout: toolTimeout }),
				},
			},
		});
		const tools = await withTimeout(
			client.getTools(),
			connectTimeoutFor(name),
			`MCP reconnect to '${name}' (${mcpUrl})`,
		);

		for (const tool of tools) {
			if (!tool.description) {
				tool.description = `${tool.name} tool`;
			}
		}

		// Remove any stale tools for this server before appending
		const staleTools = toolsByServer.get(name) ?? [];
		const staleNames = new Set(staleTools.map((t) => t.name));
		allTools = [...allTools.filter((t) => !staleNames.has(t.name)), ...tools];

		toolsByServer.set(name, tools);
		connectedServers.add(name);
		logger.info({ serverName: name, toolCount: tools.length }, "MCP server reconnected with tools");
	} catch (error) {
		// SIO-705: same serializer as the boot path so reconnect failures expose
		// AggregateError causes (DNS/socket) instead of an opaque ECONNREFUSED.
		logger.warn({ serverName: name, ...serializeMcpConnectError(error, mcpUrl) }, "Failed to reconnect MCP server");
	}
}

// SIO-780: state-aware health poll. Dispatches per ProbeResult.state:
//   ready        -> reconnect if not connected, otherwise no-op
//   down         -> drop connection
//   unready      -> log warn, keep tools (UI shows degraded via getServerStates)
//   replaced     -> reconnect + update expectedIdentity (SSE event deferred to C5)
//   misidentified -> drop connection + log error (no reconnect; the server is wrong)
async function pollServerHealth(): Promise<void> {
	if (isPolling) return;
	isPolling = true;

	try {
		const checks = [...serverUrls.entries()].map(async ([name, url]) => {
			const result = await probeServer(name, url);
			return { name, url, result };
		});

		const settled = await Promise.allSettled(checks);

		for (const settledResult of settled) {
			if (settledResult.status !== "fulfilled") continue;
			const { name, url, result } = settledResult.value;
			lastProbeState.set(name, result.state);

			// SIO-782: any transition out of unready clears the streak counter so a
			// future cold-start probe-timeout doesn't immediately cross the threshold.
			if (result.state !== "unready") unreadyStreak.delete(name);

			switch (result.state) {
				case "ready":
					if (!connectedServers.has(name)) {
						const hasTools = (toolsByServer.get(name)?.length ?? 0) > 0;
						if (hasTools) {
							connectedServers.add(name);
							logger.info({ serverName: name }, "MCP server back online (tools cached)");
						} else {
							await reconnectServer(name, url);
						}
					}
					break;
				case "down":
					if (connectedServers.has(name)) {
						connectedServers.delete(name);
						logger.warn({ serverName: name, reason: result.reason }, "MCP server down, marking disconnected");
					}
					break;
				case "unready": {
					// SIO-782: emit the warn only on threshold crossing. Probe-timeout
					// synthetic snapshots (tagged via errors._probeTimeout in probeServer)
					// log at info even at threshold, because they signal "agent gave up
					// probing" not "proxy reported a real outage".
					const streak = (unreadyStreak.get(name) ?? 0) + 1;
					unreadyStreak.set(name, streak);
					if (streak === UNREADY_WARN_THRESHOLD) {
						const probeTimeout = result.snapshot.errors?._probeTimeout === "true";
						const logFields = {
							serverName: name,
							components: result.snapshot.components,
							streak,
							probeTimeout,
						};
						if (probeTimeout) {
							logger.info(logFields, "MCP server probe timing out (probe-side, not upstream)");
						} else {
							logger.warn(logFields, "MCP server upstream degraded");
						}
					}
					break;
				}
				case "replaced": {
					const oldCard = expectedIdentity.get(name);
					logger.info(
						{
							serverName: name,
							reason: result.reason,
							oldInstanceId: oldCard?.instanceId ?? null,
							newInstanceId: result.card.instanceId,
						},
						"MCP server replaced, reconnecting",
					);
					const oldToolCount = toolsByServer.get(name)?.length ?? 0;
					await reconnectServer(name, url);
					const newToolCount = toolsByServer.get(name)?.length ?? 0;
					expectedIdentity.set(name, result.card);
					const event: McpReplacedEvent = {
						type: "mcp_replaced",
						server: name,
						oldInstanceId: oldCard?.instanceId ?? null,
						newInstanceId: result.card.instanceId,
						toolCountDelta: newToolCount - oldToolCount,
					};
					// SIO-906: emit() runs listeners synchronously and re-throws; a single
					// dead SSE controller must not unwind into pollServerHealth() and kill
					// the whole health-poll cycle for every server.
					try {
						mcpEvents.emit("mcp_replaced", event);
					} catch (err) {
						logger.warn(
							{ serverName: name, error: err instanceof Error ? err.message : String(err) },
							"mcp_replaced listener threw; continuing health poll",
						);
					}
					logger.info(event, "mcp_replaced event emitted");
					break;
				}
				case "misidentified":
					logger.error({ serverName: name, reason: result.reason }, "MCP server misidentified mid-session");
					connectedServers.delete(name);
					break;
			}
		}
	} finally {
		isPolling = false;
	}
}

function startHealthPolling(): void {
	if (getHealthPollTimer()) return; // SIO-1113: HMR reload must not stack poll loops
	const timer = setInterval(() => {
		pollServerHealth().catch((error) => {
			logger.error({ error: error instanceof Error ? error.message : String(error) }, "Health poll cycle failed");
		});
	}, HEALTH_POLL_INTERVAL_MS);
	timer.unref?.(); // never keep the process alive solely for the poll loop
	setHealthPollTimer(timer);
	logger.info({ intervalMs: HEALTH_POLL_INTERVAL_MS }, "MCP health polling started");
}

export function stopHealthPolling(): void {
	const timer = getHealthPollTimer();
	if (timer) {
		clearInterval(timer);
		setHealthPollTimer(null);
		logger.info("MCP health polling stopped");
	}
}

// SIO-680/682: exported for testing only. Do not import from production code.
// SIO-774: same test-only export pattern for the per-server connect-timeout helper.
// SIO-782: pollServerHealth + serverUrls + unreadyStreak exposed for debounce tests.
export {
	connectTimeoutFor as _connectTimeoutForTest,
	toolTimeoutFor as _toolTimeoutForTest,
	withTimeout as _withTimeoutForTest,
};
export const _pollServerHealthForTest = pollServerHealth;
// SIO-1113: expose the health-poll singleton for the HMR-stacking regression test.
export const _startHealthPollingForTest = startHealthPolling;
export function _getHealthPollTimerForTest(): HealthPollTimer | null {
	return getHealthPollTimer();
}
export function _setServerUrlsForTest(entries: Array<[string, string]>): void {
	serverUrls = new Map(entries);
}
export function _resetUnreadyStreakForTest(): void {
	unreadyStreak.clear();
}
export function _getLoggerForTest(): typeof logger {
	return logger;
}
