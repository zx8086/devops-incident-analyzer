// gitagent-bridge/src/workflow.test.ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflows, WorkflowSchema, WorkflowStepSchema } from "./workflow.ts";

describe("WorkflowStepSchema: exactly-one-kind", () => {
	const base = { name: "s" };

	test("accepts a single skill step", () => {
		expect(WorkflowStepSchema.safeParse({ ...base, skill: "normalize-incident" }).success).toBe(true);
	});

	test("accepts a single graph step (graph: true)", () => {
		expect(WorkflowStepSchema.safeParse({ ...base, graph: true }).success).toBe(true);
	});

	test("rejects a step with no kind", () => {
		expect(WorkflowStepSchema.safeParse({ ...base }).success).toBe(false);
	});

	test("rejects a step with two kinds", () => {
		expect(WorkflowStepSchema.safeParse({ ...base, skill: "x", node: "y" }).success).toBe(false);
	});

	test("rejects unknown keys (strict)", () => {
		expect(WorkflowStepSchema.safeParse({ ...base, node: "classifier", bogus: 1 }).success).toBe(false);
	});
});

describe("WorkflowSchema", () => {
	test("accepts a full workflow with triggers, depends_on, templates, error_handling", () => {
		const wf = {
			name: "incident-triage",
			version: "0.1.0",
			description: "demo",
			triggers: [{ type: "manual" }],
			steps: [
				{ name: "pre", skill: "wiki-query", outputs: ["pages"] },
				{
					name: "triage",
					graph: true,
					depends_on: ["pre"],
					// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-843 - literal SkillsFlow template token, not a JS template string
					with: { wiki: "${{ steps.pre.outputs.pages }}" },
					outputs: ["report"],
				},
				{ name: "learn", tool: "memory-pr", depends_on: ["triage"], error_handling: "continue" },
			],
			error_handling: "best_effort",
		};
		expect(WorkflowSchema.safeParse(wf).success).toBe(true);
	});

	test("rejects an empty steps array", () => {
		const wf = { name: "x", version: "0.1.0", description: "d", steps: [] };
		expect(WorkflowSchema.safeParse(wf).success).toBe(false);
	});
});

describe("loadWorkflows", () => {
	test("returns an empty map when workflows/ is absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "gitagent-wf-none-"));
		try {
			expect(loadWorkflows(dir).size).toBe(0);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("parses every *.yaml keyed by workflow name", () => {
		const dir = mkdtempSync(join(tmpdir(), "gitagent-wf-"));
		mkdirSync(join(dir, "workflows"), { recursive: true });
		writeFileSync(
			join(dir, "workflows", "triage.yaml"),
			["name: triage", "version: 0.1.0", "description: d", "steps:", "  - name: a", "    node: classifier"].join("\n"),
		);
		try {
			const wfs = loadWorkflows(dir);
			expect(wfs.size).toBe(1);
			expect(wfs.has("triage")).toBe(true);
			expect(wfs.get("triage")?.steps[0]?.node).toBe("classifier");
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("throws with the file path on a schema-invalid workflow", () => {
		const dir = mkdtempSync(join(tmpdir(), "gitagent-wf-bad-"));
		mkdirSync(join(dir, "workflows"), { recursive: true });
		// step with two kinds -> superRefine failure
		writeFileSync(
			join(dir, "workflows", "broken.yaml"),
			[
				"name: broken",
				"version: 0.1.0",
				"description: d",
				"steps:",
				"  - name: a",
				"    node: classifier",
				"    skill: x",
			].join("\n"),
		);
		try {
			expect(() => loadWorkflows(dir)).toThrow(/broken\.yaml/);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});
