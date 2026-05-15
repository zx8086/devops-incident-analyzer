// src/tools/ec2/describe-instances.ts
import { DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeInstancesSchema = z.object({
	instanceIds: z.array(z.string()).optional().describe("Optional list of EC2 instance IDs"),
	maxResults: z.number().int().min(5).max(1000).optional(),
	nextToken: z.string().optional(),
});

export type DescribeInstancesParams = z.infer<typeof describeInstancesSchema>;

export function describeInstances(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_instances",
		listField: "Reservations",
		fn: async (params: DescribeInstancesParams) => {
			const client = getEc2Client(config);
			return client.send(
				new DescribeInstancesCommand({
					InstanceIds: params.instanceIds,
					MaxResults: params.maxResults,
					NextToken: params.nextToken,
				}),
			);
		},
	});
}
