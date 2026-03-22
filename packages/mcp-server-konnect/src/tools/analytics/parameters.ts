import { z } from "zod";
import { CommonSchemas, timeRangeSchema } from "../../utils/validation.js";

// =========================
// Analytics API Parameters
// =========================

export const queryApiRequestsParameters = () =>
	z.object({
		timeRange: timeRangeSchema,
		statusCodes: z
			.array(z.number().int().min(100).max(599))
			.optional()
			.describe("Filter by specific HTTP status codes (e.g. [200, 201, 404])"),
		excludeStatusCodes: z
			.array(z.number().int().min(100).max(599))
			.optional()
			.describe("Exclude specific HTTP status codes (e.g. [400, 401, 500])"),
		httpMethods: z.array(z.string()).optional().describe("Filter by HTTP methods (e.g. ['GET', 'POST', 'DELETE'])"),
		consumerIds: z.array(z.string()).optional().describe("Filter by consumer IDs"),
		serviceIds: z.array(z.string()).optional().describe("Filter by service IDs"),
		routeIds: z.array(z.string()).optional().describe("Filter by route IDs (from list-routes tool)"),
		maxResults: CommonSchemas.pageSize,
	});

export const getConsumerRequestsParameters = () =>
	z.object({
		consumerId: z
			.string()
			.describe("Consumer ID to filter by (obtainable from analyze-failed-requests or query-api-requests tools)"),
		timeRange: timeRangeSchema,
		successOnly: z.boolean().default(false).describe("Show only successful (2xx) requests"),
		failureOnly: z.boolean().default(false).describe("Show only failed (non-2xx) requests"),
		maxResults: CommonSchemas.pageSize,
	});
