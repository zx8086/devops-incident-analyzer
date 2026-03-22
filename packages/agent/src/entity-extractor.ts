// agent/src/entity-extractor.ts

import type { ExtractedEntities } from "@devops-agent/shared";
import { DATA_SOURCE_IDS } from "@devops-agent/shared";
import { z } from "zod";
import { createLlm } from "./llm.ts";
import type { AgentStateType } from "./state.ts";

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
		return { extractedEntities: { dataSources: [] }, targetDataSources: [...DATA_SOURCE_IDS] };
	}
	const query = typeof lastMessage.content === "string" ? lastMessage.content : String(lastMessage.content);

	const llm = createLlm("entityExtractor");
	const response = await llm.invoke([
		{
			role: "system",
			content: `Extract incident entities from the query. Available datasources: ${DATA_SOURCE_IDS.join(", ")}.
Return JSON with: dataSources (array of {id, mentionedAs}), timeFrom, timeTo (ISO 8601), services (array), severity.
Map mentions like "logs" or "elasticsearch" to "elastic", "kafka" or "events" to "kafka", "couchbase" or "database" to "couchbase", "kong" or "api gateway" to "konnect".
If no specific datasource is mentioned, include all: elastic, kafka, couchbase, konnect.`,
		},
		{ role: "human", content: query },
	]);

	try {
		const text = String(response.content);
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = ExtractionSchema.parse(JSON.parse(jsonMatch[0]));
			const entities: ExtractedEntities = { dataSources: parsed.dataSources };
			return {
				extractedEntities: entities,
				previousEntities: state.extractedEntities,
				targetDataSources: parsed.dataSources.map((d) => d.id),
			};
		}
	} catch {
		// Fallback: query all datasources
	}

	const allDataSources = DATA_SOURCE_IDS.map((id) => ({ id, mentionedAs: "all" }));
	return {
		extractedEntities: { dataSources: [...allDataSources] },
		previousEntities: state.extractedEntities,
		targetDataSources: [...DATA_SOURCE_IDS],
	};
}
