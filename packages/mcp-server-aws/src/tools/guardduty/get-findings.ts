// src/tools/guardduty/get-findings.ts
import { type Finding, GetFindingsCommand } from "@aws-sdk/client-guardduty";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getGuardDutyClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapListTool } from "../wrap.ts";

export const getFindingsSchema = z.object({
	DetectorId: z.string().describe("Detector ID from aws_guardduty_list_detectors"),
	FindingIds: z
		.array(z.string())
		.min(1)
		.max(50)
		.describe("Finding IDs from aws_guardduty_list_findings (1-50; never guess these)"),
});

export type GetFindingsParams = WithEstate<z.infer<typeof getFindingsSchema>>;

// Hydrates the IDs returned by aws_guardduty_list_findings into full finding detail.
// This is the second call of the list -> get 2-call chain.
export function getFindings(config: AwsConfig) {
	return wrapListTool({
		name: "aws_guardduty_get_findings",
		listField: "Findings",
		// SIO-833: full findings are large; keep a compact projection of the COMPLETE list so
		// severity/type coverage survives byte-truncation.
		summarize: (response: { Findings?: Finding[] }) =>
			(response.Findings ?? []).map((f) => ({
				Id: f.Id,
				Severity: f.Severity,
				Type: f.Type,
				Title: f.Title,
				Region: f.Region,
				UpdatedAt: f.UpdatedAt,
			})),
		fn: async (params: GetFindingsParams) => {
			const client = getGuardDutyClient(config, params.estate);
			return client.send(
				new GetFindingsCommand({
					DetectorId: params.DetectorId,
					FindingIds: params.FindingIds,
				}),
			);
		},
	});
}
