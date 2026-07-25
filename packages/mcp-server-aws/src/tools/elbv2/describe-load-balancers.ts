// src/tools/elbv2/describe-load-balancers.ts
import {
	DescribeLoadBalancersCommand,
	type DescribeLoadBalancersOutput,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getElbv2Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const describeLoadBalancersSchema = z.object({
	loadBalancerArns: z
		.array(z.string())
		.optional()
		.describe("Optional list of load balancer ARNs to filter (omit to list all)"),
	names: z.array(z.string()).optional().describe("Optional list of load balancer names to filter"),
	pageSize: z.number().int().min(1).max(400).optional().describe("Max results per page (1-400). Alias: limit."),
	marker: z.string().optional().describe("Pagination marker from a previous response's NextMarker. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to PageSize/Marker below; SDK param wins).
	limit: z.number().int().min(1).max(400).optional().describe("Canonical page-size alias (-> PageSize)."),
	cursor: z.string().optional().describe("Canonical pagination-token alias (-> Marker). Pass _truncated.cursor here."),
});

export type DescribeLoadBalancersParams = WithEstate<z.infer<typeof describeLoadBalancersSchema>>;

// SIO-1205: scalar projection of the complete LB inventory for the incident network
// map -- DNSName is the field Route53 record targets are matched against.
export function summarizeLoadBalancers(response: DescribeLoadBalancersOutput) {
	return (response.LoadBalancers ?? []).map((lb) => ({
		LoadBalancerArn: lb.LoadBalancerArn,
		DNSName: lb.DNSName,
		Type: lb.Type,
		Scheme: lb.Scheme,
		VpcId: lb.VpcId,
	}));
}

export function describeLoadBalancers(config: AwsConfig) {
	return wrapListTool({
		name: "aws_elbv2_describe_load_balancers",
		listField: "LoadBalancers",
		fn: async (params: DescribeLoadBalancersParams) => {
			const client = getElbv2Client(config, params.estate);
			return client.send(
				new DescribeLoadBalancersCommand({
					LoadBalancerArns: params.loadBalancerArns,
					Names: params.names,
					PageSize: preferSdkParam(params.pageSize, params.limit),
					Marker: preferSdkParam(params.marker, params.cursor),
				}),
			);
		},
		summarize: summarizeLoadBalancers,
	});
}
