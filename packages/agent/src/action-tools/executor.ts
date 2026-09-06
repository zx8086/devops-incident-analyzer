// agent/src/action-tools/executor.ts
import type { ActionResult, PendingAction } from "@devops-agent/shared";
import { executePiInvestigate, executePiVerify } from "./pi-verifier.ts";
import { executeSlackNotify, isSlackConfigured } from "./slack-notifier.ts";
import { executeCreateTicket, isLinearConfigured } from "./ticket-creator.ts";

// LLM-proposable tools only. The pi-coms tools (SIO-1635) are proposed
// deterministically by proposePiVerification and are not listed here.
export function getAvailableActionTools(): string[] {
	const available: string[] = [];
	if (isSlackConfigured()) available.push("notify-slack");
	if (isLinearConfigured()) available.push("create-ticket");
	return available;
}

export async function executeAction(
	action: PendingAction,
	context: { reportContent: string; threadId: string },
): Promise<ActionResult> {
	const base = { actionId: action.id, tool: action.tool };

	try {
		if (action.tool === "notify-slack") {
			const params = action.params as {
				channel?: string;
				message?: string;
				severity?: string;
				thread_ts?: string;
			};
			const result = await executeSlackNotify({
				channel: String(params.channel ?? ""),
				message: String(params.message ?? ""),
				severity: String(params.severity ?? "info"),
				thread_ts: params.thread_ts ? String(params.thread_ts) : undefined,
				reportContent: context.reportContent,
			});

			return result.sent
				? { ...base, status: "success", result: { timestamp: result.timestamp, channel: result.channel } }
				: { ...base, status: "error", error: "Slack message delivery failed" };
		}

		if (action.tool === "create-ticket") {
			const params = action.params as {
				title?: string;
				description?: string;
				severity?: string;
				affected_services?: string[];
				datasources_queried?: string[];
			};
			const result = await executeCreateTicket({
				title: String(params.title ?? "Untitled Incident"),
				description: String(params.description ?? ""),
				severity: String(params.severity ?? "medium"),
				affected_services: params.affected_services,
				datasources_queried: params.datasources_queried,
				reportContent: context.reportContent,
			});

			return result.ticket_id
				? { ...base, status: "success", result: { ticket_id: result.ticket_id, url: result.url } }
				: { ...base, status: "error", error: "Ticket creation failed" };
		}

		// SIO-1635: hub replies come back as structured result payloads; a verify
		// that cannot confirm every claim also proposes the investigate card.
		if (action.tool === "verify-with-pi" || action.tool === "investigate-with-pi") {
			const outcome =
				action.tool === "verify-with-pi"
					? await executePiVerify(action.params, context.reportContent)
					: await executePiInvestigate(action.params, context.reportContent);
			return outcome.status === "success"
				? {
						...base,
						status: "success",
						result: outcome.result,
						...(outcome.followUpActions && { followUpActions: outcome.followUpActions }),
					}
				: { ...base, status: "error", error: outcome.error ?? "pi-coms action failed" };
		}

		return { ...base, status: "error", error: `Unknown action tool: ${action.tool}` };
	} catch (err) {
		return { ...base, status: "error", error: err instanceof Error ? err.message : String(err) };
	}
}
