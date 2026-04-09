// agent/src/mitigation.ts

import { getLogger } from "@devops-agent/observability";
import type { MitigationSteps } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { createLlm } from "./llm.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:mitigation");

const MitigationOutputSchema = z.object({
	investigate: z.array(z.string()),
	monitor: z.array(z.string()),
	escalate: z.array(z.string()),
	relatedRunbooks: z.array(z.string()),
});

const MITIGATION_PROMPT = `Based on the incident analysis report below, suggest safe, non-destructive mitigation steps.

Categorize each suggestion into exactly one category:
- investigate: additional read-only queries or checks to narrow the root cause
- monitor: specific metrics, thresholds, or dashboards to watch
- escalate: actions requiring human approval (scaling, rollback, config changes)
- relatedRunbooks: file paths or titles of relevant runbooks (use "knowledge/runbooks/<topic>.md" format)

RULES:
- Never suggest destructive operations (restart, delete, drop, reset, truncate)
- All "investigate" suggestions must be read-only and safe to automate
- All "escalate" suggestions must explicitly state they require human approval
- Limit to 3-5 suggestions per category
- If the report confidence is low, lead investigate with broader diagnostic steps

Return ONLY valid JSON matching: { investigate: string[], monitor: string[], escalate: string[], relatedRunbooks: string[] }`;

export async function proposeMitigation(
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	const report = state.finalAnswer;
	if (!report || report.length < 50) {
		logger.info("No substantial report to generate mitigations from");
		return { mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] } };
	}

	const confidence = state.confidenceScore;
	const confidenceHint = confidence > 0 && confidence < 0.6
		? "\n\nNOTE: Report confidence is below 0.6. Lead with broader investigation steps and explicitly note data gaps."
		: "";

	const queriedSources = state.targetDataSources;
	const sourceContext = queriedSources.length > 0
		? `\nQueried datasources: ${queriedSources.join(", ")}`
		: "";

	const llm = createLlm("mitigation");
	try {
		// Truncate report to avoid token overflow -- mitigation only needs the summary
		const truncated = report.slice(0, 3000);
		const response = await llm.invoke(
			[
				{ role: "system", content: `${MITIGATION_PROMPT}${confidenceHint}${sourceContext}` },
				{ role: "human", content: truncated },
			],
			config,
		);

		const text = String(response.content);
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = MitigationOutputSchema.parse(JSON.parse(jsonMatch[0]));
			const steps: MitigationSteps = { ...parsed };
			logger.info(
				{
					investigate: steps.investigate.length,
					monitor: steps.monitor.length,
					escalate: steps.escalate.length,
					runbooks: steps.relatedRunbooks.length,
				},
				"Mitigation steps generated",
			);
			return { mitigationSteps: steps };
		}

		logger.warn("Failed to parse mitigation JSON from LLM response");
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Mitigation generation failed",
		);
	}

	return { mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] } };
}
