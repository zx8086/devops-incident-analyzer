// packages/agent/src/correlation/extractors/gitlab.ts
import type { GitLabFindings, GitLabMergedRequest, ToolOutput } from "@devops-agent/shared";
import { GitLabMergedRequestSchema } from "@devops-agent/shared";
import { matchesFocus } from "../focus-match.ts";

// SIO-1030: focusServices scopes merged requests to the incident. Strict drop —
// an MR is kept only when its title/description references a focus service
// (matchesFocus short-circuits show-all on empty focus).
export function extractGitLabFindings(outputs: ToolOutput[], focusServices: string[] = []): GitLabFindings {
	const mergedRequests: GitLabMergedRequest[] = [];

	for (const o of outputs) {
		if (o.toolName !== "gitlab_list_merge_requests") continue;
		if (!Array.isArray(o.rawJson)) continue;
		for (const mr of o.rawJson) {
			const parsed = GitLabMergedRequestSchema.safeParse(mr);
			if (!parsed.success) continue;
			const haystack = `${parsed.data.title ?? ""} ${parsed.data.description ?? ""}`;
			if (!matchesFocus(haystack, focusServices)) continue;
			mergedRequests.push(parsed.data);
		}
	}

	return mergedRequests.length > 0 ? { mergedRequests } : {};
}
