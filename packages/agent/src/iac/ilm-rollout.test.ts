// agent/src/iac/ilm-rollout.test.ts
import { describe, expect, mock, test } from "bun:test";
import { branchSlug, deploymentJsonPath, detectRetentionReduction, mergeIlmPhases, parseIntentJson } from "./nodes.ts";
import type { IacRequest, IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

const POLICY = JSON.stringify(
	{
		name: "90-days@lifecycle",
		hot: { max_age: "30d", max_primary_shard_size: "50gb", min_docs: 1, rollover: true },
		warm: { min_age: "2d", forcemerge: { max_num_segments: 1 } },
		cold: { min_age: "30d" },
		delete: { min_age: "90d", delete_searchable_snapshot: true },
	},
	null,
	2,
);

describe("mergeIlmPhases", () => {
	test("replaces a scalar leaf and captures the previous value", () => {
		const { content, previous } = mergeIlmPhases(POLICY, { delete: { min_age: "60d" } });
		const parsed = JSON.parse(content) as { delete: { min_age: string; delete_searchable_snapshot: boolean } };
		expect(parsed.delete.min_age).toBe("60d");
		expect(parsed.delete.delete_searchable_snapshot).toBe(true);
		expect(previous).toEqual({ delete: { min_age: "90d" } });
	});

	test("deep-merges a nested object without clobbering siblings", () => {
		const { content, previous } = mergeIlmPhases(POLICY, { warm: { forcemerge: { max_num_segments: 2 } } });
		const parsed = JSON.parse(content) as { warm: { min_age: string; forcemerge: { max_num_segments: number } } };
		expect(parsed.warm.forcemerge.max_num_segments).toBe(2);
		expect(parsed.warm.min_age).toBe("2d");
		expect(previous).toEqual({ warm: { forcemerge: { max_num_segments: 1 } } });
	});

	test("applies a multi-phase patch in one call", () => {
		const { content, previous } = mergeIlmPhases(POLICY, {
			delete: { min_age: "60d" },
			warm: { forcemerge: { max_num_segments: 2 } },
		});
		const parsed = JSON.parse(content) as {
			delete: { min_age: string };
			warm: { forcemerge: { max_num_segments: number } };
		};
		expect(parsed.delete.min_age).toBe("60d");
		expect(parsed.warm.forcemerge.max_num_segments).toBe(2);
		expect(previous).toEqual({ delete: { min_age: "90d" }, warm: { forcemerge: { max_num_segments: 1 } } });
	});

	test("preserves 2-space indent and a trailing newline", () => {
		const { content } = mergeIlmPhases(POLICY, { delete: { min_age: "60d" } });
		expect(content.endsWith("}\n")).toBe(true);
		expect(content).toContain('\n  "delete": {');
	});

	test("captures undefined previous for a newly added nested leaf", () => {
		const { previous } = mergeIlmPhases(POLICY, { hot: { priority: 50 } });
		expect((previous as { hot: { priority?: unknown } }).hot.priority).toBeUndefined();
	});

	test("throws on non-object JSON", () => {
		expect(() => mergeIlmPhases("[]", { delete: { min_age: "60d" } })).toThrow();
	});
});

describe("detectRetentionReduction", () => {
	test("flags a shorter delete.min_age as a reduction", () => {
		const r = detectRetentionReduction({ delete: { min_age: "90d" } }, { delete: { min_age: "30d" } });
		expect(r).toEqual({ from: "90d", to: "30d" });
	});

	test("returns null when retention increases", () => {
		expect(detectRetentionReduction({ delete: { min_age: "30d" } }, { delete: { min_age: "60d" } })).toBeNull();
	});

	test("compares across units (48h is shorter than 3d)", () => {
		const r = detectRetentionReduction({ delete: { min_age: "3d" } }, { delete: { min_age: "48h" } });
		expect(r).toEqual({ from: "3d", to: "48h" });
	});

	test("returns null when the patch does not touch delete.min_age", () => {
		expect(detectRetentionReduction({ warm: { min_age: "2d" } }, { warm: { min_age: "1d" } })).toBeNull();
	});

	test("returns null on an unparseable duration", () => {
		expect(detectRetentionReduction({ delete: { min_age: "90d" } }, { delete: { min_age: "forever" } })).toBeNull();
	});
});

describe("parseIntentJson — ilm-rollout", () => {
	test("extracts workflow/cluster/policyName/phasesPatch with no clarification", () => {
		const raw = JSON.stringify({
			workflow: "ilm-rollout",
			cluster: "eu-b2b",
			policyName: "30-days@lifecycle",
			phasesPatch: { delete: { min_age: "60d" } },
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("ilm-rollout");
		expect(req.cluster).toBe("eu-b2b");
		expect(req.policyName).toBe("30-days@lifecycle");
		expect(req.phasesPatch).toEqual({ delete: { min_age: "60d" } });
		expect(req.clarification).toBeUndefined();
	});

	test("normalizes an explicit-null phasesPatch to undefined", () => {
		const raw = JSON.stringify({ workflow: "ilm-rollout", cluster: "eu-b2b", policyName: "logs", phasesPatch: null });
		const req = parseIntentJson(raw);
		expect(req.phasesPatch).toBeUndefined();
	});
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - ${policy} names the literal placeholder under test
describe("deploymentJsonPath — ${policy} substitution", () => {
	test("substitutes both cluster and policy, preserving @ and . in the filename", () => {
		const path = deploymentJsonPath(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - literal ${cluster}/${policy} placeholders are the test input
			"environments/${cluster}/lifecycle-policies/${policy}.json",
			"eu-b2b",
			"30-days@lifecycle",
		);
		expect(path).toBe("environments/eu-b2b/lifecycle-policies/30-days@lifecycle.json");
	});

	test("still works for a cluster-only template (back-compat)", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - literal ${cluster} placeholder is the test input
		expect(deploymentJsonPath("environments/_deployments/${cluster}.json", "ap-cld")).toBe(
			"environments/_deployments/ap-cld.json",
		);
	});
});

describe("branchSlug — ilm-rollout", () => {
	test("uses policyName as the descriptor and slugs @/.", () => {
		const req: IacRequest = {
			workflow: "ilm-rollout",
			isProd: false,
			cluster: "eu-b2b",
			policyName: "30-days@lifecycle",
		};
		// slug lowercases and replaces non-[a-z0-9-] runs with a single '-'
		expect(branchSlug(req)).toBe("eu-b2b-30-days-lifecycle-ilm-rollout");
	});
});

// Build a fake tool set so callTool() inside nodes.ts resolves against our stubs.
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

describe("draftChange -> proposeIlmChange", () => {
	test("happy path: edits the policy JSON, commits, sets precheckPassed + diff", async () => {
		const { draftChange } = await import("./nodes.ts");
		const policy = JSON.stringify({ name: "30-days@lifecycle", delete: { min_age: "30d" } }, null, 2);
		mockTools({
			gitlab_get_file_content: () =>
				`[200] ${JSON.stringify({ content: Buffer.from(policy).toString("base64"), encoding: "base64" })}`,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "ilm-rollout" as const,
				isProd: false,
				cluster: "eu-b2b",
				policyName: "30-days@lifecycle",
				phasesPatch: { delete: { min_age: "60d" } },
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedFilePath).toBe("environments/eu-b2b/lifecycle-policies/30-days@lifecycle.json");
		expect(result.proposedDiff).toContain('"min_age"');
		// SIO-933: a MODIFY diff stays terse -- only the patched leaves. The existing policy has no
		// `priority`, the patch doesn't set one, so it must NOT appear (proves the modify branch is
		// unchanged and we did not start dumping the whole file on a modify).
		expect(result.proposedDiff).not.toContain('"priority"');
		expect(result.retentionChange).toBeNull(); // 30d -> 60d is an INCREASE, not a reduction
	});

	test("blocks with a clear message when phasesPatch is empty", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: { workflow: "ilm-rollout" as const, isProd: false, cluster: "eu-b2b", policyName: "logs" },
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("phase field");
	});

	test("creates the policy file when it 404s (onboards an untracked policy)", async () => {
		const { draftChange } = await import("./nodes.ts");
		let committed: Record<string, unknown> = {};
		mockTools({
			gitlab_get_file_content: () => '[404] {"message":"404 File Not Found"}',
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (args) => {
				committed = args;
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "ilm-rollout" as const,
				isProd: false,
				cluster: "eu-b2b",
				policyName: ".alerts-ilm-policy",
				phasesPatch: { hot: { max_age: "30d", rollover: true }, delete: { min_age: "90d" } },
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toBeUndefined();
		expect(result.policyCreated).toBe(true);
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedFilePath).toBe("environments/eu-b2b/lifecycle-policies/.alerts-ilm-policy.json");
		expect(result.retentionChange).toBeNull();
		expect(result.proposedDiff).toContain("NEW ILM policy");
		expect(result.proposedDiff).toContain('"min_age"');
		// SIO-933: a CREATE diff renders the FULL resulting policy as additions, so the reviewer can
		// confirm it -- the `name` and inherited canonical fields (e.g. `priority`, never in the patch)
		// must be visible, not just the patched leaves.
		expect(result.proposedDiff).toContain('"name"');
		expect(result.proposedDiff).toContain('"priority"');
		expect(committed.action).toBe("create");
		const written = JSON.parse(String(committed.content)) as { name: string; delete: { min_age: string } };
		expect(written.name).toBe(".alerts-ilm-policy");
		expect(written.delete.min_age).toBe("90d");
	});

	test("sets retentionChange when retention is reduced", async () => {
		const { draftChange } = await import("./nodes.ts");
		const policy = JSON.stringify({ name: "90-days@lifecycle", delete: { min_age: "90d" } }, null, 2);
		mockTools({
			gitlab_get_file_content: () =>
				`[200] ${JSON.stringify({ content: Buffer.from(policy).toString("base64"), encoding: "base64" })}`,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "ilm-rollout" as const,
				isProd: false,
				cluster: "eu-cld",
				policyName: "90-days@lifecycle",
				phasesPatch: { delete: { min_age: "30d" } },
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.retentionChange).toEqual({ from: "90d", to: "30d" });
	});
});

// SIO-933: optional component-template bind. The bind file is committed onto the SAME branch as the
// policy (one MR). Component-template path is environments/<cluster>/cluster-defaults/<template>.json.
describe("draftChange -> bind component-template (SIO-933)", () => {
	const SPARSE_TEMPLATE = JSON.stringify(
		{ name: "logs-generic.otel@custom", settings: { index: { codec: "best_compression" } } },
		null,
		2,
	);
	const b64 = (s: string) =>
		`[200] ${JSON.stringify({ content: Buffer.from(s).toString("base64"), encoding: "base64" })}`;
	const POLICY_PATH = "environments/eu-cld/lifecycle-policies/eu-otel-logs-lifecycle-prod.json";
	const TEMPLATE_PATH = "environments/eu-cld/cluster-defaults/logs-generic.otel.json";

	test("creates the policy AND binds the template in ONE MR", async () => {
		const { draftChange } = await import("./nodes.ts");
		const committed: Record<string, { content: string; action?: string }> = {};
		mockTools({
			// policy 404s (create-from-scratch, no siblings -> canonical shape); template exists.
			gitlab_get_file_content: (a) =>
				String(a.filePath) === TEMPLATE_PATH ? b64(SPARSE_TEMPLATE) : '[404] {"message":"404 File Not Found"}',
			gitlab_get_repository_tree: () => "[200] []",
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (a) => {
				committed[String(a.file_path)] = { content: String(a.content), action: a.action as string };
				return "[201] {}";
			},
		});
		const result = await draftChange(
			asIacState({
				iacRequest: {
					workflow: "ilm-rollout" as const,
					isProd: false,
					cluster: "eu-cld",
					policyName: "eu-otel-logs-lifecycle-prod",
					phasesPatch: { delete: { min_age: "30d" } },
					bindTemplate: "logs-generic.otel",
				},
			}),
		);
		expect(result.blockedReason).toBeUndefined();
		// BOTH files in the MR, policy first.
		expect(result.proposedFiles).toEqual([POLICY_PATH, TEMPLATE_PATH]);
		expect(result.lifecycleRetargeted).toBe(true);
		// Template commit sets the nested lifecycle.name, preserving the sibling codec setting.
		const tpl = JSON.parse(committed[TEMPLATE_PATH]?.content ?? "{}");
		expect(tpl.settings.index.lifecycle.name).toBe("eu-otel-logs-lifecycle-prod");
		expect(tpl.settings.index.codec).toBe("best_compression");
		expect(committed[TEMPLATE_PATH]?.action).toBe("update");
		// Diff carries both the NEW-policy block and the component-template block.
		expect(result.proposedDiff).toContain("NEW ILM policy");
		expect(result.proposedDiff).toContain("component-template logs-generic.otel");
		expect(result.proposedDiff).toContain("settings.index.lifecycle");
	});

	test("blocks the whole turn (no MR) when the bind target template 404s", async () => {
		const { draftChange } = await import("./nodes.ts");
		const policy = JSON.stringify({ name: "logs@lifecycle", delete: { min_age: "90d" } }, null, 2);
		mockTools({
			// policy exists; template 404s.
			gitlab_get_file_content: (a) =>
				String(a.filePath) === TEMPLATE_PATH ? '[404] {"message":"404 File Not Found"}' : b64(policy),
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const result = await draftChange(
			asIacState({
				iacRequest: {
					workflow: "ilm-rollout" as const,
					isProd: false,
					cluster: "eu-cld",
					policyName: "logs@lifecycle",
					phasesPatch: { delete: { min_age: "60d" } },
					bindTemplate: "logs-generic.otel",
				},
			}),
		);
		expect(result.blockedReason).toContain("logs-generic.otel");
		expect(result.blockedReason).toContain("not found");
		expect(String(result.messages?.[0]?.content)).toContain("partial MR");
		// No MR fields set -- the turn is blocked atomically.
		expect(result.proposedFiles).toBeUndefined();
		expect(result.precheckPassed).toBeUndefined();
	});

	test("a no-op bind (template already points at the policy) still proposes the policy alone", async () => {
		const { draftChange } = await import("./nodes.ts");
		const policy = JSON.stringify({ name: "logs@lifecycle", delete: { min_age: "90d" } }, null, 2);
		const boundTemplate = JSON.stringify({
			name: "logs-generic.otel@custom",
			settings: { index: { lifecycle: { name: "logs@lifecycle" } } },
		});
		mockTools({
			gitlab_get_file_content: (a) => (String(a.filePath) === TEMPLATE_PATH ? b64(boundTemplate) : b64(policy)),
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const result = await draftChange(
			asIacState({
				iacRequest: {
					workflow: "ilm-rollout" as const,
					isProd: false,
					cluster: "eu-cld",
					policyName: "logs@lifecycle",
					phasesPatch: { delete: { min_age: "60d" } },
					bindTemplate: "logs-generic.otel",
				},
			}),
		);
		expect(result.blockedReason).toBeUndefined();
		// Only the policy file -- the bind was a no-op and contributes nothing.
		expect(result.proposedFiles).toEqual(["environments/eu-cld/lifecycle-policies/logs@lifecycle.json"]);
		expect(result.lifecycleRetargeted).toBe(false);
	});

	test("bind-only: a no-op policy patch + bindTemplate still opens an MR for the bind", async () => {
		const { draftChange } = await import("./nodes.ts");
		// Policy already has delete.min_age 90d, so patching it to 90d is a no-op.
		const policy = JSON.stringify({ name: "logs@lifecycle", delete: { min_age: "90d" } }, null, 2);
		const committed: Record<string, string> = {};
		mockTools({
			gitlab_get_file_content: (a) => (String(a.filePath) === TEMPLATE_PATH ? b64(SPARSE_TEMPLATE) : b64(policy)),
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (a) => {
				committed[String(a.file_path)] = String(a.content);
				return "[201] {}";
			},
		});
		const result = await draftChange(
			asIacState({
				iacRequest: {
					workflow: "ilm-rollout" as const,
					isProd: false,
					cluster: "eu-cld",
					policyName: "logs@lifecycle",
					phasesPatch: { delete: { min_age: "90d" } }, // no-op
					bindTemplate: "logs-generic.otel",
				},
			}),
		);
		expect(result.blockedReason).toBeUndefined();
		// Policy skipped (no-op), only the template file is in the MR.
		expect(result.proposedFiles).toEqual([TEMPLATE_PATH]);
		expect(result.lifecycleRetargeted).toBe(true);
		expect(committed[POLICY_PATH]).toBeUndefined(); // policy was never committed
	});

	test("blocks a bind combined with a multi-file (>=2) request", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const result = await draftChange(
			asIacState({
				iacRequest: {
					workflow: "ilm-rollout" as const,
					isProd: false,
					cluster: "eu-cld",
					bindTemplate: "logs-generic.otel",
					ilmPolicies: [
						{ policyName: "metrics", phasesPatch: { warm: { allocate: { number_of_replicas: 0 } } } },
						{ policyName: "logs", phasesPatch: { warm: { allocate: { number_of_replicas: 0 } } } },
					],
				},
			}),
		);
		expect(result.blockedReason).toContain("multiple ILM policies");
		expect(result.proposedFiles).toBeUndefined();
	});
});

// SIO-932: one request naming >=2 policy files -> ONE branch + ONE MR with all files.
describe("parseIntentJson — multi-file ilm (SIO-932)", () => {
	test("keeps the ilmPolicies array and nulls the singular policyName when >=2 entries", () => {
		const raw = JSON.stringify({
			workflow: "ilm-rollout",
			cluster: "eu-b2b",
			ilmPolicies: [
				{ policyName: "metrics", phasesPatch: { warm: { allocate: { number_of_replicas: 0 } } } },
				{ policyName: "logs", phasesPatch: { warm: { allocate: { number_of_replicas: 0 } } } },
			],
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("ilm-rollout");
		expect(req.cluster).toBe("eu-b2b");
		expect(req.ilmPolicies?.length).toBe(2);
		expect(req.ilmPolicies?.map((e) => e.policyName)).toEqual(["metrics", "logs"]);
		// singular fields stay empty on the multi path (draftChange dispatches on ilmPolicies.length)
		expect(req.policyName).toBeUndefined();
		expect(req.phasesPatch).toBeUndefined();
	});

	test("folds a single-entry ilmPolicies array back to the singular path (back-compat)", () => {
		const raw = JSON.stringify({
			workflow: "ilm-rollout",
			cluster: "eu-b2b",
			ilmPolicies: [{ policyName: "metrics", phasesPatch: { warm: { allocate: { number_of_replicas: 0 } } } }],
		});
		const req = parseIntentJson(raw);
		expect(req.ilmPolicies).toBeUndefined();
		expect(req.policyName).toBe("metrics");
		expect(req.phasesPatch).toEqual({ warm: { allocate: { number_of_replicas: 0 } } });
	});

	test("normalizes an explicit-null ilmPolicies to undefined (uses singular fields)", () => {
		const raw = JSON.stringify({
			workflow: "ilm-rollout",
			cluster: "eu-b2b",
			policyName: "logs",
			phasesPatch: { warm: { allocate: { number_of_replicas: 0 } } },
			ilmPolicies: null,
		});
		const req = parseIntentJson(raw);
		expect(req.ilmPolicies).toBeUndefined();
		expect(req.policyName).toBe("logs");
	});

	// SIO-932: users name the file with the extension ("set X in metrics.json"); the template already
	// appends .json, so a doubled metrics.json.json would 404 and onboard a bogus policy. Strip it.
	test("strips a trailing .json from each ilmPolicies entry's policyName", () => {
		const raw = JSON.stringify({
			workflow: "ilm-rollout",
			cluster: "eu-b2b",
			ilmPolicies: [
				{ policyName: "metrics.json", phasesPatch: { cold: { priority: 30 } } },
				{ policyName: "logs.json", phasesPatch: { cold: { priority: 30 } } },
			],
		});
		const req = parseIntentJson(raw);
		expect(req.ilmPolicies?.map((e) => e.policyName)).toEqual(["metrics", "logs"]);
	});

	test("strips a trailing .json from the singular policyName + sourcePolicy (ilm-rollout)", () => {
		const raw = JSON.stringify({
			workflow: "ilm-rollout",
			cluster: "eu-b2b",
			policyName: "metrics.json",
			sourcePolicy: "logs.json",
		});
		const req = parseIntentJson(raw);
		expect(req.policyName).toBe("metrics");
		expect(req.sourcePolicy).toBe("logs");
	});

	// SIO-933: bindTemplate is a cluster-defaults basename; users write it with .json. Strip it for
	// ilm-rollout (mirrors policyName/sourcePolicy); the @custom suffix lives in the file's name, not
	// the basename, so it must NOT be stripped.
	test("strips a trailing .json from bindTemplate for ilm-rollout", () => {
		const raw = JSON.stringify({
			workflow: "ilm-rollout",
			cluster: "eu-cld",
			policyName: "eu-otel-logs-lifecycle-prod",
			sourcePolicy: "eu-default-lifecycle-logs-prod",
			bindTemplate: "logs-generic.otel.json",
		});
		const req = parseIntentJson(raw);
		expect(req.bindTemplate).toBe("logs-generic.otel");
	});

	test("preserves @lifecycle basenames and only removes the .json suffix", () => {
		const raw = JSON.stringify({
			workflow: "ilm-rollout",
			cluster: "eu-b2b",
			policyName: "30-days@lifecycle.json",
			phasesPatch: { delete: { min_age: "60d" } },
		});
		const req = parseIntentJson(raw);
		expect(req.policyName).toBe("30-days@lifecycle");
	});
});

describe("branchSlug — multi-file ilm (SIO-932)", () => {
	test("joins the policy names into one descriptor", () => {
		const req: IacRequest = {
			workflow: "ilm-rollout",
			isProd: false,
			cluster: "eu-b2b",
			ilmPolicies: [
				{ policyName: "metrics", phasesPatch: { warm: {} } },
				{ policyName: "logs", phasesPatch: { warm: {} } },
			],
		};
		expect(branchSlug(req)).toBe("eu-b2b-metrics-logs-ilm-rollout");
	});
});

describe("draftChange -> proposeIlmChanges (multi-file, SIO-932)", () => {
	// The exact failing case from the bug report: metrics.json AND logs.json, replicas -> 0.
	const policyFor = (name: string) => JSON.stringify({ name, warm: { allocate: { number_of_replicas: 1 } } }, null, 2);

	test("commits BOTH files to ONE branch and aggregates files + diff", async () => {
		const { draftChange } = await import("./nodes.ts");
		const branchesCreated: string[] = [];
		const commits: Array<{ branch: string; file_path: string }> = [];
		mockTools({
			gitlab_get_file_content: (args) => {
				const fp = String(args.filePath);
				const name = fp.includes("/metrics.json") ? "metrics" : "logs";
				return `[200] ${JSON.stringify({ content: Buffer.from(policyFor(name)).toString("base64"), encoding: "base64" })}`;
			},
			gitlab_create_branch: (args) => {
				branchesCreated.push(String(args.branch));
				return "[201] {}";
			},
			gitlab_commit_file: (args) => {
				commits.push({ branch: String(args.branch), file_path: String(args.file_path) });
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "ilm-rollout" as const,
				isProd: false,
				cluster: "eu-b2b",
				ilmPolicies: [
					{ policyName: "metrics", phasesPatch: { warm: { allocate: { number_of_replicas: 0 } } } },
					{ policyName: "logs", phasesPatch: { warm: { allocate: { number_of_replicas: 0 } } } },
				],
			},
		};
		const result = await draftChange(asIacState(state));

		expect(result.blockedReason).toBeUndefined();
		expect(result.precheckPassed).toBe(true);
		// ONE branch created, used for BOTH commits.
		expect(branchesCreated.length).toBe(1);
		expect(commits.length).toBe(2);
		expect(commits.every((c) => c.branch === branchesCreated[0])).toBe(true);
		expect(commits.map((c) => c.file_path).sort()).toEqual([
			"environments/eu-b2b/lifecycle-policies/logs.json",
			"environments/eu-b2b/lifecycle-policies/metrics.json",
		]);
		// proposedFiles is the authoritative list; combined diff names both files.
		expect(result.proposedFiles?.length).toBe(2);
		expect(result.proposedFiles).toEqual([
			"environments/eu-b2b/lifecycle-policies/metrics.json",
			"environments/eu-b2b/lifecycle-policies/logs.json",
		]);
		expect(result.proposedDiff).toContain("metrics.json");
		expect(result.proposedDiff).toContain("logs.json");
	});

	test("ATOMIC: a per-file failure blocks the whole batch (no MR-ready result)", async () => {
		const { draftChange } = await import("./nodes.ts");
		const commits: string[] = [];
		mockTools({
			gitlab_get_file_content: (args) => {
				const fp = String(args.filePath);
				if (fp.includes("/metrics.json")) {
					return `[200] ${JSON.stringify({ content: Buffer.from(policyFor("metrics")).toString("base64"), encoding: "base64" })}`;
				}
				// logs.json read fails (token/5xx) -> the helper blocks -> the whole batch blocks.
				return "[500] internal error";
			},
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (args) => {
				commits.push(String(args.file_path));
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "ilm-rollout" as const,
				isProd: false,
				cluster: "eu-b2b",
				ilmPolicies: [
					{ policyName: "metrics", phasesPatch: { warm: { allocate: { number_of_replicas: 0 } } } },
					{ policyName: "logs", phasesPatch: { warm: { allocate: { number_of_replicas: 0 } } } },
				],
			},
		};
		const result = await draftChange(asIacState(state));
		// Blocked, names the offending file, and is NOT MR-ready (precheckPassed stays falsy).
		expect(result.blockedReason).toContain("logs");
		expect(result.precheckPassed).toBeFalsy();
		// graph.ts routes a blockedReason straight to END, so openMr never runs.
	});

	test("blocks when an entry has neither a phasesPatch nor a sourcePolicy, naming the file", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: {
				workflow: "ilm-rollout" as const,
				isProd: false,
				cluster: "eu-b2b",
				ilmPolicies: [
					{ policyName: "metrics", phasesPatch: { warm: { allocate: { number_of_replicas: 0 } } } },
					{ policyName: "logs" },
				],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("logs");
		expect(result.blockedReason).toContain("phase field");
	});

	test("single-entry ilmPolicies path still produces a single-file MR (folded by parseIntentJson)", async () => {
		// parseIntentJson folds 1 entry to the singular fields, so draftChange sees the single path.
		const { draftChange } = await import("./nodes.ts");
		const policy = JSON.stringify({ name: "metrics", warm: { allocate: { number_of_replicas: 1 } } }, null, 2);
		const commits: string[] = [];
		mockTools({
			gitlab_get_file_content: () =>
				`[200] ${JSON.stringify({ content: Buffer.from(policy).toString("base64"), encoding: "base64" })}`,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (args) => {
				commits.push(String(args.file_path));
				return "[201] {}";
			},
		});
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "ilm-rollout",
				cluster: "eu-b2b",
				ilmPolicies: [{ policyName: "metrics", phasesPatch: { warm: { allocate: { number_of_replicas: 0 } } } }],
			}),
		);
		const result = await draftChange(asIacState({ iacRequest: req }));
		expect(result.blockedReason).toBeUndefined();
		expect(commits.length).toBe(1);
		expect(result.proposedFiles).toEqual(["environments/eu-b2b/lifecycle-policies/metrics.json"]);
		expect(result.proposedFilePath).toBe("environments/eu-b2b/lifecycle-policies/metrics.json");
	});
});

describe("reviewPlan — multi-file ilm (SIO-932)", () => {
	test("descriptor reads 'N ILM policies: <fields>'", async () => {
		const { reviewPlan } = await import("./nodes.ts");
		const state = {
			iacRequest: {
				workflow: "ilm-rollout" as const,
				isProd: false,
				cluster: "eu-b2b",
				ilmPolicies: [
					{ policyName: "metrics", phasesPatch: { warm: { allocate: { number_of_replicas: 0 } } } },
					{ policyName: "logs", phasesPatch: { warm: { allocate: { number_of_replicas: 0 } } } },
				],
			},
			branch: "agent/eu-b2b-metrics-logs-ilm-rollout-20260617",
			proposedFiles: [
				"environments/eu-b2b/lifecycle-policies/metrics.json",
				"environments/eu-b2b/lifecycle-policies/logs.json",
			],
			proposedDiff: "diff",
			precheckPassed: true,
		};
		const result = await reviewPlan(asIacState(state));
		expect(result.planReview?.title).toContain("2 ILM policies");
		expect(result.planReview?.title).toContain("warm");
	});
});

describe("reviewPlan — ilm-rollout", () => {
	const baseState = (retentionChange: { from: string; to: string } | null) => ({
		iacRequest: {
			workflow: "ilm-rollout" as const,
			isProd: false,
			cluster: "eu-cld",
			policyName: "90-days@lifecycle",
			phasesPatch: { delete: { min_age: retentionChange?.to ?? "120d" } },
		},
		branch: "agent/eu-cld-90-days-lifecycle-ilm-rollout-20260602",
		proposedDiff: "diff",
		precheckPassed: true,
		retentionChange,
	});

	test("marks the review kind config-edit and skips local terraform", async () => {
		const { reviewPlan } = await import("./nodes.ts");
		const result = await reviewPlan(asIacState(baseState(null)));
		expect(result.planReview?.kind).toBe("config-edit");
		expect(result.planReview?.plan).toContain("CI computes the Terraform plan");
	});

	test("adds the always-on ILM phase-transition risk", async () => {
		const { reviewPlan } = await import("./nodes.ts");
		const result = await reviewPlan(asIacState(baseState(null)));
		expect(result.risks?.some((r) => r.includes("force-merge") || r.includes("rolls over"))).toBe(true);
	});

	test("prepends a HIGH retention-reduction risk when retention is reduced", async () => {
		const { reviewPlan } = await import("./nodes.ts");
		const result = await reviewPlan(asIacState(baseState({ from: "90d", to: "30d" })));
		expect(result.risks?.[0]).toContain("Retention REDUCED 90d->30d");
		expect(result.risks?.[0]).toContain("irrecoverable");
	});

	test("title carries the policy name and changed-phase keys", async () => {
		const { reviewPlan } = await import("./nodes.ts");
		const result = await reviewPlan(asIacState(baseState(null)));
		expect(result.planReview?.title).toContain("90-days@lifecycle");
		expect(result.planReview?.title).toContain("delete");
	});

	test("labels a created policy and adds the new-policy risk note", async () => {
		const { reviewPlan } = await import("./nodes.ts");
		const result = await reviewPlan(asIacState({ ...baseState(null), policyCreated: true }));
		expect(result.planReview?.title).toContain("create");
		expect(result.risks?.some((r) => r.includes("NEW managed ILM policy"))).toBe(true);
	});
});
