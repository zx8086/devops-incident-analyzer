// src/tools/securityhub/get-findings.ts
import {
	type AwsSecurityFinding,
	type AwsSecurityFindingFilters,
	GetFindingsCommand,
} from "@aws-sdk/client-securityhub";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getSecurityHubClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapListTool } from "../wrap.ts";

const SEVERITY_LABELS = ["INFORMATIONAL", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export const getFindingsSchema = z.object({
	severityLabels: z
		.array(z.enum(SEVERITY_LABELS))
		.optional()
		.describe("Filter to these severity labels (e.g. ['CRITICAL','HIGH']); omit for all severities"),
	recordState: z
		.enum(["ACTIVE", "ARCHIVED"])
		.optional()
		.describe("Filter by record state; default to ACTIVE for live findings"),
	MaxResults: z.number().int().min(1).max(100).optional().describe("Max findings to return (1-100)"),
	NextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type GetFindingsParams = WithEstate<z.infer<typeof getFindingsSchema>>;

function buildFilters(params: GetFindingsParams): AwsSecurityFindingFilters | undefined {
	const filters: AwsSecurityFindingFilters = {};
	if (params.severityLabels?.length) {
		filters.SeverityLabel = params.severityLabels.map((value) => ({ Value: value, Comparison: "EQUALS" }));
	}
	if (params.recordState) {
		filters.RecordState = [{ Value: params.recordState, Comparison: "EQUALS" }];
	}
	return Object.keys(filters).length > 0 ? filters : undefined;
}

export function getFindings(config: AwsConfig) {
	return wrapListTool({
		name: "aws_securityhub_get_findings",
		listField: "Findings",
		// SIO-833: findings are large; keep a compact id/severity/title projection of the COMPLETE
		// list so severity coverage survives byte-truncation for the model's context.
		summarize: (response: { Findings?: AwsSecurityFinding[] }) =>
			(response.Findings ?? []).map((f) => ({
				Id: f.Id,
				Severity: f.Severity?.Label,
				Title: f.Title,
				WorkflowStatus: f.Workflow?.Status,
			})),
		fn: async (params: GetFindingsParams) => {
			const client = getSecurityHubClient(config, params.estate);
			return client.send(
				new GetFindingsCommand({
					Filters: buildFilters(params),
					MaxResults: params.MaxResults,
					NextToken: params.NextToken,
				}),
			);
		},
	});
}
