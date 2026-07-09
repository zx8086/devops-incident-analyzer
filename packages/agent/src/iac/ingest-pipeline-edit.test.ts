// agent/src/iac/ingest-pipeline-edit.test.ts
import { describe, expect, mock, test } from "bun:test";
import { branchSlug, parseIntentJson } from "./nodes.ts";
import type { IacRequest, IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

// SIO-1024: the exact ap-cld Meraki edit from the failing request. Note the FILE BASENAME
// (drop-cisco-meraki-ip-session) DIFFERS from the body's `name` (logs-cisco_meraki.log@custom) --
// the edit path keys on the path basename, so the proposer reads/writes the file the user named.
const MERAKI_EDIT = {
	name: "drop-cisco-meraki-ip-session",
	body: {
		name: "logs-cisco_meraki.log@custom",
		description: "ap-cld noise reduction Phase 3 -- drop Meraki ip-session-initiated + http-access.",
		processors: [
			{
				drop: {
					description: "Drop Meraki ip-session-initiated + http-access; preserve cisco.meraki.firewall.action:deny.",
					if: "(ctx.event?.action == 'ip-session-initiated' || ctx.event?.action == 'http-access') && ctx.cisco?.meraki?.firewall?.action != 'deny'",
				},
			},
		],
	},
};

// The current (pre-edit) file content the GitLab read returns, base64-wrapped as the API does.
const existingFile = (obj: Record<string, unknown>) =>
	`[200] ${JSON.stringify({ content: Buffer.from(`${JSON.stringify(obj, null, 2)}\n`).toString("base64"), encoding: "base64" })}`;

const PRIOR_BODY = {
	name: "logs-cisco_meraki.log@custom",
	description: "ap-cld noise reduction Phase 2.",
	processors: [
		{ drop: { description: "Drop ip-session-initiated only.", if: "ctx.event?.action == 'ip-session-initiated'" } },
	],
};

describe("parseIntentJson -- ingest-pipeline-edit", () => {
	test("maps a 'replace the entire contents' request to ingest-pipeline-edit with a verbatim body", () => {
		const raw = JSON.stringify({
			workflow: "ingest-pipeline-edit",
			cluster: "ap-cld",
			ingestPipelineEdits: [MERAKI_EDIT],
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("ingest-pipeline-edit");
		expect(req.cluster).toBe("ap-cld");
		expect(req.ingestPipelineEdits).toHaveLength(1);
		// name is the FILE BASENAME from the path, not the body's name field.
		expect(req.ingestPipelineEdits?.[0]?.name).toBe("drop-cisco-meraki-ip-session");
		expect(req.ingestPipelineEdits?.[0]?.body).toEqual(MERAKI_EDIT.body);
		expect(req.clarification).toBeUndefined();
	});

	test("strips a trailing .json from the file basename", () => {
		const raw = JSON.stringify({
			workflow: "ingest-pipeline-edit",
			cluster: "ap-cld",
			ingestPipelineEdits: [{ name: "drop-cisco-meraki-ip-session.json", body: MERAKI_EDIT.body }],
		});
		const req = parseIntentJson(raw);
		expect(req.ingestPipelineEdits?.[0]?.name).toBe("drop-cisco-meraki-ip-session");
	});
});

describe("branchSlug -- ingest-pipeline-edit", () => {
	test("uses cluster + joined file basenames + workflow", () => {
		const req: IacRequest = {
			workflow: "ingest-pipeline-edit",
			isProd: false,
			cluster: "ap-cld",
			ingestPipelineEdits: [MERAKI_EDIT],
		};
		const slug = branchSlug(req);
		// Leads with the cluster + the file basename (lowercased); the 40-char cap can truncate the
		// trailing workflow segment, exactly as the create slug does.
		expect(slug.startsWith("ap-cld-drop-cisco-meraki")).toBe(true);
		expect(slug.length).toBeLessThanOrEqual(40);
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

describe("draftChange -> proposeIngestPipelineEdit", () => {
	test("happy path: REPLACES an existing file on ONE branch with action 'update' + before/after diff", async () => {
		const { draftChange } = await import("./nodes.ts");
		const committed: Array<Record<string, unknown>> = [];
		const simulated: Array<Record<string, unknown>> = [];
		let branchCreates = 0;
		const reads: string[] = [];
		mockTools({
			elastic_simulate_ingest_pipeline: (args) => {
				simulated.push(args);
				return '[200] {"docs":[{"doc":{"_source":{}}}]}';
			},
			// The file EXISTS -> a 2xx with the prior body, so the edit proceeds (vs create, which skips a 2xx).
			gitlab_get_file_content: (args) => {
				reads.push(String(args.filePath));
				return existingFile(PRIOR_BODY);
			},
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
				workflow: "ingest-pipeline-edit" as const,
				isProd: false,
				cluster: "ap-cld",
				ingestPipelineEdits: [MERAKI_EDIT],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(branchCreates).toBe(1);
		// The target path is derived from the FILE BASENAME, not the body name.
		expect(reads[0]).toBe("environments/ap-cld/ingest-pipelines/drop-cisco-meraki-ip-session.json");
		expect(committed).toHaveLength(1);
		// The distinguishing inversion vs create: action is "update".
		expect(committed[0]?.action).toBe("update");
		expect(String(committed[0]?.file_path)).toBe(
			"environments/ap-cld/ingest-pipelines/drop-cisco-meraki-ip-session.json",
		);
		// Body committed verbatim.
		expect(JSON.parse(String(committed[0]?.content))).toEqual(MERAKI_EDIT.body);
		// SIO-1020 simulate ran with the top-level name dropped.
		expect(simulated).toHaveLength(1);
		expect((simulated[0]?.pipeline as Record<string, unknown>)?.name).toBeUndefined();
		expect(simulated[0]?.deployment).toBe("ap-cld");
		// Before/after diff: shows the removed prior `if` and the new `if`.
		expect(result.proposedDiff).toContain("Phase 2"); // from the prior body (removed)
		expect(result.proposedDiff).toContain("http-access"); // from the new body (added)
	});

	test("blocks (no branch, no commit) when the target file does not exist (404)", async () => {
		const { draftChange } = await import("./nodes.ts");
		let branchCreates = 0;
		let commits = 0;
		mockTools({
			elastic_simulate_ingest_pipeline: () => '[200] {"docs":[]}',
			// A 404 on an EDIT must block -- the edit path never silently creates.
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
				workflow: "ingest-pipeline-edit" as const,
				isProd: false,
				cluster: "ap-cld",
				ingestPipelineEdits: [MERAKI_EDIT],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("No ingest-pipeline file");
		expect(result.blockedReason).toContain("drop-cisco-meraki-ip-session");
		// A 404 is reached only after the branch is created (the read is per-file in the commit loop),
		// but no COMMIT happens.
		expect(branchCreates).toBe(1);
		expect(commits).toBe(0);
		expect(result.precheckPassed).toBeUndefined();
	});

	test("blocks when simulate rejects the replacement body (no commit)", async () => {
		const { draftChange } = await import("./nodes.ts");
		let commits = 0;
		mockTools({
			elastic_simulate_ingest_pipeline: () =>
				'[400] {"error":{"type":"parse_exception","reason":"[patterns] Invalid regex pattern"}}',
			gitlab_get_file_content: () => existingFile(PRIOR_BODY),
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => {
				commits += 1;
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "ingest-pipeline-edit" as const,
				isProd: false,
				cluster: "ap-cld",
				ingestPipelineEdits: [MERAKI_EDIT],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("failed simulation");
		expect(result.blockedReason).toContain("parse_exception");
		expect(commits).toBe(0);
	});

	test("blocks when a body is not a JSON object", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: {
				workflow: "ingest-pipeline-edit" as const,
				isProd: false,
				cluster: "ap-cld",
				ingestPipelineEdits: [{ name: "drop-x", body: [] as unknown as Record<string, unknown> }],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("JSON-object body");
	});
});
