// src/tools/xray/get-service-graph.ts
import { GetServiceGraphCommand } from "@aws-sdk/client-xray";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getXrayClient } from "../../services/client-factory.ts";
import { wrapBlobTool } from "../wrap.ts";

export const getServiceGraphSchema = z.object({
	StartTime: z.string().describe("ISO 8601 start time for the service graph"),
	EndTime: z.string().describe("ISO 8601 end time for the service graph"),
});

export type GetServiceGraphParams = z.infer<typeof getServiceGraphSchema>;

export function getServiceGraph(config: AwsConfig) {
	return wrapBlobTool({
		name: "aws_xray_get_service_graph",
		fn: async (params: GetServiceGraphParams) => {
			const client = getXrayClient(config);
			return client.send(
				new GetServiceGraphCommand({
					StartTime: new Date(params.StartTime),
					EndTime: new Date(params.EndTime),
				}),
			);
		},
	});
}
