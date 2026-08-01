// skillflow/src/executor.ts
//
// SkillsFlow executor (EPIC 4 / SIO-848). Runs a workflow's steps in topological
// order, threading ${{ steps.X.outputs.Y }} data flow and applying per-step
// error_handling. AUGMENTS the graph: a `graph: true` step runs the whole
// compiled pipeline as a single capability; it does not re-implement routing.

import type { WorkflowDef, WorkflowStep } from "@devops-agent/gitagent-bridge";
import { getLogger, traceSpan } from "@devops-agent/observability";
import { topoLayers } from "./dag.ts";
import { handlerFor, type ResolvedStep, type StepHandlers, stepKind, stepTarget } from "./resolvers.ts";
import { resolveInputs, type TemplateContext } from "./template.ts";

const logger = getLogger("skillflow:executor");

export interface RunWorkflowOptions {
	handlers: StepHandlers;
	trigger?: Record<string, string>;
	// SIO-1352: GAP declared-inputs payload for ${{ inputs.* }} references
	// (opaque keys; see TemplateContext.inputs).
	inputs?: Record<string, string>;
	// Dry run: resolve order + inputs without invoking handlers. Returns the plan.
	dryRun?: boolean;
}

export interface StepRunResult {
	name: string;
	kind: string;
	target: string;
	inputs: Record<string, string>;
	outputs: Record<string, string>;
	status: "ok" | "failed" | "skipped";
	error?: string;
}

export interface WorkflowRunResult {
	workflow: string;
	steps: StepRunResult[];
	ok: boolean;
}

function resolveStep(step: WorkflowStep, ctx: TemplateContext): ResolvedStep {
	const kind = stepKind(step);
	return { step, kind, target: stepTarget(step, kind), inputs: resolveInputs(step.with, ctx) };
}

async function runOne(step: WorkflowStep, ctx: TemplateContext, options: RunWorkflowOptions): Promise<StepRunResult> {
	const resolved = resolveStep(step, ctx);
	const base: StepRunResult = {
		name: step.name,
		kind: resolved.kind,
		target: resolved.target,
		inputs: resolved.inputs,
		outputs: {},
		status: "ok",
	};

	if (options.dryRun) {
		return { ...base, status: "skipped" };
	}

	const handler = handlerFor(options.handlers, resolved.kind);
	const attempts = step.error_handling === "retry" ? (step.retry?.attempts ?? 1) : 1;

	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const outputs = await traceSpan("skillflow", `skillflow.step.${step.name}`, () => handler(resolved), {
				"skillflow.step.kind": resolved.kind,
				"skillflow.step.target": resolved.target,
			});
			return { ...base, outputs };
		} catch (error) {
			lastError = error;
			if (attempt < attempts && step.retry) {
				await new Promise((r) => setTimeout(r, step.retry?.backoff_ms ?? 0));
			}
		}
	}

	const message = lastError instanceof Error ? lastError.message : String(lastError);
	// error_handling "continue" -> record failure but keep going; otherwise the
	// caller decides via the returned ok=false (fail-fast handled in runWorkflow).
	return { ...base, status: "failed", error: message };
}

// Applies one step's outcome to ctx/results, mirroring the placeholder-seeding
// and fail-fast rules that pre-SIO-1355 applied inline per iteration. Returns
// whether the workflow must abort before starting the next layer.
function applyStepResult(
	step: WorkflowStep,
	result: StepRunResult,
	def: WorkflowDef,
	ctx: TemplateContext,
	results: StepRunResult[],
): { ok: boolean; abort: boolean } {
	results.push(result);

	if (result.status === "ok") {
		ctx.steps.set(step.name, result.outputs);
		return { ok: true, abort: false };
	}
	if (result.status === "skipped") {
		// Dry run: seed declared outputs with placeholders so downstream
		// templates resolve structurally. This validates that every
		// referenced step+output is declared (catching typos) without
		// executing anything.
		const placeholders: Record<string, string> = {};
		for (const name of step.outputs ?? []) placeholders[name] = "";
		ctx.steps.set(step.name, placeholders);
		return { ok: true, abort: false };
	}

	// Failed. "continue" tolerates the failure; anything else fails the run.
	// best_effort at the workflow level also tolerates per-step failure.
	const tolerate = step.error_handling === "continue" || def.error_handling === "best_effort";
	if (tolerate) {
		logger.warn({ step: step.name, error: result.error }, "step failed; continuing per error_handling");
		// SIO-1356: seed the failed step's DECLARED outputs with empty-string
		// placeholders (same seeding as the dry-run skipped path above). Without
		// this, a downstream step templating ${{ steps.<failed>.outputs.X }}
		// throws TemplateError out of the whole run -- defeating error_handling:
		// continue for any workflow whose later steps reference an optional
		// branch. Downstream handlers see "" and treat the branch as absent.
		const placeholders: Record<string, string> = {};
		for (const name of step.outputs ?? []) placeholders[name] = "";
		ctx.steps.set(step.name, placeholders);
		return { ok: false, abort: false };
	}
	logger.error({ step: step.name, error: result.error }, "step failed; aborting workflow (fail-fast)");
	return { ok: false, abort: true };
}

export async function runWorkflow(def: WorkflowDef, options: RunWorkflowOptions): Promise<WorkflowRunResult> {
	// SIO-1355: layers, not one flat order -- every step in a layer has all its
	// depends_on already resolved by an earlier (fully-applied) layer, so the
	// layer's steps run concurrently via Promise.all. runOne itself never
	// throws (it converts handler rejection into a "failed" StepRunResult), so
	// Promise.all is safe here -- no allSettled needed at this level.
	const layers = topoLayers(def.steps);
	const ctx: TemplateContext = { steps: new Map(), trigger: options.trigger, inputs: options.inputs };
	const results: StepRunResult[] = [];
	let ok = true;

	outer: for (const layer of layers) {
		const layerResults = await Promise.all(layer.map((step) => runOne(step, ctx, options)));
		// Apply in declared order (not settle order) so ctx.steps writes and the
		// results array stay deterministic regardless of which handler resolved
		// first -- this is what a serial reader of `results` or `ctx.steps`
		// expects, and matches topoLayers' declared-order tie-break.
		for (let i = 0; i < layer.length; i++) {
			const step = layer[i];
			const result = layerResults[i];
			if (!step || !result) continue;
			const outcome = applyStepResult(step, result, def, ctx, results);
			if (!outcome.ok) ok = false;
			if (outcome.abort) break outer;
		}
	}

	return { workflow: def.name, steps: results, ok };
}
