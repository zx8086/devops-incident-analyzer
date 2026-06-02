// agent/src/iac/guards.ts
import type { IacClusterState, IacRequest } from "./state.ts";

export interface GuardResult {
	blocked: boolean;
	reason?: string;
}

// Deterministic, safety-critical pre-draft guards from agents/elastic-iac/RULES.md.
// LLM-judgment rules (e.g. "name the prod cluster explicitly") live in the prompt;
// these are the mechanical constraints we never want to depend on the model for.
export function evaluateGuards(req: IacRequest, state: IacClusterState | null): GuardResult {
	// Tier downsize order: validation requires Max >= Current. Reduce Current first,
	// then Max -- a max-below-current change always fails the provider plan.
	if (req.newMaxGb != null && req.newSizeGb != null && req.newMaxGb < req.newSizeGb) {
		return {
			blocked: true,
			reason: `Maximum (${req.newMaxGb} GB) is below Current (${req.newSizeGb} GB). Reduce Current size first, then Maximum (validation requires Max >= Current).`,
		};
	}

	// Hot-tier downsize is gated until .alerts indices are managed (RULES conditional).
	const isDownsize = req.newSizeGb != null && state?.currentSizeGb != null && req.newSizeGb < state.currentSizeGb;
	if (req.tier === "hot" && isDownsize && state && !state.alertsManaged) {
		return {
			blocked: true,
			reason:
				"Hot-tier downsize is gated until .alerts indices are managed. Resolve the unmanaged .alerts setup before proposing a hot downsize.",
		};
	}

	return { blocked: false };
}
