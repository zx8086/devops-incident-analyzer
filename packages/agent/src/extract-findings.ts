// agent/src/extract-findings.ts
import { getLogger } from "@devops-agent/observability";
import type { DataSourceResult } from "@devops-agent/shared";
import { extractCouchbaseFindings } from "./correlation/extractors/couchbase.ts";
import { extractGitLabFindings } from "./correlation/extractors/gitlab.ts";
import { extractKafkaFindings } from "./correlation/extractors/kafka.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:extract-findings");

// SIO-785: union of service names from the investigation context. Used by the
// kafka extractor to filter consumer groups + DLQ topics to those related to
// what the user is investigating. Other extractors may adopt this in follow-ups.
function collectFocusServices(state: AgentStateType): string[] {
	const set = new Set<string>();
	for (const s of state.investigationFocus?.services ?? []) {
		if (s) set.add(s);
	}
	for (const s of state.normalizedIncident?.affectedServices ?? []) {
		if (s?.name) set.add(s.name);
	}
	return Array.from(set);
}

export async function extractFindings(state: AgentStateType): Promise<Partial<AgentStateType>> {
	const focusServices = collectFocusServices(state);
	const extractors: Record<string, (r: DataSourceResult) => Partial<DataSourceResult>> = {
		kafka: (r) => ({ kafkaFindings: extractKafkaFindings(r.toolOutputs ?? [], focusServices) }),
		gitlab: (r) => ({ gitlabFindings: extractGitLabFindings(r.toolOutputs ?? []) }),
		couchbase: (r) => ({ couchbaseFindings: extractCouchbaseFindings(r.toolOutputs ?? []) }),
	};
	const dataSourceResults = state.dataSourceResults.map((r) => {
		const extractor = extractors[r.dataSourceId];
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
