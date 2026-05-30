// skillflow/src/executor.ts
//
// SkillsFlow executor (EPIC 4 / SIO-848). Runs a workflow's steps in topological
// order, threading ${{ steps.X.outputs.Y }} data flow and applying per-step
// error_handling. AUGMENTS the graph: a `graph: true` step runs the whole
// compiled pipeline as a single capability; it does not re-implement routing.

import type { WorkflowDef, WorkflowStep } from "@devops-agent/gitagent-bridge";
import { getLogger, traceSpan } from "@devops-agent/observability";
import { topoSort } from "./dag.ts";
import { handlerFor, type ResolvedStep, type StepHandlers, stepKind, stepTarget } from "./resolvers.ts";
import { resolveInputs, type TemplateContext } from "./template.ts";

const logger = getLogger("skillflow:executor");

export interface RunWorkflowOptions {
	handlers: StepHandlers;
	trigger?: Record<string, string>;
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

export async function runWorkflow(def: WorkflowDef, options: RunWorkflowOptions): Promise<WorkflowRunResult> {
	const ordered = topoSort(def.steps);
	const ctx: TemplateContext = { steps: new Map(), trigger: options.trigger };
	const results: StepRunResult[] = [];
	let ok = true;

	for (const step of ordered) {
		const result = await runOne(step, ctx, options);
		results.push(result);
		if (result.status === "ok") {
			ctx.steps.set(step.name, result.outputs);
			continue;
		}
		if (result.status === "skipped") {
			// Dry run: seed declared outputs with placeholders so downstream
			// templates resolve structurally. This validates that every
			// referenced step+output is declared (catching typos) without
			// executing anything.
			const placeholders: Record<string, string> = {};
			for (const name of step.outputs ?? []) placeholders[name] = "";
			ctx.steps.set(step.name, placeholders);
			continue;
		}

		// Failed. "continue" tolerates the failure; anything else fails the run.
		// best_effort at the workflow level also tolerates per-step failure.
		const tolerate = step.error_handling === "continue" || def.error_handling === "best_effort";
		if (tolerate) {
			logger.warn({ step: step.name, error: result.error }, "step failed; continuing per error_handling");
			ok = false;
			continue;
		}
		logger.error({ step: step.name, error: result.error }, "step failed; aborting workflow (fail-fast)");
		ok = false;
		break;
	}

	return { workflow: def.name, steps: results, ok };
}
