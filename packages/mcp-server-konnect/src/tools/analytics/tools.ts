import type { z } from "zod";
import * as parameters from "./parameters.js";
import * as prompts from "./prompts.js";

export type AnalyticsTool = {
	method: string;
	name: string;
	description: string;
	parameters: z.ZodObject<any, any, any, any>;
	category: string;
};

export const analyticsTools = (): AnalyticsTool[] => [
	{
		method: "query_api_requests",
		name: "Query API Requests",
		description: prompts.queryApiRequestsPrompt(),
		parameters: parameters.queryApiRequestsParameters(),
		category: "analytics",
	},
	{
		method: "get_consumer_requests",
		name: "Get Consumer Requests",
		description: prompts.getConsumerRequestsPrompt(),
		parameters: parameters.getConsumerRequestsParameters(),
		category: "analytics",
	},
];
