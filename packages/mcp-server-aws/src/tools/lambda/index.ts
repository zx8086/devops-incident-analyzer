// src/tools/lambda/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { AWS_READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import {
	type GetFunctionConfigurationParams,
	getFunctionConfiguration,
	getFunctionConfigurationSchema,
} from "./get-function-configuration.ts";
import { type ListFunctionsParams, listFunctions, listFunctionsSchema } from "./list-functions.ts";

export function registerLambdaTools(server: McpServer, config: AwsConfig): void {
	const functions = listFunctions(config);
	server.registerTool(
		"aws_lambda_list_functions",
		{
			description:
				"List Lambda functions in the account. Returns Functions[] with runtime, handler, memory, timeout, last modified.",
			inputSchema: withEstate(config, listFunctionsSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await functions(params as ListFunctionsParams)),
	);

	const functionConfig = getFunctionConfiguration(config);
	server.registerTool(
		"aws_lambda_get_function_configuration",
		{
			description:
				"Get configuration details for a single Lambda function including runtime, env vars, layers, VPC config.",
			inputSchema: withEstate(config, getFunctionConfigurationSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await functionConfig(params as GetFunctionConfigurationParams)),
	);
}
