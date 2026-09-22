import { describe, expect, test } from "bun:test";
import type { GitLabReadClient } from "./repositories.ts";
import { extractTerraformTopology } from "./topology.ts";

describe("Terraform topology extraction", () => {
	test("links account, VPC, subnet, route, and DNS facts to file evidence", async () => {
		const client = {
			async project() {
				return { id: 1, defaultBranch: "main", headSha: "sha-1", lastActivityAt: "2026-09-22" };
			},
			async readFile() {
				return {
					blobId: "blob-1",
					size: 400,
					content: `
resource "aws_vpc" "workload" { cidr_block = "10.0.0.0/16" }
resource "aws_subnet" "private_a" { vpc_id = aws_vpc.workload.id }
resource "aws_route_table" "private" { vpc_id = aws_vpc.workload.id }
resource "aws_route53_record" "service" { name = "service.example.com" }
`,
				};
			},
		} as unknown as GitLabReadClient;

		const topology = await extractTerraformTopology(client, {
			repository: "aws-lz-network-workloads",
			paths: ["environments/dev/main.tf"],
		});

		expect(topology.nodes.map((node) => node.kind)).toEqual(["vpc", "subnet", "route-table", "dns-record"]);
		expect(topology.nodes.every((node) => node.evidenceId === topology.evidence[0]?.id)).toBe(true);
		expect(topology.provenance.ref).toBe("sha-1");
	});

	test("keeps repeated local names distinct across files and does not infer a parent when a file has several VPCs", async () => {
		const client = {
			async project() {
				return { id: 1, defaultBranch: "main", headSha: "sha-1", lastActivityAt: "2026-09-22" };
			},
			async readFile(_projectPath: string, path: string) {
				return {
					blobId: `blob:${path}`,
					size: 200,
					content:
						path === "dev.tf"
							? 'resource "aws_vpc" "this" {}\nresource "aws_subnet" "private" {}'
							: 'resource "aws_vpc" "this" {}\nresource "aws_vpc" "peer" {}\nresource "aws_subnet" "private" {}',
				};
			},
		} as unknown as GitLabReadClient;

		const topology = await extractTerraformTopology(client, {
			repository: "aws-lz-network-workloads",
			paths: ["dev.tf", "prd.tf"],
		});

		expect(topology.nodes.filter((node) => node.name === "this")).toHaveLength(2);
		expect(topology.nodes.filter((node) => node.name === "private")).toHaveLength(2);
		expect(topology.edges).toHaveLength(1);
		expect(topology.edges[0]?.evidenceId).toContain("dev.tf");
	});
});
