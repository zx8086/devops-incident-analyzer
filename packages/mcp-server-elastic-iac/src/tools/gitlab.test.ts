// src/tools/gitlab.test.ts
import { describe, expect, test } from "bun:test";
import { buildCommitFileBody, flipCommitAction } from "./gitlab.ts";

// SIO-873: the GitLab commits API needs a single action with the FULL new file content
// (not a diff). This is what gitlab_commit_file POSTs.
describe("buildCommitFileBody", () => {
	test("defaults to a single update action with full content", () => {
		const body = buildCommitFileBody({
			branch: "agent/ap-cld-9-4-2-version-upgrade-20260602",
			commitMessage: "ap-cld: upgrade Elasticsearch 9.4.1 -> 9.4.2",
			filePath: "environments/_deployments/ap-cld.json",
			content: '{\n  "version": "9.4.2"\n}\n',
		});
		expect(body.branch).toBe("agent/ap-cld-9-4-2-version-upgrade-20260602");
		expect(body.commit_message).toContain("9.4.1 -> 9.4.2");
		expect(body.actions).toHaveLength(1);
		expect(body.actions[0]).toEqual({
			action: "update",
			file_path: "environments/_deployments/ap-cld.json",
			content: '{\n  "version": "9.4.2"\n}\n',
		});
	});

	// SIO-885: the reconcile marker is a NEW file -> create. "update" on it 400s.
	test("honors an explicit create action (new file)", () => {
		const body = buildCommitFileBody({
			branch: "agent/reconcile-eu-b2b-templates-reconcile-to-json",
			commitMessage: "eu-b2b: reconcile templates to declared config",
			filePath: "stacks/templates/.agent-reconcile/eu-b2b.json",
			content: "{}\n",
			action: "create",
		});
		expect(body.actions[0]?.action).toBe("create");
	});
});

// SIO-885: gitlab_commit_file is an upsert. flipCommitAction recovers from the action/file
// mismatch GitLab returns ("doesn't exist" / "already exists") by flipping update<->create.
describe("flipCommitAction", () => {
	test("update on a missing file -> retry as create", () => {
		expect(flipCommitAction("update", '[400] {"message":"A file with this name doesn\'t exist"}')).toBe("create");
		// tolerate the "does not exist" phrasing too
		expect(flipCommitAction("update", '[400] {"message":"A file with this name does not exist"}')).toBe("create");
	});
	test("create on an existing file -> retry as update", () => {
		expect(flipCommitAction("create", '[400] {"message":"A file with this name already exists"}')).toBe("update");
	});
	test("null when the response is not a recoverable file-exists mismatch", () => {
		expect(flipCommitAction("update", '[201] {"id":"abc"}')).toBeNull();
		expect(flipCommitAction("update", '[403] {"message":"insufficient permissions"}')).toBeNull();
		expect(flipCommitAction("create", '[400] {"message":"branch not found"}')).toBeNull();
	});
});

// SIO-875: the terraform-report walk (parent -> child -> plan job).
import { childPipelineId, planJob } from "./gitlab.ts";

describe("childPipelineId", () => {
	test("returns the first downstream pipeline id from bridges", () => {
		const bridges = [{ name: "deploy", downstream_pipeline: { id: 343, status: "success" } }];
		expect(childPipelineId(bridges)).toBe(343);
	});
	test("null when no bridge / no downstream yet", () => {
		expect(childPipelineId([])).toBeNull();
		expect(childPipelineId([{ name: "deploy", downstream_pipeline: null }])).toBeNull();
		expect(childPipelineId({ not: "an array" })).toBeNull();
	});
});

describe("planJob", () => {
	test("finds the plan:<deployment>:<stack> job and parses the stack", () => {
		const jobs = [
			{ id: 1307, name: "validate" },
			{ id: 1308, name: "plan:ap-cld:deployments" },
		];
		expect(planJob(jobs)).toEqual({ id: 1308, stack: "deployments" });
	});
	test("null when no plan job present yet", () => {
		expect(planJob([{ id: 1, name: "validate" }])).toBeNull();
		expect(planJob([])).toBeNull();
		expect(planJob("nope")).toBeNull();
	});
});

// SIO-884: drift-check job/pipeline helpers.
import { findJobByName, parsePipelineRef } from "./gitlab.ts";

describe("findJobByName", () => {
	test("returns the id of the matching job", () => {
		const jobs = [
			{ id: 1, name: "validate" },
			{ id: 2, name: "drift-check-on-demand" },
		];
		expect(findJobByName(jobs, "drift-check-on-demand")).toBe(2);
	});
	test("null when absent / non-array", () => {
		expect(findJobByName([{ id: 1, name: "validate" }], "drift-check-on-demand")).toBeNull();
		expect(findJobByName("nope", "x")).toBeNull();
	});
});

describe("parsePipelineRef", () => {
	test("reads id + status from a create-pipeline body", () => {
		expect(parsePipelineRef(`[201] ${JSON.stringify({ id: 555, status: "created" })}`)).toEqual({
			id: 555,
			status: "created",
		});
	});
	test("defaults status to 'created' and null on no id", () => {
		expect(parsePipelineRef(`[201] ${JSON.stringify({ id: 7 })}`)).toEqual({ id: 7, status: "created" });
		expect(parsePipelineRef("[500] err")).toBeNull();
	});
});

import { buildSyntheticsPipelineVars } from "./gitlab.ts";

// SIO-902: the synthetics trigger var array. Whole-deployment (no STACK); PROJECT only when scoped.
describe("buildSyntheticsPipelineVars", () => {
	test("drift-check: SYNTH_DRIFT_CHECK + DEPLOYMENT, no PROJECT when omitted", () => {
		expect(buildSyntheticsPipelineVars("SYNTH_DRIFT_CHECK", "eu-b2b")).toEqual([
			{ key: "SYNTH_DRIFT_CHECK", value: "true" },
			{ key: "DEPLOYMENT", value: "eu-b2b" },
		]);
	});

	test("push: SYNTH_PUSH + DEPLOYMENT + PROJECT when project-scoped", () => {
		expect(buildSyntheticsPipelineVars("SYNTH_PUSH", "eu-b2b", "eu-oit.prd")).toEqual([
			{ key: "SYNTH_PUSH", value: "true" },
			{ key: "DEPLOYMENT", value: "eu-b2b" },
			{ key: "PROJECT", value: "eu-oit.prd" },
		]);
	});

	test("never emits a STACK variable", () => {
		const vars = buildSyntheticsPipelineVars("SYNTH_DRIFT_CHECK", "eu-b2b", "eu-oit.prd");
		expect(vars.some((v) => v.key === "STACK")).toBe(false);
	});
});
