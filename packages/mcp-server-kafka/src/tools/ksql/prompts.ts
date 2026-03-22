// src/tools/ksql/prompts.ts

export const KSQL_GET_SERVER_INFO_DESCRIPTION = `Get ksqlDB server information including version, Kafka cluster ID, service ID, and server status. Use this to verify ksqlDB connectivity and version. Requires KSQL_ENABLED=true.`;

export const KSQL_LIST_STREAMS_DESCRIPTION = `List all ksqlDB streams with their backing topics, key/value formats, and windowing configuration. Use this to discover available streams for querying. Requires KSQL_ENABLED=true.`;

export const KSQL_LIST_TABLES_DESCRIPTION = `List all ksqlDB materialized tables with their backing topics and formats. Use this to discover available tables for pull queries. Requires KSQL_ENABLED=true.`;

export const KSQL_LIST_QUERIES_DESCRIPTION = `List all running ksqlDB queries including persistent queries (streams/tables) and their state. Shows query ID, SQL statement, sink topics, and query type. Requires KSQL_ENABLED=true.`;

export const KSQL_DESCRIBE_DESCRIPTION = `Describe a ksqlDB stream or table including its schema (column names, types), backing Kafka topic, key/value formats, and query statistics. Requires KSQL_ENABLED=true.`;

export const KSQL_RUN_QUERY_DESCRIPTION = `Execute a ksqlDB pull query (SELECT with WHERE clause on key) or a push query with a LIMIT clause. Returns query results as rows. For pull queries, results are returned immediately. For push queries, set a reasonable LIMIT to avoid unbounded results. READ OPERATION: Requires KSQL_ENABLED=true.`;

export const KSQL_EXECUTE_STATEMENT_DESCRIPTION = `Execute a ksqlDB DDL or DML statement such as CREATE STREAM, CREATE TABLE, DROP STREAM, DROP TABLE, INSERT INTO, or TERMINATE query. Use this to manage ksqlDB objects and data pipelines. WRITE OPERATION: Requires KAFKA_ALLOW_WRITES=true and KSQL_ENABLED=true.`;
