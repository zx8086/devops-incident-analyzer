// skillflow/src/triggers.ts
//
// SkillsFlow trigger evaluation (EPIC 4 / SIO-848). Decides whether a workflow
// should fire for a given event. `manual` always matches an explicit run;
// `event` matches by name. `schedule` is deferred until a scheduler.yml exists.

import type { WorkflowDef } from "@devops-agent/gitagent-bridge";

export interface TriggerEvent {
	type: "manual" | "event";
	// event name when type === "event"
	name?: string;
}

// Returns true when the workflow declares a trigger matching the event. A
// workflow with no triggers is manual-only (matches a manual event).
export function shouldTrigger(def: WorkflowDef, event: TriggerEvent): boolean {
	const triggers = def.triggers ?? [];
	if (triggers.length === 0) return event.type === "manual";

	for (const trigger of triggers) {
		if (event.type === "manual" && trigger.type === "manual") return true;
		if (event.type === "event" && trigger.type === "event" && trigger.event === event.name) return true;
		// schedule triggers are not evaluated here (no scheduler yet).
	}
	return false;
}
