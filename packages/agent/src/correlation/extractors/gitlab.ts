// packages/agent/src/correlation/extractors/gitlab.ts
import type { GitLabFindings, GitLabMergedRequest, ToolOutput } from "@devops-agent/shared";
import { GitLabMergedRequestSchema } from "@devops-agent/shared";

export function extractGitLabFindings(outputs: ToolOutput[]): GitLabFindings {
	const mergedRequests: GitLabMergedRequest[] = [];

	for (const o of outputs) {
		if (o.toolName !== "gitlab_list_merge_requests") continue;
		if (!Array.isArray(o.rawJson)) continue;
		for (const mr of o.rawJson) {
			const parsed = GitLabMergedRequestSchema.safeParse(mr);
			if (parsed.success) mergedRequests.push(parsed.data);
		}
	}

	return mergedRequests.length > 0 ? { mergedRequests } : {};
}
