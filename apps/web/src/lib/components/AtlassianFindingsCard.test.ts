// apps/web/src/lib/components/AtlassianFindingsCard.test.ts
// SIO-785 Phase 2: typed Atlassian linked-incidents render inline in chat.
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import AtlassianFindingsCard from "./AtlassianFindingsCard.svelte";

describe("AtlassianFindingsCard.svelte", () => {
	test("renders nothing when no linkedIssues", () => {
		const { body } = render(AtlassianFindingsCard, { props: { findings: {} } });
		expect(body).not.toContain("Atlassian findings");
	});

	test("renders nothing when linkedIssues is empty array", () => {
		const { body } = render(AtlassianFindingsCard, { props: { findings: { linkedIssues: [] } } });
		expect(body).not.toContain("Atlassian findings");
	});

	test("renders a row with key, summary, status, and linked URL", () => {
		const { body } = render(AtlassianFindingsCard, {
			props: {
				findings: {
					linkedIssues: [
						{
							key: "INC-101",
							summary: "Notifications outage",
							status: "Resolved",
							severity: "P1",
							url: "https://tommy.atlassian.net/browse/INC-101",
						},
					],
				},
			},
		});
		expect(body).toContain("Atlassian findings");
		expect(body).toContain("Linked incidents");
		expect(body).toContain("INC-101");
		expect(body).toContain("Notifications outage");
		expect(body).toContain("Resolved");
		expect(body).toContain('href="https://tommy.atlassian.net/browse/INC-101"');
	});

	test("renders severity badge when present", () => {
		const { body } = render(AtlassianFindingsCard, {
			props: {
				findings: {
					linkedIssues: [{ key: "A-1", summary: "x", status: "Open", severity: "P0" }],
				},
			},
		});
		expect(body).toContain("P0");
	});

	test("omits the link wrapper when no url is provided (still shows key)", () => {
		const { body } = render(AtlassianFindingsCard, {
			props: {
				findings: {
					linkedIssues: [{ key: "A-1", summary: "x", status: "Open" }],
				},
			},
		});
		expect(body).toContain("A-1");
		expect(body).not.toContain('href="https://tommy.atlassian.net');
	});

	test("status dot maps to green for Resolved/Done/Closed", () => {
		const { body } = render(AtlassianFindingsCard, {
			props: {
				findings: {
					linkedIssues: [
						{ key: "X-1", summary: "x", status: "Resolved" },
						{ key: "X-2", summary: "x", status: "In Progress" },
						{ key: "X-3", summary: "x", status: "Open" },
					],
				},
			},
		});
		expect(body).toContain("bg-green-500");
		expect(body).toContain("bg-amber-500");
		expect(body).toContain("bg-red-500");
	});
});
