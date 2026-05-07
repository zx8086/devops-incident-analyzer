// src/tools/connect/prompts.ts

export const CONNECT_GET_CLUSTER_INFO_DESCRIPTION = `Get Kafka Connect cluster information including version, commit, and the Kafka cluster ID it is attached to. Use this to verify Connect cluster connectivity and version. Requires CONNECT_ENABLED=true.`;

export const CONNECT_LIST_CONNECTORS_DESCRIPTION = `List all Kafka Connect connectors with embedded status (state per connector + per task) and configuration info. Use this when many connect-* consumer groups are simultaneously EMPTY to determine whether the Connect cluster is unhealthy or whether individual connectors are stopped/failed. Requires CONNECT_ENABLED=true.`;

export const CONNECT_GET_CONNECTOR_STATUS_DESCRIPTION = `Get the runtime status of a single Kafka Connect connector including its state (RUNNING/PAUSED/FAILED/UNASSIGNED), worker assignment, and the state of each task. Use this to investigate a specific connector's health, especially when a connect-<name> consumer group is EMPTY. Requires CONNECT_ENABLED=true.`;

export const CONNECT_GET_CONNECTOR_TASK_STATUS_DESCRIPTION = `Get the status of a specific task within a Kafka Connect connector, including task state, worker assignment, and any failure trace (stack trace if FAILED). Use this to drill into a specific failing task. Requires CONNECT_ENABLED=true.`;
