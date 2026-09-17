// scripts/monitor/checks/spoke-health.ts
import type { AgentCard } from "../../../contracts/wire.ts";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";

// SIO-1681: the only check that reads the HUB instead of AWS.
//
// eu-oit-prd 403'd every Bedrock call for two hours on 2026-09-09 while the
// hub, `fleet status` and the monitor all showed it healthy. SIO-1678 made a
// failed reply loud and the spoke now counts its own consecutive provider
// failures, but both still need someone to look. The monitor has no model of
// its own, so it can report a spoke whose model is failing -- which is exactly
// the moment the spoke cannot report for itself.
//
// Why three: the spoke's counter is ALREADY a persistence measure (it resets on
// any successful turn), so unlike checks/targets.ts this needs no second
// cross-cycle gate. Three consecutive provider errors with no success between
// them is not a blip; one or two can be a throttle or a transient 5xx that the
// next turn rides through.
const ERROR_THRESHOLD = 3;
const REALERT_MS = 86_400_000;

// Only what this check needs, so the test can drive it without a MonitorComs.
export type AgentLister = { listAgents: () => Promise<AgentCard[]> };

// The provider's error text is spoke-borne and must NEVER enter the finding.
// Excluding this family from its own investigation is not enough: the finding
// is journaled whole, and `priorIncidents` (state.ts) matches journal rows with
// a bare `payload LIKE '%resource%'` across EVERY family, so a later finding on
// the same spoke would carry this row -- and any instructions hidden in it --
// straight into an investigation prompt.
//
// Classifying rather than sanitising is deliberate: an allowlisted class cannot
// smuggle anything, whereas an escaping rule is one missed case from failing.
// The class is also the part with diagnostic value; the operator reads the full
// message from the hub (`/v1/agents`) or the host, which the gotchas entry says.
export type RunErrorClass = "access-denied" | "throttled" | "timeout" | "other" | "unknown";

// `model` is spoke-reported too and the hub stores any string it is sent
// (`typeof body.model === "string"` is the only gate), so it rides the same
// journal-to-prompt path as the error text. A model id is a bounded token
// vocabulary, so it is kept -- it is the single most useful field for
// diagnosing this failure -- but restricted to that shape and length rather
// than passed through. Anything else becomes "unreported".
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/;

export function safeModelId(model: string | undefined): string {
	const m = (model ?? "").trim();
	return MODEL_ID.test(m) ? m : "unreported";
}

export function classifyRunError(message: string | undefined): RunErrorClass {
	const m = (message ?? "").toLowerCase();
	if (m.trim() === "") return "unknown";
	if (m.includes("accessdenied") || m.includes("not authorized") || m.includes("403")) return "access-denied";
	if (m.includes("throttl") || m.includes("too many requests") || m.includes("429")) return "throttled";
	if (m.includes("timed out") || m.includes("timeout")) return "timeout";
	return "other";
}

export type CheckSpokeHealthOpts = {
	// The agent this monitor is paired with (the monitor's INVESTIGATE_TARGET).
	// Scoped deliberately: every monitor can see every agent on the hub, so
	// reporting all of them would have one sick spoke reported by each monitor
	// in the fleet.
	spoke: string;
	threshold?: number;
	now?: number;
};

export async function checkSpokeHealth(
	hub: AgentLister,
	state: MonitorState,
	opts: CheckSpokeHealthOpts,
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const at = new Date(now).toISOString();
	const threshold = Math.max(1, Math.floor(opts.threshold ?? ERROR_THRESHOLD));
	const key = `spoke-health:${opts.spoke}:model-errors`;

	let agents: AgentCard[];
	try {
		agents = await hub.listAgents();
	} catch {
		// An unreachable hub is not a spoke-health finding, and the cycle runs
		// every 15 minutes: staying quiet is right, and the hub's own absence is
		// visible elsewhere.
		return [];
	}

	const agent = agents.find((a) => a.name === opts.spoke);
	// An absent agent is the hub's stale/offline story, not this one's. Two
	// families claiming the same incident would double every outage report.
	if (!agent) return [];

	const errors = agent.consecutive_run_errors ?? 0;
	if (errors < threshold) {
		// Recovered (or never broken): re-arm so the next outage reports at once
		// instead of waiting out the re-alert window. Same idiom as
		// checks/targets.ts, and the reason the spoke's counter resetting to 0
		// matters here rather than only on the console.
		state.clearAlerts(key);
		return [];
	}

	if (!state.shouldAlert(key, REALERT_MS)) return [];
	state.markAlerted(key, "spoke-health");

	return [
		{
			family: "spoke-health",
			severity: "warn",
			resource: opts.spoke,
			// Naming the contradiction is the whole point: an operator reading
			// "online" anywhere else needs to know it means reachable, not working.
			summary: `Spoke ${opts.spoke} reports ${agent.status} but its last ${errors} consecutive model calls all failed; it answers prompts without answering them. Check the model's access in this account (a Bedrock 403 did this on 2026-09-09).`,
			dedup_key: key,
			evidence: {
				spoke: opts.spoke,
				status: agent.status,
				model: safeModelId(agent.model),
				consecutiveRunErrors: errors,
				// The CLASS only -- never the provider's text. See classifyRunError:
				// this row can reach an investigation prompt through priorIncidents,
				// so the raw message does not enter the finding at all.
				lastRunErrorClass: classifyRunError(agent.last_run_error),
				contextUsedPct: agent.context_used_pct,
				queueDepth: agent.queue_depth,
			},
			at,
		},
	];
}
