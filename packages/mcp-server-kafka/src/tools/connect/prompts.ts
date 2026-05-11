// src/tools/connect/prompts.ts

export const CONNECT_GET_CLUSTER_INFO_DESCRIPTION = `[READ] Get Kafka Connect cluster information including version, commit, and the Kafka cluster ID it is attached to. Use this to verify Connect cluster connectivity and version. Requires CONNECT_ENABLED=true.`;

export const CONNECT_LIST_CONNECTORS_DESCRIPTION = `[READ] List all Kafka Connect connectors with embedded status (state per connector + per task) and configuration info. Use this when many connect-* consumer groups are simultaneously EMPTY to determine whether the Connect cluster is unhealthy or whether individual connectors are stopped/failed. Requires CONNECT_ENABLED=true.`;

export const CONNECT_GET_CONNECTOR_STATUS_DESCRIPTION = `[READ] Get the runtime status of a single Kafka Connect connector including its state (RUNNING/PAUSED/FAILED/UNASSIGNED), worker assignment, and the state of each task. Use this to investigate a specific connector's health, especially when a connect-<name> consumer group is EMPTY. Requires CONNECT_ENABLED=true.`;

export const CONNECT_GET_CONNECTOR_TASK_STATUS_DESCRIPTION = `[READ] Get the status of a specific task within a Kafka Connect connector, including task state, worker assignment, and any failure trace (stack trace if FAILED). Use this to drill into a specific failing task. Requires CONNECT_ENABLED=true.`;

export const CONNECT_PAUSE_CONNECTOR_DESCRIPTION =
	"[WRITE] Pause a running connector. Stops new task work; tasks already running finish in-flight. Reversible via connect_resume_connector.";

export const CONNECT_RESUME_CONNECTOR_DESCRIPTION = "[WRITE] Resume a paused connector.";

export const CONNECT_RESTART_CONNECTOR_DESCRIPTION =
	"[WRITE] Restart a connector and optionally its tasks. Use this when connect_get_connector_status reports FAILED state. Pass includeTasks=true to restart tasks too; pass onlyFailed=true to limit to FAILED tasks.";

export const CONNECT_RESTART_CONNECTOR_TASK_DESCRIPTION =
	"[DESTRUCTIVE] Restart a single task on a connector. Drops in-flight messages on that task — destructive at the message level. Prefer connect_restart_connector with onlyFailed=true unless targeting one specific task.";

export const CONNECT_DELETE_CONNECTOR_DESCRIPTION =
	"[DESTRUCTIVE] Permanently delete a connector. Irreversible — config and offsets are gone unless externally backed up.";
