import type { MCPTool } from "../registry.js";
import * as analyticsOps from "./operations.js";
import * as parameters from "./parameters.js";
import type { GetConsumerRequestsArgs, QueryApiRequestsArgs } from "./parameters.js";
import * as prompts from "./prompts.js";

export const analyticsTools = (): MCPTool[] => [
	{
		method: "query_api_requests",
		name: "Query API Requests",
		description: prompts.queryApiRequestsPrompt(),
		parameters: parameters.queryApiRequestsParameters,
		category: "analytics",
		handler: async (args: QueryApiRequestsArgs, { api }) =>
			analyticsOps.queryApiRequests(
				api,
				args.timeRange,
				args.statusCodes,
				args.excludeStatusCodes,
				args.httpMethods,
				args.consumerIds,
				args.serviceIds,
				args.routeIds,
				args.maxResults,
			),
	},
	{
		method: "get_consumer_requests",
		name: "Get Consumer Requests",
		description: prompts.getConsumerRequestsPrompt(),
		parameters: parameters.getConsumerRequestsParameters,
		category: "analytics",
		handler: async (args: GetConsumerRequestsArgs, { api }) =>
			analyticsOps.getConsumerRequests(
				api,
				args.consumerId,
				args.timeRange,
				args.successOnly,
				args.failureOnly,
				args.maxResults,
			),
	},
];
