// agent/src/confidence-gate.ts

import { getLogger } from "@devops-agent/observability";
import { getAgent } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:confidence-gate");

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

// Exported so validator.ts can flag lowConfidence against the same threshold
// when it applies its own post-checkConfidence cap (SIO-1123).
export function getConfidenceThreshold(): number {
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

// SIO-1194: single threshold-derived cap shared by the aggregator, the correlation
// enforce node, and the validator. min(0.59, threshold - 0.01) keeps a capped run
// strictly below the HITL gate whatever the manifest configures (a hardcoded 0.59
// would read as PASSING under a manifest threshold below 0.59 -- SIO-1123 rationale).
const CONFIDENCE_CAP_DEFAULT = 0.59;
const CONFIDENCE_CAP_MARGIN = 0.01;

export function deriveConfidenceCap(threshold: number = getConfidenceThreshold()): number {
	// Clamp at 0: a pathological manifest threshold below the margin must not
	// produce a negative cap (CodeRabbit PR #455).
	return Math.max(0, Math.min(CONFIDENCE_CAP_DEFAULT, threshold - CONFIDENCE_CAP_MARGIN));
}

// SIO-632: Non-blocking confidence check. Flags low confidence via state so the
// SSE handler can send a warning to the frontend, but does NOT interrupt the
// pipeline. Read-only analysis reports should always be delivered to the user --
// the confidence score is informational, not a gate for read-only operations.
export function checkConfidence(state: AgentStateType): Partial<AgentStateType> {
	const score = state.confidenceScore;
	const threshold = getConfidenceThreshold();

	logger.info({ confidenceScore: score, threshold }, "Checking confidence against HITL threshold");

	// SIO-1273: the `score > 0` guard that used to be here produced the exact inversion of its
	// intent. It was presumably meant as "no number yet, do not cry wolf", but because 0 is also
	// what an ABSENT confidence line extracts to, the LEAST trustworthy report -- one that never
	// stated a confidence at all -- was the one declared passing. Run eaebc62b shipped
	// `confidence: 0` with `lowConfidence: false` for precisely that reason. An explicit
	// `Confidence: 0.0` was waved through too, which is indefensible on any reading.
	//
	// This gate is non-blocking by design (see above), so flagging cannot strand a run: the cost
	// of a false positive is a banner a human dismisses, against an unscored report presented as
	// trustworthy.
	if (score < threshold) {
		logger.warn({ confidenceScore: score, threshold }, "Confidence below threshold, flagging for user review");
		return { lowConfidence: true };
	}

	logger.info("Confidence check passed");
	return { lowConfidence: false };
}
