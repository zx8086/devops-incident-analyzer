// src/tools/guardduty/get-detector.ts
import { GetDetectorCommand } from "@aws-sdk/client-guardduty";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getGuardDutyClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapBlobTool } from "../wrap.ts";

export const getDetectorSchema = z.object({
	DetectorId: z.string().describe("Detector ID from aws_guardduty_list_detectors"),
});

export type GetDetectorParams = WithEstate<z.infer<typeof getDetectorSchema>>;

// Single-object response (Status, FindingPublishingFrequency, DataSources, Features).
// Confirms GuardDuty is ENABLED and which data sources/features are on for this estate.
export function getDetector(config: AwsConfig) {
	return wrapBlobTool({
		name: "aws_guardduty_get_detector",
		fn: async (params: GetDetectorParams) => {
			const client = getGuardDutyClient(config, params.estate);
			return client.send(new GetDetectorCommand({ DetectorId: params.DetectorId }));
		},
	});
}
