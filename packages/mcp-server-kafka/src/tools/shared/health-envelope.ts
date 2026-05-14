// src/tools/shared/health-envelope.ts
//
// SIO-742: shared envelope shape for the five Confluent component health-check
// tools (restproxy/ksql/connect/schema_registry + ksql_cluster_status). All
// health-check tools return this normalized shape so the LLM sub-agent can
// classify reachability uniformly without parsing per-service error formats.

import { KafkaToolError } from "../../lib/errors.ts";

export type HealthStatus = "up" | "down" | "unreachable";

export interface HealthEnvelope {
	status: HealthStatus;
	service: string;
	endpoint: string;
	hostname?: string;
	latencyMs: number;
	details?: Record<string, unknown>;
	error?: {
		message: string;
		statusCode?: number;
		upstreamContentType?: string;
	};
}

// Run a probe function, time it, and classify the result into the envelope.
// On 5xx upstream (KafkaToolError with a statusCode) -> "down".
// On network/timeout/non-HTTP error -> "unreachable".
// On success -> "up", with the optional details payload from the probe.
//
// service: human label ("REST Proxy", "ksqlDB", "Kafka Connect", "Schema Registry")
// endpoint: the upstream URL or path being probed (informational only)
export async function runHealthProbe(
	service: string,
	endpoint: string,
	probe: () => Promise<Record<string, unknown> | undefined>,
): Promise<HealthEnvelope> {
	const start = performance.now();
	try {
		const details = await probe();
		const latencyMs = Math.round(performance.now() - start);
		return {
			status: "up",
			service,
			endpoint,
			latencyMs,
			...(details ? { details } : {}),
		};
	} catch (error) {
		const latencyMs = Math.round(performance.now() - start);
		return classifyError(error, service, endpoint, latencyMs);
	}
}

function classifyError(error: unknown, service: string, endpoint: string, latencyMs: number): HealthEnvelope {
	if (error instanceof KafkaToolError) {
		const statusCode = error.statusCode;
		// A real HTTP status (any 4xx/5xx) means we reached the service and it
		// returned an error response. Treat as "down" -- the agent can still see
		// the structured statusCode + hostname for correlation.
		if (statusCode !== undefined) {
			return {
				status: "down",
				service,
				endpoint,
				hostname: error.hostname,
				latencyMs,
				error: {
					message: error.message,
					statusCode,
					...(error.upstreamContentType ? { upstreamContentType: error.upstreamContentType } : {}),
				},
			};
		}
		// No statusCode = we never got an HTTP response (DNS, refused, timeout)
		return {
			status: "unreachable",
			service,
			endpoint,
			hostname: error.hostname,
			latencyMs,
			error: { message: error.message },
		};
	}
	const message = error instanceof Error ? error.message : String(error);
	return {
		status: "unreachable",
		service,
		endpoint,
		latencyMs,
		error: { message },
	};
}
