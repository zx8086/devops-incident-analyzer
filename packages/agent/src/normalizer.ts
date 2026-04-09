// agent/src/normalizer.ts

import { getLogger } from "@devops-agent/observability";
import { DATA_SOURCE_IDS } from "@devops-agent/shared";
import type { NormalizedIncident } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { createLlm } from "./llm.ts";
import { extractTextFromContent } from "./message-utils.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:normalizer");

// LLMs often return null instead of omitting fields, and numbers instead of strings
// for metric values. Coerce and strip nulls to handle this gracefully.
const coerceNullableString = z.union([z.string(), z.number(), z.null()])
	.transform((v) => (v === null || v === undefined ? undefined : String(v)))
	.optional();

const NormalizationSchema = z.object({
	severity: z.enum(["critical", "high", "medium", "low"]).nullish().transform((v) => v ?? undefined),
	timeWindow: z.object({ from: z.string(), to: z.string() }).nullish().transform((v) => v ?? undefined),
	affectedServices: z
		.array(z.object({
			name: z.string(),
			namespace: coerceNullableString,
			deployment: coerceNullableString,
		}))
		.nullish()
		.transform((v) => v ?? undefined),
	extractedMetrics: z
		.array(z.object({
			name: z.union([z.string(), z.number()]).transform(String),
			value: coerceNullableString,
			threshold: coerceNullableString,
		}))
		.nullish()
		.transform((v) => v ?? undefined),
});

const NORMALIZER_PROMPT = `Normalize the user's incident query into structured data for downstream analysis.

Available datasources: ${DATA_SOURCE_IDS.join(", ")}

Extract and return JSON with:
- severity: "critical" (outage), "high" (degraded), "medium" (anomaly), "low" (informational). Infer from keywords like "down", "outage" = critical; "slow", "degraded" = high; "check", "how" = medium.
- timeWindow: { from, to } as ISO 8601. Parse "last 30 min", "past hour", etc. If no time is mentioned, default to { from: 1 hour ago, to: now }.
- affectedServices: array of { name, namespace?, deployment? }. Extract service names, namespaces, or deployment identifiers mentioned.
- extractedMetrics: array of { name, value?, threshold? }. Extract metrics like "error rate 15%", "latency > 500ms", "lag 10000".

Return ONLY valid JSON, no explanation.`;

export async function normalizeIncident(
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	const lastMessage = state.messages.at(-1);
	if (!lastMessage) {
		logger.info("No message to normalize");
		return {};
	}

	const query = extractTextFromContent(lastMessage.content);
	logger.info({ query: query.slice(0, 100) }, "Normalizing incident query");

	// On follow-ups, provide previous incident context so the LLM can inherit time windows
	const followUpHint = state.isFollowUp && state.normalizedIncident?.timeWindow
		? `\nPrevious incident context: severity=${state.normalizedIncident.severity ?? "unknown"}, timeWindow=${JSON.stringify(state.normalizedIncident.timeWindow)}. Inherit these if the new query does not override them.`
		: "";

	const now = new Date();
	const oneHourAgo = new Date(now.getTime() - 3600_000);
	const timeContext = `\nCurrent time: ${now.toISOString()}. Default time window: { "from": "${oneHourAgo.toISOString()}", "to": "${now.toISOString()}" }`;

	const llm = createLlm("normalizer");
	try {
		const response = await llm.invoke(
			[
				{ role: "system", content: `${NORMALIZER_PROMPT}${timeContext}${followUpHint}` },
				{ role: "human", content: query },
			],
			config,
		);

		const text = String(response.content);
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = NormalizationSchema.parse(JSON.parse(jsonMatch[0]));
			const incident: NormalizedIncident = { ...parsed };
			logger.info(
				{
					severity: incident.severity,
					serviceCount: incident.affectedServices?.length ?? 0,
					metricCount: incident.extractedMetrics?.length ?? 0,
					hasTimeWindow: !!incident.timeWindow,
				},
				"Normalization complete",
			);
			return { normalizedIncident: incident };
		}
	} catch (error) {
		logger.warn({ error: error instanceof Error ? error.message : String(error) }, "Normalization failed, continuing without");
	}

	return {};
}
