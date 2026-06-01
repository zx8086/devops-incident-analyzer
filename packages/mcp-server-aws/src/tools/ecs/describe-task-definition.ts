// src/tools/ecs/describe-task-definition.ts
import { DescribeTaskDefinitionCommand } from "@aws-sdk/client-ecs";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEcsClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapBlobTool } from "../wrap.ts";

export const describeTaskDefinitionSchema = z.object({
	taskDefinition: z
		.string()
		.describe(
			"Task definition to describe: family, family:revision, or full ARN. " +
				"Get it from a service's taskDefinition field (aws_ecs_describe_services).",
		),
	include: z.array(z.string()).optional().describe("Optional list of additional data to include (e.g. TAGS)"),
});

export type DescribeTaskDefinitionParams = WithEstate<z.infer<typeof describeTaskDefinitionSchema>>;

export function describeTaskDefinition(config: AwsConfig) {
	// SIO-855: single (possibly large) object whose containerDefinitions carry the
	// env/secrets that reveal a service's datastore endpoint -- wrapBlobTool, not list.
	return wrapBlobTool({
		name: "aws_ecs_describe_task_definition",
		fn: async (params: DescribeTaskDefinitionParams) => {
			const client = getEcsClient(config, params.estate);
			return client.send(
				new DescribeTaskDefinitionCommand({
					taskDefinition: params.taskDefinition,
					include: params.include as "TAGS"[] | undefined,
				}),
			);
		},
	});
}
