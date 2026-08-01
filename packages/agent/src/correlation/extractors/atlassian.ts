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

// SIO-1244: capture the envelope's `service` -- the focus-derived term the sub-agent
// actually searched with (OutputSchema in find-linked-incidents.ts). It was being
// discarded, which left the per-issue summary match below standing alone.
// SIO-1338: capture `configWarning` too (SIO-1184 dead-project config, SIO-1337 pagination
// truncation) -- previously discarded here, leaving the composer's own warning unreachable by
// anything downstream of the raw tool JSON.
const EnvelopeSchema = z.object({
	service: z.string().optional(),
	issues: z.array(z.unknown()).optional(),
	configWarning: z.string().optional(),
});

// SIO-1030: focusServices scopes linked incidents to the incident under
// investigation. Strict drop — an issue is kept only when its summary references
// a focus service (matchesFocus short-circuits show-all on empty focus).
//
// SIO-1244: that rule alone dropped all 10 findings on run 43796e9f while Atlassian was the
// most load-bearing datasource in the report (DEVOPS-1405 supplied a Candidate Underlying
// Cause). Two reasons it cannot stand on its own:
//
//   1. Ticket-shaped findings carry no service field. AtlassianLinkedIssueSchema has
//      key/summary/status/severity/dates/url, so a service-NAME matcher has only prose to go
//      on, and incident summaries are written in business language.
//   2. It CANCELS the tool's deliberate design. The JQL matches on labels, `text ~ service`,
//      component AND errorKeywords, with SIO-1093 noting outright that incident tickets are
//      frequently NOT tagged with the normalized service (the prana AFS case:
//      `labels = "order-service"` returned 0 while the tickets exist under AFS/FMS/season
//      text). The tool broadens on purpose; re-narrowing on service names discarded every
//      keyword-matched ticket. `labels`/`component` are not even carried on ShapedIssue, so a
//      correctly-labelled ticket loses that evidence before it ever reaches the matcher.
//
// So provenance decides first: a ticket retrieved BY a focus-scoped query is in-focus by
// construction. The guard is that the envelope's OWN `service` must match the focus --
// without it this degenerates into "scoping off", which is precisely what SIO-1030 prevents.
// Envelopes failing that guard (a stale or unrelated probe) still get per-issue matching, now
// over `key + summary` so a ticket naming the service in either one survives.
export function extractAtlassianFindings(outputs: ToolOutput[], focusServices: string[] = []): AtlassianFindings {
	const linkedIssues: AtlassianLinkedIssue[] = [];
	// SIO-1338: multiple findLinkedIncidents calls in one turn (one per probed service) can each
	// carry their own configWarning -- collect and dedupe rather than letting the last call win,
	// mirroring the space-join composition the composer tool itself uses (SIO-1337).
	const configWarnings = new Set<string>();
	for (const o of outputs) {
		if (o.toolName !== "findLinkedIncidents") continue;
		const env = EnvelopeSchema.safeParse(o.rawJson);
		if (!env.success) continue;
		if (env.data.configWarning) configWarnings.add(env.data.configWarning);
		const queriedService = env.data.service ?? "";
		const envelopeInFocus = queriedService.length > 0 && matchesFocus(queriedService, focusServices);
		for (const raw of env.data.issues ?? []) {
			const parsed = AtlassianLinkedIssueSchema.safeParse(raw);
			if (!parsed.success) continue;
			if (!envelopeInFocus && !matchesFocus(`${parsed.data.key} ${parsed.data.summary}`, focusServices)) continue;
			linkedIssues.push(parsed.data);
		}
	}
	const configWarning = configWarnings.size > 0 ? [...configWarnings].join(" ") : undefined;
	if (linkedIssues.length === 0 && !configWarning) return {};
	return {
		...(linkedIssues.length > 0 ? { linkedIssues } : {}),
		...(configWarning ? { configWarning } : {}),
	};
}
