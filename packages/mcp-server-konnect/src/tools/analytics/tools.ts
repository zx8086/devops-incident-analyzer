import type { z } from "zod";
import type { ToolHandler } from "../registry.js";
import * as analyticsOps from "./operations.js";
import * as parameters from "./parameters.js";
import * as prompts from "./prompts.js";

export type AnalyticsTool = {
	method: string;
	name: string;
	description: string;
	parameters: z.ZodObject;
	category: string;
	handler: ToolHandler;
};

export const analyticsTools = (): AnalyticsTool[] => [
	{
		method: "query_api_requests",
		name: "Query API Requests",
		description: prompts.queryApiRequestsPrompt(),
		parameters: parameters.queryApiRequestsParameters(),
		category: "analytics",
		handler: async (args, { api }) =>
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
		parameters: parameters.getConsumerRequestsParameters(),
		category: "analytics",
		handler: async (args, { api }) =>
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
