// apps/web/src/lib/components/GitLabFindingsCard.test.ts
// SIO-777: typed gitlab findings render inline in chat as a deploy timeline.
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import GitLabFindingsCard from "./GitLabFindingsCard.svelte";

describe("GitLabFindingsCard.svelte", () => {
	test("renders nothing when findings has no mergedRequests", () => {
		const { body } = render(GitLabFindingsCard, { props: { findings: {} } });
		expect(body).not.toContain("GitLab findings");
	});

	test("renders one MR with date, project name parsed from web_url, and title", () => {
		const { body } = render(GitLabFindingsCard, {
			props: {
				findings: {
					mergedRequests: [
						{
							id: 361,
							title: "Merge branch release/AMS-2026 into main",
							merged_at: "2026-05-05T14:23:18.000Z",
							web_url: "https://gitlab.com/pvhcorp/b2b/services/pvh.services.styles/-/merge_requests/361",
						},
					],
				},
			},
		});
		expect(body).toContain("GitLab findings");
		expect(body).toContain("Recent deploys");
		expect(body).toContain("2026-05-05");
		// Project name truncated to last two path segments.
		expect(body).toContain("services/pvh.services.styles");
		expect(body).toContain("Merge branch release/AMS-2026");
		expect(body).toContain('href="https://gitlab.com/pvhcorp/b2b/services/pvh.services.styles/-/merge_requests/361"');
	});

	test("falls back to project_id when web_url is missing", () => {
		const { body } = render(GitLabFindingsCard, {
			props: {
				findings: {
					mergedRequests: [{ id: 1, title: "Fix things", merged_at: "2026-05-04T00:00:00Z", project_id: 42 }],
				},
			},
		});
		expect(body).toContain("project #42");
	});

	test("sorts by merged_at descending", () => {
		const { body } = render(GitLabFindingsCard, {
			props: {
				findings: {
					mergedRequests: [
						{ id: 1, title: "OLDEST", merged_at: "2026-04-01T00:00:00Z" },
						{ id: 2, title: "NEWEST", merged_at: "2026-05-10T00:00:00Z" },
						{ id: 3, title: "MIDDLE", merged_at: "2026-04-15T00:00:00Z" },
					],
				},
			},
		});
		const newest = body.indexOf("NEWEST");
		const middle = body.indexOf("MIDDLE");
		const oldest = body.indexOf("OLDEST");
		expect(newest).toBeGreaterThan(-1);
		expect(middle).toBeGreaterThan(newest);
		expect(oldest).toBeGreaterThan(middle);
	});

	test("truncates very long titles with an ellipsis", () => {
		const longTitle = "a very long merge request title ".repeat(10);
		const { body } = render(GitLabFindingsCard, {
			props: {
				findings: {
					mergedRequests: [{ id: 1, title: longTitle, merged_at: "2026-05-01T00:00:00Z" }],
				},
			},
		});
		expect(body).toContain("…");
	});

	test("handles MR without web_url as plain text (no link)", () => {
		const { body } = render(GitLabFindingsCard, {
			props: {
				findings: {
					mergedRequests: [{ id: 1, title: "Untracked deploy", merged_at: "2026-05-01T00:00:00Z" }],
				},
			},
		});
		expect(body).toContain("Untracked deploy");
		expect(body).not.toContain("href=");
	});
});
