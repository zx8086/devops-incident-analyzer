// packages/agent/src/landing-zone/topology-projection.test.ts

import { describe, expect, test } from "bun:test";
import type { LandingZoneTopologyEntity, LandingZoneTopologyRelationship } from "./topology-extractor.ts";
import { parseReconciledTopologyToolResult, projectLandingZoneTopology } from "./topology-projection.ts";
import type { ReconciledTopology, ReconciledTopologyFact } from "./topology-reconcile.ts";

const observed = {
	state: "observed" as const,
	source: "aws-api" as const,
	observedAt: "2026-09-23T07:00:00.000Z",
};
const desired = {
	state: "desired" as const,
	source: "terraform" as const,
	repository: "pvhcorp/dhco/aws/aws-landing-zone/aws-lz-network-workloads",
	filePath: "environments/prd/vpcs/example.yaml",
	commitSha: "abc1234",
	sourceTimestamp: "2026-09-23T06:00:00.000Z",
};

function entity(
	id: string,
	kind: LandingZoneTopologyEntity["kind"],
	options: {
		name?: string;
		accountId?: string;
		status?: ReconciledTopologyFact<LandingZoneTopologyEntity>["reconciliation"]["status"];
		confidence?: ReconciledTopologyFact<LandingZoneTopologyEntity>["reconciliation"]["confidence"];
		proposed?: boolean;
	} = {},
): ReconciledTopologyFact<LandingZoneTopologyEntity> {
	const provenance = options.proposed
		? [
				{
					state: "proposed" as const,
					source: "gitlab-merge-request" as const,
					mergeRequestUrl: "https://gitlab.com/example/-/merge_requests/1",
				},
			]
		: [observed];
	return {
		id,
		fact: {
			id,
			kind,
			...(options.name && { name: options.name }),
			...(options.accountId && { accountId: options.accountId }),
			properties: {},
			provenance: provenance[0] ?? observed,
		},
		provenance,
		reconciliation: {
			status: options.status ?? (options.proposed ? "pending" : "aligned"),
			confidence: options.confidence ?? (options.proposed ? "unverified" : "verified"),
		},
		validFrom: "2026-09-23T07:00:00.000Z",
		consecutiveMisses: 0,
	};
}

function edge(
	id: string,
	kind: LandingZoneTopologyRelationship["kind"],
	from: string,
	to: string,
	status: ReconciledTopologyFact<LandingZoneTopologyRelationship>["reconciliation"]["status"] = "aligned",
): ReconciledTopologyFact<LandingZoneTopologyRelationship> {
	const provenance = status === "pending" ? [{ ...desired, state: "proposed" as const }] : [desired, observed];
	return {
		id,
		fact: { id, kind, from, to, properties: {}, provenance: provenance[0] ?? desired },
		provenance,
		reconciliation: { status, confidence: status === "aligned" ? "verified" : "unverified" },
		validFrom: "2026-09-23T07:00:00.000Z",
		consecutiveMisses: 0,
	};
}

const topology: ReconciledTopology = {
	entities: [
		entity("111122223333", "aws-account", { accountId: "111122223333", name: "example-prd" }),
		entity("vpc-a", "vpc", { accountId: "111122223333", name: "<workload & core>" }),
		entity("vpc-b", "vpc", { accountId: "111122223333", name: "separate-vpc" }),
		entity("subnet-a", "subnet", { accountId: "111122223333", name: "private-a" }),
		entity("rtb-a", "route-table", { accountId: "111122223333" }),
		entity("route-a", "route", { accountId: "111122223333" }),
		entity("nat-a", "nat-gateway", { accountId: "111122223333", proposed: true }),
		entity("acl-a", "network-acl", {
			accountId: "111122223333",
			status: "unknown",
			confidence: "unverified",
		}),
		entity("zone-a", "hosted-zone", { accountId: "111122223333", name: "internal.pvh" }),
		entity("dns-a", "dns-record", { accountId: "111122223333", name: "api.internal.pvh" }),
		entity("dns-b", "dns-record", { accountId: "111122223333", name: "alias.internal.pvh" }),
		entity("10.0.1.10", "ip-address", { status: "drifted" }),
		entity("999900001111", "aws-account", { accountId: "999900001111" }),
		entity("vpc-other", "vpc", { accountId: "999900001111" }),
	],
	relationships: [
		edge("owns-a", "account-owns-vpc", "111122223333", "vpc-a"),
		edge("owns-b", "account-owns-vpc", "111122223333", "vpc-b"),
		edge("contains-a", "vpc-contains-subnet", "vpc-a", "subnet-a"),
		edge("uses-a", "subnet-uses-route-table", "subnet-a", "rtb-a"),
		edge("has-route-a", "route-table-has-route", "rtb-a", "route-a"),
		edge("targets-a", "route-targets-nat-gateway", "route-a", "nat-a", "pending"),
		edge("acl-protects-a", "subnet-protected-by-network-acl", "subnet-a", "acl-a", "unknown"),
		edge("zone-record-a", "hosted-zone-contains-dns-record", "zone-a", "dns-a"),
		edge("dns-cycle-a", "dns-record-resolves-to-dns-record", "dns-a", "dns-b"),
		edge("dns-cycle-b", "dns-record-resolves-to-dns-record", "dns-b", "dns-a"),
		edge("dns-ip", "dns-record-resolves-to-ip", "dns-b", "10.0.1.10", "drifted"),
		edge("owns-other", "account-owns-vpc", "999900001111", "vpc-other"),
	],
};

describe("projectLandingZoneTopology", () => {
	test("is deterministic, preserves stable IDs, and escapes Mermaid labels", () => {
		const options = {
			view: "network" as const,
			accountId: "111122223333",
			generatedAt: "2026-09-23T08:00:00.000Z",
		};
		const first = projectLandingZoneTopology(topology, options);
		const reversed = projectLandingZoneTopology(
			{ entities: [...topology.entities].reverse(), relationships: [...topology.relationships].reverse() },
			options,
		);
		expect(first).toEqual(reversed);
		expect(first.nodes.some((node) => node.id === "vpc-a")).toBeTrue();
		expect(first.nodes.some((node) => node.id === "vpc-other")).toBeFalse();
		expect(first.mermaid).toContain("&lt;workload &amp; core&gt;");
		expect(first.mermaid).not.toContain("<workload & core>");
		expect(first.sources.some((source) => source.url?.includes("/-/blob/abc1234/"))).toBeTrue();
	});

	test("keeps a VPC-focused projection inside the selected VPC boundary", () => {
		const result = projectLandingZoneTopology(topology, {
			view: "network",
			vpcId: "vpc-a",
			generatedAt: "2026-09-23T08:00:00.000Z",
		});
		expect(result.nodes.some((node) => node.id === "vpc-a")).toBeTrue();
		expect(result.nodes.some((node) => node.id === "subnet-a")).toBeTrue();
		expect(result.nodes.some((node) => node.id === "vpc-b")).toBeFalse();
	});

	test("projects proposed, drifted, and unverified styling", () => {
		const network = projectLandingZoneTopology(topology, {
			view: "network",
			accountId: "111122223333",
			generatedAt: "2026-09-23T08:00:00.000Z",
		});
		expect(network.nodes.find((node) => node.id === "nat-a")?.visualState).toBe("proposed");
		expect(network.nodes.find((node) => node.id === "acl-a")?.visualState).toBe("unverified");
		expect(network.edges.find((item) => item.id === "targets-a")?.visualState).toBe("proposed");

		const dns = projectLandingZoneTopology(topology, {
			view: "dns",
			hostname: "api.internal.pvh",
			generatedAt: "2026-09-23T08:00:00.000Z",
		});
		expect(dns.nodes.find((node) => node.id === "10.0.1.10")?.visualState).toBe("drift");
		expect(dns.edges.find((item) => item.id === "dns-ip")?.visualState).toBe("drift");
	});

	test("handles DNS cycles and caps nodes without dangling edges", () => {
		const result = projectLandingZoneTopology(topology, {
			view: "path",
			hostname: "api.internal.pvh",
			maxNodes: 3,
			generatedAt: "2026-09-23T08:00:00.000Z",
		});
		expect(result.nodes).toHaveLength(3);
		expect(result.truncated).toBeTrue();
		const nodeIds = new Set(result.nodes.map((node) => node.id));
		expect(result.edges.every((item) => nodeIds.has(item.from) && nodeIds.has(item.to))).toBeTrue();
	});

	test("parses current reconciled facts from a knowledge-graph tool result", () => {
		const result = parseReconciledTopologyToolResult({
			content: [
				{
					type: "text",
					text: JSON.stringify([
						{ payload: JSON.stringify(topology.entities[0]) },
						{ payload: JSON.stringify(topology.relationships[0]) },
						{ payload: "not-json" },
					]),
				},
			],
		});
		expect(result.entities.map((item) => item.id)).toEqual(["111122223333"]);
		expect(result.relationships.map((item) => item.id)).toEqual(["owns-a"]);
	});

	test("marks an accessible-text cap even when neither visual collection is capped", () => {
		const dense: ReconciledTopology = {
			entities: [entity("vpc-dense", "vpc"), entity("subnet-dense", "subnet")],
			relationships: Array.from({ length: 399 }, (_, index) =>
				edge(`dense-${index}`, "vpc-contains-subnet", "vpc-dense", "subnet-dense"),
			),
		};
		const result = projectLandingZoneTopology(dense, {
			view: "network",
			generatedAt: "2026-09-23T08:00:00.000Z",
		});
		expect(result.edges).toHaveLength(399);
		expect(result.text).toHaveLength(400);
		expect(result.truncated).toBeTrue();
	});
});
