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

	// SIO-1802: the card says WHY each ticket is there, so a false positive can be explained
	// from the card rather than from the JQL.
	describe("matched-by chip (SIO-1802)", () => {
		const row = (matchedBy: string[] | undefined) => ({
			linkedIssues: [{ key: "INC-1", summary: "s", status: "Open", ...(matchedBy ? { matchedBy } : {}) }],
		});

		test("summarises structural hits and counts keywords; the title lists every clause", () => {
			const { body } = render(AtlassianFindingsCard, {
				props: { findings: row(["service-text", "keyword:UnambiguousTimeoutException", "keyword:kv timeout"]) },
			});
			expect(body).toContain("service + 2 keywords");
			expect(body).toContain("Matched by: service-text, keyword:UnambiguousTimeoutException, keyword:kv timeout");
		});

		test("names a label hit and a single keyword in the singular", () => {
			const { body } = render(AtlassianFindingsCard, {
				props: { findings: row(["service-label", "keyword:THE1"]) },
			});
			expect(body).toContain("label + 1 keyword");
			expect(body).not.toContain("1 keywords");
		});

		test("an empty attribution is shown as such, not hidden (empty-focus runs keep weak hits)", () => {
			const { body } = render(AtlassianFindingsCard, { props: { findings: row([]) } });
			expect(body).toContain("no visible match");
		});

		test("an issue recorded before SIO-1802 renders no chip", () => {
			const { body } = render(AtlassianFindingsCard, { props: { findings: row(undefined) } });
			expect(body).toContain("INC-1");
			expect(body).not.toContain("Matched");
			expect(body).not.toContain("no visible match");
		});
	});

	// SIO-1338: configWarning (SIO-1184 dead-project config, SIO-1337 pagination truncation)
	// must render even without linkedIssues -- the pre-fix `hasContent` gate on linkedIssues.length
	// alone would have made this warning invisible.
	describe("configWarning (SIO-1338)", () => {
		test("renders the warning banner alone when linkedIssues is absent", () => {
			const { body } = render(AtlassianFindingsCard, {
				props: {
					findings: { configWarning: "More than 100 incidents matched within 365d; totals are undercounts." },
				},
			});
			expect(body).toContain("Atlassian findings");
			expect(body).toContain("More than 100 incidents matched within 365d; totals are undercounts.");
			expect(body).not.toContain("Linked incidents");
		});

		test("renders the warning banner alongside linkedIssues rows", () => {
			const { body } = render(AtlassianFindingsCard, {
				props: {
					findings: {
						linkedIssues: [{ key: "DEVOPS-1", summary: "x", status: "Open" }],
						configWarning: "Configured incident project(s) INC do not exist on this Jira site.",
					},
				},
			});
			expect(body).toContain("Configured incident project(s) INC do not exist on this Jira site.");
			expect(body).toContain("DEVOPS-1");
			expect(body).toContain("Linked incidents");
		});

		test("still renders nothing when both configWarning and linkedIssues are absent", () => {
			const { body } = render(AtlassianFindingsCard, { props: { findings: {} } });
			expect(body).not.toContain("Atlassian findings");
		});
	});

	// SIO-1837: the rerank verdict on the card.
	describe("relevance", () => {
		test("shows a band per judged ticket", () => {
			const { body } = render(AtlassianFindingsCard, {
				props: {
					findings: {
						rerank: "applied",
						linkedIssues: [
							{ key: "INC-1", summary: "same failure", status: "Open", relevance: 2.96 },
							{ key: "INC-2", summary: "same service", status: "Open", relevance: 2.04 },
							{ key: "INC-3", summary: "loose", status: "Open", relevance: 1.2 },
						],
					},
				},
			});
			expect(body).toContain("same failure");
			expect(body).toContain("same service");
			expect(body).toContain("loose match");
		});

		test("an unjudged ticket carries no relevance chip", () => {
			// A card rendered with the rerank off or failed must not imply a judgement
			// that never happened.
			const { body } = render(AtlassianFindingsCard, {
				props: {
					findings: { rerank: "skipped", linkedIssues: [{ key: "INC-1", summary: "unjudged", status: "Open" }] },
				},
			});
			expect(body).toContain("INC-1");
			expect(body).not.toContain("same failure");
			expect(body).not.toContain("same service");
			expect(body).not.toContain("loose match");
		});

		test("states how many tickets were hidden, singular and plural", () => {
			const one = render(AtlassianFindingsCard, {
				props: {
					findings: {
						rerank: "applied",
						rerankDropped: 1,
						linkedIssues: [{ key: "INC-1", summary: "kept", status: "Open", relevance: 2.9 }],
					},
				},
			});
			expect(one.body).toContain("1 low-relevance ticket hidden");

			const many = render(AtlassianFindingsCard, {
				props: {
					findings: {
						rerank: "applied",
						rerankDropped: 4,
						linkedIssues: [{ key: "INC-1", summary: "kept", status: "Open", relevance: 2.9 }],
					},
				},
			});
			expect(many.body).toContain("4 low-relevance tickets hidden");
		});

		test("no hidden-count line when nothing was dropped", () => {
			const { body } = render(AtlassianFindingsCard, {
				props: {
					findings: {
						rerank: "applied",
						rerankDropped: 0,
						linkedIssues: [{ key: "INC-1", summary: "kept", status: "Open", relevance: 2.9 }],
					},
				},
			});
			expect(body).not.toContain("hidden");
		});
	});
});
