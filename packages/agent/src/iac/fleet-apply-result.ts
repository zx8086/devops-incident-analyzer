// agent/src/iac/fleet-apply-result.ts
// SIO-1072: the PURE fleet-apply parsers/classifiers, moved verbatim out of nodes.ts (mirrors the
// SIO-1047 mr-live-state.ts extraction). The reconcile sweep's fleet-settlement pass needs the SAME
// status classification the interactive apply/status-check paths use, but reconcile.ts cannot import
// nodes.ts (nodes.ts imports reconcile.ts -- a cycle). This module is a dependency-free leaf; nodes.ts
// re-imports and re-exports everything here so its existing internal call sites and external test
// importers (pipeline-status.test.ts) are unaffected.

// A pipeline status is terminal when CI has stopped running.
export function isTerminalPipelineStatus(status: string): boolean {
	return ["success", "failed", "canceled", "skipped"].includes(status);
}

// SIO-924: parse a single pipeline's {status, web_url} from gitlab_get_pipeline's
// "[status] {...}" body (GET /projects/:id/pipelines/:id). Used to stream live apply
// progress + surface a clickable pipeline link. (Pure; unit-tested.)
export function parseSinglePipeline(toolResult: string): { status: string; webUrl: string } | null {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return null;
	try {
		const p = JSON.parse(toolResult.slice(jsonStart)) as { status?: unknown; web_url?: unknown };
		if (typeof p !== "object" || p === null) return null;
		return {
			status: typeof p.status === "string" ? p.status : "unknown",
			webUrl: typeof p.web_url === "string" ? p.web_url : "",
		};
	} catch {
		return null;
	}
}

// gitlab_get_drift_check_result's outer JSON: {status,report?,failureLog?,stateLocked?,note?}.
// `report` is the raw drift-report.json text (parsed by parseDriftReport); `failureLog` is the
// job trace tail on a failed run (SIO-887, classified into a human reason); `stateLocked` is the
// MCP's full-trace state-lock verdict (SIO-904), preferred over the tail when present. (Pure; unit-tested.)
export function parseDriftCheckResult(toolResult: string): {
	status: string;
	report: string;
	failureLog: string;
	stateLocked: boolean;
	note: string;
} {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return { status: "error", report: "", failureLog: "", stateLocked: false, note: "unparseable" };
	try {
		const o = JSON.parse(toolResult.slice(jsonStart)) as {
			status?: unknown;
			report?: unknown;
			failureLog?: unknown;
			stateLocked?: unknown;
			note?: unknown;
		};
		return {
			status: typeof o.status === "string" ? o.status : "unknown",
			report: typeof o.report === "string" ? o.report : "",
			failureLog: typeof o.failureLog === "string" ? o.failureLog : "",
			stateLocked: o.stateLocked === true,
			note: typeof o.note === "string" ? o.note : "",
		};
	} catch {
		return { status: "error", report: "", failureLog: "", stateLocked: false, note: "unparseable" };
	}
}

// SIO-961: a per-agent failure from the apply report's failed_agents[] (ground truth).
export interface FleetFailedAgent {
	hostname: string;
	agentId: string;
	failedState: string;
	error: string;
}

// SIO-961: the full apply-result breakdown. succeeded/failed/rolledBack/unsettled +
// per-agent failures let the agent report a partial/in-progress outcome (most agents
// offline-pending, a few env-side failures) instead of a flat "failed".
export interface FleetApplyOutcome {
	actionId: string;
	pollStatus: string;
	acked: number;
	created: number;
	failedSilent: number;
	succeeded: number;
	failed: number;
	rolledBack: number;
	unsettled: number;
	failedAgents: FleetFailedAgent[];
	// SIO-975: the report's top-level CI-side failure reason (error_reason || error), present
	// on a true infra failure (e.g. plan job failed before any agent was actioned). "" when absent.
	errorReason: string;
}

export function parseFleetApplyOutcome(raw: string): FleetApplyOutcome {
	const empty: FleetApplyOutcome = {
		actionId: "",
		pollStatus: "",
		acked: 0,
		created: 0,
		failedSilent: 0,
		succeeded: 0,
		failed: 0,
		rolledBack: 0,
		unsettled: 0,
		failedAgents: [],
		errorReason: "",
	};
	try {
		const o = JSON.parse(raw) as Record<string, unknown>;
		const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		const str = (v: unknown): string => (typeof v === "string" ? v : "");
		const a = (o.apply ?? {}) as Record<string, unknown>;
		const rawAgents = Array.isArray(a.failed_agents) ? (a.failed_agents as Record<string, unknown>[]) : [];
		return {
			actionId: str(o.action_id),
			pollStatus: str(a.poll_status),
			acked: num(a.acked),
			created: num(a.created),
			failedSilent: num(a.failed_silent),
			succeeded: num(a.succeeded),
			failed: num(a.failed),
			rolledBack: num(a.rolled_back),
			unsettled: num(a.unsettled),
			failedAgents: rawAgents.map((ag) => ({
				hostname: str(ag.hostname),
				agentId: str(ag.agent_id),
				failedState: str(ag.failed_state),
				error: str(ag.error),
			})),
			// SIO-975: prefer the human-readable error_reason; fall back to the raw error string.
			errorReason: str(o.error_reason) || str(o.error),
		};
	} catch {
		return empty;
	}
}

// SIO-961: human note for a partial apply. Leads with the in-flight/pending majority so the
// user is not alarmed by the CI "failed" exit, then names the small env-side failure set.
function buildFleetPartialNote(outcome: FleetApplyOutcome): string {
	const parts: string[] = [];
	parts.push(`${outcome.succeeded}/${outcome.created} upgraded`);
	if (outcome.unsettled > 0) parts.push(`${outcome.unsettled} still pending (offline; upgrade when they reconnect)`);
	if (outcome.failed > 0) parts.push(`${outcome.failed} failed`);
	if (outcome.rolledBack > 0) parts.push(`${outcome.rolledBack} rolled back (failed post-upgrade health check)`);
	// A couple of sample failures with their reason (hostname + short error), not the full list.
	const samples = outcome.failedAgents.slice(0, 3).map((a) => `${a.hostname}: ${a.error.slice(0, 80)}`);
	const detail = samples.length > 0 ? ` Failures: ${samples.join("; ")}.` : "";
	const recheck = outcome.actionId ? ` Re-check with action ${outcome.actionId} (valid ~30d).` : "";
	return `Partial: ${parts.join(", ")}. The failures are agent-side (binary download / disk / health check), not a bad upgrade.${detail}${recheck}`;
}

// SIO-878: classify a failed plan job's log into a human-readable cause hint. The
// deployments stack shares one Terraform state across all 10 clusters, so concurrent
// MRs contend on a single state lock -- the most common, recoverable failure. (Pure.)
//
// SIO-904: the MCP now greps the FULL trace and returns a `stateLocked` verdict; prefer it when
// present, since the signature can sit beyond the returned tail. When the flag is absent (e.g. the
// gitlab_get_pipeline_plan_log caller), fall back to substring-matching the supplied log.
export function classifyPipelineFailure(planLog: string, stateLocked?: boolean): string {
	const lower = planLog.toLowerCase();
	if (stateLocked === true || lower.includes("error acquiring the state lock") || lower.includes("already locked")) {
		return (
			"Likely cause: a Terraform state-lock on the shared deployments stack (all 10 clusters share one " +
			"state, so concurrent MRs contend on a single lock). An operator can force-unlock in GitLab or wait " +
			"for the holding pipeline to finish, then re-run the plan."
		);
	}
	if (!planLog || planLog.startsWith("[")) return "The plan job log was not available to diagnose the failure.";
	return "The plan job failed for another reason -- review the job log.";
}

// SIO-975: classify a TERMINAL fleet-apply outcome into applied | partial | failed + a note.
// Single source of truth shared by the main apply path (detectFleetUpgrade), the SIO-926
// follow-up re-poll (checkFleetApplyStatus), and the SIO-1072 reconcile fleet-settlement pass,
// so all three surface the SAME rich detail. ciStatus is the CI job status ("success"/"failed"/
// "canceled"); outcome is the parsed apply report (null when the report was unreadable).
// Mirrors SIO-961: a failed CI job that actioned agents (created>0) with agent-side failures is
// PARTIAL (rendered via buildFleetPartialNote), not a bare failure; a true infra failure (state
// lock / nothing actioned) is failed -- and names the report's CI-side error_reason when present,
// falling back to classifyPipelineFailure only when it isn't.
export function classifyFleetApplyResult(
	ciStatus: string,
	outcome: FleetApplyOutcome | null,
	failureLog: string,
	stateLocked: boolean,
): { status: "applied" | "partial" | "failed"; note?: string } {
	if (ciStatus === "success") return { status: "applied" };
	const actioned = outcome != null && outcome.created > 0;
	const infraFailure = stateLocked || outcome == null || outcome.created === 0;
	if (actioned && !infraFailure && outcome) {
		return { status: "partial", note: buildFleetPartialNote(outcome) };
	}
	const reason = outcome?.errorReason ? `${outcome.errorReason}` : classifyPipelineFailure(failureLog, stateLocked);
	return { status: "failed", note: `Apply pipeline ${ciStatus}. ${reason}` };
}
