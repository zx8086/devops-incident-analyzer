// agent/src/extract-findings.ts
import { getLogger } from "@devops-agent/observability";
import type { DataSourceResult } from "@devops-agent/shared";
import { extractAtlassianFindings } from "./correlation/extractors/atlassian.ts";
import { extractAwsFindings } from "./correlation/extractors/aws.ts";
import { extractCouchbaseFindings } from "./correlation/extractors/couchbase.ts";
import { extractElasticFindings } from "./correlation/extractors/elastic.ts";
import { extractGitLabFindings } from "./correlation/extractors/gitlab.ts";
import { extractKafkaFindings } from "./correlation/extractors/kafka.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:extract-findings");

// SIO-1030: emit a per-domain diagnostic mirroring the KafkaFindingsCard block so
// the live scoping behaviour is visible in dev-server logs (grep the `tag`, or
// filter by `agent:extract-findings`). `droppedAll` is the tell that focusServices
// (unnormalized user/LLM strings) matched nothing and the card was over-scoped —
// warn on it so an accidentally-empty card is not silently shipped.
function logCard(
	tag: string,
	focusServices: string[],
	rawCount: number,
	filteredCount: number,
	extra: Record<string, unknown> = {},
): void {
	const filterMode = focusServices.length === 0 ? "show-all" : "scoped";
	const droppedAll = filterMode === "scoped" && rawCount > 0 && filteredCount === 0;
	const payload = {
		tag,
		focusServices,
		focusServicesCount: focusServices.length,
		rawCount,
		filteredCount,
		filterMode,
		droppedAll,
		...extra,
	};
	if (droppedAll) {
		logger.warn(payload, "findings card scoped to empty");
	} else {
		logger.info(payload, "findings extracted");
	}
}

// SIO-785: union of service names from the investigation context. Used by every
// extractor (SIO-1030) to filter findings to those related to what the user is
// investigating. Empty union = show-all (first-turn / unfocused investigations).
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
	// SIO-1030: every extractor now takes focusServices and strict-drops off-focus
	// rows. rawCount is measured by re-running the (pure, cheap) extractor with empty
	// focus (show-all) so the diagnostic reports true before/after without reaching
	// into extractor internals.
	const extractors: Record<string, (r: DataSourceResult) => Partial<DataSourceResult>> = {
		kafka: (r) => {
			const outs = r.toolOutputs ?? [];
			const kafkaFindings = extractKafkaFindings(outs, focusServices);
			// SIO-785 diagnostic: report focus + before/after counts so the live filter
			// behaviour is visible in dev-server logs without DevTools spelunking.
			// Grep: `KafkaFindingsCard` in pino output, or filter by `agent:extract-findings`.
			const raw = countRawConsumerGroups(r.toolOutputs);
			logCard("KafkaFindingsCard", focusServices, raw.count, kafkaFindings.consumerGroups?.length ?? 0, {
				dlqTopics: kafkaFindings.dlqTopics?.length ?? 0,
				sampleRawIds: raw.sampleIds,
			});
			return { kafkaFindings };
		},
		gitlab: (r) => {
			const outs = r.toolOutputs ?? [];
			const gitlabFindings = extractGitLabFindings(outs, focusServices);
			const rawCount = extractGitLabFindings(outs).mergedRequests?.length ?? 0;
			logCard("GitLabFindingsCard", focusServices, rawCount, gitlabFindings.mergedRequests?.length ?? 0);
			return { gitlabFindings };
		},
		couchbase: (r) => {
			const outs = r.toolOutputs ?? [];
			const couchbaseFindings = extractCouchbaseFindings(outs, focusServices);
			const rawCount = extractCouchbaseFindings(outs).slowQueries?.length ?? 0;
			logCard("CouchbaseFindingsCard", focusServices, rawCount, couchbaseFindings.slowQueries?.length ?? 0);
			return { couchbaseFindings };
		},
		elastic: (r) => {
			const outs = r.toolOutputs ?? [];
			const elasticFindings = extractElasticFindings(outs, focusServices);
			const raw = extractElasticFindings(outs);
			const rawCount =
				(raw.apmServices?.length ?? 0) + (raw.logClusters?.length ?? 0) + (raw.syntheticMonitors?.length ?? 0);
			const filteredCount =
				(elasticFindings.apmServices?.length ?? 0) +
				(elasticFindings.logClusters?.length ?? 0) +
				(elasticFindings.syntheticMonitors?.length ?? 0);
			logCard("ElasticFindingsCard", focusServices, rawCount, filteredCount, {
				apmServices: elasticFindings.apmServices?.length ?? 0,
				logClusters: elasticFindings.logClusters?.length ?? 0,
				syntheticMonitors: elasticFindings.syntheticMonitors?.length ?? 0,
			});
			return { elasticFindings };
		},
		// SIO-785 Phase 2 (2026-05-18): AWS CloudWatch alarms.
		aws: (r) => {
			const outs = r.toolOutputs ?? [];
			const awsFindings = extractAwsFindings(outs, focusServices);
			const rawCount = extractAwsFindings(outs).alarms?.length ?? 0;
			logCard("AWSFindingsCard", focusServices, rawCount, awsFindings.alarms?.length ?? 0);
			return { awsFindings };
		},
		// SIO-785 Phase 2 (2026-05-18): Atlassian linked incidents.
		atlassian: (r) => {
			const outs = r.toolOutputs ?? [];
			const atlassianFindings = extractAtlassianFindings(outs, focusServices);
			const rawCount = extractAtlassianFindings(outs).linkedIssues?.length ?? 0;
			logCard("AtlassianFindingsCard", focusServices, rawCount, atlassianFindings.linkedIssues?.length ?? 0);
			return { atlassianFindings };
		},
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
