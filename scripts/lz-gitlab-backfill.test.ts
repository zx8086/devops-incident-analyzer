import { describe, expect, test } from "bun:test";
import { parseBackfillArgs, runLandingZoneGitLabBackfill } from "./lz-gitlab-backfill.ts";

describe("Landing Zone GitLab initial backfill", () => {
	test("rejects a repository outside the Landing Zone allowlist", () => {
		expect(() =>
			parseBackfillArgs(["--repository", "outside-catalog", "--start-at", "2026-01-01T00:00:00.000Z"]),
		).toThrow("not in the Landing Zone catalog");
	});

	test("rejects an invalid start timestamp", () => {
		expect(() => parseBackfillArgs(["--repository", "aws-lz-account-creator", "--start-at", "not-a-date"])).toThrow(
			"valid ISO timestamp",
		);
	});

	test("prints only a safe checkpoint and outcome summary", async () => {
		const output: string[] = [];
		let imports = 0;
		await runLandingZoneGitLabBackfill(
			{
				repository: "aws-lz-account-creator",
				startAt: "2026-01-01T00:00:00.000Z",
			},
			{
				connect: async () => {},
				ready: () => true,
				importHistory: async (options) => {
					imports++;
					if (!options.checkpoint) {
						return {
							outcomes: ["proposed"],
							checkpoint: {
								projectId: "42",
								updatedAfter: "2026-01-01T00:00:00.000Z",
								inProgress: {
									upperBound: "2026-02-01T00:00:00.000Z",
									expectedTotal: 3,
									nextPage: 2,
									seenMrIds: ["42:7"],
								},
								pendingMrIids: [7],
							},
						};
					}
					expect(options.checkpoint.inProgress?.nextPage).toBe(2);
					return {
						outcomes: ["applied", "applied"],
						checkpoint: {
							projectId: "42",
							updatedAfter: "2026-02-01T00:00:00.000Z",
							pendingMrIids: [7],
						},
					};
				},
				write: (line) => output.push(line),
				env: { LANDING_ZONE_IAC_MCP_URL: "http://127.0.0.1:9090" },
			},
		);

		expect(imports).toBe(2);
		expect(output).toHaveLength(1);
		expect(JSON.parse(output[0] ?? "")).toEqual({
			repository: "aws-lz-account-creator",
			outcomes: { applied: 2, proposed: 1 },
			checkpoint: {
				updatedAfter: "2026-02-01T00:00:00.000Z",
				inProgress: false,
				pendingCount: 1,
			},
		});
		expect(output[0]).not.toContain("projectId");
		expect(output[0]).not.toContain("token");
		expect(output[0]).not.toContain("trace");
	});
});
