// agent/src/mitigation-branches.ts

import { getLogger } from "@devops-agent/observability";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { createLlm, DeadlineExceededError, type InvokableLlm, invokeWithDeadline, type LlmRole } from "./llm.ts";
import type { AgentStateType, MitigationFragment } from "./state.ts";

const logger = getLogger("agent:mitigation-branches");

const BranchOutputSchema = z.object({ items: z.array(z.string()) });

type BranchKind = MitigationFragment["kind"];

interface BranchSpec {
	kind: BranchKind;
	role: LlmRole;
	categoryDescription: string;
	rules: string[];
}

const SPECS: Record<BranchKind, BranchSpec> = {
	investigate: {
		kind: "investigate",
		role: "mitigateInvestigate",
		categoryDescription: "additional read-only queries or checks to narrow the root cause",
		rules: [
			"All suggestions must be read-only and safe to automate.",
			"Never suggest destructive operations (restart, delete, drop, reset, truncate).",
			"If the report confidence is low, lead with broader diagnostic steps.",
		],
	},
	monitor: {
		kind: "monitor",
		role: "mitigateMonitor",
		categoryDescription: "specific metrics, thresholds, or dashboards to watch",
		rules: ["Name concrete metrics, dashboards, or alert thresholds.", "Never suggest destructive operations."],
	},
	escalate: {
		kind: "escalate",
		role: "mitigateEscalate",
		categoryDescription: "actions requiring human approval (scaling, rollback, config changes)",
		rules: [
			"All suggestions must explicitly state they require human approval.",
			"Never suggest destructive operations directly; describe them as escalations.",
		],
	},
};

function buildBranchPrompt(spec: BranchSpec): string {
	return `Based on the incident analysis report below, suggest 3-5 ${spec.kind} steps.

Category: ${spec.kind} - ${spec.categoryDescription}

RULES:
${spec.rules.map((r) => `- ${r}`).join("\n")}
- Limit to 3-5 suggestions.

Return ONLY valid JSON matching: { items: string[] }`;
}

function buildContextHints(state: AgentStateType): string {
	const confidence = state.confidenceScore;
	const confidenceHint =
		confidence > 0 && confidence < 0.6
			? "\n\nNOTE: Report confidence is below 0.6. Lead with broader investigation steps and explicitly note data gaps."
			: "";
	const queriedSources = state.targetDataSources;
	const sourceContext = queriedSources.length > 0 ? `\nQueried datasources: ${queriedSources.join(", ")}` : "";
	return `${confidenceHint}${sourceContext}`;
}

async function runBranch(
	spec: BranchSpec,
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	const report = state.finalAnswer;
	if (!report || report.length < 50) {
		return { mitigationFragments: [{ kind: spec.kind, items: [] }] };
	}

	const truncated = report.slice(0, 3000);
	const llm = createLlm(spec.role);

	try {
		const response = await invokeWithDeadline(
			llm as InvokableLlm,
			spec.role,
			[
				{ role: "system", content: `${buildBranchPrompt(spec)}${buildContextHints(state)}` },
				{ role: "human", content: truncated },
			],
			config as { signal?: AbortSignal; [key: string]: unknown } | undefined,
		);

		const text = String(response.content);
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			logger.warn({ kind: spec.kind }, "Failed to parse mitigation branch JSON");
			return { mitigationFragments: [{ kind: spec.kind, items: [] }] };
		}

		const parsed = BranchOutputSchema.parse(JSON.parse(jsonMatch[0]));
		logger.info({ kind: spec.kind, count: parsed.items.length }, "Mitigation branch produced items");
		return { mitigationFragments: [{ kind: spec.kind, items: parsed.items }] };
	} catch (error) {
		if (error instanceof DeadlineExceededError) {
			logger.warn(
				{ kind: spec.kind, role: error.role, deadlineMs: error.deadlineMs },
				"Mitigation branch exceeded deadline; soft-failing",
			);
			return {
				mitigationFragments: [{ kind: spec.kind, items: [], failed: true }],
				partialFailures: [{ node: `proposeMitigation.${spec.kind}`, reason: "timeout" }],
			};
		}
		logger.warn(
			{ kind: spec.kind, error: error instanceof Error ? error.message : String(error) },
			"Mitigation branch generation failed",
		);
		return { mitigationFragments: [{ kind: spec.kind, items: [] }] };
	}
}

export async function proposeInvestigate(
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	return runBranch(SPECS.investigate, state, config);
}

export async function proposeMonitor(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
	return runBranch(SPECS.monitor, state, config);
}

export async function proposeEscalate(
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	return runBranch(SPECS.escalate, state, config);
}
