// src/tools/xray/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type GetServiceGraphParams, getServiceGraph, getServiceGraphSchema } from "./get-service-graph.ts";
import { type GetTraceSummariesParams, getTraceSummaries, getTraceSummariesSchema } from "./get-trace-summaries.ts";

export function registerXrayTools(server: McpServer, config: AwsConfig): void {
	const serviceGraph = getServiceGraph(config);
	server.tool(
		"aws_xray_get_service_graph",
		"Get the X-Ray service graph showing service dependencies and connections for a time range.",
		withEstate(config, getServiceGraphSchema.shape),
		async (params) => toMcp(await serviceGraph(params as GetServiceGraphParams)),
	);

	const traceSummaries = getTraceSummaries(config);
	server.tool(
		"aws_xray_get_trace_summaries",
		"Get X-Ray trace summaries including duration, status, and annotations for a time range.",
		withEstate(config, getTraceSummariesSchema.shape),
		async (params) => toMcp(await traceSummaries(params as GetTraceSummariesParams)),
	);
}
