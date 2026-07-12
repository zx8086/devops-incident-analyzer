// packages/agent/src/sub-agent-focus-block.ts
import type { InvestigationFocus } from "@devops-agent/shared";

// SIO-1079: the per-turn, volatile block appended to a sub-agent's system prompt. It
// carries (a) a real current-time anchor and (b) the investigation focus. The clock is a
// parameter (not read from Date here) so the block is deterministic and unit-testable; the
// caller passes new Date().toISOString(). Kept out of the cached base prompt because both
// the time anchor and the focus change every turn.
//
// The current-time line is the fix for the AWS sub-agent choosing CloudWatch query windows
// with no "now" reference: without it the LLM invented Unix epoch seconds unmoored from the
// real clock and anchored aws_logs_start_query outside the log group's retention window.
export function buildFocusBlock(focus: InvestigationFocus | undefined, nowIso: string): string {
	const timeAnchor =
		`\n\n---\n\nCurrent time: ${nowIso}. ` +
		"When a tool needs a time window (e.g. CloudWatch Logs Insights startTime/endTime, " +
		"which are Unix epoch SECONDS), anchor it to the incident/event timestamp under " +
		"investigation and to this current time -- never guess an absolute epoch, and keep the " +
		"window within the data source's retention.";

	if (!focus) return timeAnchor;

	return (
		`${timeAnchor}\n\n---\n\nINVESTIGATION FOCUS (continuing across turns):\n` +
		`- Summary: ${focus.summary}\n` +
		`- Anchored services: ${focus.services.join(", ") || "(none)"}\n` +
		`- Anchored time window: ${focus.timeWindow ? `${focus.timeWindow.from} to ${focus.timeWindow.to}` : "(none)"}\n\n` +
		"All tool calls must stay scoped to this investigation. Do not pivot to unrelated " +
		"clusters, services, or time ranges. If the user's current message references " +
		'"kafka" or "the broker" or similar pronouns, resolve them against the anchored ' +
		"services list, not the broadest possible interpretation."
	);
}
