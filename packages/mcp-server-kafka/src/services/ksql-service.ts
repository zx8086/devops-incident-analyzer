// src/services/ksql-service.ts

import type { AppConfig } from "../config/schemas.ts";

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

  async getServerInfo(): Promise<KsqlServerInfo> {
    const response = await fetch(`${this.baseUrl}/info`, {
      method: "GET",
      headers: this.headers,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Unknown error");
      throw new Error(`ksqlDB error ${response.status}: ${errorBody}`);
    }

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
    const describeResponse = result.find(
      (r: Record<string, unknown>) => r["@type"] === "sourceDescription",
    );
    return (describeResponse?.sourceDescription as Record<string, unknown>) ?? {};
  }

  async runQuery(ksql: string, properties?: Record<string, string>): Promise<unknown[]> {
    const body: Record<string, unknown> = {
      ksql: ksql.trim().endsWith(";") ? ksql : `${ksql};`,
      streamsProperties: properties ?? {},
    };

    const response = await fetch(`${this.baseUrl}/query`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Unknown error");
      throw new Error(`ksqlDB query error ${response.status}: ${errorBody}`);
    }

    return (await response.json()) as unknown[];
  }

  async executeStatement(
    ksql: string,
    properties?: Record<string, string>,
  ): Promise<Array<Record<string, unknown>>> {
    const body: Record<string, unknown> = {
      ksql: ksql.trim().endsWith(";") ? ksql : `${ksql};`,
      streamsProperties: properties ?? {},
    };

    const response = await fetch(`${this.baseUrl}/ksql`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Unknown error");
      throw new Error(`ksqlDB statement error ${response.status}: ${errorBody}`);
    }

    return (await response.json()) as Array<Record<string, unknown>>;
  }

  private extractSourceList(
    result: Array<Record<string, unknown>>,
    key: string,
  ): KsqlStreamOrTable[] {
    const sourcesResponse = result.find(
      (r) => r["@type"] === `${key}` || r["@type"] === `${key}_list` || Array.isArray(r[key]),
    );
    return (sourcesResponse?.[key] as KsqlStreamOrTable[]) ?? [];
  }
}
