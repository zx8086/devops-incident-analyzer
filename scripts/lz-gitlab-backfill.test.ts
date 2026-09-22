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

	test("parses an explicit or repository-only durable resume", () => {
		expect(parseBackfillArgs(["--repository", "aws-lz-account-creator", "--resume"])).toEqual({
			repository: "aws-lz-account-creator",
			resume: true,
		});
		expect(parseBackfillArgs(["--repository", "aws-lz-account-creator"])).toEqual({
			repository: "aws-lz-account-creator",
			resume: true,
		});
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
				readCheckpoint: async () => undefined,
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

	test("a second process resumes the durable split checkpoint persisted by the first", async () => {
		let durableCheckpoint:
			| {
					projectId: string;
					updatedAfter: string;
					inProgress?: {
						upperBound: string;
						nextPage: number;
						seenMrIds: string[];
					};
			  }
			| undefined;
		const initialArgs = parseBackfillArgs([
			"--repository",
			"aws-lz-account-creator",
			"--start-at",
			"2026-01-01T00:00:00.000Z",
		]);
		let firstCalls = 0;
		await expect(
			runLandingZoneGitLabBackfill(initialArgs, {
				connect: async () => {},
				ready: () => true,
				readCheckpoint: async () => undefined,
				importHistory: async () => {
					firstCalls++;
					if (firstCalls > 1) throw new Error("simulated process stop");
					durableCheckpoint = {
						projectId: "42",
						updatedAfter: "2026-01-01T00:00:00.000Z",
						inProgress: {
							upperBound: "2026-01-16T00:00:00.000Z",
							nextPage: 1,
							seenMrIds: [],
						},
					};
					return { outcomes: [], checkpoint: durableCheckpoint };
				},
				write: () => {},
				env: { LANDING_ZONE_IAC_MCP_URL: "http://127.0.0.1:9090" },
			}),
		).rejects.toThrow("simulated process stop");

		const output: string[] = [];
		await runLandingZoneGitLabBackfill(parseBackfillArgs(["--repository", "aws-lz-account-creator", "--resume"]), {
			connect: async () => {},
			ready: () => true,
			readCheckpoint: async () => durableCheckpoint,
			importHistory: async (options) => {
				expect(options.startAt).toBeUndefined();
				expect(options.checkpoint).toEqual(durableCheckpoint);
				return {
					outcomes: ["applied"],
					checkpoint: { projectId: "42", updatedAfter: "2026-01-16T00:00:00.000Z" },
				};
			},
			write: (line) => output.push(line),
			env: { LANDING_ZONE_IAC_MCP_URL: "http://127.0.0.1:9090" },
		});
		expect(output).toHaveLength(1);
		expect(output[0]).not.toContain("projectId");
	});
});
