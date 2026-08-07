// src/tools/tags/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { AWS_READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type GetResourcesParams, getResources, getResourcesSchema } from "./get-resources.ts";

export function registerTagsTools(server: McpServer, config: AwsConfig): void {
	const resources = getResources(config);
	server.registerTool(
		"aws_resourcegroupstagging_get_resources",
		{
			description:
				"Get resources across all AWS services filtered by tags. Useful for finding all resources with a given team or environment tag.",
			inputSchema: withEstate(config, getResourcesSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await resources(params as GetResourcesParams)),
	);
}
