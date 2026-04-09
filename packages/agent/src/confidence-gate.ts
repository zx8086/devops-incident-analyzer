// agent/src/confidence-gate.ts

import { getLogger } from "@devops-agent/observability";
import { getAgent } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:confidence-gate");

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

function getConfidenceThreshold(): number {
	try {
		const agent = getAgent();
		const triggers = agent.manifest.compliance?.supervision?.escalation_triggers;
		if (Array.isArray(triggers)) {
			for (const trigger of triggers) {
				if (typeof trigger === "object" && trigger !== null && "confidence_below" in trigger) {
					const value = Number(trigger.confidence_below);
					if (!Number.isNaN(value)) return value;
				}
			}
		}
	} catch {
		// Manifest unavailable, use default
	}
	return DEFAULT_CONFIDENCE_THRESHOLD;
}

// SIO-632: Non-blocking confidence check. Flags low confidence via state so the
// SSE handler can send a warning to the frontend, but does NOT interrupt the
// pipeline. Read-only analysis reports should always be delivered to the user --
// the confidence score is informational, not a gate for read-only operations.
export function checkConfidence(state: AgentStateType): Partial<AgentStateType> {
	const score = state.confidenceScore;
	const threshold = getConfidenceThreshold();

	logger.info({ confidenceScore: score, threshold }, "Checking confidence against HITL threshold");

	if (score > 0 && score < threshold) {
		logger.warn({ confidenceScore: score, threshold }, "Confidence below threshold, flagging for user review");
		return { lowConfidence: true };
	}

	logger.info("Confidence check passed");
	return { lowConfidence: false };
}
