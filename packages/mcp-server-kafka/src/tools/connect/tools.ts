// src/tools/connect/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schemas.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { ConnectService } from "../../services/connect-service.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations.ts";
import * as params from "./parameters.ts";
import * as prompts from "./prompts.ts";

export function registerConnectTools(server: McpServer, service: ConnectService, config: AppConfig): void {
	// SIO-742: reachability probe -- always registered.
	server.tool(
		"connect_health_check",
		prompts.CONNECT_HEALTH_CHECK_DESCRIPTION,
		params.ConnectHealthCheckParams.shape,
		wrapHandler("connect_health_check", config, async () => {
			const result = await ops.healthCheck(service, config);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"connect_get_cluster_info",
		prompts.CONNECT_GET_CLUSTER_INFO_DESCRIPTION,
		params.ConnectGetClusterInfoParams.shape,
		wrapHandler("connect_get_cluster_info", config, async () => {
			const result = await ops.getClusterInfo(service);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"connect_list_connectors",
		prompts.CONNECT_LIST_CONNECTORS_DESCRIPTION,
		params.ConnectListConnectorsParams.shape,
		wrapHandler("connect_list_connectors", config, async () => {
			const result = await ops.listConnectors(service);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"connect_get_connector_status",
		prompts.CONNECT_GET_CONNECTOR_STATUS_DESCRIPTION,
		params.ConnectGetConnectorStatusParams.shape,
		wrapHandler("connect_get_connector_status", config, async (args) => {
			const result = await ops.getConnectorStatus(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"connect_get_connector_task_status",
		prompts.CONNECT_GET_CONNECTOR_TASK_STATUS_DESCRIPTION,
		params.ConnectGetConnectorTaskStatusParams.shape,
		wrapHandler("connect_get_connector_task_status", config, async (args) => {
			const result = await ops.getConnectorTaskStatus(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	if (config.kafka.allowWrites) {
		server.tool(
			"connect_pause_connector",
			prompts.CONNECT_PAUSE_CONNECTOR_DESCRIPTION,
			params.ConnectPauseConnectorParams.shape,
			wrapHandler("connect_pause_connector", config, async (args) => {
				const result = await ops.pauseConnector(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.tool(
			"connect_resume_connector",
			prompts.CONNECT_RESUME_CONNECTOR_DESCRIPTION,
			params.ConnectResumeConnectorParams.shape,
			wrapHandler("connect_resume_connector", config, async (args) => {
				const result = await ops.resumeConnector(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.tool(
			"connect_restart_connector",
			prompts.CONNECT_RESTART_CONNECTOR_DESCRIPTION,
			params.ConnectRestartConnectorParams.shape,
			wrapHandler("connect_restart_connector", config, async (args) => {
				const result = await ops.restartConnector(service, args);
				return ResponseBuilder.success(result);
			}),
		);
	}

	if (config.kafka.allowDestructive) {
		server.tool(
			"connect_restart_connector_task",
			prompts.CONNECT_RESTART_CONNECTOR_TASK_DESCRIPTION,
			params.ConnectRestartConnectorTaskParams.shape,
			wrapHandler("connect_restart_connector_task", config, async (args) => {
				const result = await ops.restartConnectorTask(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.tool(
			"connect_delete_connector",
			prompts.CONNECT_DELETE_CONNECTOR_DESCRIPTION,
			params.ConnectDeleteConnectorParams.shape,
			wrapHandler("connect_delete_connector", config, async (args) => {
				const result = await ops.deleteConnector(service, args);
				return ResponseBuilder.success(result);
			}),
		);
	}
}
