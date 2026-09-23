// apps/web/src/lib/components/LandingZoneTopologyCard.test.ts

import { describe, expect, test } from "bun:test";
import type { LandingZoneTopologyEvent } from "@devops-agent/shared";
import { render } from "svelte/server";
import LandingZoneTopologyCard from "./LandingZoneTopologyCard.svelte";

const event: LandingZoneTopologyEvent = {
	type: "landing_zone_topology",
	view: "path",
	topology: {
		generatedAt: "2026-09-23T08:00:00.000Z",
		title: "DNS and route path",
		summary: "2 nodes and 1 relationship. 0 confirmed, 1 proposed, 1 drifted, 0 unverified.",
		accountId: "111122223333",
		focus: "api.internal.pvh",
		nodes: [
			{
				id: "dns-a",
				kind: "dns-record",
				label: "api.internal.pvh",
				visualState: "proposed",
				sourceIds: ["gitlab-source"],
			},
			{
				id: "vpc-a",
				kind: "vpc",
				label: '<script>alert("unsafe")</script>',
				detail: "account 111122223333; region eu-central-1",
				visualState: "drift",
				sourceIds: ["aws-source"],
			},
		],
		edges: [
			{
				id: "edge-a",
				from: "dns-a",
				to: "vpc-a",
				kind: "dns-record-resolves-to-vpc",
				label: "resolves to",
				visualState: "unverified",
				sourceIds: ["gitlab-source", "aws-source"],
			},
		],
		sources: [
			{
				id: "gitlab-source",
				label: "terraform: aws-lz-network-workloads / environments/prd/vpcs/example.yaml",
				url: "https://gitlab.com/pvhcorp/example/-/blob/abc/example.yaml",
				state: "desired",
			},
			{ id: "aws-source", label: "aws-api: vpc-a", state: "observed" },
		],
		legend: [
			{ state: "confirmed", label: "Confirmed", description: "Desired state confirmed by observation." },
			{ state: "proposed", label: "Proposed", description: "Open merge-request evidence." },
			{ state: "drift", label: "Drift", description: "Desired and observed evidence differ." },
			{ state: "unverified", label: "Unverified", description: "Live evidence is missing." },
		],
		text: ["api.internal.pvh [dns record] proposed", "api.internal.pvh -> <unsafe> [resolves to; unverified]"],
		mermaid: 'flowchart LR\n  n0["api.internal.pvh"]\n  n1["&lt;unsafe&gt;"]\n  n0 -.-> n1',
		truncated: true,
	},
};

describe("LandingZoneTopologyCard", () => {
	test("renders an accessible evidence map, provenance, states, and Mermaid source", () => {
		const { body } = render(LandingZoneTopologyCard, { props: { event } });
		expect(body).toContain("DNS and route path evidence map");
		expect(body).toContain("2 nodes · 1 links · 2 sources");
		expect(body).toContain("projection of desired, proposed, and observed evidence");
		expect(body).toContain("Confirmed");
		expect(body).toContain("Proposed");
		expect(body).toContain("Drift");
		expect(body).toContain("Unverified");
		expect(body).toContain("api.internal.pvh");
		expect(body).toContain("Mermaid diagram source");
		expect(body).toContain("Evidence sources");
		expect(body).toContain("https://gitlab.com/pvhcorp/example/-/blob/abc/example.yaml");
		expect(body).toContain("reached its display limit");
	});

	test("escapes evidence labels and text", () => {
		const { body } = render(LandingZoneTopologyCard, { props: { event } });
		expect(body).not.toContain('<script>alert("unsafe")</script>');
		expect(body).toContain('&lt;script>alert("unsafe")&lt;/script>');
		expect(body).toContain("&amp;lt;unsafe&amp;gt;");
	});

	test("renders nothing for an empty projection", () => {
		const { body } = render(LandingZoneTopologyCard, {
			props: { event: { ...event, topology: { ...event.topology, nodes: [], edges: [] } } },
		});
		expect(body).not.toContain("<section");
		expect(body).not.toContain("Evidence sources");
	});
});
