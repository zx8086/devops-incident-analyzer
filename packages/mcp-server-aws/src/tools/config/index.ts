// src/tools/config/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
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
	server.tool(
		"aws_config_describe_config_rules",
		"Describe AWS Config rules with compliance state, source, and scope.",
		withEstate(config, describeConfigRulesSchema.shape),
		async (params) => toMcp(await configRules(params as DescribeConfigRulesParams)),
	);

	const discoveredResources = listDiscoveredResources(config);
	server.tool(
		"aws_config_list_discovered_resources",
		"List resources of a given type discovered by AWS Config (e.g. AWS::EC2::Instance).",
		withEstate(config, listDiscoveredResourcesSchema.shape),
		async (params) => toMcp(await discoveredResources(params as ListDiscoveredResourcesParams)),
	);

	const resourceCounts = getDiscoveredResourceCounts(config);
	server.tool(
		"aws_config_get_discovered_resource_counts",
		"Get per-resource-type counts across the whole account in one call (no resourceType needed). Use to confirm an estate is alive and characterize a governance/landing-zone account when workload probes return empty.",
		withEstate(config, getDiscoveredResourceCountsSchema.shape),
		async (params) => toMcp(await resourceCounts(params as GetDiscoveredResourceCountsParams)),
	);
}
