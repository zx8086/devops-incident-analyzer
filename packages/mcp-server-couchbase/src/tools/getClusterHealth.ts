// src/tools/getClusterHealth.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { resolveBucket } from "../lib/resolveBucket";
import { logger } from "../utils/logger";

// SIO-1264: the SDK's `latency_us` field does NOT contain microseconds. It contains NANOSECONDS.
//
// couchbase/dist/diagnosticstypes.js:95 (identical in 4.6.1 and 4.7.0) builds the JSON ping report
// with `latency_us: svc.latency * 1000000`, where `svc.latency` is MILLISECONDS. Converting ms to
// us is a factor of 1_000, so the SDK is off by 1_000 and the field name is a lie.
//
// Verified against a live cluster rather than inferred from the type: a kv endpoint reported
// latency_us 15000000 while the measured TCP round trip to that same node was ~18 ms.
// 15000000/1e6 = 15 ms matches; 15000000/1e3 would be 15 SECONDS, for a ping that the enclosing
// 561 ms tools/call completed inside of. Every value in the payload is an exact multiple of 1e6,
// i.e. a millisecond-resolution source scaled by 1e6.
//
// This is what run 2445908e actually hit. The model took the field name at its word, divided by
// 1_000, and published "query-service ping latency 264,000-280,000 ms (vs. normal single-digit ms)
// ... KV latency 14,000-22,000 ms" -- rated Critical and made a Root Cause pillar. The true values
// were 264-280 ms and 14-22 ms: elevated under load, entirely unremarkable.
//
// So the raw field is not merely unlabelled, it is actively misleading, and it is the direct cause
// of the defect. We therefore REPLACE it rather than emitting it alongside a correct sibling --
// leaving `latency_us: 15000000` next to `latencyMs: 15` invites the model to "correct" the one
// that disagrees with the field name. `latencyNs` preserves full fidelity under an honest name.
// Safe to replace: no consumer of `latency_us` exists anywhere in the repo outside test mocks.
//
// Rounding to whole ms is deliberate -- sub-millisecond precision is noise in an incident report,
// and a bare integer is harder to misread than "0.264".
export function withLatencyMs(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return raw;
	const report = raw as { services?: Record<string, Array<Record<string, unknown>>> };
	if (!report.services || typeof report.services !== "object") return raw;
	const services: Record<string, Array<Record<string, unknown>>> = {};
	for (const [serviceType, entries] of Object.entries(report.services)) {
		services[serviceType] = Array.isArray(entries)
			? entries.map((entry) => {
					const ns = entry?.latency_us;
					// Number.isFinite, not `typeof === "number"`: NaN and +/-Infinity are numbers, and
					// Math.round leaves them intact, so JSON.stringify would serialise BOTH latencyMs
					// and latencyNs as null -- destroying the raw value instead of preserving it.
					// Leaving a malformed entry untouched keeps latency_us visible, which is strictly
					// more useful to an operator than two nulls (CodeRabbit, PR #508).
					if (typeof ns !== "number" || !Number.isFinite(ns)) return entry;
					const { latency_us: _dropped, ...rest } = entry;
					return { latencyMs: Math.round(ns / 1_000_000), latencyNs: ns, ...rest };
				})
			: entries;
	}
	return { ...report, services };
}

// SIO-1107: structured per-service health with latency (ported from the official
// Couchbase MCP server's get_cluster_health_and_services). With bucket_name the
// ping runs against that bucket's services; without it, against the cluster.
// capella_ping remains the cheap text-only liveness check.
export const getClusterHealthHandler = async (params: { bucket_name?: string }, bucket: Bucket) => {
	try {
		const target = params.bucket_name ? resolveBucket(bucket, params.bucket_name) : bucket.cluster;
		const pingResult = await target.ping();
		// PingResult has toJSON() in the SDK; fall back to the raw object for mocks.
		const raw =
			typeof (pingResult as { toJSON?: () => unknown }).toJSON === "function"
				? (pingResult as { toJSON: () => unknown }).toJSON()
				: pingResult;
		const payload = {
			scope: params.bucket_name ? `bucket:${params.bucket_name}` : "cluster",
			ping: withLatencyMs(raw),
		};
		return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error({ error: message, bucket: params.bucket_name }, "Cluster health ping failed");
		return {
			content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
			isError: true,
		};
	}
};

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_cluster_health",
		"Get cluster health and running services with per-service ping latency. Each service entry reports latencyMs (MILLISECONDS -- use this one) and latencyNs (nanoseconds, same value). Do not rescale them. Typical healthy values are single-digit to low-hundreds of ms for a remote cluster. Optionally scoped to a bucket.",
		{
			bucket_name: z.string().optional().describe("Optional bucket to ping instead of the cluster"),
		},
		async (params) => {
			logger.info({ bucket: params.bucket_name }, "Getting cluster health");
			return getClusterHealthHandler(params, bucket);
		},
	);
};
