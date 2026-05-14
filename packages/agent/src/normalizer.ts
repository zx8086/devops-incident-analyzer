// agent/src/normalizer.ts

import { getLogger } from "@devops-agent/observability";
import type { InvestigationFocus, NormalizedIncident } from "@devops-agent/shared";
import { DATA_SOURCE_IDS } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { createLlm } from "./llm.ts";
import { extractTextFromContent } from "./message-utils.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:normalizer");

// LLMs often return null instead of omitting fields, and numbers instead of strings
// for metric values. Coerce and strip nulls to handle this gracefully.
const coerceNullableString = z
	.union([z.string(), z.number(), z.null()])
	.transform((v) => (v === null || v === undefined ? undefined : String(v)))
	.optional();

const NormalizationSchema = z.object({
	severity: z
		.enum(["critical", "high", "medium", "low"])
		.nullish()
		.transform((v) => v ?? undefined),
	timeWindow: z
		.object({ from: z.string(), to: z.string() })
		.nullish()
		.transform((v) => v ?? undefined),
	affectedServices: z
		.array(
			z.object({
				name: z.string(),
				namespace: coerceNullableString,
				deployment: coerceNullableString,
			}),
		)
		.nullish()
		.transform((v) => v ?? undefined),
	extractedMetrics: z
		.array(
			z.object({
				name: z.union([z.string(), z.number()]).transform(String),
				value: coerceNullableString,
				threshold: coerceNullableString,
			}),
		)
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

// SIO-750: Build the investigation focus anchor from the current normalized
// incident + query. Deterministic (no LLM call). Called on the first complex
// turn of a chat session; subsequent turns reuse the existing focus via the
// state.ts sticky reducer.
//
// On cold restart with isFollowUp:true but no focus persisted (the MemorySaver
// in packages/checkpointer was lost), we reconstruct from the current incident
// as the best-effort recovery and log a warning so operators can detect this.
export function buildInvestigationFocus(
	state: AgentStateType,
	incident: NormalizedIncident,
	query: string,
): InvestigationFocus {
	if (state.isFollowUp && !state.investigationFocus) {
		logger.warn(
			{ isFollowUp: true, hasIncident: !!incident },
			"Follow-up turn arrived without persisted investigationFocus -- checkpointer may have been lost; reconstructing from current incident",
		);
	}

	const services = incident.affectedServices?.map((s) => s.name) ?? [];
	const severity = incident.severity ?? "unspecified";
	// One-line deterministic summary: "<severity> investigation of <services> -- <first 80 chars of query>".
	const querySnippet = query.trim().replace(/\s+/g, " ").slice(0, 80);
	const summary =
		services.length > 0
			? `${severity} investigation of ${services.join(", ")} -- ${querySnippet}`
			: `${severity} investigation -- ${querySnippet}`;

	return {
		services,
		datasources: [], // populated by the entity-extractor in stage 2
		timeWindow: incident.timeWindow,
		summary,
		establishedAtTurn: state.messages.length,
	};
}

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

	// SIO-750: on follow-ups, surface the persisted investigation focus so the
	// LLM does not drift to unrelated services or time ranges. The focus is the
	// authoritative inheritance source; the legacy normalizedIncident.timeWindow
	// fallback is kept for the (rare) case where focus is unset but a prior
	// normalized incident exists (e.g. mid-session migration of an already-running
	// chat).
	const focus = state.investigationFocus;
	const followUpHint =
		state.isFollowUp && focus
			? `\nOriginal investigation: ${focus.summary}\nAnchored services: ${focus.services.join(", ") || "(none)"}\nAnchored datasources: ${focus.datasources.join(", ") || "(none)"}\nAnchored time window: ${focus.timeWindow ? JSON.stringify(focus.timeWindow) : "(none)"}\nTreat new services/metrics in the user's query as scoping additions to this investigation. Inherit anchored fields unless the query explicitly overrides them.`
			: state.isFollowUp && state.normalizedIncident?.timeWindow
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
			// SIO-750: establish the investigation focus on the first complex
			// turn. The sticky reducer in state.ts preserves the existing focus
			// across later turns; we only build a fresh one here when none is
			// persisted yet.
			const investigationFocus = state.investigationFocus ?? buildInvestigationFocus(state, incident, query);
			logger.info(
				{
					severity: incident.severity,
					serviceCount: incident.affectedServices?.length ?? 0,
					metricCount: incident.extractedMetrics?.length ?? 0,
					hasTimeWindow: !!incident.timeWindow,
					focusEstablishedAtTurn: investigationFocus.establishedAtTurn,
					focusServices: investigationFocus.services,
				},
				"Normalization complete",
			);
			return { normalizedIncident: incident, investigationFocus };
		}
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Normalization failed, continuing without",
		);
	}

	return {};
}
