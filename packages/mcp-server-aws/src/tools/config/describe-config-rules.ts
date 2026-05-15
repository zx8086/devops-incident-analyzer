// src/tools/config/describe-config-rules.ts
import { DescribeConfigRulesCommand } from "@aws-sdk/client-config-service";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getConfigServiceClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeConfigRulesSchema = z.object({
	ConfigRuleNames: z.array(z.string()).optional().describe("Filter by rule names (omit to list all)"),
	NextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type DescribeConfigRulesParams = z.infer<typeof describeConfigRulesSchema>;

export function describeConfigRules(config: AwsConfig) {
	return wrapListTool({
		name: "aws_config_describe_config_rules",
		listField: "ConfigRules",
		fn: async (params: DescribeConfigRulesParams) => {
			const client = getConfigServiceClient(config);
			return client.send(
				new DescribeConfigRulesCommand({
					ConfigRuleNames: params.ConfigRuleNames,
					NextToken: params.NextToken,
				}),
			);
		},
	});
}
