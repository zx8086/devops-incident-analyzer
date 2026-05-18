// packages/agent/src/correlation/extractors/atlassian.ts
// SIO-785 Phase 2: Atlassian linked-incidents extractor. Reads the
// `{service, jql, count, issues: ShapedIssue[]}` envelope from the custom
// `findLinkedIncidents` tool (see
// packages/mcp-server-atlassian/src/tools/custom/find-linked-incidents.ts).
// Concatenates issues across multiple tool calls when the LLM probes more
// than one service in a single turn.
import type { AtlassianFindings, AtlassianLinkedIssue, ToolOutput } from "@devops-agent/shared";
import { AtlassianLinkedIssueSchema } from "@devops-agent/shared";
import { z } from "zod";

const EnvelopeSchema = z.object({
	issues: z.array(z.unknown()).optional(),
});

export function extractAtlassianFindings(outputs: ToolOutput[]): AtlassianFindings {
	const linkedIssues: AtlassianLinkedIssue[] = [];
	for (const o of outputs) {
		if (o.toolName !== "findLinkedIncidents") continue;
		const env = EnvelopeSchema.safeParse(o.rawJson);
		if (!env.success) continue;
		for (const raw of env.data.issues ?? []) {
			const parsed = AtlassianLinkedIssueSchema.safeParse(raw);
			if (parsed.success) linkedIssues.push(parsed.data);
		}
	}
	return linkedIssues.length > 0 ? { linkedIssues } : {};
}
