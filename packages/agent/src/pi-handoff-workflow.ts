// agent/src/pi-handoff-workflow.ts
//
// SIO-1651: loads the pi-handoff.yaml workflow definition once per process
// (git-versioned edits take effect on the next process start, matching
// close-workflow.ts's tradeoff).

import { loadWorkflows, type WorkflowDef } from "@devops-agent/gitagent-bridge";
import { getAgentsDir } from "./paths.ts";

let cached: WorkflowDef | undefined;

export function loadPiHandoffWorkflow(): WorkflowDef {
	if (!cached) {
		const def = loadWorkflows(getAgentsDir("incident-analyzer")).get("pi-handoff");
		if (!def) throw new Error("pi-handoff workflow not found under agents/incident-analyzer/workflows/");
		cached = def;
	}
	return cached;
}
