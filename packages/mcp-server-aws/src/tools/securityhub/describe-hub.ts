// src/tools/securityhub/describe-hub.ts
import { DescribeHubCommand } from "@aws-sdk/client-securityhub";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getSecurityHubClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapBlobTool } from "../wrap.ts";

export const describeHubSchema = z.object({
	HubArn: z.string().optional().describe("Hub ARN (omit to describe the hub in the current account/region)"),
});

export type DescribeHubParams = WithEstate<z.infer<typeof describeHubSchema>>;

// Single-object response (HubArn, SubscribedAt, AutoEnableControls, ControlFindingGenerator).
// Confirms whether Security Hub is actually enabled in this account/region.
export function describeHub(config: AwsConfig) {
	return wrapBlobTool({
		name: "aws_securityhub_describe_hub",
		fn: async (params: DescribeHubParams) => {
			const client = getSecurityHubClient(config, params.estate);
			return client.send(new DescribeHubCommand({ HubArn: params.HubArn }));
		},
	});
}
