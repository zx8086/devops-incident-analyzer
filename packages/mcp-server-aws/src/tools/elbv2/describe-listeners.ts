// src/tools/elbv2/describe-listeners.ts
import { DescribeListenersCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getElbv2Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const describeListenersSchema = z.object({
	loadBalancerArn: z
		.string()
		.optional()
		.describe("Load balancer ARN whose listeners to describe (exactly one of this or listenerArns)"),
	listenerArns: z
		.array(z.string())
		.optional()
		.describe("Specific listener ARNs to describe (exactly one of this or loadBalancerArn)"),
	pageSize: z.number().int().min(1).max(400).optional().describe("Max results per page (1-400). Alias: limit."),
	marker: z.string().optional().describe("Pagination marker from a previous response's NextMarker. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to PageSize/Marker below; SDK param wins).
	limit: z.number().int().min(1).max(400).optional().describe("Canonical page-size alias (-> PageSize)."),
	cursor: z.string().optional().describe("Canonical pagination-token alias (-> Marker). Pass _truncated.cursor here."),
});

export type DescribeListenersParams = WithEstate<z.infer<typeof describeListenersSchema>>;

export function describeListeners(config: AwsConfig) {
	return wrapListTool({
		name: "aws_elbv2_describe_listeners",
		listField: "Listeners",
		fn: async (params: DescribeListenersParams) => {
			// SIO-1205: the API requires exactly one of loadBalancerArn / listenerArns. Enforced
			// here rather than via a schema-level .refine because registration passes only the
			// schema's .shape to server.tool, which drops object-level refinements. The AWS error
			// name routes mapAwsError to kind "bad-input" with this message surfaced verbatim.
			if ((params.loadBalancerArn === undefined) === (params.listenerArns === undefined)) {
				const err = new Error("Provide exactly one of loadBalancerArn or listenerArns (not both, not neither).");
				err.name = "ValidationError";
				throw err;
			}
			const client = getElbv2Client(config, params.estate);
			return client.send(
				new DescribeListenersCommand({
					LoadBalancerArn: params.loadBalancerArn,
					ListenerArns: params.listenerArns,
					PageSize: preferSdkParam(params.pageSize, params.limit),
					Marker: preferSdkParam(params.marker, params.cursor),
				}),
			);
		},
	});
}
