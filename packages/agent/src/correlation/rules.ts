// agent/src/correlation/rules.ts
import type { CouchbaseSlowQuery, GitLabMergedRequest, ToolError } from "@devops-agent/shared";
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
	consumerGroups?: Array<{ id: string; state?: string; totalLag?: number }>;
	dlqTopics?: Array<{ name: string; totalMessages: number; recentDelta: number | null }>;
} {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "kafka");
	if (!result || result.status !== "success") return {};
	// SIO-764: read the structured sibling populated by extractFindings; result.data
	// stays as the prose summary for aggregator/UI.
	return result.kafkaFindings ?? {};
}

// SIO-717: read the result-level toolErrors (populated by sub-agent.ts) and
// the LLM's prose summary (result.data when string). This is the production
// signal -- unlike getKafkaData which expects structured fields that today's
// sub-agents do not emit (see comment on line ~154).
function getKafkaResultSignals(state: AgentStateType): { toolErrors: ToolError[]; prose: string } {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "kafka");
	if (!result || result.status !== "success") return { toolErrors: [], prose: "" };
	const toolErrors = Array.isArray(result.toolErrors) ? result.toolErrors : [];
	const prose = typeof result.data === "string" ? result.data : "";
	return { toolErrors, prose };
}

// SIO-761 Phase 5: mirror of getKafkaResultSignals for aws-agent. The aws
// sub-agent emits its findings as a prose string in result.data and structured
// tool errors in result.toolErrors. Both are read by the new aws-* correlation
// rules added in Phase 5.
function getAwsResultSignals(state: AgentStateType): { toolErrors: ToolError[]; prose: string } {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "aws");
	if (!result || result.status !== "success") return { toolErrors: [], prose: "" };
	const toolErrors = Array.isArray(result.toolErrors) ? result.toolErrors : [];
	const prose = typeof result.data === "string" ? result.data : "";
	return { toolErrors, prose };
}

// SIO-717: extract the upstream hostname from a Confluent Platform tool error
// message. The Kafka MCP server (ksql-service.ts, connect-service.ts, etc.)
// wraps upstream 5xx errors as "<Service> error <code>: <body>". Our env vars
// are *.shared-services.eu.pvh.cloud, so any tool error containing a hostname
// of that pattern indicates the agent is hitting that endpoint.
function extractConfluentHostname(message: string): string | null {
	// Match either "ksql.dev.shared-services.eu.pvh.cloud" or any of the four
	// service prefixes (ksql, connect, schemaregistry, restproxy). The full
	// hostname must appear in the error body for nginx 503 pages -- which all
	// of our env-configured endpoints do for upstream-empty responses.
	const match = message.match(/(ksql|connect|schemaregistry|restproxy)\.(dev|prd)\.shared-services\.eu\.pvh\.cloud/);
	return match ? match[0] : null;
}

// SIO-723: keywords that signal the kafka sub-agent has correctly framed
// MSK-offset-derived group names as inferences, not confirmations. At least
// one must appear in the prose when Connect/ksqlDB REST is 5xx-ing AND the
// prose names connect-* / _confluent-ksql-default_query_* groups, otherwise
// the report is implicitly presenting historical offsets as live deployment
// state. Keep this list short and require an exact substring match (cheap,
// auditable) -- the SOUL.md prompt explicitly tells the agent to use one
// of these phrases.
const SIO723_DISCLAIMER_KEYWORDS = ["inferred", "MSK offset state", "unverifiable while", "cannot confirm"];

function hasInferredOffsetDisclaimer(prose: string): boolean {
	for (const kw of SIO723_DISCLAIMER_KEYWORDS) {
		if (prose.includes(kw)) return true;
	}
	return false;
}

// SIO-723: did the kafka sub-agent's prose name connect-* groups or
// _confluent-ksql-default_query_* groups? These names are the ones that come
// from kafka_list_consumer_groups (MSK admin API), which returns historical
// offset state regardless of whether the owning Connect/ksqlDB deployment
// still exists. Used together with findConfluent5xxToolErrors to detect when
// the agent is presenting inferred names without the required disclaimer.
function findInferredConfluentGroupMentions(prose: string): { connect: boolean; ksql: boolean } {
	return {
		connect: /\bconnect-[A-Za-z0-9_-]+/.test(prose),
		ksql: prose.includes("_confluent-ksql-default_query_"),
	};
}

// SIO-717: did the kafka sub-agent see a 5xx from any Confluent service tool?
// SIO-725/728: prefer the structured statusCode + hostname fields populated by
// the MCP server's fetchUpstream helper (via the ---STRUCTURED--- sentinel in
// ResponseBuilder.error). Fall back to regex on err.message for older tool
// errors that pre-date the sentinel (other MCP servers, archived fixtures).
function findConfluent5xxToolErrors(toolErrors: ToolError[]): Array<{ tool: string; hostname: string | null }> {
	const out: Array<{ tool: string; hostname: string | null }> = [];
	for (const err of toolErrors) {
		// Structured path: SIO-725 plumbs the upstream hostname into err.hostname
		// and SIO-728 plumbs the real HTTP status into err.statusCode. Use them
		// when present -- no string-shape dependency.
		if (typeof err.statusCode === "number" && err.statusCode >= 500 && err.statusCode < 600) {
			out.push({ tool: err.toolName, hostname: err.hostname ?? null });
			continue;
		}
		// Regex fallback for tool errors without structured fields. Service names
		// come from ksql-service.ts ("ksqlDB"), connect-service.ts
		// ("Kafka Connect"), schema-registry-service.ts ("Schema Registry"),
		// restproxy-service.ts ("REST Proxy"). 5xx range matches any upstream
		// server error.
		const m = err.message.match(/(ksqlDB|Kafka Connect|Schema Registry|REST Proxy)\s+error\s+5\d\d:/);
		if (!m) continue;
		out.push({ tool: err.toolName, hostname: err.hostname ?? extractConfluentHostname(err.message) });
	}
	return out;
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
			// SIO-769: read top-level result.toolErrors (populated since SIO-725/728 via
			// the sub-agent's ---STRUCTURED--- sentinel), not kafkaFindings.toolErrors
			// which was never a populated slot. Mirrors getKafkaResultSignals (rules.ts:39).
			const result = state.dataSourceResults.find((r) => r.dataSourceId === "kafka");
			if (!result || result.status !== "success") return null;
			const toolErrors = Array.isArray(result.toolErrors) ? result.toolErrors : [];
			if (toolErrors.length === 0) return null;
			return { context: { toolErrors } };
		},
		requiredAgent: "elastic-agent",
		retry: { attempts: 3, timeoutMs: 30_000 },
	},
	{
		// SIO-717: ksqlDB queries reporting UNRESPONSIVE statusCount mean at least
		// one cluster host is not heartbeating. Per the kafka-consumer-lag runbook
		// Step 2a, this requires an Elastic ksqldb-server log lookup to determine
		// whether the host crashed, OOM'd, or hit a network partition.
		name: "ksqldb-unresponsive-task",
		description:
			"ksqlDB persistent query reports UNRESPONSIVE task status; correlate with ksqldb-server logs to identify the degraded host.",
		trigger: (state) => {
			const { prose } = getKafkaResultSignals(state);
			// Match UNRESPONSIVE and statusCount in the same prose blob -- both
			// must appear before the rule fires, to avoid matching e.g. the word
			// "UNRESPONSIVE" used incidentally elsewhere.
			if (!prose.includes("UNRESPONSIVE") || !prose.includes("statusCount")) return null;
			return { context: { signal: "ksqldb-unresponsive" } };
		},
		requiredAgent: "elastic-agent",
		retry: { attempts: 2, timeoutMs: 30_000 },
	},
	{
		// SIO-717: HTTP 5xx from a connect_* tool indicates Kafka Connect is
		// unavailable from the agent's network path. Distinct from the broader
		// kafka-tool-failures rule, which (since SIO-769) also reads
		// result.toolErrors but fires on any tool failure regardless of category.
		name: "connect-service-unavailable",
		description:
			"Kafka Connect tool returned a 5xx; correlate with kafka-connect logs in Elastic to confirm cluster-side vs network failure.",
		trigger: (state) => {
			const { toolErrors } = getKafkaResultSignals(state);
			const connectErrors = findConfluent5xxToolErrors(toolErrors).filter((e) => e.tool.startsWith("connect_"));
			return connectErrors.length === 0
				? null
				: { context: { tools: connectErrors.map((e) => e.tool), hostname: connectErrors[0]?.hostname ?? null } };
		},
		requiredAgent: "elastic-agent",
		retry: { attempts: 2, timeoutMs: 30_000 },
	},
	{
		// SIO-717: shared-substrate cross-check. ANY Confluent service 5xx from
		// the kafka sub-agent triggers a synthetic-monitor lookup in Elastic.
		// If the synthetic reports the service UP, the agent's 5xx is a path-side
		// problem (env mismatch, network policy, cross-VPC) and the finding
		// should be demoted to env-mismatch-suspected. If the synthetic agrees
		// (DOWN or missing), the original service-unavailable finding stands and
		// confidenceCap=0.59 caps the report below the 0.6 HITL threshold.
		// Without skipCoverageCheck, this rule respects the engine's idempotency
		// check (covered if elastic findings already address the hostname).
		name: "infra-service-degraded-needs-synthetic-cross-check",
		description:
			"Confluent Platform tool returned a 5xx; cross-check the corresponding Elastic synthetic monitor to distinguish a real outage from agent-side misrouting.",
		trigger: (state) => {
			const { toolErrors } = getKafkaResultSignals(state);
			const hits = findConfluent5xxToolErrors(toolErrors).filter((e) => e.hostname !== null);
			if (hits.length === 0) return null;
			// Collect unique hostnames so the cross-check covers all failing endpoints
			const hostnames = [...new Set(hits.map((h) => h.hostname).filter((h): h is string => h !== null))];
			return { context: { hostnames, signal: "confluent-5xx-needs-synthetic-crosscheck" } };
		},
		requiredAgent: "elastic-agent",
		retry: { attempts: 2, timeoutMs: 30_000 },
	},
	{
		// SIO-723: kafka_list_consumer_groups returns groups from MSK's
		// __consumer_offsets topic -- the historical record of every group that
		// ever offset-committed, NOT a live deployment manifest. When Connect or
		// ksqlDB REST is 5xx-ing, the agent has no way to verify whether a
		// connect-* / _confluent-ksql-default_query_* group still corresponds to a
		// deployed component. Reports must frame those names as inferences. This
		// rule fires when the prose names such groups WHILE the owning service is
		// 5xx-ing AND no disclaimer keyword is present, capping confidence so the
		// HITL gate forces the operator to read it with the right framing. Like
		// gitlab-deploy-vs-datastore-runtime (SIO-712), the trigger is the signal:
		// no other agent can resolve it, the cap is the entire purpose.
		name: "inferred-confluent-groups-need-disclaimer",
		description:
			"Kafka sub-agent named connect-*/ksqlDB groups (inferred from MSK offsets) while the owning REST service was 5xx-ing, without a disclaimer that those names cannot be confirmed as live deployments.",
		trigger: (state) => {
			const { toolErrors, prose } = getKafkaResultSignals(state);
			if (!prose) return null;
			const errs = findConfluent5xxToolErrors(toolErrors);
			const connect5xx = errs.some((e) => e.tool.startsWith("connect_"));
			const ksql5xx = errs.some((e) => e.tool.startsWith("ksql_"));
			if (!connect5xx && !ksql5xx) return null;
			const mentions = findInferredConfluentGroupMentions(prose);
			const violatingConnect = connect5xx && mentions.connect;
			const violatingKsql = ksql5xx && mentions.ksql;
			if (!violatingConnect && !violatingKsql) return null;
			if (hasInferredOffsetDisclaimer(prose)) return null;
			return {
				context: {
					signal: "inferred-groups-without-disclaimer",
					connect: violatingConnect,
					ksql: violatingKsql,
				},
			};
		},
		requiredAgent: "kafka-agent",
		retry: { attempts: 1, timeoutMs: 30_000 },
		skipCoverageCheck: true,
	},
	{
		// SIO-742: prior runs concluded "REST Proxy NOT DETECTED" by inferring
		// from the absence of restproxy consumer groups in kafka_list_consumer_groups
		// without calling restproxy_health_check. When prose names any Confluent
		// component as NOT DETECTED / not detected / not confirmed / deployment
		// unconfirmed, fan out to kafka-agent with the health_check action so the
		// follow-up turn explicitly probes reachability before the agent gives up.
		name: "confluent-component-not-probed",
		description:
			"Aggregator prose declared a Confluent component (REST Proxy, ksqlDB, Kafka Connect, Schema Registry) NOT DETECTED without first calling its *_health_check tool; dispatch a kafka-agent follow-up to probe reachability directly.",
		trigger: (state) => {
			const { prose } = getKafkaResultSignals(state);
			if (!prose) return null;
			// Match any of these "we did not detect" phrasings (case-insensitive).
			const NOT_PROBED_RE =
				/\b(NOT DETECTED|not detected|deployment status (is )?unconfirmed|deployment is unconfirmed|cannot confirm.*deploy|no [a-z]+ signal)\b/i;
			if (!NOT_PROBED_RE.test(prose)) return null;
			// Identify which components the prose claims are not detected.
			const components: string[] = [];
			if (/\brest proxy\b/i.test(prose)) components.push("restproxy");
			if (/\bksql(db)?\b/i.test(prose)) components.push("ksql");
			if (/\bkafka connect\b/i.test(prose)) components.push("connect");
			if (/\bschema registry\b/i.test(prose)) components.push("schema_registry");
			if (components.length === 0) return null;
			return { context: { signal: "confluent-not-probed", components } };
		},
		requiredAgent: "kafka-agent",
		retry: { attempts: 1, timeoutMs: 30_000 },
		skipCoverageCheck: true,
	},
	{
		// SIO-742: ksql_cluster_status surfaces per-host hostAlive directly. When
		// the prose admits aliveHosts < totalHosts (or "X of Y workers" with X<Y,
		// or "hostAlive: false"), cross-check ksqldb-server logs in Elastic to
		// identify the cause. Distinct from the existing ksqldb-unresponsive rule
		// which fires on the older "UNRESPONSIVE + statusCount" derivation; this
		// one is the authoritative cluster-status path.
		name: "ksql-cluster-status-degraded",
		description:
			"ksql_cluster_status reported degraded worker liveness (aliveHosts < totalHosts or hostAlive=false); correlate with ksqldb-server logs in Elastic.",
		trigger: (state) => {
			const { prose } = getKafkaResultSignals(state);
			if (!prose) return null;
			// Match the structured envelope shape (aliveHosts < totalHosts as
			// numeric pair, or "degraded: true", or explicit hostAlive: false).
			const degraded =
				/\bhostAlive\s*[:=]\s*false\b/i.test(prose) ||
				/\bdegraded\s*[:=]\s*true\b/i.test(prose) ||
				/\baliveHosts\b/.test(prose) ||
				/\b(\d+)\s*of\s*(\d+)\s+(workers?|hosts?|nodes?)\b.*(UNRESPONSIVE|degraded|down)/i.test(prose);
			if (!degraded) return null;
			return { context: { signal: "ksql-cluster-status-degraded" } };
		},
		requiredAgent: "elastic-agent",
		retry: { attempts: 2, timeoutMs: 30_000 },
	},
	{
		// SIO-761 Phase 5: aws-agent reported one or more ECS services in a
		// degraded state (runningCount < desiredCount, or "0 of N tasks running",
		// or explicit "service degraded" phrasing). Application logs/traces in
		// Elasticsearch typically explain WHY the tasks aren't running (OOM,
		// startup crash, image pull failure, etc.), so dispatch elastic-agent
		// to cross-check before the report concludes.
		name: "aws-ecs-degraded-needs-elastic-traces",
		description:
			"AWS sub-agent reported ECS service with runningCount < desiredCount; correlate with application traces in Elasticsearch.",
		trigger: (state) => {
			const { prose } = getAwsResultSignals(state);
			if (!prose) return null;
			// Three independent ECS-degraded shapes, any one suffices:
			//   a) "<N> of <M> tasks running" with N < M (numeric pair)
			//   b) "<service-name> is degraded" / "service degraded"
			//   c) "desiredCount" + "runningCount" both named in the same prose
			const taskMatch = prose.match(/\b(\d+)\s*of\s*(\d+)\s+tasks?\s+running\b/i);
			const taskMismatch = !!(taskMatch && Number(taskMatch[1]) < Number(taskMatch[2]));
			const degradedPhrasing = /\bservice(?:\s+[a-zA-Z0-9_-]+)?\s+(?:is\s+)?degraded\b/i.test(prose);
			const structuredEnvelope = /\bdesiredCount\b/.test(prose) && /\brunningCount\b/.test(prose);
			if (!taskMismatch && !degradedPhrasing && !structuredEnvelope) return null;
			return { context: { signal: "aws-ecs-degraded" } };
		},
		requiredAgent: "elastic-agent",
		retry: { attempts: 2, timeoutMs: 30_000 },
	},
	{
		// SIO-761 Phase 5: aws-agent reported a CloudWatch alarm in ALARM state
		// whose name or metric references Kafka/MSK. Consumer-lag spikes on the
		// MSK side often anchor the alarm; fan out to kafka-agent for a lag
		// snapshot before the report concludes.
		name: "aws-cloudwatch-anomaly-needs-kafka-lag",
		description:
			"AWS sub-agent reported a CloudWatch alarm in ALARM state referencing Kafka/MSK; correlate with kafka-agent consumer-group lag.",
		trigger: (state) => {
			const { prose } = getAwsResultSignals(state);
			if (!prose) return null;
			// Both signals must coexist in the same prose blob: ALARM state AND a
			// Kafka-related keyword. Either alone is too noisy (alarms exist for
			// every service; Kafka is named in lots of contexts).
			const alarmStated = /\bStateValue\b.*\bALARM\b/i.test(prose) || /\balarm.*\bin\s+ALARM\b/i.test(prose);
			const kafkaContext = /\b(MSK|Kafka|kafka|consumer\s+lag|broker)\b/.test(prose);
			if (!alarmStated || !kafkaContext) return null;
			return { context: { signal: "aws-cloudwatch-alarm-kafka" } };
		},
		requiredAgent: "kafka-agent",
		retry: { attempts: 2, timeoutMs: 30_000 },
	},
	{
		// SIO-761 Phase 5: kafka-agent reported broker-side timeout / unreachable
		// MSK cluster / connection failure. AWS-side networking, EC2 instance
		// health, or security-group changes are common root causes; fan out to
		// aws-agent for an MSK cluster + EC2 cross-check.
		name: "kafka-broker-timeout-needs-aws-metrics",
		description:
			"kafka-agent reported broker timeout / connection failure against MSK; correlate with AWS-side MSK cluster metrics, EC2 instance health, and security groups.",
		trigger: (state) => {
			const { toolErrors, prose } = getKafkaResultSignals(state);
			// Two paths: structured tool errors (preferred -- ToolError.category
			// is "transient" + the message has a network-shape pattern from
			// mapAwsError) or prose-mention fallback. Same dual-path approach
			// as SIO-717's findConfluent5xxToolErrors.
			const networkErrorTransient = toolErrors.some(
				(e) =>
					e.category === "transient" &&
					/(timeout|unreachable|unavailable|connection\s+refused|ENOTFOUND|ECONNREFUSED|ETIMEDOUT)/i.test(e.message),
			);
			const proseBrokerTimeout =
				/\bbroker\b.*(timeout|unreachable|unavailable|connection\s+refused)/i.test(prose) ||
				/\bMSK\b.*(timeout|unreachable|unavailable)/i.test(prose) ||
				/\bkafka\b.*\bconnection\b.*\btimeout\b/i.test(prose);
			if (!networkErrorTransient && !proseBrokerTimeout) return null;
			return { context: { signal: "kafka-broker-timeout-needs-aws" } };
		},
		requiredAgent: "aws-agent",
		retry: { attempts: 2, timeoutMs: 30_000 },
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

// SIO-771/772: gitlab + couchbase sides now wired -- this rule fires in
// production when a recent merged MR shares a distinctive token with a
// post-merge couchbase slowQuery statement. konnect side intentionally
// deferred until a real consumer arrives (see SIO-773 deferral policy).

// SIO-771: reads result.gitlabFindings.mergedRequests, populated by
// extractGitLabFindings from the gitlab_list_merge_requests tool. Pre-SIO-771
// this cast result.data to a typed object that production never wrote --
// dormant since SIO-712.
function getGitLabMergedRequests(state: AgentStateType): GitLabMergedRequest[] {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "gitlab");
	if (!result || result.status !== "success") return [];
	return result.gitlabFindings?.mergedRequests ?? [];
}

// SIO-772: couchbase reads the typed sibling populated by extractCouchbaseFindings.
// SIO-771/772 intentionally defers the konnect side -- no extractor wired this
// iteration. Returns [] for konnect, which makes the rule's konnect iteration a
// no-op without removing the branch (future konnect work activates it).
function getDatastoreSlowQueries(state: AgentStateType, dataSourceId: "couchbase" | "konnect"): CouchbaseSlowQuery[] {
	if (dataSourceId === "konnect") return [];
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "couchbase");
	if (!result || result.status !== "success") return [];
	return result.couchbaseFindings?.slowQueries ?? [];
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
