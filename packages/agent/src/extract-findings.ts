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

// SIO-785: how many raw consumer-group ids are in the tool outputs, used in the
// diagnostic log to compare against post-filter count. Counts unique ids across
// both kafka_list_consumer_groups (bare array or {groups:[...]} wrapped) and
// kafka_get_consumer_group_lag tool outputs.
function countRawConsumerGroups(toolOutputs: DataSourceResult["toolOutputs"]): {
	count: number;
	sampleIds: string[];
} {
	const ids = new Set<string>();
	for (const o of toolOutputs ?? []) {
		if (o.toolName === "kafka_list_consumer_groups") {
			const rows = Array.isArray(o.rawJson)
				? o.rawJson
				: typeof o.rawJson === "object" && o.rawJson && "groups" in o.rawJson && Array.isArray(o.rawJson.groups)
					? o.rawJson.groups
					: [];
			for (const r of rows) {
				if (typeof r === "object" && r && "id" in r && typeof r.id === "string") ids.add(r.id);
			}
		} else if (o.toolName === "kafka_get_consumer_group_lag") {
			if (
				typeof o.rawJson === "object" &&
				o.rawJson &&
				"groupId" in o.rawJson &&
				typeof o.rawJson.groupId === "string"
			) {
				ids.add(o.rawJson.groupId);
			}
		}
	}
	return { count: ids.size, sampleIds: Array.from(ids).slice(0, 3) };
}

export async function extractFindings(state: AgentStateType): Promise<Partial<AgentStateType>> {
	const focusServices = collectFocusServices(state);
	const extractors: Record<string, (r: DataSourceResult) => Partial<DataSourceResult>> = {
		kafka: (r) => {
			const kafkaFindings = extractKafkaFindings(r.toolOutputs ?? [], focusServices);
			// SIO-785 diagnostic: report focus + before/after counts so the live filter
			// behaviour is visible in dev-server logs without DevTools spelunking.
			// Grep: `KafkaFindingsCard` in pino output, or filter by `agent:extract-findings`.
			const raw = countRawConsumerGroups(r.toolOutputs);
			logger.info(
				{
					tag: "KafkaFindingsCard",
					focusServices,
					focusServicesCount: focusServices.length,
					rawConsumerGroups: raw.count,
					filteredConsumerGroups: kafkaFindings.consumerGroups?.length ?? 0,
					dlqTopics: kafkaFindings.dlqTopics?.length ?? 0,
					sampleRawIds: raw.sampleIds,
					filterMode: focusServices.length === 0 ? "show-all" : "scoped",
				},
				"kafka findings extracted",
			);
			return { kafkaFindings };
		},
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
