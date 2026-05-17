// packages/shared/src/transport/proxy-readiness.ts
// SIO-780: readiness probe for the AgentCore SigV4 proxy. /ready combines:
//   1. getCredentials() — AWS creds available
//   2. SigV4-signed JSON-RPC tools/list to the upstream AgentCore endpoint
//   3. Role sentinel check — upstream's tool list must include the expected
//      sentinel tool for the configured role
// All three must succeed for ready: true.

import { createReadinessProbe, type ReadinessSnapshot } from "./readiness.ts";

const ROLE_SENTINEL_TOOLS: Record<"aws-proxy" | "kafka-proxy", string> = {
	"aws-proxy": "aws___call_aws",
	"kafka-proxy": "kafka_list_topics",
};

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
				const body = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
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
