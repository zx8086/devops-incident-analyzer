// src/tools/connect/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "../../config/index.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { ConnectService } from "../../services/connect-service.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations.ts";
import * as params from "./parameters.ts";
import * as prompts from "./prompts.ts";

export function registerConnectTools(server: McpServer, service: ConnectService): void {
	const config = getConfig();

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
}
