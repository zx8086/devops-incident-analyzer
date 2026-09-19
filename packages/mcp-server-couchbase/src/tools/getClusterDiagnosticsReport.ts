/* src/tools/getClusterDiagnosticsReport.ts */

import { buildToolErrorEnvelope } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { classifyCouchbaseError, summarizeCouchbaseError } from "../lib/classifyCouchbaseError";
import { logger } from "../utils/logger";
import { couchbaseToolAnnotations } from "./tool-classification";

// SIO-1823: diagnostics() reports endpoint state as a NUMBER
// (couchbase/dist/diagnosticstypes.d.ts EndpointState). Live output was
// `{"state": 2, "last_activity_us": 0, "remote": "...", ...}` -- an agent reading "2"
// cannot tell connected from disconnecting, and 0 means DISCONNECTED here while 0 means
// OK in a ping report (PingState). Decoding to a name removes that trap; the numeric
// value is kept alongside so nothing is lost.
const ENDPOINT_STATE_NAMES: Record<number, string> = {
	0: "disconnected",
	1: "connecting",
	2: "connected",
	3: "disconnecting",
};

type DiagnosticsEndpoint = Record<string, unknown> & { state?: unknown; last_activity_us?: unknown };

export function decodeDiagnosticsReport(raw: unknown): unknown {
	const report = raw as { services?: Record<string, DiagnosticsEndpoint[]> } | undefined;
	if (!report?.services || typeof report.services !== "object") return raw;

	const services: Record<string, Array<Record<string, unknown>>> = {};
	for (const [serviceType, endpoints] of Object.entries(report.services)) {
		services[serviceType] = Array.isArray(endpoints)
			? endpoints.map((endpoint) => {
					const decoded: Record<string, unknown> = { ...endpoint };
					if (typeof endpoint.state === "number") {
						decoded.stateName = ENDPOINT_STATE_NAMES[endpoint.state] ?? "unknown";
					}
					// last_activity_us is microseconds since the endpoint was last used. It is 0
					// on a freshly opened connection, which is not "idle forever" -- report the
					// derived value only when it is meaningful.
					if (typeof endpoint.last_activity_us === "number" && endpoint.last_activity_us > 0) {
						decoded.lastActivityMs = Math.round(endpoint.last_activity_us / 1000);
					}
					return decoded;
				})
			: endpoints;
	}
	return { ...report, services };
}

// Exported for unit testing.
export const getClusterDiagnosticsReport = async (bucket: Bucket) => {
	try {
		// diagnostics() reads the SDK's CACHED connection state and performs no network I/O,
		// which is the point: it answers "was this connection already broken, and for how
		// long" during an incident, where capella_get_cluster_health's active ping would
		// instead re-establish a connection and report it healthy.
		const report = await bucket.cluster.diagnostics();
		return {
			content: [{ type: "text" as const, text: JSON.stringify(decodeDiagnosticsReport(report), null, 2) }],
			isError: false,
		};
	} catch (error) {
		logger.error({ error: summarizeCouchbaseError(error) }, "Failed to get cluster diagnostics report");
		const message = error instanceof Error ? error.message : String(error);
		const kind = classifyCouchbaseError(error);
		const envelope = buildToolErrorEnvelope({ kind, message: `Failed to get cluster diagnostics report: ${message}` });
		return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true };
	}
};

export default (server: McpServer, bucket: Bucket) => {
	server.registerTool(
		"capella_get_cluster_diagnostics_report",
		{
			description:
				"Get the SDK's cached connection diagnostics: which endpoints exist per service, their connection state, and how long since each was last used. Performs NO network I/O -- unlike capella_get_cluster_health, it reports whether connections were already broken rather than probing them now.",
			inputSchema: {},
			annotations: couchbaseToolAnnotations("capella_get_cluster_diagnostics_report"),
		},
		async () => {
			logger.info("Getting cluster diagnostics report");
			return getClusterDiagnosticsReport(bucket);
		},
	);
};
