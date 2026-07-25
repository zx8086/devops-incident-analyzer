// src/tools/route53/list-resource-record-sets.ts
import {
	ListResourceRecordSetsCommand,
	type ListResourceRecordSetsResponse,
	type RRType,
} from "@aws-sdk/client-route-53";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getRoute53Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

// SIO-1205: this API's pagination is POSITIONAL (NextRecordName/NextRecordType in the
// response, passed back as startRecordName/startRecordType), NOT a token --
// findContinuationToken cannot detect it, so byte-truncation reports Case B. There is
// deliberately NO cursor alias here; faking token support would send the model into a loop.
export const listResourceRecordSetsSchema = z.object({
	hostedZoneId: z.string().min(1).describe("Hosted zone id (Z...) from aws_route53_list_hosted_zones"),
	startRecordName: z
		.string()
		.optional()
		.describe("Positional continuation: pass the previous response's NextRecordName to fetch the next page"),
	startRecordType: z
		.string()
		.optional()
		.describe("Positional continuation: pass the previous response's NextRecordType (requires startRecordName)"),
	maxItems: z.number().int().min(1).max(300).optional().describe("Max record sets per page (1-300). Alias: limit."),
	// SIO-838: canonical page-size alias only (no cursor -- pagination is positional, see above).
	limit: z.number().int().min(1).max(300).optional().describe("Canonical page-size alias (-> MaxItems)."),
});

export type ListResourceRecordSetsParams = WithEstate<z.infer<typeof listResourceRecordSetsSchema>>;

// SIO-1205: scalar projection for the incident network map -- the alias target or first
// record value is what gets matched against load balancer DNSNames.
export function summarizeRecordSets(response: ListResourceRecordSetsResponse) {
	return (response.ResourceRecordSets ?? []).map((r) => ({
		Name: r.Name,
		Type: r.Type,
		AliasDNSName: r.AliasTarget?.DNSName,
		FirstValue: r.ResourceRecords?.[0]?.Value,
	}));
}

export function listResourceRecordSets(config: AwsConfig) {
	return wrapListTool({
		name: "aws_route53_list_resource_record_sets",
		listField: "ResourceRecordSets",
		fn: async (params: ListResourceRecordSetsParams) => {
			const client = getRoute53Client(config, params.estate);
			return client.send(
				new ListResourceRecordSetsCommand({
					HostedZoneId: params.hostedZoneId,
					StartRecordName: params.startRecordName,
					StartRecordType: params.startRecordType as RRType | undefined,
					MaxItems: preferSdkParam(params.maxItems, params.limit),
				}),
			);
		},
		summarize: summarizeRecordSets,
	});
}
