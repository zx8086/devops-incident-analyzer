// src/tools/cloudtrail/get-trail-status.ts
import { GetTrailStatusCommand } from "@aws-sdk/client-cloudtrail";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudTrailClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapBlobTool } from "../wrap.ts";

export const getTrailStatusSchema = z.object({
	Name: z.string().describe("Trail name or ARN (from aws_cloudtrail_describe_trails / list_trails)"),
});

export type GetTrailStatusParams = WithEstate<z.infer<typeof getTrailStatusSchema>>;

// Single-object status response (IsLogging, LatestDeliveryError, LatestDeliveryTime, etc.)
// answers "is this trail actually logging right now / did delivery break" for a governance audit.
export function getTrailStatus(config: AwsConfig) {
	return wrapBlobTool({
		name: "aws_cloudtrail_get_trail_status",
		fn: async (params: GetTrailStatusParams) => {
			const client = getCloudTrailClient(config, params.estate);
			return client.send(new GetTrailStatusCommand({ Name: params.Name }));
		},
	});
}
