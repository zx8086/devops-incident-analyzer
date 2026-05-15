// src/tools/lambda/get-function-configuration.ts
import { GetFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getLambdaClient } from "../../services/client-factory.ts";
import { wrapBlobTool } from "../wrap.ts";

export const getFunctionConfigurationSchema = z.object({
	FunctionName: z.string().describe("Lambda function name, ARN, or partial ARN"),
});

export type GetFunctionConfigurationParams = z.infer<typeof getFunctionConfigurationSchema>;

export function getFunctionConfiguration(config: AwsConfig) {
	return wrapBlobTool({
		name: "aws_lambda_get_function_configuration",
		fn: async (params: GetFunctionConfigurationParams) => {
			const client = getLambdaClient(config);
			return client.send(
				new GetFunctionConfigurationCommand({
					FunctionName: params.FunctionName,
				}),
			);
		},
	});
}
