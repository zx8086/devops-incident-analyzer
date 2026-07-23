// src/services/ksql-service.ts

import type { AppConfig } from "../config/schemas.ts";
import { fetchUpstream } from "../lib/upstream-fetch.ts";

export interface KsqlServerInfo {
	KsqlServerInfo: {
		version: string;
		kafkaClusterId: string;
		ksqlServiceId: string;
		serverStatus: string;
	};
}

// ksqlDB /healthcheck endpoint shape. isHealthy is the load-bearing field
// and reflects "this node is responsive". Sub-keys describe per-component
// readiness (metastore, Kafka connectivity, command runner).
export interface KsqlHealthcheck {
	isHealthy: boolean;
	details?: {
		metastore?: { isHealthy: boolean };
		kafka?: { isHealthy: boolean };
		commandRunner?: { isHealthy: boolean };
	};
}

// SIO-742: ksqlDB /clusterStatus surfaces per-host liveness in a 3-node cluster.
// hostAlive=false on any host means quorum is degraded; the agent infers
// "2 of 3 workers UNRESPONSIVE" from this map without needing to enumerate
// queries first.
export interface KsqlClusterStatus {
	clusterStatus: Record<
		string,
		{
			hostAlive: boolean;
			lastStatusUpdateMs?: number;
			activeStandbyPerQuery?: Record<string, unknown>;
			hostStoreLags?: Record<string, unknown>;
		}
	>;
}

export interface KsqlStreamOrTable {
	name: string;
	topic: string;
	keyFormat: string;
	valueFormat: string;
	isWindowed: boolean;
	type: string;
}

export interface KsqlQueryResult {
	header?: { queryId: string; schema: string };
	row?: { columns: unknown[] };
	finalMessage?: string;
}

export class KsqlService {
	private readonly baseUrl: string;
	private readonly headers: Record<string, string>;

	constructor(config: AppConfig) {
		this.baseUrl = config.ksql.endpoint.replace(/\/$/, "");
		this.headers = {
			"Content-Type": "application/vnd.ksql.v1+json",
			Accept: "application/vnd.ksql.v1+json",
		};

		if (config.ksql.apiKey && config.ksql.apiSecret) {
			this.headers.Authorization = `Basic ${btoa(`${config.ksql.apiKey}:${config.ksql.apiSecret}`)}`;
		}
	}

	async probeReachability(timeoutMs = 5000): Promise<void> {
		// SIO-725/729: see restproxy-service.probeReachability comment.
		await fetchUpstream(
			`${this.baseUrl}/info`,
			{ method: "GET", headers: this.headers, signal: AbortSignal.timeout(timeoutMs) },
			{ serviceLabel: "ksqlDB", baseUrl: this.baseUrl },
		);
	}

	async getServerInfo(): Promise<KsqlServerInfo> {
		const response = await this.request("/info", { method: "GET" });
		return (await response.json()) as KsqlServerInfo;
	}

	// SIO-742: GET /healthcheck. Distinct from /info: this is a deliberate
	// liveness probe that reports kafka + metastore + command-runner readiness.
	async getHealthcheck(): Promise<KsqlHealthcheck> {
		const response = await this.request("/healthcheck", { method: "GET" });
		return (await response.json()) as KsqlHealthcheck;
	}

	// SIO-742: GET /clusterStatus. Returns a map of host -> { hostAlive, ... }
	// across the ksqlDB cluster. Required to surface "N of M workers up"
	// directly instead of inferring from ksql_list_queries response shape.
	async getClusterStatus(): Promise<KsqlClusterStatus> {
		const response = await this.request("/clusterStatus", { method: "GET" });
		return (await response.json()) as KsqlClusterStatus;
	}

	// SIO-1188: MUST stay non-EXTENDED. `LIST STREAMS EXTENDED;` returns a
	// SourceDescriptionList (@type "sourceDescriptions", key sourceDescriptions)
	// which extractSourceList can never match, so the tool returned [] against
	// every cluster since inception (audit SIO-1186 found 0 streams vs ~30 live).
	// The plain statement returns @type "streams"/"tables" whose rows are exactly
	// KsqlStreamOrTable. Detail lives behind ksql_describe (DESCRIBE ... EXTENDED
	// uses the singular sourceDescription shape, which parses correctly).
	async listStreams(): Promise<KsqlStreamOrTable[]> {
		const result = await this.executeStatement("LIST STREAMS;");
		return this.extractSourceList(result, "streams");
	}

	async listTables(): Promise<KsqlStreamOrTable[]> {
		const result = await this.executeStatement("LIST TABLES;");
		return this.extractSourceList(result, "tables");
	}

	async listQueries(): Promise<
		Array<{
			queryString: string;
			sinks: string[];
			id: string;
			queryType: string;
			state: string;
		}>
	> {
		const result = await this.executeStatement("LIST QUERIES;");
		const queriesResponse = result.find((r: Record<string, unknown>) => r["@type"] === "queries");
		return (
			(queriesResponse?.queries as Array<{
				queryString: string;
				sinks: string[];
				id: string;
				queryType: string;
				state: string;
			}>) ?? []
		);
	}

	async describe(sourceName: string): Promise<Record<string, unknown>> {
		const result = await this.executeStatement(`DESCRIBE ${sourceName} EXTENDED;`);
		const describeResponse = result.find((r: Record<string, unknown>) => r["@type"] === "sourceDescription");
		return (describeResponse?.sourceDescription as Record<string, unknown>) ?? {};
	}

	// SIO-1191: ksql push queries default to auto.offset.reset=latest upstream, so
	// `EMIT CHANGES LIMIT n` waits for NEW events -- on a quiet stream the request
	// hangs into the SigV4 proxy's 30s per-attempt abort (which then RETRIES the
	// query) and surfaces as a platform-phrased -32000 (audit SIO-1186: 60s 502;
	// with earliest the same query returned in ~2s). Default earliest so bounded
	// queries complete on historical data; caller-supplied properties always win.
	// The 25s server-side signal stays under the proxy's 30s so timeouts return as
	// a classified tool error instead of a proxy -32000.
	static readonly RUN_QUERY_TIMEOUT_MS = 25_000;
	static readonly RUN_QUERY_DEFAULT_PROPERTIES: Record<string, string> = {
		"ksql.streams.auto.offset.reset": "earliest",
	};

	async runQuery(ksql: string, properties?: Record<string, string>): Promise<unknown[]> {
		const body: Record<string, unknown> = {
			ksql: ksql.trim().endsWith(";") ? ksql : `${ksql};`,
			streamsProperties: { ...KsqlService.RUN_QUERY_DEFAULT_PROPERTIES, ...(properties ?? {}) },
		};
		const response = await this.request("/query", {
			method: "POST",
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(KsqlService.RUN_QUERY_TIMEOUT_MS),
		});
		return (await response.json()) as unknown[];
	}

	async executeStatement(ksql: string, properties?: Record<string, string>): Promise<Array<Record<string, unknown>>> {
		const body: Record<string, unknown> = {
			ksql: ksql.trim().endsWith(";") ? ksql : `${ksql};`,
			streamsProperties: properties ?? {},
		};
		const response = await this.request("/ksql", { method: "POST", body: JSON.stringify(body) });
		return (await response.json()) as Array<Record<string, unknown>>;
	}

	// SIO-725/729: single fetch path for ksqlDB. All three former inline-fetch
	// sites (info, query, ksql) now route through fetchUpstream which captures
	// hostname / content-type / status on error and rejects non-JSON responses.
	private async request(path: string, init: RequestInit): Promise<Response> {
		return fetchUpstream(
			`${this.baseUrl}${path}`,
			{ ...init, headers: this.headers },
			{ serviceLabel: "ksqlDB", baseUrl: this.baseUrl },
		);
	}

	private extractSourceList(result: Array<Record<string, unknown>>, key: string): KsqlStreamOrTable[] {
		const sourcesResponse = result.find(
			(r) => r["@type"] === `${key}` || r["@type"] === `${key}_list` || Array.isArray(r[key]),
		);
		return (sourcesResponse?.[key] as KsqlStreamOrTable[]) ?? [];
	}
}
