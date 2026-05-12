// agent/src/mitigation.ts

import { getLogger } from "@devops-agent/observability";
import type { MitigationSteps, PendingAction } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { getAvailableActionTools } from "./action-tools/executor.ts";
import { createLlm, DeadlineExceededError, type InvokableLlm, invokeWithDeadline } from "./llm.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:mitigation");

const ActionProposalSchema = z.object({
	actions: z.array(
		z.object({
			tool: z.enum(["notify-slack", "create-ticket"]),
			params: z.record(z.string(), z.unknown()),
			reason: z.string(),
		}),
	),
});

function buildActionProposalPrompt(availableTools: string[]): string {
	const toolDescs: string[] = [];
	if (availableTools.includes("notify-slack")) {
		toolDescs.push(
			"- notify-slack: params { channel (string), message (string, concise summary), severity (critical|high|medium|low|info) }",
		);
	}
	if (availableTools.includes("create-ticket")) {
		toolDescs.push(
			"- create-ticket: params { title (string, under 80 chars), description (string, structured summary), severity (critical|high|medium|low), affected_services (string[]), datasources_queried (string[]) }",
		);
	}

	return `Based on the incident analysis below, suggest action tool invocations if the severity warrants it.

Available tools:
${toolDescs.join("\n")}

RULES:
- Only suggest actions for high or critical severity incidents
- For notify-slack: write a concise incident summary as the message, not the full report
- For create-ticket: write a clear title (under 80 chars) and structured description
- Include a brief reason explaining why this action is warranted
- If the incident does not warrant action, return an empty actions array

Return ONLY valid JSON matching: { actions: [{ tool, params, reason }] }`;
}

function mergeFragmentsToSteps(state: AgentStateType): MitigationSteps {
	const byKind: { investigate: string[]; monitor: string[]; escalate: string[] } = {
		investigate: [],
		monitor: [],
		escalate: [],
	};
	for (const f of state.mitigationFragments) {
		if (f.failed) continue;
		byKind[f.kind].push(...f.items);
	}
	return {
		investigate: byKind.investigate,
		monitor: byKind.monitor,
		escalate: byKind.escalate,
		relatedRunbooks: state.selectedRunbooks ?? [],
	};
}

// SIO-741: Joins the three parallel mitigation branches. Merges mitigationFragments
// into the durable mitigationSteps shape (single-writer for that field) and then
// runs Step 2 (action proposal) sequentially, gated on severity and configured
// action tools. Replaces the former proposeMitigation node which combined Step 1
// (now split into three Send branches) with Step 2.
export async function aggregateMitigation(
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	const report = state.finalAnswer;
	if (!report || report.length < 50) {
		logger.info("No substantial report to generate mitigations from");
		return {
			mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
			pendingActions: [],
		};
	}

	const mitigationSteps = mergeFragmentsToSteps(state);
	logger.info(
		{
			investigate: mitigationSteps.investigate.length,
			monitor: mitigationSteps.monitor.length,
			escalate: mitigationSteps.escalate.length,
			runbooks: mitigationSteps.relatedRunbooks.length,
		},
		"Mitigation fragments merged",
	);

	let pendingActions: PendingAction[] = [];
	const partialFailures: Array<{ node: string; reason: string }> = [];

	const availableTools = getAvailableActionTools();
	const severity = state.normalizedIncident?.severity;
	const shouldPropose = availableTools.length > 0 && (severity === "critical" || severity === "high");

	if (shouldPropose) {
		const truncated = report.slice(0, 3000);
		const queriedSources = state.targetDataSources;
		const confidence = state.confidenceScore;
		const actionLlm = createLlm("actionProposal");
		try {
			const response = await invokeWithDeadline(
				actionLlm as InvokableLlm,
				"actionProposal",
				[
					{ role: "system", content: buildActionProposalPrompt(availableTools) },
					{
						role: "human",
						content: `Severity: ${severity}\nConfidence: ${confidence}\nDatasources: ${queriedSources.join(", ")}\n\n${truncated}`,
					},
				],
				config as { signal?: AbortSignal; [key: string]: unknown } | undefined,
			);

			const text = String(response.content);
			const jsonMatch = text.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				const parsed = ActionProposalSchema.parse(JSON.parse(jsonMatch[0]));
				pendingActions = parsed.actions
					.filter((a) => availableTools.includes(a.tool))
					.map((a) => ({
						id: crypto.randomUUID(),
						tool: a.tool,
						params: a.params,
						reason: a.reason,
					}));
				logger.info({ count: pendingActions.length }, "Action proposals generated");
			}
		} catch (error) {
			if (error instanceof DeadlineExceededError) {
				logger.warn(
					{ role: error.role, deadlineMs: error.deadlineMs },
					"Action proposal step exceeded deadline; soft-failing",
				);
				partialFailures.push({ node: "proposeMitigation.actionProposal", reason: "timeout" });
			} else {
				logger.warn(
					{ error: error instanceof Error ? error.message : String(error) },
					"Action proposal generation failed",
				);
			}
		}
	}

	return { mitigationSteps, pendingActions, partialFailures };
}
