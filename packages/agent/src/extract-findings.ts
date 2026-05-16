// agent/src/extract-findings.ts
import { getLogger } from "@devops-agent/observability";
import type { DataSourceResult } from "@devops-agent/shared";
import { extractKafkaFindings } from "./correlation/extractors/kafka.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:extract-findings");

const EXTRACTORS: Record<string, (r: DataSourceResult) => Partial<DataSourceResult>> = {
	kafka: (r) => ({ kafkaFindings: extractKafkaFindings(r.toolOutputs ?? []) }),
};

export async function extractFindings(state: AgentStateType): Promise<Partial<AgentStateType>> {
	const dataSourceResults = state.dataSourceResults.map((r) => {
		const extractor = EXTRACTORS[r.dataSourceId];
		if (!extractor) return r;
		try {
			return { ...r, ...extractor(r) };
		} catch (err) {
			logger.warn(
				{ dataSourceId: r.dataSourceId, error: err instanceof Error ? err.message : String(err) },
				"extractFindings failed",
			);
			return r;
		}
	});
	return { dataSourceResults };
}
