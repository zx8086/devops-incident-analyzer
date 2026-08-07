// src/tools/route53/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { AWS_READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type ListHostedZonesParams, listHostedZones, listHostedZonesSchema } from "./list-hosted-zones.ts";
import {
	type ListResourceRecordSetsParams,
	listResourceRecordSets,
	listResourceRecordSetsSchema,
} from "./list-resource-record-sets.ts";

// SIO-1205: the DNS edge of the incident network map -- which record resolves the focus
// service's hostname, and what does it point at (usually an ALB/NLB DNSName).
export function registerRoute53Tools(server: McpServer, config: AwsConfig): void {
	const hostedZones = listHostedZones(config);
	server.registerTool(
		"aws_route53_list_hosted_zones",
		{
			description:
				"List Route 53 hosted zones. Returns HostedZones[] with Id, Name (trailing dot included), Config.PrivateZone, and ResourceRecordSetCount. Start here to find the zone covering the focus service's domain, then drill into aws_route53_list_resource_record_sets.",
			inputSchema: withEstate(config, listHostedZonesSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await hostedZones(params as ListHostedZonesParams)),
	);

	const recordSets = listResourceRecordSets(config);
	server.registerTool(
		"aws_route53_list_resource_record_sets",
		{
			description:
				"List the resource record sets of a hosted zone. Returns ResourceRecordSets[] with Name, Type, TTL, ResourceRecords[].Value, and AliasTarget.DNSName -- match A/ALIAS/CNAME targets against load balancer DNSNames (normalize case and trailing dots). Pagination is POSITIONAL, not token-based: to continue, pass the response's NextRecordName/NextRecordType as startRecordName/startRecordType. Narrow with startRecordName near the focus hostname instead of walking the whole zone.",
			inputSchema: withEstate(config, listResourceRecordSetsSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await recordSets(params as ListResourceRecordSetsParams)),
	);
}
