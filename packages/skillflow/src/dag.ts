// skillflow/src/dag.ts
//
// SkillsFlow DAG ordering (EPIC 4 / SIO-848). Pure topological sort with cycle
// detection over a workflow's steps and their depends_on edges.

import type { WorkflowStep } from "@devops-agent/gitagent-bridge";

export class WorkflowCycleError extends Error {
	constructor(public readonly involved: string[]) {
		super(`workflow has a dependency cycle involving: ${involved.join(" -> ")}`);
		this.name = "WorkflowCycleError";
	}
}

export class UnknownDependencyError extends Error {
	constructor(
		public readonly step: string,
		public readonly missing: string,
	) {
		super(`workflow step "${step}" depends_on unknown step "${missing}"`);
		this.name = "UnknownDependencyError";
	}
}

// Returns the steps in a valid execution order (dependencies first). Throws on
// an unknown dependency or a cycle. Kahn's algorithm; ties broken by declared
// order for deterministic output.
export function topoSort(steps: WorkflowStep[]): WorkflowStep[] {
	const byName = new Map<string, WorkflowStep>();
	for (const step of steps) byName.set(step.name, step);

	// Validate edges up front so the error names the offending step.
	for (const step of steps) {
		for (const dep of step.depends_on ?? []) {
			if (!byName.has(dep)) throw new UnknownDependencyError(step.name, dep);
		}
	}

	const indegree = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const step of steps) {
		indegree.set(step.name, step.depends_on?.length ?? 0);
	}
	for (const step of steps) {
		for (const dep of step.depends_on ?? []) {
			const list = dependents.get(dep) ?? [];
			list.push(step.name);
			dependents.set(dep, list);
		}
	}

	// Seed queue with zero-indegree steps in declared order.
	const queue: string[] = steps.filter((s) => (indegree.get(s.name) ?? 0) === 0).map((s) => s.name);
	const ordered: WorkflowStep[] = [];

	while (queue.length > 0) {
		const name = queue.shift() as string;
		const step = byName.get(name);
		if (step) ordered.push(step);
		for (const dependent of dependents.get(name) ?? []) {
			const next = (indegree.get(dependent) ?? 0) - 1;
			indegree.set(dependent, next);
			if (next === 0) queue.push(dependent);
		}
	}

	if (ordered.length !== steps.length) {
		const stuck = steps.filter((s) => !ordered.includes(s)).map((s) => s.name);
		throw new WorkflowCycleError(stuck);
	}
	return ordered;
}
