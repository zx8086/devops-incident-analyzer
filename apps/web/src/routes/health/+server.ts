// apps/web/src/routes/health/+server.ts
import { getConnectedServers, getServerStates } from "@devops-agent/agent";
import { json } from "@sveltejs/kit";
import { getActiveSseConnections, getAgentRuntimeStatus } from "$lib/server/agent";
import type { RequestHandler } from "./$types";

// SIO-482: liveness/info endpoint. Always returns HTTP 200 (this is not a
// k8s-style readiness gate); the `status` field degrades to "degraded" when a
// probed MCP server is not "ready". Backward compatible: `status`, `timestamp`,
// and the env-presence `services` map are preserved.
export const GET: RequestHandler = async () => {
	const services = {
		elastic: !!process.env.ELASTIC_MCP_URL,
		kafka: !!process.env.KAFKA_MCP_URL,
		couchbase: !!process.env.COUCHBASE_MCP_URL,
		konnect: !!process.env.KONNECT_MCP_URL,
	};

	// Live MCP connectivity from the bridge's last probe (empty until first connect).
	const mcpServerStates = getServerStates();
	const connectedServers = getConnectedServers();
	const runtime = getAgentRuntimeStatus();

	// Degraded when any server the bridge has probed is not "ready".
	const degraded = Object.values(mcpServerStates).some((state) => state !== "ready");

	return json({
		status: degraded ? "degraded" : "ok",
		timestamp: new Date().toISOString(),
		services,
		mcp: {
			connected: connectedServers,
			states: mcpServerStates,
		},
		agent: {
			graphReady: runtime.graphReady,
			iacGraphReady: runtime.iacGraphReady,
			mcpInitialized: runtime.mcpInitialized,
			checkpointerType: runtime.checkpointerType,
		},
		activeSseConnections: getActiveSseConnections(),
	});
};
