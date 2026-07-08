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
import { matchesFocus } from "../focus-match.ts";

const EnvelopeSchema = z.object({
	issues: z.array(z.unknown()).optional(),
});

// SIO-1030: focusServices scopes linked incidents to the incident under
// investigation. Strict drop — an issue is kept only when its summary references
// a focus service (matchesFocus short-circuits show-all on empty focus).
export function extractAtlassianFindings(outputs: ToolOutput[], focusServices: string[] = []): AtlassianFindings {
	const linkedIssues: AtlassianLinkedIssue[] = [];
	for (const o of outputs) {
		if (o.toolName !== "findLinkedIncidents") continue;
		const env = EnvelopeSchema.safeParse(o.rawJson);
		if (!env.success) continue;
		for (const raw of env.data.issues ?? []) {
			const parsed = AtlassianLinkedIssueSchema.safeParse(raw);
			if (!parsed.success) continue;
			if (!matchesFocus(parsed.data.summary, focusServices)) continue;
			linkedIssues.push(parsed.data);
		}
	}
	return linkedIssues.length > 0 ? { linkedIssues } : {};
}
