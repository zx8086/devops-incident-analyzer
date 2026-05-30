// skillflow/src/resolvers.ts
//
// SkillsFlow step resolvers (EPIC 4 / SIO-848). A step's kind (skill/agent/tool/
// node/graph) selects an executor. The executors that touch the heavy agent
// runtime (buildGraph, createLlm, sub-agents, action tools) are injected by the
// caller via StepHandlers, so this package stays decoupled and unit-testable.

import type { WorkflowStep } from "@devops-agent/gitagent-bridge";

export type StepKind = "skill" | "agent" | "tool" | "node" | "graph";

export interface ResolvedStep {
	step: WorkflowStep;
	kind: StepKind;
	// The named target (skill/agent/tool/node name), or "graph" for a graph step.
	target: string;
	// Template-resolved inputs.
	inputs: Record<string, string>;
}

// A handler runs one resolved step and returns its named outputs. Provided by
// the caller (the agent package wires real skill/agent/tool/node/graph runners).
export type StepHandler = (resolved: ResolvedStep) => Promise<Record<string, string>>;

export interface StepHandlers {
	skill?: StepHandler;
	agent?: StepHandler;
	tool?: StepHandler;
	node?: StepHandler;
	graph?: StepHandler;
}

export function stepKind(step: WorkflowStep): StepKind {
	if (step.skill !== undefined) return "skill";
	if (step.agent !== undefined) return "agent";
	if (step.tool !== undefined) return "tool";
	if (step.node !== undefined) return "node";
	if (step.graph !== undefined) return "graph";
	// WorkflowStepSchema's superRefine guarantees exactly one kind, so this is
	// unreachable for a schema-validated step.
	throw new Error(`workflow step "${step.name}" has no resolvable kind`);
}

export function stepTarget(step: WorkflowStep, kind: StepKind): string {
	switch (kind) {
		case "skill":
			return step.skill as string;
		case "agent":
			return step.agent as string;
		case "tool":
			return step.tool as string;
		case "node":
			return step.node as string;
		case "graph":
			return "graph";
	}
}

export class MissingHandlerError extends Error {
	constructor(public readonly kind: StepKind) {
		super(`no handler registered for "${kind}" steps`);
		this.name = "MissingHandlerError";
	}
}

export function handlerFor(handlers: StepHandlers, kind: StepKind): StepHandler {
	const handler = handlers[kind];
	if (!handler) throw new MissingHandlerError(kind);
	return handler;
}
