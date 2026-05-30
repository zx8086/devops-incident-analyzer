// src/tools/cloudtrail/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type DescribeTrailsParams, describeTrails, describeTrailsSchema } from "./describe-trails.ts";
import { type GetTrailStatusParams, getTrailStatus, getTrailStatusSchema } from "./get-trail-status.ts";
import { type ListTrailsParams, listTrails, listTrailsSchema } from "./list-trails.ts";

export function registerCloudTrailTools(server: McpServer, config: AwsConfig): void {
	const trails = describeTrails(config);
	server.tool(
		"aws_cloudtrail_describe_trails",
		"Describe CloudTrail trails with config: multi-region, S3 bucket target, KMS key, log-file validation. Use to audit governance/baseline accounts.",
		withEstate(config, describeTrailsSchema.shape),
		async (params) => toMcp(await trails(params as DescribeTrailsParams)),
	);

	const trailStatus = getTrailStatus(config);
	server.tool(
		"aws_cloudtrail_get_trail_status",
		"Get a single trail's logging status: IsLogging, LatestDeliveryError, LatestDeliveryTime. Use to confirm a trail is actually delivering events (was logging disabled or is delivery broken).",
		withEstate(config, getTrailStatusSchema.shape),
		async (params) => toMcp(await trailStatus(params as GetTrailStatusParams)),
	);

	const trailList = listTrails(config);
	server.tool(
		"aws_cloudtrail_list_trails",
		"List trail summaries (name, ARN, home region) across regions. Use for cross-region trail enumeration before describing a specific trail.",
		withEstate(config, listTrailsSchema.shape),
		async (params) => toMcp(await trailList(params as ListTrailsParams)),
	);
}
