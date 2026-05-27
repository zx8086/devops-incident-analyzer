// src/tools/cloudformation/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import {
	type DescribeStackEventsParams,
	describeStackEvents,
	describeStackEventsSchema,
} from "./describe-stack-events.ts";
import { type DescribeStacksParams, describeStacks, describeStacksSchema } from "./describe-stacks.ts";
import { type ListStacksParams, listStacks, listStacksSchema } from "./list-stacks.ts";

export function registerCloudFormationTools(server: McpServer, config: AwsConfig): void {
	const stacks = listStacks(config);
	server.tool(
		"aws_cloudformation_list_stacks",
		"List CloudFormation stack summaries, optionally filtered by stack status.",
		withEstate(config, listStacksSchema.shape),
		async (params) => toMcp(await stacks(params as ListStacksParams)),
	);

	const stackDetails = describeStacks(config);
	server.tool(
		"aws_cloudformation_describe_stacks",
		"Describe one or all CloudFormation stacks with status, parameters, outputs, and capabilities.",
		withEstate(config, describeStacksSchema.shape),
		async (params) => toMcp(await stackDetails(params as DescribeStacksParams)),
	);

	const stackEvents = describeStackEvents(config);
	server.tool(
		"aws_cloudformation_describe_stack_events",
		"List events for a CloudFormation stack. Useful for diagnosing deployment failures.",
		withEstate(config, describeStackEventsSchema.shape),
		async (params) => toMcp(await stackEvents(params as DescribeStackEventsParams)),
	);
}
