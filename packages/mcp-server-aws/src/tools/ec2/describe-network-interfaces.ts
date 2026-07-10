// src/tools/ec2/describe-network-interfaces.ts
import { DescribeNetworkInterfacesCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

// SIO-1057: EC2 Filter is [{ Name, Values[] }]. Kept permissive so the agent can filter by
// addresses.private-ip-address, vpc-id, interface-type, etc. to resolve an ENI -> private IP.
const filterSchema = z.object({
	Name: z.string(),
	Values: z.array(z.string()),
});

export const describeNetworkInterfacesSchema = z.object({
	networkInterfaceIds: z
		.array(z.string())
		.optional()
		.describe("Optional list of ENI IDs (eni-...) to filter (omit to list all)"),
	filters: z
		.array(filterSchema)
		.optional()
		.describe('EC2 filters, e.g. [{ Name: "private-ip-address", Values: ["10.34.50.147"] }]'),
	maxResults: z.number().int().min(5).max(1000).optional().describe("Max results per page (5-1000). Alias: limit."),
	nextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to maxResults/nextToken below; SDK param wins).
	limit: z.number().int().min(5).max(1000).optional().describe("Canonical page-size alias (-> maxResults)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> nextToken). Pass _truncated.cursor here."),
});

export type DescribeNetworkInterfacesParams = WithEstate<z.infer<typeof describeNetworkInterfacesSchema>>;

export function describeNetworkInterfaces(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_network_interfaces",
		listField: "NetworkInterfaces",
		fn: async (params: DescribeNetworkInterfacesParams) => {
			const client = getEc2Client(config, params.estate);
			return client.send(
				new DescribeNetworkInterfacesCommand({
					NetworkInterfaceIds: params.networkInterfaceIds,
					Filters: params.filters,
					MaxResults: preferSdkParam(params.maxResults, params.limit),
					NextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}
