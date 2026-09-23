import { describe, expect, test } from "bun:test";
import { adaptAwsObservedTopology, extractTerraformDesiredTopology } from "./topology-extractor.ts";

const provenance = {
	repository: "pvhcorp/dhco/aws/aws-landing-zone/aws-lz-network-workloads",
	path: "environments/dev/vpcs/example.tf",
	commitSha: "abc123",
	sourceTimestamp: "2026-09-22T10:00:00.000Z",
};

describe("Landing Zone topology extraction", () => {
	test("extracts the schema-backed workload VPC YAML surface", () => {
		const result = extractTerraformDesiredTopology({
			...provenance,
			path: "environments/prd/vpcs/aws-example-prd.yaml",
			accountId: "111122223333",
			content: `
vpcs:
  - name: aws-example-prd
    segment: prod
    region: eu-central-1
    ipam_pool_name: eu-prod-workload-pool
    ipam_netmask_length: 24
    availability_zones: 3
    cloudwan_attachment: true
    enable_public_access: false
    tags:
      Owner: owner@pvh.com
    vpc_endpoints:
      enabled: true
      interface: [ssm]
      gateway: [s3]
    subnets:
      workload:
        technical_name: workload
        subnet_category: workload
        availability_zones: 2
        ipam_netmask_length: 27
        routing:
          type: custom
          routes:
            - destination: 0.0.0.0/0
              target_type: cloud_wan
              target_reference: core_network
`,
		});

		expect(result.entities.some((entity) => entity.kind === "vpc" && entity.name === "aws-example-prd")).toBeTrue();
		expect(result.entities.filter((entity) => entity.kind === "subnet")).toHaveLength(2);
		expect(result.entities.find((entity) => entity.kind === "subnet")?.properties.classification).toBe("private");
		expect(result.relationships.some((edge) => edge.kind === "route-targets-core-network")).toBeTrue();
		expect(result.relationships.some((edge) => edge.kind === "vpc-has-network-attachment")).toBeTrue();
		expect(result.entities.filter((entity) => entity.kind === "vpc-endpoint")).toHaveLength(2);
		expect(JSON.stringify(result)).not.toContain("owner@pvh.com");
	});

	test("extracts account requests without treating unassigned account and VPC IDs as observed", () => {
		const result = extractTerraformDesiredTopology({
			...provenance,
			repository: "pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator",
			path: "accounts/martech.yml",
			content: `
application_name: martech
common:
  owner: owner@pvh.com
environments:
  dev:
    region: [eu-central-1]
    ou_id: ou-kapu-ske24tyb
    vpc_netmask: 24
`,
		});

		const account = result.entities.find((entity) => entity.kind === "aws-account");
		const vpc = result.entities.find((entity) => entity.kind === "vpc");
		expect(account?.id).toContain("aws-account:");
		expect(account?.accountId).toBeUndefined();
		expect(vpc?.properties.requestedNetmask).toBe(24);
		expect(result.relationships.some((edge) => edge.kind === "ou-contains-account")).toBeTrue();
		expect(result.relationships.some((edge) => edge.kind === "account-owns-vpc")).toBeTrue();
		expect(JSON.stringify(result)).not.toContain("owner@pvh.com");
	});

	test("extracts both active post-vending VPC inventory shapes", () => {
		const single = extractTerraformDesiredTopology({
			...provenance,
			repository: "pvhcorp/dhco/aws/aws-landing-zone/aws-lz-post-vending",
			path: "workloads/bartender.yml",
			content: `
application_name: bartender
environments:
  prd:
    account_id: "460223323058"
    vpc_id: vpc-087af2e6a03e82ee9
    region: eu-central-1
`,
		});
		const multiple = extractTerraformDesiredTopology({
			...provenance,
			repository: "pvhcorp/dhco/aws/aws-landing-zone/aws-lz-post-vending",
			path: "workloads/security-gis.yml",
			content: `
application_name: gis
environments:
  prd:
    account_id: "717916807622"
    vpcs:
      - vpc_id: vpc-0685292a589e32f6e
        region: eu-central-1
      - vpc_id: vpc-006f26f619fb31c2c
        region: us-east-1
`,
		});

		expect(single.entities.find((entity) => entity.kind === "vpc")?.id).toBe("vpc-087af2e6a03e82ee9");
		expect(single.relationships.some((edge) => edge.kind === "account-owns-vpc")).toBeTrue();
		expect(multiple.entities.filter((entity) => entity.kind === "vpc")).toHaveLength(2);
		expect(multiple.entities.filter((entity) => entity.kind === "region")).toHaveLength(2);
	});

	test("extracts approved Terraform fields with address and file provenance", () => {
		const result = extractTerraformDesiredTopology({
			...provenance,
			accountId: "111122223333",
			region: "eu-central-1",
			content: `
resource "aws_vpc" "workload" {
  cidr_block = "10.42.0.0/16"
}
resource "aws_subnet" "misleading_public_name" {
  vpc_id            = aws_vpc.workload.id
  cidr_block        = "10.42.1.0/24"
  availability_zone = "eu-central-1a"
}
resource "aws_route_table" "egress" { vpc_id = aws_vpc.workload.id }
resource "aws_route_table_association" "workload" {
  subnet_id      = aws_subnet.misleading_public_name.id
  route_table_id = aws_route_table.egress.id
}
resource "aws_nat_gateway" "egress" { subnet_id = aws_subnet.misleading_public_name.id }
resource "aws_route" "default" {
  route_table_id         = aws_route_table.egress.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.egress.id
}
`,
		});

		expect(result.entities.find((entity) => entity.kind === "vpc")?.provenance).toMatchObject({
			state: "desired",
			repository: provenance.repository,
			filePath: provenance.path,
			commitSha: provenance.commitSha,
			terraformAddress: "aws_vpc.workload",
		});
		expect(result.entities.find((entity) => entity.kind === "subnet")?.properties.classification).toBe("private");
		expect(result.relationships.some((relationship) => relationship.kind === "subnet-uses-route-table")).toBeTrue();
		expect(result.relationships.some((relationship) => relationship.kind === "route-targets-nat-gateway")).toBeTrue();
		expect(result.relationships.some((relationship) => relationship.kind === "account-owns-vpc")).toBeTrue();
		expect(result.relationships.some((relationship) => relationship.kind === "vpc-located-in-region")).toBeTrue();
	});

	test("surfaces DNS and routing gaps without treating resolution as reachability", () => {
		const result = extractTerraformDesiredTopology({
			...provenance,
			content: `
resource "aws_vpc" "workload" { cidr_block = "10.42.0.0/16" }
resource "aws_route_table" "local_only" { vpc_id = aws_vpc.workload.id }
resource "aws_route53_zone" "private" { name = "internal.example.com" }
resource "aws_route53_record" "api" {
  zone_id = aws_route53_zone.private.zone_id
  name    = "api.internal.example.com"
  type    = "A"
  records = ["10.42.2.10"]
}
resource "aws_lb" "api" { name = "api" }
resource "aws_route53_record" "api_alias" {
  zone_id = aws_route53_zone.private.zone_id
  name    = "alias.internal.example.com"
  type    = "A"
  alias {
    name    = aws_lb.api.dns_name
    zone_id = aws_lb.api.zone_id
  }
}
resource "aws_route53_resolver_endpoint" "outbound" { name = "outbound" }
resource "aws_route53_resolver_rule" "corp" {
  domain_name         = "corp.example.com"
  resolver_endpoint_id = aws_route53_resolver_endpoint.outbound.id
}
resource "aws_vpc_endpoint" "service" {
  vpc_id              = aws_vpc.workload.id
  private_dns_enabled = false
}
`,
		});

		expect(result.relationships.some((edge) => edge.kind === "resolver-rule-forwards-to-endpoint")).toBeTrue();
		expect(result.relationships.some((edge) => edge.kind === "dns-record-resolves-to-load-balancer")).toBeTrue();
		expect(result.warnings).toContain("DNS records are present without a recorded hosted-zone VPC association");
		expect(result.warnings).toContain(
			"Resolver forwarding is present without a recorded route target for the endpoint",
		);
		expect(result.warnings).toContain(
			"A VPC endpoint has private DNS disabled; DNS resolution must be proven separately",
		);
	});

	test("does not classify a subnet from its name and keeps DNS separate from routing", () => {
		const result = extractTerraformDesiredTopology({
			...provenance,
			content: `
resource "aws_vpc" "workload" { cidr_block = "10.42.0.0/16" }
resource "aws_subnet" "public_by_name_only" {
  vpc_id     = aws_vpc.workload.id
  cidr_block = "10.42.2.0/24"
}
resource "aws_route53_zone" "private" { name = "internal.example.com" }
resource "aws_route53_zone_association" "workload" {
  zone_id = aws_route53_zone.private.zone_id
  vpc_id  = aws_vpc.workload.id
}
resource "aws_route53_record" "api" {
  zone_id = aws_route53_zone.private.zone_id
  name    = "api.internal.example.com"
  type    = "A"
  records = ["10.42.2.10"]
}
`,
		});

		expect(result.entities.find((entity) => entity.kind === "subnet")?.properties.classification).toBe("unknown");
		expect(
			result.relationships.some((relationship) => relationship.kind === "vpc-associated-with-hosted-zone"),
		).toBeTrue();
		expect(result.relationships.some((relationship) => relationship.kind.startsWith("route-targets-"))).toBeFalse();
	});

	test("adapts only allowlisted AWS fields and drops tags and secret-like values", () => {
		const result = adaptAwsObservedTopology({
			accountId: "111122223333",
			region: "eu-central-1",
			observedAt: "2026-09-22T10:30:00.000Z",
			vpcs: [{ vpcId: "vpc-1", cidrBlock: "10.42.0.0/16", tags: { Name: "workload", password: "secret" } }],
			subnets: [
				{
					subnetId: "subnet-1",
					vpcId: "vpc-1",
					cidrBlock: "10.42.1.0/24",
					availabilityZone: "eu-central-1a",
					tags: { token: "do-not-store" },
				},
			],
			routeTables: [
				{
					routeTableId: "rtb-1",
					vpcId: "vpc-1",
					associations: [{ subnetId: "subnet-1" }],
					routes: [{ destinationCidrBlock: "0.0.0.0/0", natGatewayId: "nat-1" }],
				},
			],
			natGateways: [{ natGatewayId: "nat-1", subnetId: "subnet-1" }],
			hostedZones: [],
		});

		expect(result.entities[0]?.provenance).toMatchObject({ state: "observed", source: "aws-api" });
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(JSON.stringify(result)).not.toContain("do-not-store");
		expect(result.relationships.some((edge) => edge.kind === "subnet-uses-route-table")).toBeTrue();
		expect(result.entities.find((entity) => entity.kind === "subnet")?.properties.classification).toBe("private");
	});
});
