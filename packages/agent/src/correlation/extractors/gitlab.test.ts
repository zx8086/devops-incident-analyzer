// packages/agent/src/correlation/extractors/gitlab.test.ts
import { describe, expect, test } from "bun:test";
import type { ToolOutput } from "@devops-agent/shared";
import { extractGitLabFindings } from "./gitlab.ts";

describe("extractGitLabFindings", () => {
	test("returns empty findings when no relevant tool outputs are present", () => {
		const outputs: ToolOutput[] = [{ toolName: "gitlab_list_commits", rawJson: [] }];
		expect(extractGitLabFindings(outputs)).toEqual({});
	});

	test("maps gitlab_list_merge_requests bare-array response to mergedRequests[]", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "gitlab_list_merge_requests",
				rawJson: [
					{
						id: 153,
						project_id: 42,
						title: "Fix OFFSET regression in styles-v3",
						description: "Reverts to LIMIT-only paging in product_search",
						merged_at: "2026-04-22T09:14:33.000Z",
						web_url: "https://gitlab.com/example/styles-v3/-/merge_requests/153",
					},
				],
			},
		];
		const findings = extractGitLabFindings(outputs);
		expect(findings.mergedRequests).toHaveLength(1);
		expect(findings.mergedRequests?.[0]?.id).toBe(153);
		expect(findings.mergedRequests?.[0]?.merged_at).toBe("2026-04-22T09:14:33.000Z");
	});

	test("ignores malformed entries (missing required id) and keeps valid siblings", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "gitlab_list_merge_requests",
				rawJson: [{ title: "no id here" }, { id: 99, title: "valid sibling" }],
			},
		];
		const findings = extractGitLabFindings(outputs);
		expect(findings.mergedRequests).toHaveLength(1);
		expect(findings.mergedRequests?.[0]?.id).toBe(99);
	});

	test("ignores non-array rawJson (e.g. upstream error string)", () => {
		const outputs: ToolOutput[] = [{ toolName: "gitlab_list_merge_requests", rawJson: "503 upstream error" }];
		expect(extractGitLabFindings(outputs)).toEqual({});
	});
});

describe("extractGitLabFindings focus scoping (SIO-1030)", () => {
	const mrs = (rows: Array<Record<string, unknown>>): ToolOutput => ({
		toolName: "gitlab_list_merge_requests",
		rawJson: rows,
	});

	test("empty focus keeps every MR (show-all, back-compat)", () => {
		const out = extractGitLabFindings(
			[
				mrs([
					{ id: 1, title: "prices thing" },
					{ id: 2, title: "articles thing" },
				]),
			],
			[],
		);
		expect(out.mergedRequests).toHaveLength(2);
	});

	test("keeps MRs referencing the focus in title/description, drops unrelated", () => {
		const out = extractGitLabFindings(
			[
				mrs([
					{ id: 10, title: "Fix OFFSET regression", description: "affects prices-api-v2-service paging" },
					{ id: 11, title: "Bump kong-proxy timeout", description: "unrelated infra tweak" },
				]),
			],
			["prices-api-v2-service"],
		);
		expect(out.mergedRequests?.map((m) => m.id)).toEqual([10]);
	});
});
