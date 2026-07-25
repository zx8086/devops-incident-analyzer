// src/tools/elbv2/describe-target-health.ts
import {
	DescribeTargetHealthCommand,
	type DescribeTargetHealthOutput,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getElbv2Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapListTool } from "../wrap.ts";

// SIO-1205: DescribeTargetHealth has NO pagination (no Marker/PageSize on the API),
// so this schema deliberately omits the limit/cursor aliases -- byte-truncation of an
// oversized page correctly reports Case B.
export const describeTargetHealthSchema = z.object({
	targetGroupArn: z.string().min(1).describe("Target group ARN to check health for (one call per target group)"),
	targets: z
		.array(
			z.object({
				Id: z.string().describe("Target id: an instance id (i-...) or an IP address"),
				Port: z.number().int().optional(),
				AvailabilityZone: z.string().optional(),
			}),
		)
		.optional()
		.describe("Optional specific targets to check (omit to check all registered targets)"),
});

export type DescribeTargetHealthParams = WithEstate<z.infer<typeof describeTargetHealthSchema>>;

export function summarizeTargetHealth(response: DescribeTargetHealthOutput) {
	return (response.TargetHealthDescriptions ?? []).map((d) => ({
		Id: d.Target?.Id,
		Port: d.Target?.Port,
		State: d.TargetHealth?.State,
	}));
}

export function describeTargetHealth(config: AwsConfig) {
	return wrapListTool({
		name: "aws_elbv2_describe_target_health",
		listField: "TargetHealthDescriptions",
		fn: async (params: DescribeTargetHealthParams) => {
			const client = getElbv2Client(config, params.estate);
			const response = await client.send(
				new DescribeTargetHealthCommand({
					TargetGroupArn: params.targetGroupArn,
					Targets: params.targets,
				}),
			);
			// SIO-1205: the SDK response has no target group ARN and downstream consumers only
			// see { toolName, rawJson } with no request args -- echo the requested ARN so the
			// network-map builder can attribute health rows to their target group.
			return { TargetGroupArn: params.targetGroupArn, ...response };
		},
		summarize: summarizeTargetHealth,
	});
}
