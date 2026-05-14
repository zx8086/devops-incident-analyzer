// src/tools/ksql/operations.ts

import type { AppConfig } from "../../config/schemas.ts";
import type { KsqlService } from "../../services/ksql-service.ts";
import { type HealthEnvelope, runHealthProbe } from "../shared/health-envelope.ts";

export async function getServerInfo(service: KsqlService) {
	return service.getServerInfo();
}

// SIO-742: probe /healthcheck and wrap into the standard envelope. Returns
// "up" + the upstream isHealthy boolean as details, "down" on HTTP 5xx, and
// "unreachable" on network failure.
export async function healthCheck(service: KsqlService, config: AppConfig): Promise<HealthEnvelope> {
	const endpoint = `${config.ksql.endpoint.replace(/\/$/, "")}/healthcheck`;
	return runHealthProbe("ksqlDB", endpoint, async () => {
		const result = await service.getHealthcheck();
		return { isHealthy: result.isHealthy, ...(result.details ? { components: result.details } : {}) };
	});
}

// SIO-742: probe /clusterStatus and summarise per-host liveness. The summary
// fields (aliveHosts/totalHosts) save the LLM from parsing the raw map and
// give correlation rules a flat shape to trigger on.
export async function clusterStatus(service: KsqlService, config: AppConfig): Promise<HealthEnvelope> {
	const endpoint = `${config.ksql.endpoint.replace(/\/$/, "")}/clusterStatus`;
	return runHealthProbe("ksqlDB", endpoint, async () => {
		const result = await service.getClusterStatus();
		const hosts = Object.entries(result.clusterStatus ?? {});
		const aliveHosts = hosts.filter(([, info]) => info.hostAlive).length;
		const totalHosts = hosts.length;
		return {
			aliveHosts,
			totalHosts,
			degraded: totalHosts > 0 && aliveHosts < totalHosts,
			clusterStatus: result.clusterStatus,
		};
	});
}

export async function listStreams(service: KsqlService) {
	const streams = await service.listStreams();
	return { streams, count: streams.length };
}

export async function listTables(service: KsqlService) {
	const tables = await service.listTables();
	return { tables, count: tables.length };
}

export async function listQueries(service: KsqlService) {
	const queries = await service.listQueries();
	return { queries, count: queries.length };
}

export async function describe(service: KsqlService, params: { sourceName: string }) {
	return service.describe(params.sourceName);
}

export async function runQuery(service: KsqlService, params: { ksql: string; properties?: Record<string, string> }) {
	return service.runQuery(params.ksql, params.properties);
}

export async function executeStatement(
	service: KsqlService,
	params: { ksql: string; properties?: Record<string, string> },
) {
	return service.executeStatement(params.ksql, params.properties);
}
