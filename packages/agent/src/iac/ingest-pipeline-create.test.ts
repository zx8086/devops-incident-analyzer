// agent/src/iac/ingest-pipeline-create.test.ts
import { describe, expect, mock, test } from "bun:test";
import { branchSlug, interpretSimulateResult, parseIntentJson } from "./nodes.ts";
import type { IacRequest, IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

// The two Cisco @custom pipelines from the SIO-1019 request, as parsed ingestPipelines[] entries.
const FTD_ENTRY = {
	name: "logs-cisco_ftd.log@custom",
	body: {
		name: "logs-cisco_ftd.log@custom",
		processors: [
			{
				drop: {
					if: "ctx.event?.action == 'flow-expiration'",
					description: "Drop Cisco FTD flow-expiration teardown events (flow bookkeeping, no security value)",
				},
			},
		],
	},
};

const MERAKI_ENTRY = {
	name: "logs-cisco_meraki.log@custom",
	body: {
		name: "logs-cisco_meraki.log@custom",
		processors: [
			{
				drop: {
					if: "ctx.event?.action == 'ip-session-initiated'",
					description: "Drop Meraki ip-session-initiated flow telemetry",
				},
			},
		],
	},
};

describe("parseIntentJson — ingest-pipeline-create", () => {
	test("extracts the ingestPipelines[] array with verbatim bodies", () => {
		const raw = JSON.stringify({
			workflow: "ingest-pipeline-create",
			cluster: "us-cld",
			ingestPipelines: [FTD_ENTRY, MERAKI_ENTRY],
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("ingest-pipeline-create");
		expect(req.cluster).toBe("us-cld");
		expect(req.ingestPipelines).toHaveLength(2);
		expect(req.ingestPipelines?.[0]?.name).toBe("logs-cisco_ftd.log@custom");
		// Body is carried VERBATIM (no reshaping).
		expect(req.ingestPipelines?.[0]?.body).toEqual(FTD_ENTRY.body);
		expect(req.ingestPipelines?.[1]?.body).toEqual(MERAKI_ENTRY.body);
		expect(req.clarification).toBeUndefined();
	});

	test("strips a trailing .json from the pipeline name (keeps the @custom suffix)", () => {
		const raw = JSON.stringify({
			workflow: "ingest-pipeline-create",
			cluster: "us-cld",
			ingestPipelines: [{ name: "logs-cisco_ftd.log@custom.json", body: FTD_ENTRY.body }],
		});
		const req = parseIntentJson(raw);
		// .json stripped, but the @custom segment (part of the real pipeline name) is preserved.
		expect(req.ingestPipelines?.[0]?.name).toBe("logs-cisco_ftd.log@custom");
	});
});

describe("branchSlug — ingest-pipeline-create", () => {
	test("uses cluster + joined pipeline names + workflow (40-char cap)", () => {
		const req: IacRequest = {
			workflow: "ingest-pipeline-create",
			isProd: false,
			cluster: "us-cld",
			ingestPipelines: [FTD_ENTRY, MERAKI_ENTRY],
		};
		const slug = branchSlug(req);
		expect(slug.length).toBe(40);
		// leads with the cluster and the first pipeline name (lowercased, non-alnum -> '-').
		expect(slug.startsWith("us-cld-logs-cisco")).toBe(true);
	});
});

function mockTools(handlers: Record<string, (args: Record<string, unknown>) => string>) {
	const tools = Object.entries(handlers).map(([name, fn]) => ({
		name,
		invoke: async (args: Record<string, unknown>) => fn(args),
	}));
	mock.module("../mcp-bridge.ts", () => ({
		getToolsForDataSource: () => tools,
		getConnectedServers: () => ["elastic-iac-mcp"],
	}));
}

describe("draftChange -> proposeIngestPipelineCreate", () => {
	test("happy path: creates two files on ONE branch with VERBATIM bodies, sets diff + proposedFiles", async () => {
		const { draftChange } = await import("./nodes.ts");
		const committed: Array<Record<string, unknown>> = [];
		const simulated: Array<Record<string, unknown>> = [];
		let branchCreates = 0;
		mockTools({
			// SIO-1020: simulate runs first and must pass (2xx) before any commit.
			elastic_simulate_ingest_pipeline: (args) => {
				simulated.push(args);
				return '[200] {"docs":[{"doc":{"_source":{}}}]}';
			},
			// both files are new -> 404 means "go ahead and create".
			gitlab_get_file_content: () => '[404] {"message":"404 File Not Found"}',
			gitlab_create_branch: () => {
				branchCreates += 1;
				return "[201] {}";
			},
			gitlab_commit_file: (args) => {
				committed.push(args);
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "ingest-pipeline-create" as const,
				isProd: false,
				cluster: "us-cld",
				ingestPipelines: [FTD_ENTRY, MERAKI_ENTRY],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(branchCreates).toBe(1); // ONE shared branch
		expect(committed).toHaveLength(2);
		expect(committed.every((c) => c.action === "create")).toBe(true);
		// SIO-1020: both bodies were simulated against the deployment, and the top-level `name`
		// (an IaC-file field, not a _simulate field) is dropped from the simulated pipeline.
		expect(simulated).toHaveLength(2);
		expect((simulated[0]?.pipeline as Record<string, unknown>)?.name).toBeUndefined();
		expect((simulated[0]?.pipeline as Record<string, unknown>)?.processors).toBeDefined();
		expect(simulated[0]?.deployment).toBe("us-cld");
		expect(result.proposedFiles).toEqual([
			"environments/us-cld/ingest-pipelines/logs-cisco_ftd.log@custom.json",
			"environments/us-cld/ingest-pipelines/logs-cisco_meraki.log@custom.json",
		]);
		expect(result.proposedFilePath).toBe("environments/us-cld/ingest-pipelines/logs-cisco_ftd.log@custom.json");
		// Committed content is the verbatim body, pretty-printed + trailing newline (the file parses back to it).
		const ftdContent = String(committed[0]?.content);
		expect(ftdContent.endsWith("}\n")).toBe(true);
		expect(JSON.parse(ftdContent)).toEqual(FTD_ENTRY.body);
		// full-file diff on create
		expect(result.proposedDiff).toContain("logs-cisco_ftd.log@custom");
		expect(result.proposedDiff).toContain("flow-expiration");
	});

	test("skips an entry whose file already exists (no-op create), keeps the other", async () => {
		const { draftChange } = await import("./nodes.ts");
		const committed: Array<Record<string, unknown>> = [];
		const existing = `[200] ${JSON.stringify({ content: Buffer.from("{}").toString("base64"), encoding: "base64" })}`;
		mockTools({
			gitlab_get_file_content: (args) =>
				String(args.filePath).includes("ftd") ? existing : '[404] {"message":"404 File Not Found"}',
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (args) => {
				committed.push(args);
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "ingest-pipeline-create" as const,
				isProd: false,
				cluster: "us-cld",
				ingestPipelines: [FTD_ENTRY, MERAKI_ENTRY],
			},
		};
		const result = await draftChange(asIacState(state));
		// only meraki committed; ftd skipped as already-existing
		expect(committed).toHaveLength(1);
		expect(String(committed[0]?.file_path)).toContain("meraki");
		expect(result.proposedFiles).toEqual(["environments/us-cld/ingest-pipelines/logs-cisco_meraki.log@custom.json"]);
	});

	test("blocks when an entry is missing a name", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: {
				workflow: "ingest-pipeline-create" as const,
				isProd: false,
				cluster: "us-cld",
				ingestPipelines: [{ name: "", body: { processors: [] } }],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("ingest pipeline");
	});

	test("blocks when a body is not a JSON object (array body)", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: {
				workflow: "ingest-pipeline-create" as const,
				isProd: false,
				cluster: "us-cld",
				// An array is not a valid pipeline document; the proposer rejects it.
				ingestPipelines: [{ name: "bad", body: [] as unknown as Record<string, unknown> }],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("JSON-object body");
	});

	test("blocks when every requested file already exists (nothing to create)", async () => {
		const { draftChange } = await import("./nodes.ts");
		const existing = `[200] ${JSON.stringify({ content: Buffer.from("{}").toString("base64"), encoding: "base64" })}`;
		mockTools({
			gitlab_get_file_content: () => existing,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "ingest-pipeline-create" as const,
				isProd: false,
				cluster: "us-cld",
				ingestPipelines: [FTD_ENTRY, MERAKI_ENTRY],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("already exist");
	});

	// SIO-1020: simulate gates the commit.
	test("blocks (no branch, no commit) when simulate rejects the body", async () => {
		const { draftChange } = await import("./nodes.ts");
		let branchCreates = 0;
		let commits = 0;
		mockTools({
			elastic_simulate_ingest_pipeline: () =>
				'[400] {"error":{"type":"parse_exception","reason":"[patterns] Invalid regex pattern"}}',
			gitlab_get_file_content: () => '[404] {"message":"404 File Not Found"}',
			gitlab_create_branch: () => {
				branchCreates += 1;
				return "[201] {}";
			},
			gitlab_commit_file: () => {
				commits += 1;
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "ingest-pipeline-create" as const,
				isProd: false,
				cluster: "us-cld",
				ingestPipelines: [FTD_ENTRY],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("failed simulation");
		expect(result.blockedReason).toContain("parse_exception");
		// The body never reached the repo -- no branch, no commit.
		expect(branchCreates).toBe(0);
		expect(commits).toBe(0);
		expect(result.precheckPassed).toBeUndefined();
	});

	test("proceeds (best-effort) when simulate is unavailable: cluster not configured", async () => {
		const { draftChange } = await import("./nodes.ts");
		const committed: Array<Record<string, unknown>> = [];
		mockTools({
			// The deployment has no configured cluster connection for simulate.
			elastic_simulate_ingest_pipeline: () =>
				"[cluster 'us-cld' not configured: set ELASTIC_IAC_CLUSTER_DEPLOYMENTS + ELASTIC_IAC_CLUSTER_<ID>_URL]",
			gitlab_get_file_content: () => '[404] {"message":"404 File Not Found"}',
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (args) => {
				committed.push(args);
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "ingest-pipeline-create" as const,
				isProd: false,
				cluster: "us-cld",
				ingestPipelines: [FTD_ENTRY],
			},
		};
		const result = await draftChange(asIacState(state));
		// Simulate could not run, but the change still proceeds (CI is the backstop).
		expect(result.precheckPassed).toBe(true);
		expect(committed).toHaveLength(1);
	});
});

describe("interpretSimulateResult (SIO-1020)", () => {
	test("2xx -> ok (pipeline compiled)", () => {
		expect(interpretSimulateResult('[200] {"docs":[]}')).toEqual({ ok: true });
		expect(interpretSimulateResult("[201] {}")).toEqual({ ok: true });
	});

	test("4xx/5xx -> not ok with the ES error as the reason", () => {
		const v = interpretSimulateResult('[400] {"error":{"type":"parse_exception"}}');
		expect(v).toMatchObject({ ok: false });
		if ("ok" in v && v.ok === false) expect(v.reason).toContain("parse_exception");
		expect(interpretSimulateResult("[500] boom")).toMatchObject({ ok: false });
	});

	test("non-status placeholders -> skipped (warn-and-proceed)", () => {
		expect(interpretSimulateResult("[cluster 'us-cld' not configured: ...]")).toMatchObject({ skipped: true });
		expect(interpretSimulateResult("[cluster request failed: timeout]")).toMatchObject({ skipped: true });
		expect(
			interpretSimulateResult("[elastic_simulate_ingest_pipeline unavailable - elastic-iac server not connected]"),
		).toMatchObject({ skipped: true });
	});
});
