// src/tools/tags/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { toMcp } from "../wrap.ts";
import { getResources, getResourcesSchema } from "./get-resources.ts";

export function registerTagsTools(server: McpServer, config: AwsConfig): void {
	const resources = getResources(config);
	server.tool(
		"aws_resourcegroupstagging_get_resources",
		"Get resources across all AWS services filtered by tags. Useful for finding all resources with a given team or environment tag.",
		getResourcesSchema.shape,
		async (params) => toMcp(await resources(params)),
	);
}
