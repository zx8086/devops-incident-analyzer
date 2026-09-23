import { describe, expect, test } from "bun:test";
import type { LandingZoneTopologySnapshot } from "./topology-extractor.ts";
import { reconcileTopology } from "./topology-reconcile.ts";

const desiredVpc: LandingZoneTopologySnapshot["entities"][number] = {
	id: "vpc:vpc-1",
	kind: "vpc",
	name: "workload",
	properties: { cidr: "10.0.0.0/16" },
	provenance: {
		state: "desired",
		source: "terraform",
		repository: "group/repo",
		filePath: "main.tf",
		commitSha: "abc",
		terraformAddress: "aws_vpc.workload",
		sourceTimestamp: "2026-09-22T10:00:00.000Z",
	},
};

const desired: LandingZoneTopologySnapshot = {
	entities: [desiredVpc],
	relationships: [],
	warnings: [],
};

describe("Landing Zone topology reconciliation", () => {
	test("marks equal desired and observed facts aligned", () => {
		const result = reconcileTopology({
			desired,
			observed: {
				entities: [
					{
						...desiredVpc,
						provenance: {
							state: "observed",
							source: "aws-api",
							resourceId: "vpc-1",
							observedAt: "2026-09-22T10:30:00.000Z",
						},
					},
				],
				relationships: [],
				warnings: [],
			},
			missThreshold: 2,
			now: "2026-09-22T10:31:00.000Z",
		});

		expect(result.entities[0]?.reconciliation.status).toBe("aligned");
		expect(result.entities[0]?.validFrom).toBe("2026-09-22T10:31:00.000Z");
	});

	test("matches Terraform and AWS entities by verified account, region, and CIDR when their IDs differ", () => {
		const desiredVpcId = "vpc:group/repo:main.tf:aws_vpc.workload";
		const desiredSubnetId = "subnet:group/repo:main.tf:aws_subnet.workload";
		const result = reconcileTopology({
			desired: {
				entities: [
					{
						...desiredVpc,
						id: desiredVpcId,
						accountId: "111122223333",
						region: "eu-central-1",
					},
					{
						...desiredVpc,
						id: desiredSubnetId,
						kind: "subnet",
						accountId: "111122223333",
						region: "eu-central-1",
						properties: { cidr: "10.0.1.0/24" },
					},
				],
				relationships: [
					{
						id: "desired-vpc-subnet",
						kind: "vpc-contains-subnet",
						from: desiredVpcId,
						to: desiredSubnetId,
						properties: {},
						provenance: desiredVpc.provenance,
					},
				],
				warnings: [],
			},
			observed: {
				entities: [
					{
						id: "vpc-0123456789",
						kind: "vpc",
						accountId: "111122223333",
						region: "eu-central-1",
						name: "workload",
						properties: { cidr: "10.0.0.0/16" },
						provenance: {
							state: "observed",
							source: "aws-api",
							resourceId: "vpc-0123456789",
							observedAt: "2026-09-22T10:30:00.000Z",
						},
					},
					{
						id: "subnet-0123456789",
						kind: "subnet",
						accountId: "111122223333",
						region: "eu-central-1",
						properties: { cidr: "10.0.1.0/24" },
						provenance: {
							state: "observed",
							source: "aws-api",
							resourceId: "subnet-0123456789",
							observedAt: "2026-09-22T10:30:00.000Z",
						},
					},
				],
				relationships: [
					{
						id: "observed-vpc-subnet",
						kind: "vpc-contains-subnet",
						from: "vpc-0123456789",
						to: "subnet-0123456789",
						properties: {},
						provenance: {
							state: "observed",
							source: "aws-api",
							resourceId: "subnet-0123456789",
							observedAt: "2026-09-22T10:30:00.000Z",
						},
					},
				],
				warnings: [],
			},
			missThreshold: 2,
			now: "2026-09-22T10:31:00.000Z",
		});

		expect(result.entities).toHaveLength(2);
		expect(result.entities[0]?.reconciliation.status).toBe("aligned");
		expect(result.entities[0]?.provenance).toHaveLength(2);
		expect(result.relationships).toHaveLength(1);
		expect(result.relationships[0]?.reconciliation.status).toBe("aligned");
	});

	test("aligns a desired inventory reference when AWS adds observed-only metadata", () => {
		const result = reconcileTopology({
			desired: {
				entities: [{ ...desiredVpc, id: "vpc-0123456789", properties: {} }],
				relationships: [],
				warnings: [],
			},
			observed: {
				entities: [
					{
						...desiredVpc,
						id: "vpc-0123456789",
						properties: { cidr: "10.0.0.0/16" },
						provenance: {
							state: "observed",
							source: "aws-api",
							resourceId: "vpc-0123456789",
							observedAt: "2026-09-22T10:30:00.000Z",
						},
					},
				],
				relationships: [],
				warnings: [],
			},
			missThreshold: 2,
			now: "2026-09-22T10:31:00.000Z",
		});

		expect(result.entities[0]?.reconciliation.status).toBe("aligned");
	});

	test("distinguishes drift, pending proposals, and unavailable observations", () => {
		const drifted = reconcileTopology({
			desired,
			observed: {
				entities: [
					{
						...desiredVpc,
						properties: { cidr: "10.1.0.0/16" },
						provenance: {
							state: "observed",
							source: "aws-api",
							resourceId: "vpc-1",
							observedAt: "2026-09-22T10:30:00.000Z",
						},
					},
				],
				relationships: [],
				warnings: [],
			},
			proposed: desired,
			missThreshold: 2,
			now: "2026-09-22T10:31:00.000Z",
		});
		expect(drifted.entities[0]?.reconciliation.status).toBe("drifted");
		expect(drifted.entities.some((entity) => entity.provenance.some((item) => item.state === "proposed"))).toBeTrue();

		const unknown = reconcileTopology({ desired, missThreshold: 2, now: "2026-09-22T10:31:00.000Z" });
		expect(unknown.entities[0]?.reconciliation.status).toBe("unknown");
	});

	test("invalidates stale source-owned facts after K misses without deleting history", () => {
		const previous = reconcileTopology({
			desired,
			observed: desired,
			missThreshold: 2,
			now: "2026-09-22T10:31:00.000Z",
		});
		const once = reconcileTopology({
			desired,
			previous,
			observed: { entities: [], relationships: [], warnings: [] },
			missThreshold: 2,
			now: "2026-09-22T11:00:00.000Z",
		});
		const twice = reconcileTopology({
			desired,
			previous: once,
			observed: { entities: [], relationships: [], warnings: [] },
			missThreshold: 2,
			now: "2026-09-22T12:00:00.000Z",
		});
		const reobserved = reconcileTopology({
			desired,
			previous: twice,
			observed: desired,
			missThreshold: 2,
			now: "2026-09-22T13:00:00.000Z",
		});

		expect(once.entities[0]?.consecutiveMisses).toBe(1);
		expect(once.entities[0]?.validTo).toBeUndefined();
		expect(twice.entities[0]?.consecutiveMisses).toBe(2);
		expect(twice.entities[0]?.validTo).toBe("2026-09-22T12:00:00.000Z");
		expect(reobserved.entities[0]?.validFrom).toBe("2026-09-22T13:00:00.000Z");
		expect(reobserved.entities[0]?.validTo).toBeUndefined();
	});
});
