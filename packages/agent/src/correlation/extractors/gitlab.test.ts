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

// SIO-1644: a WRONG focus (the LLM naming infrastructure components rather than
// services -- run a54d89c4) dropped every MR and shipped a blank card, strictly worse
// than show-all. Mirrors the SIO-1159 aws fallback tests.
describe("extractGitLabFindings unscoped fallback (SIO-1644)", () => {
	const mrs = (rows: Array<Record<string, unknown>>): ToolOutput => ({
		toolName: "gitlab_list_merge_requests",
		rawJson: rows,
	});
	const FOCUS = ["cni-plugin", "container-runtime"];

	test("droppedAll with focus returns top-5 flagged unscoped, most recently merged first", () => {
		const rows = Array.from({ length: 7 }, (_, i) => ({
			id: i + 1,
			title: `unrelated change ${i + 1}`,
			merged_at: `2026-09-0${i + 1}T00:00:00Z`,
		}));
		const out = extractGitLabFindings([mrs(rows)], FOCUS);
		expect(out.unscoped).toBe(true);
		expect(out.mergedRequests).toHaveLength(5);
		// Newest first: 2026-09-07 down to 2026-09-03.
		expect(out.mergedRequests?.[0]?.id).toBe(7);
		expect(out.mergedRequests?.[4]?.id).toBe(3);
	});

	test("scoped hits suppress the fallback and carry no unscoped flag", () => {
		const out = extractGitLabFindings(
			[
				mrs([
					{ id: 1, title: "bump cni-plugin version", merged_at: "2026-09-01T00:00:00Z" },
					{ id: 2, title: "unrelated change", merged_at: "2026-09-09T00:00:00Z" },
				]),
			],
			FOCUS,
		);
		expect(out.unscoped).toBeUndefined();
		expect(out.mergedRequests?.map((m) => m.id)).toEqual([1]);
	});

	test("empty focus never engages the fallback (show-all has no unscoped flag)", () => {
		const out = extractGitLabFindings([mrs([{ id: 1, title: "anything" }])], []);
		expect(out.unscoped).toBeUndefined();
		expect(out.mergedRequests).toHaveLength(1);
	});

	test("no MRs at all stays empty rather than flagging an empty fallback", () => {
		const out = extractGitLabFindings([mrs([])], FOCUS);
		expect(out).toEqual({});
	});

	// Greptile on PR #796: the sub-agent can issue several gitlab_list_merge_requests calls
	// with overlapping filters, and extractors see the MERGED outputs per dataSourceId
	// (SIO-1245). Without keying, one MR occupies several of the five slots and crowds out
	// distinct recent deploys.
	test("an MR repeated across overlapping tool calls occupies ONE fallback slot", () => {
		const mr = (id: number) => ({
			id,
			project_id: 42,
			title: `unrelated ${id}`,
			merged_at: `2026-09-0${id}T00:00:00Z`,
		});
		const out = extractGitLabFindings([mrs([mr(1), mr(2)]), mrs([mr(1), mr(3)])], FOCUS);
		expect(out.unscoped).toBe(true);
		const ids = out.mergedRequests?.map((m) => m.id) ?? [];
		expect(ids).toEqual([3, 2, 1]);
		expect(ids.length).toBe(new Set(ids).size);
	});

	test("the same MR id in DIFFERENT projects is not collapsed (ids are per-project)", () => {
		const out = extractGitLabFindings(
			[
				mrs([
					{ id: 7, project_id: 1, title: "alpha", merged_at: "2026-09-01T00:00:00Z" },
					{ id: 7, project_id: 2, title: "beta", merged_at: "2026-09-02T00:00:00Z" },
				]),
			],
			FOCUS,
		);
		expect(out.mergedRequests).toHaveLength(2);
	});

	test("undated MRs sort last rather than winning the fallback by accident", () => {
		const out = extractGitLabFindings(
			[
				mrs([
					{ id: 1, title: "no date" },
					{ id: 2, title: "dated", merged_at: "2026-09-01T00:00:00Z" },
				]),
			],
			FOCUS,
		);
		expect(out.unscoped).toBe(true);
		expect(out.mergedRequests?.map((m) => m.id)).toEqual([2, 1]);
	});
});
