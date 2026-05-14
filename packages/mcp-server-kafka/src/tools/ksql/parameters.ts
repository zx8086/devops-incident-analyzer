// src/tools/ksql/parameters.ts
import { z } from "zod";

export const KsqlGetServerInfoParams = z.object({});

// SIO-742: no-parameter health probes.
export const KsqlHealthCheckParams = z.object({});

export const KsqlClusterStatusParams = z.object({});

export const KsqlListStreamsParams = z.object({});

export const KsqlListTablesParams = z.object({});

export const KsqlListQueriesParams = z.object({});

export const KsqlDescribeParams = z.object({
	sourceName: z.string().min(1).describe("Name of the stream or table to describe"),
});

export const KsqlRunQueryParams = z.object({
	ksql: z
		.string()
		.min(1)
		.describe(
			"ksqlDB query to execute. For pull queries use SELECT...WHERE on key columns. For push queries include a LIMIT clause.",
		),
	properties: z
		.record(z.string(), z.string())
		.optional()
		.describe("Optional ksqlDB stream properties (e.g., auto.offset.reset: 'earliest')"),
});

export const KsqlExecuteStatementParams = z.object({
	ksql: z
		.string()
		.min(1)
		.describe("ksqlDB DDL/DML statement (CREATE STREAM, CREATE TABLE, DROP, INSERT INTO, TERMINATE, etc.)"),
	properties: z.record(z.string(), z.string()).optional().describe("Optional ksqlDB stream properties"),
});
