// tests/unit/ml/validators.test.ts
// SIO-1148: Zod validator contract tests for the ML tool family, plus the reset_job
// force-confirmation guard (the destructive-op gate the defect asks for).

// Satisfy the boot-time env validator (src/config/index.ts validates at import time).
Bun.env.ES_URL ??= "http://localhost:9200";

import { describe, expect, test } from "bun:test";
import type { Client } from "@elastic/elasticsearch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { registerAllTools } from "../../../src/tools/index.js";
import { mlCloseJobValidator } from "../../../src/tools/ml/close_job.js";
import { mlGetDatafeedStatsValidator } from "../../../src/tools/ml/get_datafeed_stats.js";
import { mlGetDatafeedsValidator } from "../../../src/tools/ml/get_datafeeds.js";
import { mlGetJobStatsValidator } from "../../../src/tools/ml/get_job_stats.js";
import { mlListJobsValidator } from "../../../src/tools/ml/list_jobs.js";
import { mlOpenJobValidator } from "../../../src/tools/ml/open_job.js";
import { mlResetJobValidator } from "../../../src/tools/ml/reset_job.js";
import { mlStartDatafeedValidator } from "../../../src/tools/ml/start_datafeed.js";
import { mlStopDatafeedValidator } from "../../../src/tools/ml/stop_datafeed.js";
import { getToolFromServer } from "../../utils/elasticsearch-client.js";

describe("ML read validators: id is optional (defaults to _all)", () => {
	test("get_job_stats accepts empty args", () => {
		expect(() => mlGetJobStatsValidator.parse({})).not.toThrow();
	});
	test("list_jobs accepts empty args", () => {
		expect(() => mlListJobsValidator.parse({})).not.toThrow();
	});
	test("get_datafeed_stats accepts empty args", () => {
		expect(() => mlGetDatafeedStatsValidator.parse({})).not.toThrow();
	});
	test("get_datafeeds accepts empty args", () => {
		expect(() => mlGetDatafeedsValidator.parse({})).not.toThrow();
	});
});

describe("ML write validators: id is required and non-empty", () => {
	test("open_job rejects empty jobId", () => {
		expect(() => mlOpenJobValidator.parse({ jobId: "" })).toThrow(/jobId cannot be empty/);
	});
	test("close_job rejects empty jobId", () => {
		expect(() => mlCloseJobValidator.parse({ jobId: "" })).toThrow(/jobId cannot be empty/);
	});
	test("start_datafeed rejects empty datafeedId", () => {
		expect(() => mlStartDatafeedValidator.parse({ datafeedId: "" })).toThrow(/datafeedId cannot be empty/);
	});
	test("stop_datafeed rejects empty datafeedId", () => {
		expect(() => mlStopDatafeedValidator.parse({ datafeedId: "" })).toThrow(/datafeedId cannot be empty/);
	});
	test("reset_job rejects empty jobId", () => {
		expect(() => mlResetJobValidator.parse({ jobId: "" })).toThrow(/jobId cannot be empty/);
	});
	test("open_job accepts a valid jobId", () => {
		expect(() => mlOpenJobValidator.parse({ jobId: "apm-errors-high-rate-by-service" })).not.toThrow();
	});
});

describe("reset_job force-confirmation guard (SIO-1148 destructive gate)", () => {
	// A client that throws if any ml method is called — proves the guard refuses BEFORE
	// touching the cluster when force is not set.
	function makeThrowingClient(): Client {
		return {
			ml: {
				getJobs: async () => {
					throw new Error("ml.getJobs must not be called when force is absent");
				},
				resetJob: async () => {
					throw new Error("ml.resetJob must not be called when force is absent");
				},
			},
		} as unknown as Client;
	}

	function getResetHandler(client: Client): (args: Record<string, unknown>) => Promise<unknown> {
		const server = new McpServer({ name: "test-server", version: "0.0.0" });
		registerAllTools(server, client);
		const tool = getToolFromServer(server, "elasticsearch_ml_reset_job");
		if (!tool) throw new Error("elasticsearch_ml_reset_job not registered");
		return tool.handler as (args: Record<string, unknown>) => Promise<unknown>;
	}

	test("reset without force throws McpError(InvalidParams) and never calls the client", async () => {
		const handler = getResetHandler(makeThrowingClient());
		await expect(handler({ jobId: "apm-errors-high-rate-by-service" })).rejects.toMatchObject({
			name: "McpError",
			code: -32602, // ErrorCode.InvalidParams
		});
	});

	test("reset without force error message instructs the caller to pass force:true", async () => {
		const handler = getResetHandler(makeThrowingClient());
		try {
			await handler({ jobId: "apm-errors-high-rate-by-service" });
			throw new Error("expected reset without force to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).message).toMatch(/force: true/);
			expect((err as McpError).message).toMatch(/IRREVERSIBLE/);
		}
	});

	test("reset with force reaches the existence preflight (ml.getJobs), proving the guard passed", async () => {
		// With force:true the guard is cleared, so the handler proceeds to the getJobs preflight.
		// A not-found from getJobs is surfaced as an InvalidRequest McpError — this asserts the
		// guard no longer short-circuits, without needing a live reset.
		const client = {
			ml: {
				getJobs: async () => {
					throw new Error("resource_not_found_exception: No known job with id 'ghost'");
				},
				resetJob: async () => {
					throw new Error("ml.resetJob should not be reached when the job does not exist");
				},
			},
		} as unknown as Client;
		const handler = getResetHandler(client);
		try {
			await handler({ jobId: "ghost", force: true });
			throw new Error("expected reset of a non-existent job to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			// Proves the force guard was cleared and the handler advanced to the getJobs preflight,
			// which surfaces the not-found rather than the force-required message.
			expect((err as McpError).message).toMatch(/does not exist/);
			expect((err as McpError).message).not.toMatch(/force: true/);
		}
	});
});
