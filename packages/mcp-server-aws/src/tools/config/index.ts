// src/tools/config/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { toMcp } from "../wrap.ts";
import { describeConfigRules, describeConfigRulesSchema } from "./describe-config-rules.ts";
import { listDiscoveredResources, listDiscoveredResourcesSchema } from "./list-discovered-resources.ts";

export function registerConfigTools(server: McpServer, config: AwsConfig): void {
	const configRules = describeConfigRules(config);
	server.tool(
		"aws_config_describe_config_rules",
		"Describe AWS Config rules with compliance state, source, and scope.",
		describeConfigRulesSchema.shape,
		async (params) => toMcp(await configRules(params)),
	);

	const discoveredResources = listDiscoveredResources(config);
	server.tool(
		"aws_config_list_discovered_resources",
		"List resources of a given type discovered by AWS Config (e.g. AWS::EC2::Instance).",
		listDiscoveredResourcesSchema.shape,
		async (params) => toMcp(await discoveredResources(params)),
	);
}
