// src/tools/guardduty/list-detectors.ts
import { ListDetectorsCommand } from "@aws-sdk/client-guardduty";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getGuardDutyClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapListTool } from "../wrap.ts";

export const listDetectorsSchema = z.object({
	NextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type ListDetectorsParams = WithEstate<z.infer<typeof listDetectorsSchema>>;

// DetectorId is required by every other GuardDuty call (get_detector, list_findings, get_findings),
// so enumerate detectors here FIRST and never guess an ID. A region has at most one detector.
export function listDetectors(config: AwsConfig) {
	return wrapListTool({
		name: "aws_guardduty_list_detectors",
		listField: "DetectorIds",
		fn: async (params: ListDetectorsParams) => {
			const client = getGuardDutyClient(config, params.estate);
			return client.send(new ListDetectorsCommand({ NextToken: params.NextToken }));
		},
	});
}
