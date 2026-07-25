// src/tools/route53/list-hosted-zones.ts
import { ListHostedZonesCommand } from "@aws-sdk/client-route-53";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getRoute53Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const listHostedZonesSchema = z.object({
	marker: z.string().optional().describe("Pagination marker from a previous response's NextMarker. Alias: cursor."),
	maxItems: z.number().int().min(1).max(100).optional().describe("Max hosted zones per page (1-100). Alias: limit."),
	// SIO-838: canonical pagination aliases (map to MaxItems/Marker below; SDK param wins).
	limit: z.number().int().min(1).max(100).optional().describe("Canonical page-size alias (-> MaxItems)."),
	cursor: z.string().optional().describe("Canonical pagination-token alias (-> Marker). Pass _truncated.cursor here."),
});

export type ListHostedZonesParams = WithEstate<z.infer<typeof listHostedZonesSchema>>;

export function listHostedZones(config: AwsConfig) {
	return wrapListTool({
		name: "aws_route53_list_hosted_zones",
		listField: "HostedZones",
		fn: async (params: ListHostedZonesParams) => {
			const client = getRoute53Client(config, params.estate);
			return client.send(
				new ListHostedZonesCommand({
					Marker: preferSdkParam(params.marker, params.cursor),
					MaxItems: preferSdkParam(params.maxItems, params.limit),
				}),
			);
		},
	});
}
