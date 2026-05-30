// skillflow/src/skillflow.test.ts
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: SIO-848 - this file deliberately tests literal SkillsFlow ${{ }} template tokens, not JS template strings
import { describe, expect, test } from "bun:test";
import { WorkflowSchema, type WorkflowStep } from "@devops-agent/gitagent-bridge";
import { topoSort, UnknownDependencyError, WorkflowCycleError } from "./dag.ts";
import { runWorkflow } from "./executor.ts";
import { type ResolvedStep, type StepHandlers, stepKind, stepTarget } from "./resolvers.ts";
import { resolveInputs, resolveTemplate, type TemplateContext, TemplateError } from "./template.ts";
import { shouldTrigger } from "./triggers.ts";

function step(name: string, extra: Partial<WorkflowStep> = {}): WorkflowStep {
	return { name, node: "classifier", ...extra } as WorkflowStep;
}

describe("topoSort", () => {
	test("orders dependencies first", () => {
		const steps = [step("c", { depends_on: ["b"] }), step("a"), step("b", { depends_on: ["a"] })];
		expect(topoSort(steps).map((s) => s.name)).toEqual(["a", "b", "c"]);
	});

	test("rejects an unknown dependency", () => {
		expect(() => topoSort([step("a", { depends_on: ["ghost"] })])).toThrow(UnknownDependencyError);
	});

	test("detects a cycle", () => {
		const steps = [step("a", { depends_on: ["b"] }), step("b", { depends_on: ["a"] })];
		expect(() => topoSort(steps)).toThrow(WorkflowCycleError);
	});
});

describe("resolveTemplate", () => {
	const ctx: TemplateContext = {
		steps: new Map([["pre", { pages: "p1,p2" }]]),
		trigger: { changed_files: "a.ts" },
	};

	test("resolves a step output reference", () => {
		expect(resolveTemplate("got ${{ steps.pre.outputs.pages }}", ctx)).toBe("got p1,p2");
	});

	test("resolves a trigger reference", () => {
		expect(resolveTemplate("${{ trigger.changed_files }}", ctx)).toBe("a.ts");
	});

	test("throws on an unknown step output (strict)", () => {
		expect(() => resolveTemplate("${{ steps.pre.outputs.missing }}", ctx)).toThrow(TemplateError);
	});

	test("throws on a reference to a step that has not run", () => {
		expect(() => resolveTemplate("${{ steps.ghost.outputs.x }}", ctx)).toThrow(TemplateError);
	});

	test("resolveInputs resolves every value", () => {
		const out = resolveInputs({ a: "${{ steps.pre.outputs.pages }}", b: "literal" }, ctx);
		expect(out).toEqual({ a: "p1,p2", b: "literal" });
	});
});

describe("stepKind / stepTarget", () => {
	test("identifies each kind and its target", () => {
		expect(stepKind(step("s", { node: "classifier" }))).toBe("node");
		expect(stepTarget(step("s", { node: undefined, skill: "x" } as Partial<WorkflowStep>), "skill")).toBe("x");
		const g = { name: "g", graph: true } as WorkflowStep;
		expect(stepKind(g)).toBe("graph");
		expect(stepTarget(g, "graph")).toBe("graph");
	});
});

describe("runWorkflow", () => {
	const def = WorkflowSchema.parse({
		name: "triage",
		version: "0.1.0",
		description: "demo",
		steps: [
			{ name: "pre", skill: "wiki-query", outputs: ["pages"] },
			{
				name: "triage",
				graph: true,
				depends_on: ["pre"],
				with: { wiki: "${{ steps.pre.outputs.pages }}" },
				outputs: ["report"],
			},
		],
	});

	test("threads outputs across steps via templates", async () => {
		const seen: Record<string, Record<string, string>> = {};
		const handlers: StepHandlers = {
			skill: async (r: ResolvedStep) => {
				seen[r.step.name] = r.inputs;
				return { pages: "topology" };
			},
			graph: async (r: ResolvedStep) => {
				seen[r.step.name] = r.inputs;
				return { report: "done" };
			},
		};
		const result = await runWorkflow(def, { handlers });
		expect(result.ok).toBe(true);
		// the graph step received the pre step's output via the template
		expect(seen.triage).toEqual({ wiki: "topology" });
		expect(result.steps.map((s) => s.status)).toEqual(["ok", "ok"]);
	});

	test("dry run resolves the plan without invoking handlers", async () => {
		let called = false;
		const handlers: StepHandlers = {
			skill: async () => {
				called = true;
				return {};
			},
			graph: async () => {
				called = true;
				return {};
			},
		};
		const result = await runWorkflow(def, { handlers, dryRun: true });
		expect(called).toBe(false);
		expect(result.steps.every((s) => s.status === "skipped")).toBe(true);
	});

	test("fail-fast aborts on a failing step by default", async () => {
		const handlers: StepHandlers = {
			skill: async () => {
				throw new Error("boom");
			},
			graph: async () => ({ report: "x" }),
		};
		const result = await runWorkflow(def, { handlers });
		expect(result.ok).toBe(false);
		// triage never ran because pre failed and default is fail-fast
		expect(result.steps.find((s) => s.name === "triage")).toBeUndefined();
	});

	test("error_handling: continue tolerates a failing step", async () => {
		const tolerant = WorkflowSchema.parse({
			name: "t",
			version: "0.1.0",
			description: "d",
			steps: [
				{ name: "pre", skill: "x", error_handling: "continue", outputs: ["pages"] },
				{ name: "after", node: "classifier", depends_on: ["pre"] },
			],
		});
		const handlers: StepHandlers = {
			skill: async () => {
				throw new Error("boom");
			},
			node: async () => ({}),
		};
		const result = await runWorkflow(tolerant, { handlers });
		// pre failed but was tolerated; after still ran
		expect(result.steps.find((s) => s.name === "after")?.status).toBe("ok");
		expect(result.ok).toBe(false);
	});
});

describe("shouldTrigger", () => {
	test("no triggers -> manual only", () => {
		const def = WorkflowSchema.parse({
			name: "w",
			version: "0.1.0",
			description: "d",
			steps: [{ name: "a", node: "classifier" }],
		});
		expect(shouldTrigger(def, { type: "manual" })).toBe(true);
		expect(shouldTrigger(def, { type: "event", name: "pull_request" })).toBe(false);
	});

	test("event trigger matches by name", () => {
		const def = WorkflowSchema.parse({
			name: "w",
			version: "0.1.0",
			description: "d",
			triggers: [{ type: "event", event: "pull_request" }],
			steps: [{ name: "a", node: "classifier" }],
		});
		expect(shouldTrigger(def, { type: "event", name: "pull_request" })).toBe(true);
		expect(shouldTrigger(def, { type: "event", name: "push" })).toBe(false);
	});
});
