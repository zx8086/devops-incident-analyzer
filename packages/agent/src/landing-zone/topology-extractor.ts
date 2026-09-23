// packages/agent/src/landing-zone/topology-extractor.ts

import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const LandingZoneTopologyKindSchema = z.enum([
	"aws-organization",
	"organizational-unit",
	"aws-account",
	"region",
	"availability-zone",
	"vpc",
	"subnet",
	"route-table",
	"route",
	"internet-gateway",
	"nat-gateway",
	"transit-gateway",
	"core-network",
	"network-attachment",
	"vpc-endpoint",
	"network-acl",
	"hosted-zone",
	"dns-record",
	"load-balancer",
	"resolver-endpoint",
	"resolver-rule",
	"dns-firewall-rule-group",
	"ip-address",
	"cidr-block",
]);
export type LandingZoneTopologyKind = z.infer<typeof LandingZoneTopologyKindSchema>;

export const LandingZoneTopologyRelationshipKindSchema = z.enum([
	"organization-contains-ou",
	"ou-contains-account",
	"account-owns-vpc",
	"vpc-located-in-region",
	"vpc-contains-subnet",
	"subnet-located-in-availability-zone",
	"subnet-uses-route-table",
	"subnet-protected-by-network-acl",
	"route-table-has-route",
	"route-destines-cidr",
	"route-targets-internet-gateway",
	"route-targets-nat-gateway",
	"route-targets-transit-gateway",
	"route-targets-core-network",
	"route-targets-vpc-endpoint",
	"vpc-has-network-attachment",
	"network-attachment-targets-transit-gateway",
	"network-attachment-targets-core-network",
	"vpc-associated-with-hosted-zone",
	"vpc-uses-resolver-rule",
	"vpc-hosts-resolver-endpoint",
	"hosted-zone-contains-dns-record",
	"dns-record-resolves-to-ip",
	"dns-record-resolves-to-vpc-endpoint",
	"dns-record-resolves-to-load-balancer",
	"dns-record-resolves-to-dns-record",
	"resolver-rule-forwards-to-endpoint",
]);
export type LandingZoneTopologyRelationshipKind = z.infer<typeof LandingZoneTopologyRelationshipKindSchema>;

export const TopologyProvenanceSchema = z
	.object({
		state: z.enum(["desired", "observed", "proposed"]),
		source: z.enum(["terraform", "aws-api", "gitlab-merge-request"]),
		repository: z.string().min(1).optional(),
		filePath: z.string().min(1).optional(),
		commitSha: z.string().min(1).optional(),
		terraformAddress: z.string().min(1).optional(),
		resourceId: z.string().min(1).optional(),
		mergeRequestUrl: z.url().optional(),
		sourceTimestamp: z.string().datetime().optional(),
		observedAt: z.string().datetime().optional(),
	})
	.strict();
export type TopologyProvenance = z.infer<typeof TopologyProvenanceSchema>;

const TopologyPropertiesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export const LandingZoneTopologyEntitySchema = z
	.object({
		id: z.string().min(1),
		kind: LandingZoneTopologyKindSchema,
		name: z.string().min(1).optional(),
		accountId: z.string().min(1).optional(),
		region: z.string().min(1).optional(),
		properties: TopologyPropertiesSchema,
		provenance: TopologyProvenanceSchema,
	})
	.strict();
export type LandingZoneTopologyEntity = z.infer<typeof LandingZoneTopologyEntitySchema>;

export const LandingZoneTopologyRelationshipSchema = z
	.object({
		id: z.string().min(1),
		kind: LandingZoneTopologyRelationshipKindSchema,
		from: z.string().min(1),
		to: z.string().min(1),
		properties: TopologyPropertiesSchema,
		provenance: TopologyProvenanceSchema,
	})
	.strict();
export type LandingZoneTopologyRelationship = z.infer<typeof LandingZoneTopologyRelationshipSchema>;

export interface LandingZoneTopologySnapshot {
	entities: LandingZoneTopologyEntity[];
	relationships: LandingZoneTopologyRelationship[];
	warnings: string[];
}

export interface TerraformTopologySource {
	repository: string;
	path: string;
	commitSha: string;
	sourceTimestamp: string;
	content: string;
	state?: "desired" | "proposed";
	mergeRequestUrl?: string;
	accountId?: string;
	region?: string;
}

const WorkloadVpcYamlSchema = z
	.object({
		vpcs: z.array(
			z
				.object({
					name: z.string().min(1),
					segment: z.string().min(1),
					region: z.string().min(1),
					ipam_pool_name: z.string().min(1),
					ipam_netmask_length: z.number().int(),
					availability_zones: z.number().int().positive(),
					cloudwan_attachment: z.boolean(),
					enable_public_access: z.boolean(),
					vpc_endpoints: z
						.object({
							enabled: z.boolean().optional(),
							interface: z.array(z.string().min(1)).optional(),
							gateway: z.array(z.string().min(1)).optional(),
						})
						.passthrough()
						.optional(),
					subnets: z.record(
						z.string(),
						z
							.object({
								technical_name: z.string().min(1),
								subnet_category: z.string().min(1),
								availability_zones: z.number().int().positive(),
								cidr_blocks: z.array(z.string().min(1)).optional(),
								routing: z
									.object({
										type: z.string().min(1),
										routes: z
											.array(
												z
													.object({
														destination: z.string().min(1),
														target_type: z.string().min(1),
														target_reference: z.string().min(1).optional(),
													})
													.passthrough(),
											)
											.optional(),
									})
									.passthrough(),
							})
							.passthrough(),
					),
				})
				.passthrough(),
		),
	})
	.passthrough();

const AccountYamlSchema = z
	.object({
		application_name: z.string().min(1),
		environments: z.record(
			z.string(),
			z
				.object({
					region: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
					ou_id: z.string().min(1),
					vpc_netmask: z.number().int().optional(),
				})
				.passthrough(),
		),
	})
	.passthrough();

const PostVendingYamlSchema = z
	.object({
		application_name: z.string().min(1),
		environments: z.record(
			z.string(),
			z
				.object({
					account_id: z.string().min(1),
					vpc_id: z.string().min(1).optional(),
					region: z.string().min(1).optional(),
					vpcs: z
						.array(
							z
								.object({
									vpc_id: z.string().min(1),
									region: z.string().min(1),
								})
								.passthrough(),
						)
						.min(1)
						.optional(),
				})
				.refine((environment) => Boolean(environment.vpcs?.length || (environment.vpc_id && environment.region)), {
					message: "Provide vpcs or both vpc_id and region",
				})
				.passthrough(),
		),
	})
	.passthrough();

interface HclResource {
	type: string;
	name: string;
	address: string;
	body: string;
}

function resourceBlocks(content: string): HclResource[] {
	const resources: HclResource[] = [];
	const header = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;
	for (let match = header.exec(content); match; match = header.exec(content)) {
		let depth = 1;
		let cursor = header.lastIndex;
		let quoted = false;
		let escaped = false;
		for (; cursor < content.length && depth > 0; cursor++) {
			const character = content[cursor];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\" && quoted) {
				escaped = true;
				continue;
			}
			if (character === '"') quoted = !quoted;
			if (quoted) continue;
			if (character === "{") depth++;
			if (character === "}") depth--;
		}
		if (depth !== 0) break;
		const type = match[1];
		const name = match[2];
		if (type && name)
			resources.push({ type, name, address: `${type}.${name}`, body: content.slice(header.lastIndex, cursor - 1) });
		header.lastIndex = cursor;
	}
	return resources;
}

function attribute(body: string, name: string): string | undefined {
	const match = body.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(\\[[^\\]]*\\]|"[^"]*"|[^\\n}]+)`));
	const raw = match?.[1]?.trim().replace(/,$/, "").trim();
	if (!raw) return undefined;
	return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
}

function reference(value: string | undefined): string | undefined {
	return value?.match(/\b(aws_[a-z0-9_]+\.[A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)?/)?.[1];
}

function stringList(value: string | undefined): string[] {
	if (!value?.startsWith("[")) return value ? [value] : [];
	return [...value.matchAll(/"([^"]+)"/g)].flatMap((match) => (match[1] ? [match[1]] : []));
}

function aliasTargetReference(body: string): string | undefined {
	return body.match(/alias\s*\{[\s\S]*?name\s*=\s*(aws_lb\.[A-Za-z0-9_-]+)\.dns_name/)?.[1];
}

const resourceKinds: Readonly<Record<string, LandingZoneTopologyKind>> = {
	aws_organizations_organization: "aws-organization",
	aws_organizations_organizational_unit: "organizational-unit",
	aws_organizations_account: "aws-account",
	aws_vpc: "vpc",
	aws_subnet: "subnet",
	aws_route_table: "route-table",
	aws_route: "route",
	aws_internet_gateway: "internet-gateway",
	aws_nat_gateway: "nat-gateway",
	aws_ec2_transit_gateway: "transit-gateway",
	aws_networkmanager_core_network: "core-network",
	aws_networkmanager_vpc_attachment: "network-attachment",
	aws_ec2_transit_gateway_vpc_attachment: "network-attachment",
	aws_vpc_endpoint: "vpc-endpoint",
	aws_network_acl: "network-acl",
	aws_route53_zone: "hosted-zone",
	aws_route53_record: "dns-record",
	aws_lb: "load-balancer",
	aws_route53_resolver_endpoint: "resolver-endpoint",
	aws_route53_resolver_rule: "resolver-rule",
	aws_route53_resolver_firewall_rule_group: "dns-firewall-rule-group",
};

function desiredProvenance(source: TerraformTopologySource, terraformAddress: string): TopologyProvenance {
	return TopologyProvenanceSchema.parse({
		state: source.state ?? "desired",
		source: source.state === "proposed" ? "gitlab-merge-request" : "terraform",
		repository: source.repository,
		filePath: source.path,
		commitSha: source.commitSha,
		terraformAddress,
		sourceTimestamp: source.sourceTimestamp,
		...(source.mergeRequestUrl && { mergeRequestUrl: source.mergeRequestUrl }),
	});
}

function entityId(kind: LandingZoneTopologyKind, identity: string): string {
	return `${kind}:${identity}`;
}

function relationship(
	kind: LandingZoneTopologyRelationshipKind,
	from: string,
	to: string,
	provenance: TopologyProvenance,
	properties: Record<string, string | number | boolean> = {},
): LandingZoneTopologyRelationship {
	return { id: `${kind}:${from}:${to}`, kind, from, to, properties, provenance };
}

function addReferenceRelationship(
	relationships: LandingZoneTopologyRelationship[],
	byAddress: Map<string, LandingZoneTopologyEntity>,
	kind: LandingZoneTopologyRelationshipKind,
	fromAddress: string | undefined,
	toAddress: string | undefined,
	provenance: TopologyProvenance,
): void {
	const from = fromAddress ? byAddress.get(fromAddress) : undefined;
	const to = toAddress ? byAddress.get(toAddress) : undefined;
	if (from && to) relationships.push(relationship(kind, from.id, to.id, provenance));
}

function yamlSubnetClassification(
	routing: z.infer<typeof WorkloadVpcYamlSchema>["vpcs"][number]["subnets"][string]["routing"],
): "public" | "private" | "isolated" | "unknown" {
	if (!routing) return "unknown";
	if (routing.type === "internet") return "public";
	if (routing.type === "isolated" || routing.type === "none") return "isolated";
	if (routing.type === "nat" || routing.type === "tgw" || routing.type === "cwan") return "private";
	const defaultRoute = routing.routes?.find(
		(route) => route.destination === "0.0.0.0/0" || route.destination === "::/0",
	);
	if (!defaultRoute) return routing.type === "custom" ? "isolated" : "unknown";
	return ["internet-gateway", "internet_gateway"].includes(defaultRoute.target_type) ? "public" : "private";
}

function yamlRouteTarget(
	targetType: string,
): { kind: LandingZoneTopologyKind; relationship: LandingZoneTopologyRelationshipKind } | undefined {
	if (["internet-gateway", "internet_gateway"].includes(targetType))
		return { kind: "internet-gateway", relationship: "route-targets-internet-gateway" };
	if (["nat-gateway", "nat_gateway"].includes(targetType))
		return { kind: "nat-gateway", relationship: "route-targets-nat-gateway" };
	if (targetType === "tgw") return { kind: "transit-gateway", relationship: "route-targets-transit-gateway" };
	if (["cwan", "cloud_wan"].includes(targetType))
		return { kind: "core-network", relationship: "route-targets-core-network" };
	if (targetType === "vpc-endpoint") return { kind: "vpc-endpoint", relationship: "route-targets-vpc-endpoint" };
	return undefined;
}

function extractWorkloadVpcYaml(
	source: TerraformTopologySource,
	document: z.infer<typeof WorkloadVpcYamlSchema>,
): LandingZoneTopologySnapshot {
	const entities: LandingZoneTopologyEntity[] = [];
	const relationships: LandingZoneTopologyRelationship[] = [];
	for (const vpc of document.vpcs) {
		const address = `yaml.vpcs[${JSON.stringify(vpc.name)}]`;
		const provenance = desiredProvenance(source, address);
		const vpcId = entityId("vpc", `${source.repository}:${source.path}:${vpc.name}`);
		entities.push({
			id: vpcId,
			kind: "vpc",
			name: vpc.name,
			...(source.accountId && { accountId: source.accountId }),
			region: vpc.region,
			properties: {
				segment: vpc.segment,
				ipamPoolName: vpc.ipam_pool_name,
				ipamNetmaskLength: vpc.ipam_netmask_length,
				enablePublicAccess: vpc.enable_public_access,
			},
			provenance,
		});
		if (source.accountId) {
			if (!entities.some((entity) => entity.kind === "aws-account" && entity.id === source.accountId))
				entities.push({
					id: source.accountId,
					kind: "aws-account",
					name: source.accountId,
					accountId: source.accountId,
					properties: {},
					provenance,
				});
			relationships.push(relationship("account-owns-vpc", source.accountId, vpcId, provenance));
		}
		if (!entities.some((entity) => entity.kind === "region" && entity.id === vpc.region))
			entities.push({
				id: vpc.region,
				kind: "region",
				name: vpc.region,
				region: vpc.region,
				properties: {},
				provenance,
			});
		relationships.push(relationship("vpc-located-in-region", vpcId, vpc.region, provenance));

		for (const [subnetKey, subnet] of Object.entries(vpc.subnets)) {
			const routeTableId = entityId("route-table", `${vpcId}:${subnetKey}`);
			entities.push({
				id: routeTableId,
				kind: "route-table",
				name: `${vpc.name}-${subnet.technical_name}`,
				...(source.accountId && { accountId: source.accountId }),
				region: vpc.region,
				properties: { vpcId },
				provenance,
			});
			for (let index = 0; index < subnet.availability_zones; index++) {
				const subnetId = entityId("subnet", `${vpcId}:${subnetKey}:${index + 1}`);
				const cidr = subnet.cidr_blocks?.[index];
				entities.push({
					id: subnetId,
					kind: "subnet",
					name: `${subnet.technical_name}-${index + 1}`,
					...(source.accountId && { accountId: source.accountId }),
					region: vpc.region,
					properties: {
						category: subnet.subnet_category,
						classification: yamlSubnetClassification(subnet.routing),
						availabilityZoneIndex: index + 1,
						...(cidr && { cidr }),
					},
					provenance,
				});
				relationships.push(relationship("vpc-contains-subnet", vpcId, subnetId, provenance));
				relationships.push(relationship("subnet-uses-route-table", subnetId, routeTableId, provenance));
			}
			for (const [routeIndex, route] of (subnet.routing?.routes ?? []).entries()) {
				const routeId = entityId("route", `${routeTableId}:${routeIndex + 1}`);
				const cidrId = entityId("cidr-block", route.destination);
				entities.push({
					id: routeId,
					kind: "route",
					name: `${subnet.technical_name}-${routeIndex + 1}`,
					...(source.accountId && { accountId: source.accountId }),
					region: vpc.region,
					properties: {},
					provenance,
				});
				if (!entities.some((entity) => entity.id === cidrId))
					entities.push({
						id: cidrId,
						kind: "cidr-block",
						name: route.destination,
						properties: { cidr: route.destination },
						provenance,
					});
				relationships.push(relationship("route-table-has-route", routeTableId, routeId, provenance));
				relationships.push(relationship("route-destines-cidr", routeId, cidrId, provenance));
				const target = yamlRouteTarget(route.target_type);
				if (!target) continue;
				const targetName = route.target_reference ?? route.target_type;
				const targetId = entityId(target.kind, targetName);
				if (!entities.some((entity) => entity.id === targetId))
					entities.push({
						id: targetId,
						kind: target.kind,
						name: targetName,
						...(source.accountId && { accountId: source.accountId }),
						region: vpc.region,
						properties: {},
						provenance,
					});
				relationships.push(relationship(target.relationship, routeId, targetId, provenance));
			}
		}

		if (vpc.cloudwan_attachment) {
			const attachmentId = entityId("network-attachment", vpcId);
			const coreNetworkId = entityId("core-network", "core_network");
			entities.push({
				id: attachmentId,
				kind: "network-attachment",
				name: vpc.name,
				...(source.accountId && { accountId: source.accountId }),
				region: vpc.region,
				properties: { segment: vpc.segment },
				provenance,
			});
			if (!entities.some((entity) => entity.id === coreNetworkId))
				entities.push({
					id: coreNetworkId,
					kind: "core-network",
					name: "core_network",
					properties: {},
					provenance,
				});
			relationships.push(relationship("vpc-has-network-attachment", vpcId, attachmentId, provenance));
			relationships.push(
				relationship("network-attachment-targets-core-network", attachmentId, coreNetworkId, provenance),
			);
		}

		if (vpc.vpc_endpoints?.enabled !== false) {
			for (const [endpointType, services] of [
				["interface", vpc.vpc_endpoints?.interface ?? []],
				["gateway", vpc.vpc_endpoints?.gateway ?? []],
			] as const)
				for (const service of services) {
					const endpointId = entityId("vpc-endpoint", `${vpcId}:${service}`);
					entities.push({
						id: endpointId,
						kind: "vpc-endpoint",
						name: service,
						...(source.accountId && { accountId: source.accountId }),
						region: vpc.region,
						properties: { endpointType },
						provenance,
					});
				}
		}
	}
	return { entities, relationships, warnings: [] };
}

function extractAccountYaml(
	source: TerraformTopologySource,
	document: z.infer<typeof AccountYamlSchema>,
): LandingZoneTopologySnapshot {
	const entities: LandingZoneTopologyEntity[] = [];
	const relationships: LandingZoneTopologyRelationship[] = [];
	for (const [environmentName, environment] of Object.entries(document.environments)) {
		const address = `yaml.environments[${JSON.stringify(environmentName)}]`;
		const provenance = desiredProvenance(source, address);
		const accountId = entityId(
			"aws-account",
			`${source.repository}:${source.path}:${document.application_name}:${environmentName}`,
		);
		const ouId = entityId("organizational-unit", environment.ou_id);
		entities.push({
			id: accountId,
			kind: "aws-account",
			name: `${document.application_name}-${environmentName}`,
			properties: { applicationName: document.application_name, environment: environmentName },
			provenance,
		});
		if (!entities.some((entity) => entity.id === ouId))
			entities.push({
				id: ouId,
				kind: "organizational-unit",
				name: environment.ou_id,
				properties: {},
				provenance,
			});
		relationships.push(relationship("ou-contains-account", ouId, accountId, provenance));

		for (const region of Array.isArray(environment.region) ? environment.region : [environment.region]) {
			if (!entities.some((entity) => entity.kind === "region" && entity.id === region))
				entities.push({
					id: region,
					kind: "region",
					name: region,
					region,
					properties: {},
					provenance,
				});
			if (environment.vpc_netmask === undefined) continue;
			const vpcId = entityId("vpc", `${accountId}:${region}`);
			entities.push({
				id: vpcId,
				kind: "vpc",
				name: `${document.application_name}-${environmentName}-${region}`,
				region,
				properties: { requestedNetmask: environment.vpc_netmask },
				provenance,
			});
			relationships.push(relationship("account-owns-vpc", accountId, vpcId, provenance));
			relationships.push(relationship("vpc-located-in-region", vpcId, region, provenance));
		}
	}
	return { entities, relationships, warnings: [] };
}

function extractPostVendingYaml(
	source: TerraformTopologySource,
	document: z.infer<typeof PostVendingYamlSchema>,
): LandingZoneTopologySnapshot {
	const entities: LandingZoneTopologyEntity[] = [];
	const relationships: LandingZoneTopologyRelationship[] = [];
	for (const [environmentName, environment] of Object.entries(document.environments)) {
		const provenance = desiredProvenance(source, `yaml.environments[${JSON.stringify(environmentName)}]`);
		if (!entities.some((entity) => entity.id === environment.account_id))
			entities.push({
				id: environment.account_id,
				kind: "aws-account",
				name: `${document.application_name}-${environmentName}`,
				accountId: environment.account_id,
				properties: { applicationName: document.application_name, environment: environmentName },
				provenance,
			});
		const vpcs = environment.vpcs ?? [{ vpc_id: environment.vpc_id ?? "", region: environment.region ?? "" }];
		for (const vpc of vpcs) {
			if (!entities.some((entity) => entity.id === vpc.region))
				entities.push({
					id: vpc.region,
					kind: "region",
					name: vpc.region,
					region: vpc.region,
					properties: {},
					provenance,
				});
			entities.push({
				id: vpc.vpc_id,
				kind: "vpc",
				name: `${document.application_name}-${environmentName}-${vpc.region}`,
				accountId: environment.account_id,
				region: vpc.region,
				properties: {},
				provenance,
			});
			relationships.push(relationship("account-owns-vpc", environment.account_id, vpc.vpc_id, provenance));
			relationships.push(relationship("vpc-located-in-region", vpc.vpc_id, vpc.region, provenance));
		}
	}
	return { entities, relationships, warnings: [] };
}

export function extractTerraformDesiredTopology(source: TerraformTopologySource): LandingZoneTopologySnapshot {
	const parsedSource = z
		.object({
			repository: z.string().min(1),
			path: z.string().min(1),
			commitSha: z.string().min(1),
			sourceTimestamp: z.string().datetime(),
			content: z.string(),
			state: z.enum(["desired", "proposed"]).optional(),
			mergeRequestUrl: z.url().optional(),
			accountId: z.string().min(1).optional(),
			region: z.string().min(1).optional(),
		})
		.strict()
		.parse(source);
	if (/\.ya?ml$/i.test(parsedSource.path)) {
		const document = parseYaml(parsedSource.content);
		const workload = WorkloadVpcYamlSchema.safeParse(document);
		if (workload.success) return extractWorkloadVpcYaml(parsedSource, workload.data);
		const postVending = PostVendingYamlSchema.safeParse(document);
		if (postVending.success) return extractPostVendingYaml(parsedSource, postVending.data);
		const account = AccountYamlSchema.safeParse(document);
		if (account.success) return extractAccountYaml(parsedSource, account.data);
		throw new Error(
			`Unsupported or invalid Landing Zone topology YAML: ${workload.error.message}; ${postVending.error.message}; ${account.error.message}`,
		);
	}
	const resources = resourceBlocks(parsedSource.content);
	const entities: LandingZoneTopologyEntity[] = [];
	const relationships: LandingZoneTopologyRelationship[] = [];
	const byAddress = new Map<string, LandingZoneTopologyEntity>();

	for (const resource of resources) {
		const kind = resourceKinds[resource.type];
		if (!kind) continue;
		const provenance = desiredProvenance(parsedSource, resource.address);
		const properties: Record<string, string | number | boolean> = {};
		const cidr = attribute(resource.body, "cidr_block");
		const name = attribute(resource.body, "name") ?? resource.name;
		if (cidr) properties.cidr = cidr;
		if (kind === "subnet") properties.classification = attribute(resource.body, "subnet_classification") ?? "unknown";
		if (kind === "dns-record") {
			const recordType = attribute(resource.body, "type");
			if (recordType) properties.type = recordType;
		}
		if (kind === "resolver-endpoint") {
			const direction = attribute(resource.body, "direction");
			if (direction) properties.direction = direction;
		}
		if (kind === "resolver-rule") {
			const domain = attribute(resource.body, "domain_name");
			if (domain) properties.domain = domain;
		}
		if (kind === "vpc-endpoint") {
			const privateDnsEnabled = attribute(resource.body, "private_dns_enabled");
			if (privateDnsEnabled) properties.privateDnsEnabled = privateDnsEnabled === "true";
		}
		const entity = LandingZoneTopologyEntitySchema.parse({
			id: entityId(kind, `${parsedSource.repository}:${parsedSource.path}:${resource.address}`),
			kind,
			name,
			...(parsedSource.accountId && { accountId: parsedSource.accountId }),
			...(parsedSource.region && { region: parsedSource.region }),
			properties,
			provenance,
		});
		entities.push(entity);
		byAddress.set(resource.address, entity);
	}
	if (parsedSource.accountId) {
		const accountId = parsedSource.accountId;
		const provenance = desiredProvenance(parsedSource, "context.account");
		entities.push({
			id: accountId,
			kind: "aws-account",
			name: parsedSource.accountId,
			accountId: parsedSource.accountId,
			properties: {},
			provenance,
		});
		for (const vpc of entities.filter((entity) => entity.kind === "vpc"))
			relationships.push(relationship("account-owns-vpc", accountId, vpc.id, vpc.provenance));
	}
	if (parsedSource.region) {
		const regionId = parsedSource.region;
		const provenance = desiredProvenance(parsedSource, "context.region");
		entities.push({
			id: regionId,
			kind: "region",
			name: parsedSource.region,
			region: parsedSource.region,
			properties: {},
			provenance,
		});
		for (const vpc of entities.filter((entity) => entity.kind === "vpc"))
			relationships.push(relationship("vpc-located-in-region", vpc.id, regionId, vpc.provenance));
	}

	for (const resource of resources) {
		const current = byAddress.get(resource.address);
		const provenance = current?.provenance ?? desiredProvenance(parsedSource, resource.address);
		if (resource.type === "aws_subnet") {
			if (!current) continue;
			addReferenceRelationship(
				relationships,
				byAddress,
				"vpc-contains-subnet",
				reference(attribute(resource.body, "vpc_id")),
				resource.address,
				provenance,
			);
			const availabilityZone = attribute(resource.body, "availability_zone");
			if (availabilityZone) {
				const azId = entityId("availability-zone", availabilityZone);
				if (!entities.some((entity) => entity.id === azId))
					entities.push({
						id: azId,
						kind: "availability-zone",
						name: availabilityZone,
						region: availabilityZone.slice(0, -1),
						properties: {},
						provenance,
					});
				relationships.push(relationship("subnet-located-in-availability-zone", current.id, azId, provenance));
			}
		}
		if (resource.type === "aws_organizations_organizational_unit") {
			addReferenceRelationship(
				relationships,
				byAddress,
				"organization-contains-ou",
				reference(attribute(resource.body, "parent_id")),
				resource.address,
				provenance,
			);
		}
		if (resource.type === "aws_organizations_account") {
			addReferenceRelationship(
				relationships,
				byAddress,
				"ou-contains-account",
				reference(attribute(resource.body, "parent_id")),
				resource.address,
				provenance,
			);
		}
		if (resource.type === "aws_route_table_association") {
			addReferenceRelationship(
				relationships,
				byAddress,
				"subnet-uses-route-table",
				reference(attribute(resource.body, "subnet_id")),
				reference(attribute(resource.body, "route_table_id")),
				provenance,
			);
		}
		if (resource.type === "aws_network_acl_association") {
			addReferenceRelationship(
				relationships,
				byAddress,
				"subnet-protected-by-network-acl",
				reference(attribute(resource.body, "subnet_id")),
				reference(attribute(resource.body, "network_acl_id")),
				provenance,
			);
		}
		if (
			resource.type === "aws_networkmanager_vpc_attachment" ||
			resource.type === "aws_ec2_transit_gateway_vpc_attachment"
		) {
			const vpcReference = reference(attribute(resource.body, "vpc_arn") ?? attribute(resource.body, "vpc_id"));
			addReferenceRelationship(
				relationships,
				byAddress,
				"vpc-has-network-attachment",
				vpcReference,
				resource.address,
				provenance,
			);
			addReferenceRelationship(
				relationships,
				byAddress,
				resource.type === "aws_networkmanager_vpc_attachment"
					? "network-attachment-targets-core-network"
					: "network-attachment-targets-transit-gateway",
				resource.address,
				reference(attribute(resource.body, "core_network_id") ?? attribute(resource.body, "transit_gateway_id")),
				provenance,
			);
		}
		if (resource.type === "aws_route") {
			if (!current) continue;
			addReferenceRelationship(
				relationships,
				byAddress,
				"route-table-has-route",
				reference(attribute(resource.body, "route_table_id")),
				resource.address,
				provenance,
			);
			const destination =
				attribute(resource.body, "destination_cidr_block") ?? attribute(resource.body, "destination_ipv6_cidr_block");
			if (destination) {
				const cidrId = entityId("cidr-block", destination);
				if (!entities.some((entity) => entity.id === cidrId))
					entities.push({
						id: cidrId,
						kind: "cidr-block",
						name: destination,
						properties: { cidr: destination },
						provenance,
					});
				relationships.push(relationship("route-destines-cidr", current.id, cidrId, provenance));
			}
			for (const [field, kind] of [
				["gateway_id", "route-targets-internet-gateway"],
				["nat_gateway_id", "route-targets-nat-gateway"],
				["transit_gateway_id", "route-targets-transit-gateway"],
				["core_network_arn", "route-targets-core-network"],
				["vpc_endpoint_id", "route-targets-vpc-endpoint"],
			] as const) {
				addReferenceRelationship(
					relationships,
					byAddress,
					kind,
					resource.address,
					reference(attribute(resource.body, field)),
					provenance,
				);
			}
		}
		if (resource.type === "aws_route53_zone_association") {
			addReferenceRelationship(
				relationships,
				byAddress,
				"vpc-associated-with-hosted-zone",
				reference(attribute(resource.body, "vpc_id")),
				reference(attribute(resource.body, "zone_id")),
				provenance,
			);
		}
		if (resource.type === "aws_route53_record") {
			if (!current) continue;
			addReferenceRelationship(
				relationships,
				byAddress,
				"hosted-zone-contains-dns-record",
				reference(attribute(resource.body, "zone_id")),
				resource.address,
				provenance,
			);
			for (const target of stringList(attribute(resource.body, "records"))) {
				if (!z.ipv4().safeParse(target).success && !z.ipv6().safeParse(target).success) continue;
				const ipId = entityId("ip-address", target);
				if (!entities.some((entity) => entity.id === ipId))
					entities.push({ id: ipId, kind: "ip-address", name: target, properties: { ip: target }, provenance });
				relationships.push(relationship("dns-record-resolves-to-ip", current.id, ipId, provenance));
			}
			addReferenceRelationship(
				relationships,
				byAddress,
				"dns-record-resolves-to-load-balancer",
				resource.address,
				aliasTargetReference(resource.body),
				provenance,
			);
		}
		if (resource.type === "aws_route53_resolver_rule") {
			addReferenceRelationship(
				relationships,
				byAddress,
				"resolver-rule-forwards-to-endpoint",
				resource.address,
				reference(attribute(resource.body, "resolver_endpoint_id")),
				provenance,
			);
		}
		if (resource.type === "aws_route53_resolver_rule_association") {
			addReferenceRelationship(
				relationships,
				byAddress,
				"vpc-uses-resolver-rule",
				reference(attribute(resource.body, "vpc_id")),
				reference(attribute(resource.body, "resolver_rule_id")),
				provenance,
			);
		}
	}

	const defaultRoutes = new Map<string, LandingZoneTopologyRelationshipKind>();
	for (const route of entities.filter((entity) => entity.kind === "route")) {
		const destination = relationships.find((edge) => edge.kind === "route-destines-cidr" && edge.from === route.id);
		const destinationEntity = destination ? entities.find((entity) => entity.id === destination.to) : undefined;
		if (destinationEntity?.properties.cidr !== "0.0.0.0/0" && destinationEntity?.properties.cidr !== "::/0") continue;
		const target = relationships.find((edge) => edge.from === route.id && edge.kind.startsWith("route-targets-"));
		const table = relationships.find((edge) => edge.kind === "route-table-has-route" && edge.to === route.id);
		if (target && table) defaultRoutes.set(table.from, target.kind);
	}
	for (const association of relationships.filter((edge) => edge.kind === "subnet-uses-route-table")) {
		const subnet = entities.find((entity) => entity.id === association.from);
		if (subnet?.properties.classification !== "unknown") continue;
		const target = defaultRoutes.get(association.to);
		if (target === "route-targets-internet-gateway") subnet.properties.classification = "public";
		else if (target) subnet.properties.classification = "private";
		else subnet.properties.classification = "isolated";
	}

	const warnings: string[] = [];
	if (
		entities.some((entity) => entity.kind === "dns-record") &&
		!relationships.some((edge) => edge.kind === "vpc-associated-with-hosted-zone")
	)
		warnings.push("DNS records are present without a recorded hosted-zone VPC association");
	if (
		relationships.some((edge) => edge.kind === "resolver-rule-forwards-to-endpoint") &&
		!relationships.some((edge) => edge.kind.startsWith("route-targets-"))
	)
		warnings.push("Resolver forwarding is present without a recorded route target for the endpoint");
	if (entities.some((entity) => entity.kind === "vpc-endpoint" && entity.properties.privateDnsEnabled === false))
		warnings.push("A VPC endpoint has private DNS disabled; DNS resolution must be proven separately");
	return { entities, relationships, warnings };
}

const AwsObservationSchema = z
	.object({
		accountId: z.string().min(1),
		region: z.string().min(1),
		observedAt: z.string().datetime(),
		vpcs: z.array(
			z
				.object({
					vpcId: z.string().min(1),
					cidrBlock: z.string().optional(),
					tags: z.record(z.string(), z.string()).optional(),
				})
				.strict(),
		),
		subnets: z.array(
			z
				.object({
					subnetId: z.string().min(1),
					vpcId: z.string().min(1),
					cidrBlock: z.string().optional(),
					availabilityZone: z.string().optional(),
					tags: z.record(z.string(), z.string()).optional(),
				})
				.strict(),
		),
		routeTables: z.array(
			z
				.object({
					routeTableId: z.string().min(1),
					vpcId: z.string().min(1),
					associations: z.array(z.object({ subnetId: z.string().min(1) }).strict()).optional(),
					routes: z
						.array(
							z
								.object({
									destinationCidrBlock: z.string().min(1),
									gatewayId: z.string().min(1).optional(),
									natGatewayId: z.string().min(1).optional(),
									transitGatewayId: z.string().min(1).optional(),
									vpcEndpointId: z.string().min(1).optional(),
									coreNetworkArn: z.string().min(1).optional(),
								})
								.strict(),
						)
						.optional(),
				})
				.strict(),
		),
		natGateways: z
			.array(z.object({ natGatewayId: z.string().min(1), subnetId: z.string().min(1) }).strict())
			.optional(),
		hostedZones: z.array(
			z
				.object({ hostedZoneId: z.string().min(1), name: z.string().min(1), vpcIds: z.array(z.string().min(1)) })
				.strict(),
		),
	})
	.strict();

export type AwsTopologyObservation = z.input<typeof AwsObservationSchema>;

export function adaptAwsObservedTopology(input: AwsTopologyObservation): LandingZoneTopologySnapshot {
	const observation = AwsObservationSchema.parse(input);
	const provenance = (resourceId: string): TopologyProvenance => ({
		state: "observed",
		source: "aws-api",
		resourceId,
		observedAt: observation.observedAt,
	});
	const entities: LandingZoneTopologyEntity[] = [];
	const relationships: LandingZoneTopologyRelationship[] = [];
	const accountEntityId = observation.accountId;
	const regionEntityId = observation.region;
	entities.push({
		id: accountEntityId,
		kind: "aws-account",
		name: observation.accountId,
		accountId: observation.accountId,
		properties: {},
		provenance: provenance(observation.accountId),
	});
	entities.push({
		id: regionEntityId,
		kind: "region",
		name: observation.region,
		region: observation.region,
		properties: {},
		provenance: provenance(observation.region),
	});
	for (const vpc of observation.vpcs) {
		const vpcEntityId = vpc.vpcId;
		entities.push({
			id: vpcEntityId,
			kind: "vpc",
			accountId: observation.accountId,
			region: observation.region,
			properties: { ...(vpc.cidrBlock && { cidr: vpc.cidrBlock }) },
			provenance: provenance(vpc.vpcId),
		});
		relationships.push(relationship("account-owns-vpc", accountEntityId, vpcEntityId, provenance(vpc.vpcId)));
		relationships.push(relationship("vpc-located-in-region", vpcEntityId, regionEntityId, provenance(vpc.vpcId)));
	}
	for (const subnet of observation.subnets) {
		const subnetId = subnet.subnetId;
		entities.push({
			id: subnetId,
			kind: "subnet",
			accountId: observation.accountId,
			region: observation.region,
			properties: { ...(subnet.cidrBlock && { cidr: subnet.cidrBlock }), classification: "unknown" },
			provenance: provenance(subnet.subnetId),
		});
		relationships.push(relationship("vpc-contains-subnet", subnet.vpcId, subnetId, provenance(subnet.subnetId)));
		if (subnet.availabilityZone) {
			const azId = subnet.availabilityZone;
			if (!entities.some((entity) => entity.id === azId))
				entities.push({
					id: azId,
					kind: "availability-zone",
					name: subnet.availabilityZone,
					region: observation.region,
					properties: {},
					provenance: provenance(subnet.availabilityZone),
				});
			relationships.push(
				relationship("subnet-located-in-availability-zone", subnetId, azId, provenance(subnet.subnetId)),
			);
		}
	}
	for (const table of observation.routeTables) {
		const tableId = table.routeTableId;
		entities.push({
			id: tableId,
			kind: "route-table",
			accountId: observation.accountId,
			region: observation.region,
			properties: { vpcId: table.vpcId },
			provenance: provenance(table.routeTableId),
		});
		for (const association of table.associations ?? [])
			relationships.push(
				relationship("subnet-uses-route-table", association.subnetId, tableId, provenance(table.routeTableId)),
			);
		for (const [index, route] of (table.routes ?? []).entries()) {
			const targets = [
				[route.gatewayId, "internet-gateway", "route-targets-internet-gateway"],
				[route.natGatewayId, "nat-gateway", "route-targets-nat-gateway"],
				[route.transitGatewayId, "transit-gateway", "route-targets-transit-gateway"],
				[route.coreNetworkArn, "core-network", "route-targets-core-network"],
				[route.vpcEndpointId, "vpc-endpoint", "route-targets-vpc-endpoint"],
			] as const;
			const target = targets.find(([id]) => id);
			const routeIdentity = `${table.routeTableId}:${route.destinationCidrBlock}:${target?.[0] ?? index}`;
			const routeEntityId = routeIdentity;
			const cidrId = route.destinationCidrBlock;
			entities.push({
				id: routeEntityId,
				kind: "route",
				accountId: observation.accountId,
				region: observation.region,
				properties: {},
				provenance: provenance(routeIdentity),
			});
			if (!entities.some((entity) => entity.id === cidrId))
				entities.push({
					id: cidrId,
					kind: "cidr-block",
					name: route.destinationCidrBlock,
					properties: { cidr: route.destinationCidrBlock },
					provenance: provenance(routeIdentity),
				});
			relationships.push(relationship("route-table-has-route", tableId, routeEntityId, provenance(routeIdentity)));
			relationships.push(relationship("route-destines-cidr", routeEntityId, cidrId, provenance(routeIdentity)));
			if (target?.[0]) {
				const targetId = target[0];
				if (!entities.some((entity) => entity.id === targetId))
					entities.push({
						id: targetId,
						kind: target[1],
						name: target[0],
						accountId: observation.accountId,
						region: observation.region,
						properties: {},
						provenance: provenance(target[0]),
					});
				relationships.push(relationship(target[2], routeEntityId, targetId, provenance(routeIdentity)));
			}
		}
	}
	for (const nat of observation.natGateways ?? []) {
		const natId = nat.natGatewayId;
		if (!entities.some((entity) => entity.id === natId))
			entities.push({
				id: natId,
				kind: "nat-gateway",
				name: nat.natGatewayId,
				accountId: observation.accountId,
				region: observation.region,
				properties: { subnetId: nat.subnetId },
				provenance: provenance(nat.natGatewayId),
			});
	}
	for (const zone of observation.hostedZones) {
		const zoneId = zone.hostedZoneId;
		entities.push({
			id: zoneId,
			kind: "hosted-zone",
			name: zone.name,
			accountId: observation.accountId,
			region: observation.region,
			properties: {},
			provenance: provenance(zone.hostedZoneId),
		});
		for (const vpcId of zone.vpcIds)
			relationships.push(relationship("vpc-associated-with-hosted-zone", vpcId, zoneId, provenance(zone.hostedZoneId)));
	}
	const defaultTargets = new Map<string, LandingZoneTopologyRelationshipKind>();
	for (const route of entities.filter((entity) => entity.kind === "route")) {
		const destination = relationships.find((edge) => edge.kind === "route-destines-cidr" && edge.from === route.id);
		const cidr = destination ? entities.find((entity) => entity.id === destination.to)?.properties.cidr : undefined;
		if (cidr !== "0.0.0.0/0" && cidr !== "::/0") continue;
		const table = relationships.find((edge) => edge.kind === "route-table-has-route" && edge.to === route.id);
		const target = relationships.find((edge) => edge.from === route.id && edge.kind.startsWith("route-targets-"));
		if (table && target) defaultTargets.set(table.from, target.kind);
	}
	for (const association of relationships.filter((edge) => edge.kind === "subnet-uses-route-table")) {
		const subnet = entities.find((entity) => entity.id === association.from);
		if (!subnet) continue;
		const target = defaultTargets.get(association.to);
		subnet.properties.classification =
			target === "route-targets-internet-gateway" ? "public" : target ? "private" : "isolated";
	}
	return { entities, relationships, warnings: [] };
}
