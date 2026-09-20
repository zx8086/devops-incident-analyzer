// agent/src/extract-findings.ts
import { getLogger } from "@devops-agent/observability";
import type { AtlassianFindings, AtlassianLinkedIssue, DataSourceResult } from "@devops-agent/shared";
import { createDecisionMetricsRecorder, rankCorrelation, resolveDecisionMetricsDbPath } from "@devops-agent/shared";
import { buildApplicationTopology, mergeApplicationTopologyOverlay } from "./application-topology.ts";
import {
	buildIncidentQuery,
	isAtlassianRerankEnabled,
	rerankLinkedIssues,
	resolveTypeSafeApiKey,
} from "./atlassian-rerank.ts";
import { extractAtlassianFindings } from "./correlation/extractors/atlassian.ts";
import { extractAwsFindings } from "./correlation/extractors/aws.ts";
import { collectCouchbaseKeyspaces, extractCouchbaseFindings } from "./correlation/extractors/couchbase.ts";
import { extractElasticFindings } from "./correlation/extractors/elastic.ts";
import { extractGitLabFindings } from "./correlation/extractors/gitlab.ts";
import { extractKafkaFindings } from "./correlation/extractors/kafka.ts";
import { extractOrbitFindings } from "./correlation/extractors/orbit.ts";
import { buildMlAnomalyExplainer } from "./ml-anomaly-explainer.ts";
import { buildNetworkTopology } from "./network-topology.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:extract-findings");

// SIO-1245: the merged tool-output list an extractor runs over (one dataSourceId's rows
// concatenated). Derived from DataSourceResult so it cannot drift from the schema.
type ToolOutputs = NonNullable<DataSourceResult["toolOutputs"]>;

// SIO-1030: emit a per-domain diagnostic mirroring the KafkaFindingsCard block so
// the live scoping behaviour is visible in dev-server logs (grep the `tag`, or
// filter by `agent:extract-findings`). `droppedAll` is the tell that focusServices
// (unnormalized user/LLM strings) matched nothing and the card was over-scoped —
// warn on it so an accidentally-empty card is not silently shipped.
// SIO-1643: `droppedAllLevel` lets a card-less tag (Orbit) report an all-dropped set
// at info -- every Orbit rule re-checks matchesFocus itself, so an off-focus turn
// dropping every Orbit row is expected, not an over-scoped card.
function logCard(
	tag: string,
	focusServices: string[],
	rawCount: number,
	filteredCount: number,
	extra: Record<string, unknown> = {},
	// otherRows: rows the card renders that rawCount/filteredCount do not measure. SIO-1815:
	// the Kafka counts are consumer groups only, so a card showing 5 DLQ topics was logged
	// at warn as "scoped to empty" on the 2026-09-18 run -- a false alarm in a log whose
	// whole job is to flag a blank card.
	opts: { droppedAllLevel?: "warn" | "info"; otherRows?: number } = {},
): void {
	const filterMode = focusServices.length === 0 ? "show-all" : "scoped";
	const droppedAll = filterMode === "scoped" && rawCount > 0 && filteredCount === 0 && (opts.otherRows ?? 0) === 0;
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
		if (opts.droppedAllLevel === "info") {
			logger.info(payload, "findings scoped to empty (rule-only tag, no card)");
		} else {
			logger.warn(payload, "findings card scoped to empty");
		}
	} else {
		logger.info(payload, "findings extracted");
	}
}

// SIO-785: union of service names from the investigation context. Used by every
// extractor (SIO-1030) to filter findings to those related to what the user is
// investigating. Empty union = show-all (first-turn / unfocused investigations).
export function collectFocusServices(
	state: Pick<AgentStateType, "investigationFocus" | "normalizedIncident">,
): string[] {
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

// SIO-1837: the rerank lane for the Atlassian card. Returns the new findings, or
// undefined to mean "keep what the deterministic path produced". Every exit that
// is not a successful rerank returns undefined, so the card can only ever be the
// arithmetic's answer or a strictly-judged reordering of it.
async function rerankAtlassianCard(
	state: AgentStateType,
	focusServices: string[],
	atlassianOutputs: ToolOutputs,
	deterministic: AtlassianFindings,
): Promise<AtlassianFindings | undefined> {
	// EVERY gate is checked BEFORE the weak-hit-inclusive extraction. Greptile
	// PR #869 caught the inverted order: widening first and then returning that
	// wider set on a skip put single-keyword tickets on the card precisely when
	// the rerank was NOT running to judge them -- the opposite of the safety
	// property this function exists to hold. Reproduced before fixing, with a
	// weak hit appearing on a focused run with the flag off.
	const apiKey = resolveTypeSafeApiKey();
	if (!isAtlassianRerankEnabled() || !apiKey) {
		return { ...deterministic, rerank: "skipped" };
	}
	const incidentQuery = buildIncidentQuery(state, focusServices);
	if (incidentQuery.length === 0) {
		// No report text yet (a first turn that produced no answer): there is nothing
		// to judge relevance AGAINST, and scoring against an empty query would rank
		// by the ticket's own text alone.
		return { ...deterministic, rerank: "skipped" };
	}

	// Only now widen. Weak hits are what the judge exists to separate, and they
	// can only reach the card through an "applied" outcome below.
	const base = findingsForRerank(atlassianOutputs, focusServices);
	if (!base) return undefined;
	const { findings, issues } = base;

	const outcome = await rerankLinkedIssues(issues, incidentQuery, { apiKey });
	recordRerankDecision(state, issues.length, outcome);
	// A failure falls back to the DETERMINISTIC set, not the widened one.
	if (!outcome) return { ...deterministic, rerank: "failed" };

	logCard("AtlassianFindingsCard", focusServices, issues.length, outcome.issues.length, {
		rerank: "applied",
		rerankDropped: outcome.dropped,
		latencyMs: outcome.latencyMs,
		topScore: outcome.issues[0]?.relevance,
		bottomScore: outcome.issues[outcome.issues.length - 1]?.relevance,
	});
	return {
		...findings,
		linkedIssues: outcome.issues,
		rerank: "applied",
		rerankDropped: outcome.dropped,
	};
}

// Re-extract with weak hits kept, because those are the tickets the rerank exists
// to judge. Returns undefined when there is nothing to rank, so the caller leaves
// the card alone rather than stamping a verdict on an empty list.
function findingsForRerank(
	atlassianOutputs: ToolOutputs,
	focusServices: string[],
): { findings: AtlassianFindings; issues: AtlassianLinkedIssue[] } | undefined {
	const findings = extractAtlassianFindings(atlassianOutputs, focusServices, { keepWeakHits: true });
	const issues = findings.linkedIssues ?? [];
	return issues.length > 0 ? { findings, issues } : undefined;
}

// Best-effort, and deliberately not awaited into the turn's critical path beyond
// the write itself: a metrics failure must never cost a card. The recorder is
// opened per call because extractFindings is a graph node, not a long-lived
// service, and DECISION_METRICS_DB_PATH is usually unset (then this is a no-op).
function recordRerankDecision(
	state: AgentStateType,
	itemsIn: number,
	outcome: Awaited<ReturnType<typeof rerankLinkedIssues>>,
): void {
	const dbPath = resolveDecisionMetricsDbPath();
	if (!dbPath) return;
	void createDecisionMetricsRecorder({ dbPath, logger: { warn: (m, meta) => logger.warn(meta ?? {}, m) } })
		.then((recorder) => {
			if (!recorder) return;
			recorder.record({
				seam: "atlassian-rerank",
				outcome: outcome ? "applied" : "failed",
				requestId: state.requestId,
				model: outcome?.model,
				latencyMs: outcome?.latencyMs,
				inputTokens: outcome?.inputTokens,
				itemsIn,
				itemsDropped: outcome?.dropped,
				topScore: outcome?.issues[0]?.relevance,
				bottomScore: outcome?.issues[outcome.issues.length - 1]?.relevance,
				rankCorrelation: outcome ? rankCorrelation(outcome.deterministicRanks, outcome.jevRanks) : undefined,
			});
			recorder.close();
		})
		.catch(() => {
			// createDecisionMetricsRecorder already warns on a failed open; a rejected
			// promise here must not surface as an unhandled rejection.
		});
}

export async function extractFindings(state: AgentStateType): Promise<Partial<AgentStateType>> {
	const focusServices = collectFocusServices(state);
	// SIO-1138: statements name keyspaces, not services -- give the couchbase
	// extractor the resolved scope/collection names (SIO-1084) so it can keep
	// statements touching a keyspace whose name matches the focus.
	const couchbaseKeyspaces = collectCouchbaseKeyspaces(state.resolvedIdentifiers);
	// SIO-1030: every extractor now takes focusServices and strict-drops off-focus
	// rows. rawCount is measured by re-running the (pure, cheap) extractor with empty
	// focus (show-all) so the diagnostic reports true before/after without reaching
	// into extractor internals.
	// SIO-1245: extractors now receive the MERGED toolOutputs for a dataSourceId, not one
	// row's. The AWS estate fan-out (SIO-828) and the elastic deployment fan-out produce
	// several DataSourceResult rows sharing one dataSourceId, and extracting per row made
	// each estate scope independently -- eu-oit-prd scoped 25 -> 3 while eu-shared-services-prd
	// scoped 35 -> 0 and engaged its OWN unscoped fallback to 5. Both then raced for a single
	// card slot (the UI reducer keys dataSourceFindings by bare dataSourceId), so the fallback
	// silently replaced the good scoped set. Merging first makes the fallback a cross-row
	// decision by construction: the extractor sees every estate's outputs in one pass, so its
	// existing "scoped hits win" early-return already means "if ANY estate scoped, never fall
	// back". No separate suppression rule is needed.
	const extractors: Record<string, (outs: ToolOutputs) => Partial<DataSourceResult>> = {
		kafka: (outs) => {
			const kafkaFindings = extractKafkaFindings(outs, focusServices);
			// SIO-785 diagnostic: report focus + before/after counts so the live filter
			// behaviour is visible in dev-server logs without DevTools spelunking.
			// Grep: `KafkaFindingsCard` in pino output, or filter by `agent:extract-findings`.
			const raw = countRawConsumerGroups(outs);
			if (kafkaFindings.unscoped) {
				// SIO-1644: fallback engaged -- the card is populated but the rows are
				// not focus-linked. Distinct info line instead of the droppedAll warn
				// (mirrors the SIO-1138 couchbase / SIO-1159 aws / SIO-1643 elastic branches).
				logger.info(
					{
						tag: "KafkaFindingsCard",
						focusServices,
						rawCount: raw.count,
						fallbackCount: kafkaFindings.consumerGroups?.length ?? 0,
						fallbackDlqTopics: kafkaFindings.dlqTopics?.length ?? 0,
						filterMode: "unscoped-fallback",
					},
					"findings card fell back to unscoped top-N",
				);
			} else {
				logCard(
					"KafkaFindingsCard",
					focusServices,
					raw.count,
					kafkaFindings.consumerGroups?.length ?? 0,
					{ dlqTopics: kafkaFindings.dlqTopics?.length ?? 0, sampleRawIds: raw.sampleIds },
					{ otherRows: kafkaFindings.dlqTopics?.length ?? 0 },
				);
			}
			return { kafkaFindings };
		},
		gitlab: (outs) => {
			const gitlabFindings = extractGitLabFindings(outs, focusServices);
			const rawCount = extractGitLabFindings(outs).mergedRequests?.length ?? 0;
			if (gitlabFindings.unscoped) {
				// SIO-1644: fallback engaged -- the card is populated but the rows are
				// not focus-linked. Distinct info line instead of the droppedAll warn.
				logger.info(
					{
						tag: "GitLabFindingsCard",
						focusServices,
						rawCount,
						fallbackCount: gitlabFindings.mergedRequests?.length ?? 0,
						filterMode: "unscoped-fallback",
					},
					"findings card fell back to unscoped top-N",
				);
			} else {
				logCard("GitLabFindingsCard", focusServices, rawCount, gitlabFindings.mergedRequests?.length ?? 0);
			}
			// SIO-1076: Orbit cross-project findings ride the same gitlab result.
			// Pure and free -- parses outputs a sub-agent turn already produced.
			const orbitFindings = extractOrbitFindings(outs, focusServices);
			const orbitRaw = extractOrbitFindings(outs);
			const orbitFilteredCount =
				(orbitFindings.blastRadius?.length ?? 0) +
				(orbitFindings.recentDeploys?.length ?? 0) +
				(orbitFindings.pipelineFailures?.length ?? 0) +
				(orbitFindings.vulnerabilities?.length ?? 0);
			const orbitRawCount =
				(orbitRaw.blastRadius?.length ?? 0) +
				(orbitRaw.recentDeploys?.length ?? 0) +
				(orbitRaw.pipelineFailures?.length ?? 0) +
				(orbitRaw.vulnerabilities?.length ?? 0);
			if (orbitRawCount > 0) {
				// SIO-1643: Orbit has no findings card (rules.ts is its only reader) and
				// every Orbit rule re-checks matchesFocus, so droppedAll is info here.
				logCard(
					"OrbitFindingsCard",
					focusServices,
					orbitRawCount,
					orbitFilteredCount,
					{
						blastRadius: orbitFindings.blastRadius?.length ?? 0,
						recentDeploys: orbitFindings.recentDeploys?.length ?? 0,
						pipelineFailures: orbitFindings.pipelineFailures?.length ?? 0,
						vulnerabilities: orbitFindings.vulnerabilities?.length ?? 0,
					},
					{ droppedAllLevel: "info" },
				);
			}
			return orbitFilteredCount > 0 ? { gitlabFindings, orbitFindings } : { gitlabFindings };
		},
		couchbase: (outs) => {
			const couchbaseFindings = extractCouchbaseFindings(outs, focusServices, couchbaseKeyspaces);
			const rawCount = extractCouchbaseFindings(outs).slowQueries?.length ?? 0;
			if (couchbaseFindings.unscoped) {
				// SIO-1138: fallback engaged -- the card is populated but the rows are
				// not focus-linked. Distinct info line instead of the droppedAll warn.
				logger.info(
					{
						tag: "CouchbaseFindingsCard",
						focusServices,
						rawCount,
						fallbackCount: couchbaseFindings.slowQueries?.length ?? 0,
						resolvedKeyspaceCount: couchbaseKeyspaces.length,
						filterMode: "unscoped-fallback",
					},
					"findings card fell back to unscoped top-N",
				);
			} else {
				logCard("CouchbaseFindingsCard", focusServices, rawCount, couchbaseFindings.slowQueries?.length ?? 0);
			}
			return { couchbaseFindings };
		},
		elastic: (outs) => {
			const elasticFindings = extractElasticFindings(outs, focusServices);
			const raw = extractElasticFindings(outs);
			const rawCount =
				(raw.apmServices?.length ?? 0) + (raw.logClusters?.length ?? 0) + (raw.syntheticMonitors?.length ?? 0);
			const filteredCount =
				(elasticFindings.apmServices?.length ?? 0) +
				(elasticFindings.logClusters?.length ?? 0) +
				(elasticFindings.syntheticMonitors?.length ?? 0);
			if (elasticFindings.unscoped) {
				// SIO-1643: fallback engaged -- the card is populated but the rows are
				// not focus-linked. Distinct info line instead of the droppedAll warn
				// (mirrors the SIO-1138 couchbase / SIO-1159 aws branches).
				logger.info(
					{
						tag: "ElasticFindingsCard",
						focusServices,
						rawCount,
						fallbackCount: filteredCount,
						filterMode: "unscoped-fallback",
					},
					"findings card fell back to unscoped top-N",
				);
			} else {
				logCard("ElasticFindingsCard", focusServices, rawCount, filteredCount, {
					apmServices: elasticFindings.apmServices?.length ?? 0,
					logClusters: elasticFindings.logClusters?.length ?? 0,
					syntheticMonitors: elasticFindings.syntheticMonitors?.length ?? 0,
				});
			}
			return { elasticFindings };
		},
		// SIO-785 Phase 2 (2026-05-18): AWS CloudWatch alarms.
		aws: (outs) => {
			const awsFindings = extractAwsFindings(outs, focusServices);
			const rawCount = extractAwsFindings(outs).alarms?.length ?? 0;
			if (awsFindings.unscoped) {
				// SIO-1159: fallback engaged -- the card is populated but the rows are
				// not focus-linked. Distinct info line instead of the droppedAll warn
				// (mirrors the SIO-1138 couchbase branch above).
				logger.info(
					{
						tag: "AWSFindingsCard",
						focusServices,
						rawCount,
						fallbackCount: awsFindings.alarms?.length ?? 0,
						filterMode: "unscoped-fallback",
					},
					"findings card fell back to unscoped top-N",
				);
			} else {
				logCard("AWSFindingsCard", focusServices, rawCount, awsFindings.alarms?.length ?? 0);
			}
			return { awsFindings };
		},
		// SIO-785 Phase 2 (2026-05-18): Atlassian linked incidents.
		atlassian: (outs) => {
			const atlassianFindings = extractAtlassianFindings(outs, focusServices);
			const rawCount = extractAtlassianFindings(outs).linkedIssues?.length ?? 0;
			logCard("AtlassianFindingsCard", focusServices, rawCount, atlassianFindings.linkedIssues?.length ?? 0);
			return { atlassianFindings };
		},
	};
	// SIO-1245: group first, extract ONCE per dataSourceId over the union of its rows'
	// toolOutputs, then give every row in the group the SAME merged findings object. That
	// last part matters as much as the merge: the UI reducer keys findings by bare
	// dataSourceId (last row wins) while rules.ts/engine.ts select by dataSourceId too, so
	// identical objects are what makes the card and the rule engine agree on a multi-estate
	// turn instead of reading different estates.
	const outputsByDataSource = new Map<string, ToolOutputs>();
	const malformedDataSources = new Set<string>();
	for (const r of state.dataSourceResults) {
		const outs = r.toolOutputs;
		const existing = outputsByDataSource.get(r.dataSourceId);
		// A non-array toolOutputs is malformed. Remember it (so the extractor still throws
		// inside the per-datasource try/catch below -- the documented soft-fail contract)
		// but NEVER let it displace or block a sibling row's real data: a malformed estate
		// A arriving before a healthy estate B must not cost B its findings. Spreading here
		// would also throw outside the guard and sink the whole node.
		if (!Array.isArray(outs)) {
			if (outs != null) malformedDataSources.add(r.dataSourceId);
			continue;
		}
		if (Array.isArray(existing)) existing.push(...outs);
		else outputsByDataSource.set(r.dataSourceId, [...outs]);
	}
	for (const dataSourceId of malformedDataSources) {
		logger.warn(
			{ dataSourceId, hasUsableRows: outputsByDataSource.has(dataSourceId) },
			"ignored a row with malformed toolOutputs while merging",
		);
	}
	const deploymentsByDataSource = new Map<string, string[]>();
	for (const r of state.dataSourceResults) {
		if (!r.deploymentId) continue;
		const ids = deploymentsByDataSource.get(r.dataSourceId) ?? [];
		if (!ids.includes(r.deploymentId)) ids.push(r.deploymentId);
		deploymentsByDataSource.set(r.dataSourceId, ids);
	}

	const findingsByDataSource = new Map<string, Partial<DataSourceResult>>();
	for (const [dataSourceId, outs] of outputsByDataSource) {
		const extractor = extractors[dataSourceId];
		if (!extractor) continue;
		// One line per dataSourceId naming the rows that were merged, so a multi-estate turn
		// is legible in the log. Previously each estate emitted its own card line and the
		// pair read as one card contradicting itself (scoped 25->3, then unscoped 35->5).
		const deployments = deploymentsByDataSource.get(dataSourceId) ?? [];
		if (deployments.length > 1) {
			logger.info(
				{ dataSourceId, deployments, mergedRows: deployments.length, toolOutputs: outs.length },
				"merged multi-deployment tool outputs before extraction",
			);
		}
		try {
			findingsByDataSource.set(dataSourceId, extractor(outs));
		} catch (err) {
			logger.warn({ dataSourceId, error: err instanceof Error ? err.message : String(err) }, "extractFindings failed");
		}
	}
	// SIO-1837: order the Atlassian card by what the incident is about. Runs here,
	// after the merge, because the rerank needs the whole turn's linked issues and
	// this is the first point they exist as one list. Everything it can go wrong
	// with -- flag off, no key, no incident text, a Jev error, a timeout -- leaves
	// `findingsByDataSource` exactly as the deterministic path built it.
	const atlassianOutputs = outputsByDataSource.get("atlassian");
	const deterministicAtlassian = findingsByDataSource.get("atlassian")?.atlassianFindings;
	if (atlassianOutputs && deterministicAtlassian) {
		const reranked = await rerankAtlassianCard(state, focusServices, atlassianOutputs, deterministicAtlassian);
		if (reranked) findingsByDataSource.set("atlassian", { atlassianFindings: reranked });
	}

	const dataSourceResults = state.dataSourceResults.map((r) => {
		const findings = findingsByDataSource.get(r.dataSourceId);
		return findings ? { ...r, ...findings } : r;
	});
	// SIO-1204: per-turn network map. Pure and total (safeParse everywhere), but
	// guarded anyway so a builder bug can never sink the findings extraction. The
	// networkTopology key is ALWAYS returned (undefined included) so the replace
	// reducer clears a stale prior-turn map on turns with no network data.
	let networkTopology: ReturnType<typeof buildNetworkTopology>;
	try {
		networkTopology = buildNetworkTopology(dataSourceResults, focusServices, state.messages.length);
		if (networkTopology) {
			logCard("NetworkTopologyCard", focusServices, networkTopology.nodes.length, networkTopology.nodes.length, {
				edges: networkTopology.edges.length,
				sources: networkTopology.sources,
				truncated: networkTopology.truncated ?? false,
			});
		}
	} catch (err) {
		logger.warn({ error: err instanceof Error ? err.message : String(err) }, "buildNetworkTopology failed");
	}

	// SIO-1457: per-turn application map. Same guarded/always-returned-key contract
	// as networkTopology above. The KG prior-knowledge overlay was read earlier
	// this turn by graphEnrich (which runs before the fan-out); merging it here
	// keeps the builder itself pure/sync. Overlay-only turns still render.
	let applicationTopology: ReturnType<typeof buildApplicationTopology>;
	try {
		const built = buildApplicationTopology(dataSourceResults, focusServices, state.messages.length);
		applicationTopology = mergeApplicationTopologyOverlay(
			built,
			state.applicationTopologyOverlay ?? [],
			state.messages.length,
		);
		if (applicationTopology) {
			logCard(
				"ApplicationTopologyCard",
				focusServices,
				applicationTopology.nodes.length,
				applicationTopology.nodes.length,
				{
					edges: applicationTopology.edges.length,
					sources: applicationTopology.sources,
					truncated: applicationTopology.truncated ?? false,
				},
			);
		}
	} catch (err) {
		logger.warn({ error: err instanceof Error ? err.message : String(err) }, "buildApplicationTopology failed");
	}

	// SIO-1215: per-turn ML anomaly explainer. Same guarded/always-returned-key
	// contract as networkTopology above -- a turn with no anomaly-record query
	// clears a stale prior-turn card via the replace reducer.
	let mlAnomalyExplainer: ReturnType<typeof buildMlAnomalyExplainer>;
	try {
		mlAnomalyExplainer = buildMlAnomalyExplainer(dataSourceResults, state.messages.length);
		if (mlAnomalyExplainer) {
			logCard(
				"MlAnomalyExplainerCard",
				focusServices,
				mlAnomalyExplainer.records.length,
				mlAnomalyExplainer.records.length,
				{
					mode: mlAnomalyExplainer.mode,
					jobsSummary: mlAnomalyExplainer.jobsSummary,
					truncated: mlAnomalyExplainer.truncated ?? false,
				},
			);
		}
	} catch (err) {
		logger.warn({ error: err instanceof Error ? err.message : String(err) }, "buildMlAnomalyExplainer failed");
	}

	return { dataSourceResults, networkTopology, applicationTopology, mlAnomalyExplainer };
}
