// agent/src/iac/mr-live-state.ts
// SIO-1047: fetchMrLiveState (+ its parseMrState/parseApplyResult parsers) extracted out of nodes.ts.
// reconcile.ts imported fetchMrLiveState from nodes.ts while nodes.ts imports reconcileAll from
// reconcile.ts, forming a circular dependency. A one-way move of fetchMrLiveState alone still left it
// pulling nodes.ts's private callTool back in (a 3-file cycle), so this module carries its own minimal
// tool-call helper instead of importing nodes.ts's -- deliberate small duplication of a ~10-line MCP
// wrapper is cheaper than relocating callTool's 100+ call sites out of nodes.ts. nodes.ts re-imports
// parseMrState/parseApplyResult from here (watchPipeline needs them too) and re-exports them so its
// existing external importers (pipeline-status.test.ts) are unaffected. Net result: this module is a
// true leaf -- it imports nothing from nodes.ts or reconcile.ts.

import { getToolsForDataSource } from "../mcp-bridge.ts";

const AGENT = "elastic-iac";

// Best-effort single-tool call, mirroring nodes.ts's private callTool with its findTool indirection
// inlined (same getToolsForDataSource lookup, same fallback). Returns a placeholder when the
// unified server (and therefore the tool) is not connected so the graph degrades instead of throwing.
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
	const tool = getToolsForDataSource(AGENT).find((t) => t.name === name);
	if (!tool) return `[${name} unavailable - elastic-iac server not connected]`;
	try {
		const res = await tool.invoke(args);
		return typeof res === "string" ? res : JSON.stringify(res);
	} catch (err) {
		return `[${name} error: ${err instanceof Error ? err.message : String(err)}]`;
	}
}

// SIO-992: parse the MR lifecycle state from gitlab_get_merge_request's "[status] {json}" body.
// GitLab's GET /merge_requests/:iid returns state ("opened"|"merged"|"closed") + merged_at +
// detailed_merge_status. We only need state (+ mergedAt for context) to distinguish "MR open, plan
// ready" from "MR merged, apply runs on main". null on a non-2xx/unparseable body. (Pure.)
// SIO-993: also capture merge_commit_sha so a merged MR can find its apply pipeline on main.
// SIO-1062: also capture web_url so the KG reconcile sweep can repair a ConfigChange whose
// stored mrUrl is an error blob (re-keying it to the MR's real url).
export function parseMrState(
	toolResult: string,
): { state: string; mergedAt?: string; detailedMergeStatus?: string; mergeCommitSha?: string; webUrl?: string } | null {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return null;
	try {
		const m = JSON.parse(toolResult.slice(jsonStart)) as {
			state?: unknown;
			merged_at?: unknown;
			detailed_merge_status?: unknown;
			merge_commit_sha?: unknown;
			web_url?: unknown;
		};
		if (typeof m.state !== "string") return null;
		return {
			state: m.state,
			...(typeof m.merged_at === "string" && m.merged_at ? { mergedAt: m.merged_at } : {}),
			...(typeof m.detailed_merge_status === "string" ? { detailedMergeStatus: m.detailed_merge_status } : {}),
			...(typeof m.merge_commit_sha === "string" && m.merge_commit_sha ? { mergeCommitSha: m.merge_commit_sha } : {}),
			...(typeof m.web_url === "string" && m.web_url ? { webUrl: m.web_url } : {}),
		};
	} catch {
		return null;
	}
}

// SIO-1062: iid from GitLab's 409 duplicate-MR message
// ("...already exists for this source branch: !256"). Lives in this leaf module so both
// nodes.ts (openMr's 409 recovery) and reconcile.ts (blob-mrUrl self-heal) can share it
// without re-forming the nodes.ts <-> reconcile.ts cycle. (Pure; unit-tested.)
export function mrIidFromConflictMessage(toolResult: string): number | null {
	const m = /!(\d+)/.exec(toolResult);
	return m ? Number(m[1]) : null;
}

// SIO-995: the REAL post-merge apply outcome, from gitlab_get_merge_commit_apply_result's JSON
// {applyStatus, jobId?, pipelineId?, webUrl?, parentStatus?, reason?}. applyStatus is the APPLY JOB's
// status (success=change live, running/pending=applying-not-live, failed=NOT live), NOT the parent
// pipeline's (which reports success transiently before the child apply job runs/fails -- the SIO-993
// false-positive). applyStatus is "" when the apply job hasn't appeared yet (treat as "starting",
// never success). null on an unparseable body. (Pure.)
export function parseApplyResult(
	toolResult: string,
): { applyStatus: string; pipelineId?: number; webUrl?: string; reason?: string } | null {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return null;
	try {
		const r = JSON.parse(toolResult.slice(jsonStart)) as {
			applyStatus?: unknown;
			pipelineId?: unknown;
			webUrl?: unknown;
			reason?: unknown;
		};
		return {
			applyStatus: typeof r.applyStatus === "string" ? r.applyStatus : "",
			...(typeof r.pipelineId === "number" ? { pipelineId: r.pipelineId } : {}),
			...(typeof r.webUrl === "string" ? { webUrl: r.webUrl } : {}),
			...(typeof r.reason === "string" ? { reason: r.reason } : {}),
		};
	} catch {
		return null;
	}
}

export interface MrLiveState {
	mrState: string; // "opened" | "merged" | "closed" | "" (unread)
	mergeCommitSha?: string;
	webUrl?: string; // SIO-1062: the MR's real web_url (for blob-mrUrl repair)
	applyStatus: string; // apply-JOB status; "" when not merged or the apply job hasn't appeared
	applyPipelineId: number | null;
	applyPipelineUrl: string;
}

// SIO-1005: the live MR -> apply-job lookup, extracted from watchPipeline (the SIO-992/SIO-995
// sequence) so the reconciliation pass (reconcile.ts) re-checks a proposed MR's true state with the
// EXACT same reads -- read the MR's lifecycle state, and once merged read the apply JOB's status
// (parent -> child -> apply:* job), never the parent pipeline's. Best-effort: every field falls back
// to its empty value when a tool is unavailable or a body is unparseable.
export async function fetchMrLiveState(iid: number): Promise<MrLiveState> {
	const mrInfo = parseMrState(await callTool("gitlab_get_merge_request", { iid }));
	const mrState = mrInfo?.state ?? "";
	let applyStatus = "";
	let applyPipelineId: number | null = null;
	let applyPipelineUrl = "";
	if (mrState === "merged" && mrInfo?.mergeCommitSha) {
		const apply = parseApplyResult(
			await callTool("gitlab_get_merge_commit_apply_result", { sha: mrInfo.mergeCommitSha }),
		);
		if (apply) {
			applyStatus = apply.applyStatus;
			applyPipelineId = apply.pipelineId ?? null;
			applyPipelineUrl = apply.webUrl ?? "";
		}
	}
	return {
		mrState,
		...(mrInfo?.mergeCommitSha ? { mergeCommitSha: mrInfo.mergeCommitSha } : {}),
		...(mrInfo?.webUrl ? { webUrl: mrInfo.webUrl } : {}),
		applyStatus,
		applyPipelineId,
		applyPipelineUrl,
	};
}
