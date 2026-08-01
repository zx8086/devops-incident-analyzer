// skillflow/src/skillflow.test.ts
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: SIO-848 - this file deliberately tests literal SkillsFlow ${{ }} template tokens, not JS template strings
import { describe, expect, test } from "bun:test";
import { WorkflowSchema, type WorkflowStep } from "@devops-agent/gitagent-bridge";
import { topoLayers, topoSort, UnknownDependencyError, WorkflowCycleError } from "./dag.ts";
import { runWorkflow } from "./executor.ts";
import { MissingHandlerError, type ResolvedStep, type StepHandlers, stepKind, stepTarget } from "./resolvers.ts";
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

describe("topoLayers", () => {
	test("groups independent steps into the same layer", () => {
		const steps = [step("a"), step("b"), step("c", { depends_on: ["a", "b"] })];
		const layers = topoLayers(steps).map((layer) => layer.map((s) => s.name));
		expect(layers).toEqual([["a", "b"], ["c"]]);
	});

	test("a pure chain produces one step per layer, in dependency order", () => {
		const steps = [step("c", { depends_on: ["b"] }), step("a"), step("b", { depends_on: ["a"] })];
		const layers = topoLayers(steps).map((layer) => layer.map((s) => s.name));
		expect(layers).toEqual([["a"], ["b"], ["c"]]);
	});

	test("ties within a layer keep declared order", () => {
		const steps = [step("z"), step("a"), step("m")];
		expect(topoLayers(steps)[0]?.map((s) => s.name)).toEqual(["z", "a", "m"]);
	});

	test("rejects an unknown dependency", () => {
		expect(() => topoLayers([step("a", { depends_on: ["ghost"] })])).toThrow(UnknownDependencyError);
	});

	test("detects a cycle", () => {
		const steps = [step("a", { depends_on: ["b"] }), step("b", { depends_on: ["a"] })];
		expect(() => topoLayers(steps)).toThrow(WorkflowCycleError);
	});
});

describe("resolveTemplate", () => {
	const ctx: TemplateContext = {
		steps: new Map([["pre", { pages: "p1,p2" }]]),
		trigger: { changed_files: "a.ts" },
		inputs: { cluster: "us-cld", "clusters_in_order[0]": "eu-cld" },
	};

	test("resolves a step output reference", () => {
		expect(resolveTemplate("got ${{ steps.pre.outputs.pages }}", ctx)).toBe("got p1,p2");
	});

	test("resolves a trigger reference", () => {
		expect(resolveTemplate("${{ trigger.changed_files }}", ctx)).toBe("a.ts");
	});

	// SIO-1352: GAP declared-inputs namespace (the elastic-iac flows use it)
	test("resolves an inputs reference", () => {
		expect(resolveTemplate("${{ inputs.cluster }}", ctx)).toBe("us-cld");
	});

	test("resolves an indexed inputs reference as an opaque key", () => {
		expect(resolveTemplate("${{ inputs.clusters_in_order[0] }}", ctx)).toBe("eu-cld");
	});

	test("throws on an unknown inputs reference (strict)", () => {
		expect(() => resolveTemplate("${{ inputs.ghost }}", ctx)).toThrow(TemplateError);
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

	// SIO-1356: without placeholder seeding, this exact shape threw TemplateError
	// out of runWorkflow (resolveStep runs outside the handler try/catch), defeating
	// error_handling: continue for optional-branch templating.
	test("a failed continue-step's declared outputs resolve to empty strings downstream (SIO-1356)", async () => {
		const tolerant = WorkflowSchema.parse({
			name: "t",
			version: "0.1.0",
			description: "d",
			steps: [
				{ name: "optional", tool: "boom", error_handling: "continue", outputs: ["raw"] },
				{
					name: "assemble",
					node: "assembler",
					depends_on: ["optional"],
					with: { got: "${{ steps.optional.outputs.raw }}" },
					outputs: ["result"],
				},
			],
		});
		const seen: Record<string, Record<string, string>> = {};
		const handlers: StepHandlers = {
			tool: async () => {
				throw new Error("boom");
			},
			node: async (r: ResolvedStep) => {
				seen[r.step.name] = r.inputs;
				return { result: "assembled" };
			},
		};
		const result = await runWorkflow(tolerant, { handlers });
		expect(result.ok).toBe(false);
		expect(result.steps.find((s) => s.name === "assemble")?.status).toBe("ok");
		// the failed step's declared output resolved to "" instead of aborting the run
		expect(seen.assemble).toEqual({ got: "" });
	});

	// SIO-1355: independent steps in the same DAG layer run concurrently, not
	// sequentially. Proven by both handlers being IN FLIGHT at once (maxConcurrent
	// === 2), not by wall-clock timing -- a wall-clock margin is flaky under CI
	// runner load/scheduling jitter, while overlapping in-flight counts are not.
	test("independent steps in the same layer run concurrently", async () => {
		const parallel = WorkflowSchema.parse({
			name: "p",
			version: "0.1.0",
			description: "d",
			steps: [
				{ name: "left", tool: "slow-left", outputs: ["raw"] },
				{ name: "right", tool: "slow-right", outputs: ["raw"] },
			],
		});
		let concurrent = 0;
		let maxConcurrent = 0;
		let bothStartedResolve: (() => void) | undefined;
		const bothStarted = new Promise<void>((resolve) => {
			bothStartedResolve = resolve;
		});
		const handlers: StepHandlers = {
			tool: async () => {
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				if (concurrent === 2) bothStartedResolve?.();
				// Sequential execution would never reach concurrent === 2, so this
				// would hang and fail the test on timeout rather than racing a clock.
				await bothStarted;
				concurrent--;
				return { raw: "ok" };
			},
		};
		const result = await runWorkflow(parallel, { handlers });
		expect(result.ok).toBe(true);
		expect(maxConcurrent).toBe(2);
	});

	// A later layer must wait for the ENTIRE prior layer, not just the step(s)
	// it directly depends on.
	test("a later layer waits for the whole prior layer to finish", async () => {
		const layered = WorkflowSchema.parse({
			name: "l",
			version: "0.1.0",
			description: "d",
			steps: [
				{ name: "fast", tool: "fast", outputs: ["raw"] },
				{ name: "slow", tool: "slow", outputs: ["raw"] },
				{ name: "after", node: "assembler", depends_on: ["fast"] },
			],
		});
		const order: string[] = [];
		const handlers: StepHandlers = {
			tool: async (r) => {
				const delay = r.step.name === "slow" ? 30 : 0;
				await new Promise((res) => setTimeout(res, delay));
				order.push(r.step.name);
				return { raw: "ok" };
			},
			node: async (r) => {
				order.push(r.step.name);
				return {};
			},
		};
		const result = await runWorkflow(layered, { handlers });
		expect(result.ok).toBe(true);
		// "after" only depends on "fast", but topoLayers puts fast+slow in layer 0
		// (both have zero depends_on) -- after must still wait for slow.
		expect(order).toEqual(["fast", "slow", "after"]);
	});

	// A tolerated failure in one branch of a layer must not block sibling
	// branches in the SAME layer from completing.
	test("a tolerated failure in one layer branch does not block its siblings", async () => {
		const mixed = WorkflowSchema.parse({
			name: "m",
			version: "0.1.0",
			description: "d",
			steps: [
				{ name: "ok-branch", tool: "good", outputs: ["raw"] },
				{ name: "bad-branch", tool: "bad", error_handling: "continue", outputs: ["raw"] },
			],
		});
		const handlers: StepHandlers = {
			tool: async (r) => {
				if (r.step.name === "bad-branch") throw new Error("boom");
				return { raw: "ok" };
			},
		};
		const result = await runWorkflow(mixed, { handlers });
		expect(result.ok).toBe(false);
		expect(result.steps.find((s) => s.name === "ok-branch")?.status).toBe("ok");
		expect(result.steps.find((s) => s.name === "bad-branch")?.status).toBe("failed");
	});

	// SIO-1356 placeholder seeding re-verified under layered/concurrent
	// execution: the original test (above) only proves this sequentially. Here
	// the failing step and its downstream consumer are in different layers,
	// AND the failing step shares its own layer with an unrelated sibling.
	test("SIO-1356 placeholder seeding still works under layered execution", async () => {
		const layered = WorkflowSchema.parse({
			name: "t",
			version: "0.1.0",
			description: "d",
			steps: [
				{ name: "optional", tool: "boom", error_handling: "continue", outputs: ["raw"] },
				{ name: "sibling", tool: "fine", outputs: ["raw"] },
				{
					name: "assemble",
					node: "assembler",
					depends_on: ["optional", "sibling"],
					with: { got: "${{ steps.optional.outputs.raw }}", other: "${{ steps.sibling.outputs.raw }}" },
					outputs: ["result"],
				},
			],
		});
		const seen: Record<string, Record<string, string>> = {};
		const handlers: StepHandlers = {
			tool: async (r) => {
				if (r.step.name === "optional") throw new Error("boom");
				return { raw: "sibling-value" };
			},
			node: async (r: ResolvedStep) => {
				seen[r.step.name] = r.inputs;
				return { result: "assembled" };
			},
		};
		const result = await runWorkflow(layered, { handlers });
		expect(result.ok).toBe(false);
		expect(result.steps.find((s) => s.name === "assemble")?.status).toBe("ok");
		expect(seen.assemble).toEqual({ got: "", other: "sibling-value" });
	});

	// resolvers.ts's handlerFor throws MissingHandlerError for a step kind with
	// no registered handler; untested until now (only exercised via dry-run,
	// which never calls handlerFor at all).
	test("throws MissingHandlerError for a step kind with no registered handler", async () => {
		const skillOnly = WorkflowSchema.parse({
			name: "s",
			version: "0.1.0",
			description: "d",
			steps: [{ name: "a", skill: "incident-postmortem", outputs: ["report"] }],
		});
		await expect(runWorkflow(skillOnly, { handlers: {} })).rejects.toThrow(MissingHandlerError);
	});

	// CodeRabbit (PR #576): resolveStep() (template resolution) runs BEFORE
	// runOne's handler try/catch, synchronously. Under layer concurrency this
	// step's rejection is one branch of a Promise.all alongside a slower sibling
	// -- if runOne let the TemplateError propagate, the whole Promise.all would
	// reject and the sibling's already-in-flight result would never reach
	// ctx.steps/results, even though the sibling itself succeeded. Proves the
	// fix: the bad-template step degrades to a "failed" StepRunResult and the
	// slower sibling's result is still applied.
	test("a synchronous template-resolution failure does not drop an in-flight sibling's result", async () => {
		const mixed = WorkflowSchema.parse({
			name: "m",
			version: "0.1.0",
			description: "d",
			steps: [
				// References a step that never ran -- resolveStep throws TemplateError
				// synchronously, before any handler is invoked.
				{ name: "bad-template", tool: "x", with: { v: "${{ steps.ghost.outputs.x }}" }, outputs: ["raw"] },
				{ name: "slow-sibling", tool: "y", outputs: ["raw"] },
			],
		});
		const handlers: StepHandlers = {
			tool: async (r) => {
				if (r.step.name === "slow-sibling") await new Promise((res) => setTimeout(res, 20));
				return { raw: "ok" };
			},
		};
		const result = await runWorkflow(mixed, { handlers });
		expect(result.ok).toBe(false);
		expect(result.steps.find((s) => s.name === "bad-template")?.status).toBe("failed");
		expect(result.steps.find((s) => s.name === "slow-sibling")?.status).toBe("ok");
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
