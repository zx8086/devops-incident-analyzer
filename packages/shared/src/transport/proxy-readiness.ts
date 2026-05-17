// packages/shared/src/transport/proxy-readiness.ts
// SIO-780: readiness probe for the AgentCore SigV4 proxy. /ready combines:
//   1. getCredentials() — AWS creds available
//   2. SigV4-signed JSON-RPC tools/list to the upstream AgentCore endpoint
//   3. Role sentinel check — upstream's tool list must include the expected
//      sentinel tool for the configured role
// All three must succeed for ready: true.

import { createReadinessProbe, type ReadinessSnapshot } from "./readiness.ts";

// Sentinel tools must exist in the upstream MCP server's tools/list response.
// aws_cloudwatch_describe_alarms is the AWS agent's primary triage entry per
// agents/incident-analyzer/agents/aws-agent/RULES.md and is always registered.
const ROLE_SENTINEL_TOOLS: Record<"aws-proxy" | "kafka-proxy", string> = {
	"aws-proxy": "aws_cloudwatch_describe_alarms",
	"kafka-proxy": "kafka_list_topics",
};

// AgentCore's streamable-HTTP MCP transport returns SSE-framed JSON-RPC
// ("event: message\ndata: <json>\n\n") once the runtime is warm, and bare
// JSON ({"jsonrpc","error":{"code":-32010,...}}) during cold-start. Mirrors
// the parse pattern in agentcore-proxy.ts:230 (classifyToolStatus). Returns
// the last data: frame, or the raw body trimmed when no SSE framing exists.
function parseAgentCoreBody(rawBody: string): unknown {
	const dataLines = rawBody.split("\n").filter((l) => l.startsWith("data: "));
	const jsonText = dataLines.length > 0 ? (dataLines[dataLines.length - 1]?.slice(6) ?? "") : rawBody.trim();
	if (!jsonText) throw new Error("empty response body");
	return JSON.parse(jsonText);
}

export interface CreateProxyReadinessProbeOptions {
	role: "aws-proxy" | "kafka-proxy";
	getCredentials: () => Promise<unknown>;
	upstreamUrl: string;
	sigv4Fetch: (req: Request) => Promise<Response>;
	ttlMs?: number;
	timeoutMs?: number;
	now?: () => number;
}

export function createProxyReadinessProbe(opts: CreateProxyReadinessProbeOptions): () => Promise<ReadinessSnapshot> {
	const sentinelTool = ROLE_SENTINEL_TOOLS[opts.role];

	return createReadinessProbe({
		components: {
			credentials: async () => {
				await opts.getCredentials();
			},
			agentcoreUpstream: async () => {
				const req = new Request(opts.upstreamUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
				});
				const res = await opts.sigv4Fetch(req);
				if (!res.ok) {
					throw new Error(`tools/list returned ${res.status}`);
				}
				const rawBody = await res.text();
				const body = parseAgentCoreBody(rawBody) as {
					result?: { tools?: Array<{ name: string }> };
					error?: { code: number; message?: string };
				};
				// Cold-start: AgentCore returns -32010 while the runtime boots. The probe
				// should surface this explicitly so the operator doesn't chase a missing
				// sentinel tool that won't appear until the runtime is up.
				if (body.error?.code === -32010) {
					throw new Error(`AgentCore cold-start in progress (-32010): ${body.error.message ?? ""}`.trim());
				}
				if (body.error) {
					throw new Error(`tools/list returned JSON-RPC error ${body.error.code}: ${body.error.message ?? ""}`.trim());
				}
				const tools = body.result?.tools ?? [];
				const found = tools.some((t) => t.name === sentinelTool);
				if (!found) {
					throw new Error(
						`expected sentinel tool "${sentinelTool}" for role "${opts.role}", upstream returned ${tools.length} tools without it`,
					);
				}
			},
		},
		ttlMs: opts.ttlMs,
		timeoutMs: opts.timeoutMs,
		now: opts.now,
	});
}
