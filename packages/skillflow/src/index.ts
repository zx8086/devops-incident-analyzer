// skillflow/src/index.ts

// SIO-848: WorkflowSchema is canonical in the bridge (the lower-level dep);
// re-export it here so skillflow consumers have one import surface.
export {
	loadWorkflows,
	type WorkflowDef,
	WorkflowSchema,
	type WorkflowStep,
	WorkflowStepSchema,
	type WorkflowTrigger,
} from "@devops-agent/gitagent-bridge";
export { topoSort, UnknownDependencyError, WorkflowCycleError } from "./dag.ts";
export {
	type RunWorkflowOptions,
	runWorkflow,
	type StepRunResult,
	type WorkflowRunResult,
} from "./executor.ts";
export {
	handlerFor,
	MissingHandlerError,
	type ResolvedStep,
	type StepHandler,
	type StepHandlers,
	type StepKind,
	stepKind,
	stepTarget,
} from "./resolvers.ts";
export { resolveInputs, resolveTemplate, type TemplateContext, TemplateError } from "./template.ts";
export { shouldTrigger, type TriggerEvent } from "./triggers.ts";
