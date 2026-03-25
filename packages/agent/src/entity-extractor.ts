// agent/src/entity-extractor.ts

import { getLogger } from "@devops-agent/observability";
import type { AttachmentMeta, ExtractedEntities } from "@devops-agent/shared";
import { DATA_SOURCE_IDS } from "@devops-agent/shared";
import { z } from "zod";
import { createLlm } from "./llm.ts";
import { extractTextFromContent } from "./message-utils.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:entity-extractor");

const ExtractionSchema = z.object({
	dataSources: z.array(
		z.object({
			id: z.string(),
			mentionedAs: z.string(),
		}),
	),
	timeFrom: z.string().optional(),
	timeTo: z.string().optional(),
	services: z.array(z.string()).optional(),
	severity: z.enum(["critical", "high", "medium", "low"]).optional(),
});

export async function extractEntities(state: AgentStateType): Promise<Partial<AgentStateType>> {
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

	const llm = createLlm("entityExtractor");
	const systemPrompt = `Extract incident entities from the query. Available datasources: ${DATA_SOURCE_IDS.join(", ")}.
Return JSON with: dataSources (array of {id, mentionedAs}), timeFrom, timeTo (ISO 8601), services (array), severity.
Map mentions like "logs" or "elasticsearch" to "elastic", "kafka" or "events" to "kafka", "couchbase" or "database" to "couchbase", "kong" or "api gateway" to "konnect".
If no specific datasource is mentioned, include all: elastic, kafka, couchbase, konnect.${attachmentContext ? `\n\n${attachmentContext}` : ""}`;

	const response = await llm.invoke([
		{ role: "system", content: systemPrompt },
		{ role: "human", content: query },
	]);

	const uiSelected = state.targetDataSources;
	const isFollowUp = state.isFollowUp;

	try {
		const text = String(response.content);
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = ExtractionSchema.parse(JSON.parse(jsonMatch[0]));
			const entities: ExtractedEntities = { dataSources: parsed.dataSources };
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
