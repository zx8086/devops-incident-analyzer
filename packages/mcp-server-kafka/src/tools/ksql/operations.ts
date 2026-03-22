// src/tools/ksql/operations.ts

import type { KsqlService } from "../../services/ksql-service.ts";

export async function getServerInfo(service: KsqlService) {
  return service.getServerInfo();
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

export async function runQuery(
  service: KsqlService,
  params: { ksql: string; properties?: Record<string, string> },
) {
  return service.runQuery(params.ksql, params.properties);
}

export async function executeStatement(
  service: KsqlService,
  params: { ksql: string; properties?: Record<string, string> },
) {
  return service.executeStatement(params.ksql, params.properties);
}
