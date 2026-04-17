// agent/src/entity-extractor.ts

import { getLogger } from "@devops-agent/observability";
import type { AttachmentMeta, ExtractedEntities } from "@devops-agent/shared";
import { DATA_SOURCE_IDS } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { createLlm } from "./llm.ts";
import { extractTextFromContent } from "./message-utils.ts";
import { getAgent } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";
import { withRetry } from "./tool-retry.ts";

const logger = getLogger("agent:entity-extractor");

const ExtractionSchema = z.object({
	dataSources: z.array(
		z.object({
			id: z.string(),
			mentionedAs: z.string(),
		}),
	),
	timeFrom: z.string().nullish(),
	timeTo: z.string().nullish(),
	services: z.array(z.string()).nullish(),
	severity: z
		.string()
		.nullish()
		.transform((v) => {
			if (!v) return undefined;
			const lower = v.toLowerCase().trim();
			if (["critical", "high", "medium", "low"].includes(lower)) return lower;
			return undefined;
		}),
	toolActions: z.record(z.string(), z.array(z.string())).nullish(),
});

function buildActionCatalog(): string {
	try {
		const agent = getAgent();
		const lines: string[] = [];
		for (const tool of agent.tools) {
			if (tool.tool_mapping?.action_tool_map) {
				const actions = Object.keys(tool.tool_mapping.action_tool_map);
				lines.push(`- ${tool.tool_mapping.mcp_server}: ${actions.join(", ")}`);
			}
		}
		if (lines.length === 0) return "";
		return `\nFor each datasource, also identify which tool actions are most relevant to the query.
Available actions per datasource:
${lines.join("\n")}
Return toolActions as { "datasource_id": ["action1", "action2"] }.`;
	} catch {
		return "";
	}
}

export async function extractEntities(
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	const lastMessage = state.messages.at(-1);
	if (!lastMessage) {
		logger.info("No message found, targeting all datasources");
		return { extractedEntities: { dataSources: [] }, targetDataSources: [...DATA_SOURCE_IDS] };
	}
	const query = extractTextFromContent(lastMessage.content);
	logger.info({ query: query.slice(0, 100), uiSelected: state.targetDataSources }, "Extracting entities");

	// SIO-610: Build attachment context if files are attached
	const attachmentMeta = state.attachmentMeta ?? [];
	const attachmentContext = buildAttachmentContext(attachmentMeta);

	// SIO-630: Use normalized incident data as hints when available
	const normalized = state.normalizedIncident;
	const normalizationHint =
		normalized?.severity || normalized?.affectedServices?.length || normalized?.timeWindow
			? `\n\nNormalization context (use as hints, not overrides):
${normalized.severity ? `- Inferred severity: ${normalized.severity}` : ""}
${normalized.timeWindow ? `- Time window: ${normalized.timeWindow.from} to ${normalized.timeWindow.to}` : ""}
${normalized.affectedServices?.length ? `- Affected services: ${normalized.affectedServices.map((s) => s.name).join(", ")}` : ""}
${normalized.extractedMetrics?.length ? `- Metrics mentioned: ${normalized.extractedMetrics.map((m) => `${m.name}${m.value ? `=${m.value}` : ""}`).join(", ")}` : ""}`
			: "";

	const llm = createLlm("entityExtractor");
	const systemPrompt = `Extract incident entities from the query. Available datasources: ${DATA_SOURCE_IDS.join(", ")}.
Return JSON with: dataSources (array of {id, mentionedAs}), timeFrom, timeTo (ISO 8601), services (array), severity.
Map mentions like "logs" or "elasticsearch" to "elastic", "kafka" or "events" to "kafka", "couchbase" or "database" to "couchbase", "kong" or "api gateway" to "konnect", "gitlab" or "pipeline" or "merge request" or "CI/CD" or "commit" or "deploy" or "code change" to "gitlab", "jira" or "confluence" or "ticket" or "runbook" or "incident page" or "wiki" to "atlassian".
Always include "gitlab" alongside other datasources for complex incidents -- GitLab provides supplementary code and deployment correlation context.
If no specific datasource is mentioned, include all: ${DATA_SOURCE_IDS.join(", ")}.${attachmentContext ? `\n\n${attachmentContext}` : ""}${buildActionCatalog()}${normalizationHint}`;

	const response = await withRetry(
		() =>
			llm.invoke(
				[
					{ role: "system", content: systemPrompt },
					{ role: "human", content: query },
				],
				config,
			),
		{ maxRetries: 3, baseDelayMs: 1000, label: "entityExtractor:llm" },
	);

	const uiSelected = state.targetDataSources;
	const isFollowUp = state.isFollowUp;

	try {
		const text = String(response.content);
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = ExtractionSchema.parse(JSON.parse(jsonMatch[0]));
			const entities: ExtractedEntities = {
				dataSources: parsed.dataSources,
				toolActions: parsed.toolActions ?? undefined,
			};
			const extractedIds = parsed.dataSources.map((d) => d.id);

			// On follow-ups, if the LLM extracted a specific subset (not all datasources),
			// the user is narrowing their focus -- prefer extracted targets over UI selections.
			const extractedIsSubset = extractedIds.length > 0 && extractedIds.length < DATA_SOURCE_IDS.length;
			const effectiveTargets =
				isFollowUp && extractedIsSubset ? extractedIds : uiSelected.length > 0 ? uiSelected : extractedIds;

			logger.info(
				{ extractedDataSources: extractedIds, uiSelected, effectiveTargets, isFollowUp },
				"Entity extraction complete",
			);
			return {
				extractedEntities: entities,
				previousEntities: state.extractedEntities,
				targetDataSources: effectiveTargets,
			};
		}
	} catch (error) {
		logger.warn({ error }, "Entity extraction failed, falling back to all datasources");
	}

	const allDataSources = DATA_SOURCE_IDS.map((id) => ({ id, mentionedAs: "all" }));
	const effectiveTargets = uiSelected.length > 0 ? uiSelected : [...DATA_SOURCE_IDS];
	logger.info({ effectiveTargets, method: "fallback" }, "Using fallback datasource targets");
	return {
		extractedEntities: { dataSources: [...allDataSources] },
		previousEntities: state.extractedEntities,
		targetDataSources: effectiveTargets,
	};
}

// SIO-610: Build context hints for the extraction prompt when attachments are present
function buildAttachmentContext(meta: AttachmentMeta[]): string {
	if (meta.length === 0) return "";

	const hasImages = meta.some((a) => a.type === "image");
	const hasPdfs = meta.some((a) => a.type === "pdf");
	const hasText = meta.some((a) => a.type === "text");

	const parts: string[] = [];

	if (hasImages) {
		parts.push(
			"Images are attached. Examine screenshots for service names, error messages, timestamps, and anomaly patterns visible in dashboards or monitoring tools.",
		);
	}
	if (hasPdfs) {
		parts.push(
			"PDF documents are attached. Scan for runbook steps, architecture diagrams, SLO thresholds, and past incident reports.",
		);
	}
	if (hasText) {
		parts.push("Text documents are attached. Check for config files, log excerpts, and service definitions.");
	}

	return parts.join("\n");
}
