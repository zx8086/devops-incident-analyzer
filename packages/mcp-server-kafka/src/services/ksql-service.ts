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

	async listStreams(): Promise<KsqlStreamOrTable[]> {
		const result = await this.executeStatement("LIST STREAMS EXTENDED;");
		return this.extractSourceList(result, "streams");
	}

	async listTables(): Promise<KsqlStreamOrTable[]> {
		const result = await this.executeStatement("LIST TABLES EXTENDED;");
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

	async runQuery(ksql: string, properties?: Record<string, string>): Promise<unknown[]> {
		const body: Record<string, unknown> = {
			ksql: ksql.trim().endsWith(";") ? ksql : `${ksql};`,
			streamsProperties: properties ?? {},
		};
		const response = await this.request("/query", { method: "POST", body: JSON.stringify(body) });
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
