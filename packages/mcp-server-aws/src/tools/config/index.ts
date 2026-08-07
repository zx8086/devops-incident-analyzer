// src/tools/config/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { AWS_READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import {
	type DescribeConfigRulesParams,
	describeConfigRules,
	describeConfigRulesSchema,
} from "./describe-config-rules.ts";
import {
	type GetDiscoveredResourceCountsParams,
	getDiscoveredResourceCounts,
	getDiscoveredResourceCountsSchema,
} from "./get-discovered-resource-counts.ts";
import {
	type ListDiscoveredResourcesParams,
	listDiscoveredResources,
	listDiscoveredResourcesSchema,
} from "./list-discovered-resources.ts";

export function registerConfigTools(server: McpServer, config: AwsConfig): void {
	const configRules = describeConfigRules(config);
	server.registerTool(
		"aws_config_describe_config_rules",
		{
			description: "Describe AWS Config rules with compliance state, source, and scope.",
			inputSchema: withEstate(config, describeConfigRulesSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await configRules(params as DescribeConfigRulesParams)),
	);

	const discoveredResources = listDiscoveredResources(config);
	server.registerTool(
		"aws_config_list_discovered_resources",
		{
			description: "List resources of a given type discovered by AWS Config (e.g. AWS::EC2::Instance).",
			inputSchema: withEstate(config, listDiscoveredResourcesSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await discoveredResources(params as ListDiscoveredResourcesParams)),
	);

	const resourceCounts = getDiscoveredResourceCounts(config);
	server.registerTool(
		"aws_config_get_discovered_resource_counts",
		{
			description:
				"Get per-resource-type counts across the whole account in one call (no resourceType needed). Use to confirm an estate is alive and characterize a governance/landing-zone account when workload probes return empty.",
			inputSchema: withEstate(config, getDiscoveredResourceCountsSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await resourceCounts(params as GetDiscoveredResourceCountsParams)),
	);
}
