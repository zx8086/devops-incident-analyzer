// packages/shared/src/landing-zone-topology.test.ts

import { describe, expect, test } from "bun:test";
import {
	type LandingZoneTopology,
	LandingZoneTopologyEventSchema,
	LandingZoneTopologySchema,
	TopologyDiagramViewSchema,
} from "./landing-zone-topology.ts";

const topology: LandingZoneTopology = {
	generatedAt: "2026-09-23T08:00:00.000Z",
	title: "Account network topology",
	summary: "Desired and observed topology for account 111122223333.",
	nodes: [
		{
			id: "vpc-1",
			kind: "vpc",
			label: "workload",
			visualState: "confirmed",
			sourceIds: ["aws:vpc-1"],
		},
	],
	edges: [],
	sources: [{ id: "aws:vpc-1", label: "AWS vpc-1", state: "observed" }],
	legend: [
		{
			state: "confirmed",
			label: "Confirmed",
			description: "Desired state confirmed by observed evidence.",
		},
	],
	text: ["workload [vpc] confirmed"],
	mermaid: 'flowchart LR\n  n0["workload"]',
	truncated: false,
};

describe("Landing Zone topology stream contract", () => {
	test("pins the three projection views and accepts a strict event", () => {
		expect(TopologyDiagramViewSchema.options).toEqual(["network", "dns", "path"]);
		expect(LandingZoneTopologyEventSchema.parse({ type: "landing_zone_topology", view: "network", topology })).toEqual({
			type: "landing_zone_topology",
			view: "network",
			topology,
		});
	});

	test("rejects unknown fields and dangling edge endpoints", () => {
		expect(
			LandingZoneTopologyEventSchema.safeParse({
				type: "landing_zone_topology",
				view: "network",
				topology,
				secretValue: "must not cross the stream boundary",
			}).success,
		).toBeFalse();
		expect(
			LandingZoneTopologySchema.safeParse({
				...topology,
				edges: [
					{
						id: "edge-1",
						from: "vpc-1",
						to: "missing",
						kind: "vpc-contains-subnet",
						visualState: "confirmed",
						sourceIds: ["aws:vpc-1"],
					},
				],
			}).success,
		).toBeFalse();
	});

	test("bounds diagram size at the transport boundary", () => {
		const nodes = Array.from({ length: 201 }, (_, index) => ({
			id: `vpc-${index}`,
			kind: "vpc" as const,
			label: `VPC ${index}`,
			visualState: "unverified" as const,
			sourceIds: [],
		}));
		expect(LandingZoneTopologySchema.safeParse({ ...topology, nodes }).success).toBeFalse();
	});
});
