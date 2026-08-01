// agent/src/close-workflow.ts
//
// SIO-1357: loads the incident-close.yaml workflow definition once per
// process (git-versioned edits still take effect on the next process start,
// matching the resolve-identifiers preset loader's tradeoff).

import { loadWorkflows, type WorkflowDef } from "@devops-agent/gitagent-bridge";
import { getAgentsDir } from "./paths.ts";

let cached: WorkflowDef | undefined;

export function loadIncidentCloseWorkflow(): WorkflowDef {
	if (!cached) {
		const def = loadWorkflows(getAgentsDir("incident-analyzer")).get("incident-close");
		if (!def) throw new Error("incident-close workflow not found under agents/incident-analyzer/workflows/");
		cached = def;
	}
	return cached;
}
