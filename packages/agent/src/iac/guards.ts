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

// SIO-990: parse an Elastic ILM min_age duration ("30d", "48h", "90m", "30s") to seconds.
// Null for an unrecognized unit/format (ms/micros/nanos are not ILM min_age units). Mirrors
// nodes.ts durationToSeconds; kept local so guards.ts has no nodes.ts dependency. (Pure.)
function ilmMinAgeSeconds(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const m = value.match(/^(\d+)\s*(d|h|m|s)$/);
	if (!m) return null;
	const mult = m[2] === "d" ? 86400 : m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1;
	return Number(m[1]) * mult;
}

// SIO-990: ILM phase-ordering invariant. A policy's phase min_age values MUST be non-decreasing in
// phase order (hot -> warm -> cold -> frozen -> delete): an index can only advance to a later phase
// AFTER it is old enough for it. Elasticsearch (and CI's terraform apply) reject a policy where a
// later phase's min_age is below an earlier phase's -- this is exactly what catches a typo like
// delete.min_age=4d sitting below frozen.min_age=7d. Run on the MERGED effective policy (existing
// phases + the patch), never the patch alone, because a one-phase correction's validity spans every
// phase. Returns the offending pair as a reason, or null when the ordering is sound (or unparseable
// min_ages -- those are caught by validateIlmPolicy's structural gate, not here). (Pure.)
const ILM_PHASE_ORDER = ["hot", "warm", "cold", "frozen", "delete"] as const;

export function validateIlmPhaseOrdering(
	policy: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
	// Collect (phase, seconds) for phases present with a parseable min_age, in canonical order.
	const ages: Array<{ phase: string; seconds: number; raw: string }> = [];
	for (const phase of ILM_PHASE_ORDER) {
		const obj = policy[phase];
		if (typeof obj !== "object" || obj === null) continue;
		const raw = (obj as { min_age?: unknown }).min_age;
		const seconds = ilmMinAgeSeconds(raw);
		// hot has no min_age (it is the rollover phase); a missing/unparseable min_age is skipped --
		// either legitimately absent or a structural error validateIlmPolicy reports separately.
		if (seconds === null) continue;
		ages.push({ phase, seconds, raw: raw as string });
	}
	for (let i = 1; i < ages.length; i++) {
		const prev = ages[i - 1];
		const cur = ages[i];
		if (prev && cur && cur.seconds < prev.seconds) {
			return {
				ok: false,
				reason: `phase '${cur.phase}' min_age ${cur.raw} is earlier than '${prev.phase}' min_age ${prev.raw}; min_age must not decrease across hot -> warm -> cold -> frozen -> delete (an index can't reach ${cur.phase} before ${prev.phase}). Elasticsearch and the terraform apply will reject this.`,
			};
		}
	}
	return { ok: true };
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
