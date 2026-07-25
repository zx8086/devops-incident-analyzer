// src/tools/elbv2/describe-target-groups.ts
import { DescribeTargetGroupsCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getElbv2Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const describeTargetGroupsSchema = z.object({
	loadBalancerArn: z.string().optional().describe("Filter to target groups attached to this load balancer ARN"),
	targetGroupArns: z.array(z.string()).optional().describe("Specific target group ARNs to describe"),
	names: z.array(z.string()).optional().describe("Specific target group names to describe"),
	pageSize: z.number().int().min(1).max(400).optional().describe("Max results per page (1-400). Alias: limit."),
	marker: z.string().optional().describe("Pagination marker from a previous response's NextMarker. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to PageSize/Marker below; SDK param wins).
	limit: z.number().int().min(1).max(400).optional().describe("Canonical page-size alias (-> PageSize)."),
	cursor: z.string().optional().describe("Canonical pagination-token alias (-> Marker). Pass _truncated.cursor here."),
});

export type DescribeTargetGroupsParams = WithEstate<z.infer<typeof describeTargetGroupsSchema>>;

export function describeTargetGroups(config: AwsConfig) {
	return wrapListTool({
		name: "aws_elbv2_describe_target_groups",
		listField: "TargetGroups",
		fn: async (params: DescribeTargetGroupsParams) => {
			const client = getElbv2Client(config, params.estate);
			return client.send(
				new DescribeTargetGroupsCommand({
					LoadBalancerArn: params.loadBalancerArn,
					TargetGroupArns: params.targetGroupArns,
					Names: params.names,
					PageSize: preferSdkParam(params.pageSize, params.limit),
					Marker: preferSdkParam(params.marker, params.cursor),
				}),
			);
		},
	});
}
