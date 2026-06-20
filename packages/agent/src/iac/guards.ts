// agent/src/iac/guards.ts
import type { IacClusterState, IacRequest } from "./state.ts";

export interface GuardResult {
	blocked: boolean;
	reason?: string;
}

// SIO-980: flatten a settingsPatch (relative to settings.index) to dotted leaf paths -> value,
// e.g. { routing: { allocation: { enable: "none" } } } -> { "routing.allocation.enable": "none" }.
function flattenSettings(patch: Record<string, unknown>, prefix = ""): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(patch)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			Object.assign(out, flattenSettings(value as Record<string, unknown>, path));
		} else {
			out[path] = value;
		}
	}
	return out;
}

// SIO-980: a SHORT danger DENYLIST for a freeform cluster-defaults settingsPatch. Validity (does the
// setting exist?) is enforced by CI's terraform plan; this only refuses valid-but-DANGEROUS keys the
// plan would happily accept. "Know the dangerous keys, not all keys." Returns a reason or null.
function dangerousSettingReason(patch: Record<string, unknown>): string | null {
	const flat = flattenSettings(patch);
	for (const [path, value] of Object.entries(flat)) {
		const leaf = path.slice(path.lastIndexOf(".") + 1);
		// index.blocks.* (write/read_only/read/metadata) locks the index.
		if (path === "blocks" || path.startsWith("blocks.")) {
			return `Refusing to set index block '${path}' (= ${JSON.stringify(value)}): index blocks can lock the index read-only/write. Make this change deliberately outside the agent.`;
		}
		// number_of_replicas: 0 removes all redundancy.
		if (leaf === "number_of_replicas" && value === 0) {
			return "Refusing to set number_of_replicas to 0: that removes all shard redundancy. Use >= 1, or make this change deliberately outside the agent.";
		}
		// routing.allocation.enable: none halts shard allocation.
		if (path === "routing.allocation.enable" && value === "none") {
			return "Refusing to set routing.allocation.enable to 'none': that halts shard allocation for the index. Make this change deliberately outside the agent.";
		}
		// refresh_interval must be a duration STRING (e.g. "30s"); a number is a type error CI rejects.
		if (leaf === "refresh_interval" && typeof value !== "string") {
			return `Refusing to set refresh_interval to ${JSON.stringify(value)}: it must be a duration string (e.g. "30s"), not a ${typeof value}.`;
		}
	}
	return null;
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

	// SIO-980: danger denylist for freeform cluster-defaults settings (single + multi-file).
	if (req.settingsPatch) {
		const reason = dangerousSettingReason(req.settingsPatch);
		if (reason) return { blocked: true, reason };
	}
	for (const e of req.clusterDefaults ?? []) {
		const reason = dangerousSettingReason(e.settingsPatch);
		if (reason) return { blocked: true, reason: `Template '${e.templateName}': ${reason}` };
	}

	return { blocked: false };
}
