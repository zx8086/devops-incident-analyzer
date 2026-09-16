// packages/agent/src/correlation/extractors/gitlab.ts
import type { GitLabFindings, GitLabMergedRequest, ToolOutput } from "@devops-agent/shared";
import { GitLabMergedRequestSchema } from "@devops-agent/shared";
import { matchesFocus } from "../focus-match.ts";

// SIO-1644: mirrors aws SIO-1159 / couchbase SIO-1138 / elastic SIO-1643 --
// top-N when focus scoping drops everything, so the card is not silently blank.
const UNSCOPED_FALLBACK_LIMIT = 5;

// SIO-1030: focusServices scopes merged requests to the incident. Strict drop —
// an MR is kept only when its title/description references a focus service
// (matchesFocus short-circuits show-all on empty focus).
// SIO-1644: when scoping drops every MR, fall back to the most recently merged
// top-N flagged `unscoped: true` instead of a blank card. A WRONG focus (the LLM
// naming infrastructure components rather than services -- run a54d89c4) yields
// droppedAll empty cards, strictly worse than show-all. Rule-engine consumers
// skip unscoped rows (rules.ts getGitLabMergedRequests); the card renders them
// as recent-deploy context with an explicit caveat.
export function extractGitLabFindings(outputs: ToolOutput[], focusServices: string[] = []): GitLabFindings {
	const mergedRequests: GitLabMergedRequest[] = [];
	const all: GitLabMergedRequest[] = [];

	for (const o of outputs) {
		if (o.toolName !== "gitlab_list_merge_requests") continue;
		if (!Array.isArray(o.rawJson)) continue;
		for (const mr of o.rawJson) {
			const parsed = GitLabMergedRequestSchema.safeParse(mr);
			if (!parsed.success) continue;
			all.push(parsed.data);
			const haystack = `${parsed.data.title ?? ""} ${parsed.data.description ?? ""}`;
			if (!matchesFocus(haystack, focusServices)) continue;
			mergedRequests.push(parsed.data);
		}
	}

	if (mergedRequests.length > 0) return { mergedRequests };
	if (focusServices.length === 0 || all.length === 0) return {};
	// Most recently merged first: a recent deploy is the better triage signal when
	// nothing is focus-linked. Undated MRs sort last rather than winning by accident.
	const fallback = [...all]
		.sort((a, b) => (b.merged_at ?? "").localeCompare(a.merged_at ?? ""))
		.slice(0, UNSCOPED_FALLBACK_LIMIT);
	return { mergedRequests: fallback, unscoped: true };
}
