// src/tools/ksql/prompts.ts

export const KSQL_GET_SERVER_INFO_DESCRIPTION = `[READ] Get ksqlDB server information including version, Kafka cluster ID, service ID, and server status. Use this to verify ksqlDB connectivity and version. Requires KSQL_ENABLED=true.`;

// SIO-742: first-iteration reachability probe -- use BEFORE ksql_list_queries
// when triaging cluster health. /healthcheck is a deliberate liveness endpoint
// that reports kafka + metastore + command-runner readiness, distinct from /info.
export const KSQL_HEALTH_CHECK_DESCRIPTION =
	"[READ] Probe ksqlDB /healthcheck endpoint. No parameters. Returns { status: 'up' | 'down' | 'unreachable', service, endpoint, latencyMs, hostname?, details?, error? }. Call this FIRST when the user asks whether ksqlDB is working, healthy, or up. Do NOT infer ksqlDB state from response shapes on ksql_list_queries.";

// SIO-742: per-host worker liveness. The aggregator previously inferred
// "N of M workers UNRESPONSIVE" from ksql_list_queries response shape; this
// surfaces the same information directly so the LLM doesn't have to derive it.
export const KSQL_CLUSTER_STATUS_DESCRIPTION =
	"[READ] Probe ksqlDB /clusterStatus endpoint to surface per-host worker liveness in a multi-node ksqlDB cluster. No parameters. Returns { status, service, endpoint, latencyMs, details: { clusterStatus: { <host>: { hostAlive, lastStatusUpdateMs, ... } } } }. Use this to directly answer 'how many ksqlDB workers are alive' without enumerating persistent queries.";

export const KSQL_LIST_STREAMS_DESCRIPTION = `[READ] List all ksqlDB streams with their backing topics, key/value formats, and windowing configuration. Use this to discover available streams for querying. Requires KSQL_ENABLED=true.`;

export const KSQL_LIST_TABLES_DESCRIPTION = `[READ] List all ksqlDB materialized tables with their backing topics and formats. Use this to discover available tables for pull queries. Requires KSQL_ENABLED=true.`;

export const KSQL_LIST_QUERIES_DESCRIPTION = `[READ] List all running ksqlDB queries including persistent queries (streams/tables) and their state. Shows query ID, SQL statement, sink topics, and query type. Requires KSQL_ENABLED=true.`;

export const KSQL_DESCRIBE_DESCRIPTION = `[READ] Describe a ksqlDB stream or table including its schema (column names, types), backing Kafka topic, key/value formats, and query statistics. Requires KSQL_ENABLED=true.`;

export const KSQL_RUN_QUERY_DESCRIPTION = `[READ] Execute a bounded ksqlDB query. ALWAYS include a LIMIT clause. Push queries (EMIT CHANGES) read from the EARLIEST offset by default (the server sets ksql.streams.auto.offset.reset=earliest) so LIMIT completes on historical data instead of hanging on a quiet stream; pass properties {"ksql.streams.auto.offset.reset": "latest"} only to tail NEW events. Copy-paste example: {"ksql": "SELECT * FROM S_MY_STREAM EMIT CHANGES LIMIT 5;"}. Pull queries against tables scan state stores -- prefer a WHERE clause on the key. Server-side timeout: 25s. READ OPERATION: Requires KSQL_ENABLED=true.`;

export const KSQL_EXECUTE_STATEMENT_DESCRIPTION = `[WRITE] Execute a ksqlDB DDL or DML statement such as CREATE STREAM, CREATE TABLE, DROP STREAM, DROP TABLE, INSERT INTO, or TERMINATE query. Use this to manage ksqlDB objects and data pipelines. WRITE OPERATION: Requires KAFKA_ALLOW_WRITES=true and KSQL_ENABLED=true.`;
