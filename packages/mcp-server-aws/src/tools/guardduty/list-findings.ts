// src/tools/guardduty/list-findings.ts
import { type FindingCriteria, ListFindingsCommand } from "@aws-sdk/client-guardduty";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getGuardDutyClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const listFindingsSchema = z.object({
	DetectorId: z.string().describe("Detector ID from aws_guardduty_list_detectors"),
	minSeverity: z
		.number()
		.min(0)
		.max(10)
		.optional()
		.describe("Only finding IDs at/above this severity (GuardDuty scale 0-10; 7+ is High, 4+ is Medium)"),
	MaxResults: z.number().int().min(1).max(50).optional().describe("Max finding IDs to return (1-50). Alias: limit."),
	NextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (-> MaxResults / NextToken; SDK param wins).
	limit: z.number().int().min(1).max(50).optional().describe("Canonical page-size alias (-> MaxResults)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> NextToken). Pass _truncated.cursor here."),
});

export type ListFindingsParams = WithEstate<z.infer<typeof listFindingsSchema>>;

function buildCriteria(params: ListFindingsParams): FindingCriteria | undefined {
	if (params.minSeverity === undefined) return undefined;
	return { Criterion: { severity: { GreaterThanOrEqual: params.minSeverity } } };
}

// Returns finding IDs only; hydrate them with aws_guardduty_get_findings. Never guess IDs.
export function listFindings(config: AwsConfig) {
	return wrapListTool({
		name: "aws_guardduty_list_findings",
		listField: "FindingIds",
		fn: async (params: ListFindingsParams) => {
			const client = getGuardDutyClient(config, params.estate);
			return client.send(
				new ListFindingsCommand({
					DetectorId: params.DetectorId,
					FindingCriteria: buildCriteria(params),
					MaxResults: preferSdkParam(params.MaxResults, params.limit),
					NextToken: preferSdkParam(params.NextToken, params.cursor),
				}),
			);
		},
	});
}
