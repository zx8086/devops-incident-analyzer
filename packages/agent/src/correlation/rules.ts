// agent/src/correlation/rules.ts
import type { AgentName, AgentStateType } from "../state";

export interface CorrelationRule {
	name: string;
	description: string;
	trigger: (state: AgentStateType) => TriggerMatch | null;
	requiredAgent: AgentName;
	retry: { attempts: number; timeoutMs: number };
	// SIO-712: When true, skip the alreadyCovered idempotency check and always
	// mark a triggered rule as needs-invocation. Used for rules like
	// gitlab-deploy-vs-datastore-runtime where the trigger itself is the signal
	// (a contradiction within already-collected data) -- there's nothing to
	// re-fan-out to, the cap is the entire purpose.
	skipCoverageCheck?: boolean;
}

export interface TriggerMatch {
	context: Record<string, unknown>;
}

function getKafkaData(state: AgentStateType): {
	consumerGroups?: Array<{ id: string; state: string; totalLag?: number }>;
	dlqTopics?: Array<{ name: string; totalMessages: number; recentDelta: number | null }>;
	toolErrors?: Array<{ tool: string; code: string }>;
} {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "kafka");
	if (!result || result.status !== "success" || !result.data || typeof result.data !== "object") {
		return {};
	}
	return result.data as never;
}

export const correlationRules: CorrelationRule[] = [
	{
		name: "kafka-empty-or-dead-groups",
		description:
			"Kafka consumer groups in Empty/Dead state imply the consuming app may have exceptions; correlate with app logs.",
		trigger: (state) => {
			const groups = getKafkaData(state).consumerGroups ?? [];
			const matched = groups.filter((g) => g.state === "Empty" || g.state === "Dead");
			return matched.length === 0 ? null : { context: { groupIds: matched.map((g) => g.id) } };
		},
		requiredAgent: "elastic-agent",
		retry: { attempts: 3, timeoutMs: 30_000 },
	},
	{
		name: "kafka-significant-lag",
		description: "Stable consumer group with lag > 10K messages; app-level slowness or downstream errors are likely.",
		trigger: (state) => {
			const groups = getKafkaData(state).consumerGroups ?? [];
			const matched = groups.filter((g) => g.state === "Stable" && (g.totalLag ?? 0) > 10_000);
			return matched.length === 0
				? null
				: {
						context: {
							groupIds: matched.map((g) => g.id),
							lags: matched.map((g) => g.totalLag),
						},
					};
		},
		requiredAgent: "elastic-agent",
		retry: { attempts: 3, timeoutMs: 30_000 },
	},
	{
		name: "kafka-dlq-growth",
		description: "DLQ topic with messages added since baseline (live failure, not historical noise).",
		trigger: (state) => {
			const dlqs = getKafkaData(state).dlqTopics ?? [];
			const matched = dlqs.filter((d) => (d.recentDelta ?? 0) > 0);
			return matched.length === 0
				? null
				: { context: { topics: matched.map((d) => ({ name: d.name, delta: d.recentDelta })) } };
		},
		requiredAgent: "elastic-agent",
		retry: { attempts: 3, timeoutMs: 30_000 },
	},
	{
		name: "kafka-tool-failures",
		description: "kafka-agent tool calls failed; check whether broker logs in Elastic show cluster-side issues.",
		trigger: (state) => {
			const failures = getKafkaData(state).toolErrors ?? [];
			return failures.length === 0
				? null
				: { context: { errors: failures.map((e) => ({ tool: e.tool, code: e.code })) } };
		},
		requiredAgent: "elastic-agent",
		retry: { attempts: 3, timeoutMs: 30_000 },
	},
];

// SIO-712: deployment-vs-runtime contradiction helpers.
// Conservative stopword list: only common English connectives that pass the
// >=6-char distinctive-token filter but carry no domain meaning.
const DEPLOY_RUNTIME_STOPWORDS = new Set([
	"although",
	"because",
	"before",
	"between",
	"during",
	"either",
	"however",
	"itself",
	"please",
	"should",
	"through",
	"toward",
	"update",
	"updates",
	"version",
	"versions",
]);
const DEPLOY_RUNTIME_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEPLOY_RUNTIME_TOKEN_MIN_LEN = 6;

interface GitLabMergedRequest {
	id: number | string;
	title?: string;
	description?: string;
	merged_at?: string;
}

interface DatastoreSlowQuery {
	statement?: string;
	lastExecutionTime?: string;
	serviceTime?: number;
}

function distinctiveTokens(text: string): Set<string> {
	const tokens = text.toLowerCase().match(/[a-z][a-z0-9_]*/g) ?? [];
	const out = new Set<string>();
	for (const t of tokens) {
		if (t.length < DEPLOY_RUNTIME_TOKEN_MIN_LEN) continue;
		if (DEPLOY_RUNTIME_STOPWORDS.has(t)) continue;
		out.add(t);
	}
	return out;
}

function shareDistinctiveToken(a: string, b: string): boolean {
	const tokensA = distinctiveTokens(a);
	if (tokensA.size === 0) return false;
	const tokensB = distinctiveTokens(b);
	for (const t of tokensA) {
		if (tokensB.has(t)) return true;
	}
	return false;
}

// SIO-712: This rule's helpers expect structured DataSourceResult.data (object
// with mergedRequests / slowQueries arrays). In production today, sub-agents
// return a string in `data` (see sub-agent.ts:301), so the rule is dormant
// against real traffic and only fires in tests that hand-construct structured
// data. Matches the same dormancy pattern as the existing kafka rules (see
// getKafkaData above). Structured sub-agent output is the unblocking work;
// not in scope for SIO-712.
function getGitLabMergedRequests(state: AgentStateType): GitLabMergedRequest[] {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "gitlab");
	if (!result || result.status !== "success" || !result.data || typeof result.data !== "object") return [];
	const data = result.data as { mergedRequests?: GitLabMergedRequest[] };
	return Array.isArray(data.mergedRequests) ? data.mergedRequests : [];
}

function getDatastoreSlowQueries(state: AgentStateType, dataSourceId: "couchbase" | "konnect"): DatastoreSlowQuery[] {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === dataSourceId);
	if (!result || result.status !== "success" || !result.data || typeof result.data !== "object") return [];
	const data = result.data as { slowQueries?: DatastoreSlowQuery[] };
	return Array.isArray(data.slowQueries) ? data.slowQueries : [];
}

correlationRules.push({
	name: "gitlab-deploy-vs-datastore-runtime",
	description:
		"GitLab MR claims a fix is deployed but a datastore observation post-merge shows the same buggy-behaviour signature; flag as unresolved cross-source contradiction.",
	trigger: (state) => {
		const mrs = getGitLabMergedRequests(state);
		if (mrs.length === 0) return null;
		const now = Date.now();
		const couchbaseQueries = getDatastoreSlowQueries(state, "couchbase");
		const konnectQueries = getDatastoreSlowQueries(state, "konnect");
		const datastores = [
			{ source: "couchbase" as const, queries: couchbaseQueries },
			{ source: "konnect" as const, queries: konnectQueries },
		];
		for (const mr of mrs) {
			if (!mr.merged_at) continue;
			const mergedTs = Date.parse(mr.merged_at);
			if (!Number.isFinite(mergedTs)) continue;
			if (now - mergedTs > DEPLOY_RUNTIME_WINDOW_MS) continue;
			const mrText = `${mr.title ?? ""} ${mr.description ?? ""}`.trim();
			if (!mrText) continue;
			for (const ds of datastores) {
				for (const q of ds.queries) {
					if (!q.lastExecutionTime || !q.statement) continue;
					const observedTs = Date.parse(q.lastExecutionTime);
					if (!Number.isFinite(observedTs) || observedTs <= mergedTs) continue;
					if (!shareDistinctiveToken(mrText, q.statement)) continue;
					return {
						context: {
							gitlabRef: mr.id,
							gitlabMergedAt: mr.merged_at,
							datastoreSource: ds.source,
							datastoreObservedAt: q.lastExecutionTime,
							statementSignature: q.statement.slice(0, 200),
						},
					};
				}
			}
		}
		return null;
	},
	requiredAgent: "gitlab-agent",
	retry: { attempts: 1, timeoutMs: 30_000 },
	skipCoverageCheck: true,
});
