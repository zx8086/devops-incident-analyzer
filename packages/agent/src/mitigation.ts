// agent/src/mitigation.ts

import { getLogger } from "@devops-agent/observability";
import type { MitigationSteps, PendingAction } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { getAvailableActionTools } from "./action-tools/executor.ts";
import { createLlm } from "./llm.ts";
import { getRunbookFilenames } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:mitigation");

const MitigationOutputSchema = z.object({
	investigate: z.array(z.string()),
	monitor: z.array(z.string()),
	escalate: z.array(z.string()),
	relatedRunbooks: z.array(z.string()),
});

const ActionProposalSchema = z.object({
	actions: z.array(
		z.object({
			tool: z.enum(["notify-slack", "create-ticket"]),
			params: z.record(z.string(), z.unknown()),
			reason: z.string(),
		}),
	),
});

function buildMitigationPrompt(): string {
	const runbooks = getRunbookFilenames();
	const runbookHint =
		runbooks.length > 0
			? `\n\nAvailable runbooks: ${runbooks.join(", ")}\nReference relevant runbooks by filename in relatedRunbooks.`
			: '\nUse "knowledge/runbooks/<topic>.md" format for relatedRunbooks.';

	return `Based on the incident analysis report below, suggest safe, non-destructive mitigation steps.

Categorize each suggestion into exactly one category:
- investigate: additional read-only queries or checks to narrow the root cause
- monitor: specific metrics, thresholds, or dashboards to watch
- escalate: actions requiring human approval (scaling, rollback, config changes)
- relatedRunbooks: file paths or titles of relevant runbooks${runbookHint}

RULES:
- Never suggest destructive operations (restart, delete, drop, reset, truncate)
- All "investigate" suggestions must be read-only and safe to automate
- All "escalate" suggestions must explicitly state they require human approval
- Limit to 3-5 suggestions per category
- If the report confidence is low, lead investigate with broader diagnostic steps

Return ONLY valid JSON matching: { investigate: string[], monitor: string[], escalate: string[], relatedRunbooks: string[] }`;
}

function buildActionProposalPrompt(availableTools: string[]): string {
	const toolDescs: string[] = [];
	if (availableTools.includes("notify-slack")) {
		toolDescs.push(
			'- notify-slack: params { channel (string), message (string, concise summary), severity (critical|high|medium|low|info) }',
		);
	}
	if (availableTools.includes("create-ticket")) {
		toolDescs.push(
			'- create-ticket: params { title (string, under 80 chars), description (string, structured summary), severity (critical|high|medium|low), affected_services (string[]), datasources_queried (string[]) }',
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

export async function proposeMitigation(
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

	const confidence = state.confidenceScore;
	const confidenceHint = confidence > 0 && confidence < 0.6
		? "\n\nNOTE: Report confidence is below 0.6. Lead with broader investigation steps and explicitly note data gaps."
		: "";

	const queriedSources = state.targetDataSources;
	const sourceContext = queriedSources.length > 0
		? `\nQueried datasources: ${queriedSources.join(", ")}`
		: "";

	const truncated = report.slice(0, 3000);
	let mitigationSteps: MitigationSteps = { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] };
	let pendingActions: PendingAction[] = [];

	// Step 1: Generate mitigation steps
	const llm = createLlm("mitigation");
	try {
		const response = await llm.invoke(
			[
				{ role: "system", content: `${buildMitigationPrompt()}${confidenceHint}${sourceContext}` },
				{ role: "human", content: truncated },
			],
			config,
		);

		const text = String(response.content);
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = MitigationOutputSchema.parse(JSON.parse(jsonMatch[0]));
			mitigationSteps = { ...parsed };
			logger.info(
				{
					investigate: mitigationSteps.investigate.length,
					monitor: mitigationSteps.monitor.length,
					escalate: mitigationSteps.escalate.length,
					runbooks: mitigationSteps.relatedRunbooks.length,
				},
				"Mitigation steps generated",
			);
		} else {
			logger.warn("Failed to parse mitigation JSON from LLM response");
		}
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Mitigation generation failed",
		);
	}

	// Step 2: Generate action proposals (only if action tools are configured)
	const availableTools = getAvailableActionTools();
	const severity = state.normalizedIncident?.severity;
	const shouldPropose = availableTools.length > 0 && (severity === "critical" || severity === "high");

	if (shouldPropose) {
		const actionLlm = createLlm("actionProposal");
		try {
			const response = await actionLlm.invoke(
				[
					{ role: "system", content: buildActionProposalPrompt(availableTools) },
					{
						role: "human",
						content: `Severity: ${severity}\nConfidence: ${confidence}\nDatasources: ${queriedSources.join(", ")}\n\n${truncated}`,
					},
				],
				config,
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
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				"Action proposal generation failed",
			);
		}
	}

	return { mitigationSteps, pendingActions };
}
