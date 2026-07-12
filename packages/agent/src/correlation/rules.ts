// agent/src/correlation/rules.ts
import type {
	AwsCloudWatchAlarm,
	AwsFindings,
	CouchbaseSlowQuery,
	ElasticFindings,
	GitLabMergedRequest,
	OrbitFindings,
	ToolError,
} from "@devops-agent/shared";
import type { AgentName, AgentStateType } from "../state";
import { matchesFocus } from "./focus-match.ts";

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

// SIO-842: read the structured awsFindings sibling (populated by extractFindings from
// aws_cloudwatch_describe_alarms) instead of regex-matching the prose summary. Mirrors
// getKafkaData. result.data stays prose for the aggregator/UI.
function getAwsFindings(state: AgentStateType): AwsFindings {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "aws");
	if (!result || result.status !== "success") return {};
	return result.awsFindings ?? {};
}

// SIO-842: an alarm is Kafka/MSK-relevant if its name, metric, or namespace names
// Kafka/MSK. Per-alarm (unlike the old prose regex, which matched "Kafka" anywhere in
// the whole blob and so fired on unrelated alarms).
function isKafkaAlarm(a: AwsCloudWatchAlarm): boolean {
	return /\b(MSK|Kafka)\b/i.test(`${a.name} ${a.metricName ?? ""} ${a.namespace ?? ""}`);
}

// SIO-842 / SIO-1030: an alarm is in-scope for the incident if any established focus
// service is referenced by its name/metric/namespace. Delegates to the shared
// matchesFocus so the correlation rule and the AWS finding card (aws.ts extractor)
// scope with one matcher — no drift where the card hides an alarm the rule still
// treats as in-scope. Empty focus => "all" (show-all semantics preserved).
function alarmReferencesFocus(a: AwsCloudWatchAlarm, focusServices: string[]): boolean {
	return matchesFocus(`${a.name} ${a.metricName ?? ""} ${a.namespace ?? ""}`, focusServices);
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
			const matched = groups.filter((g) => g.state === "EMPTY" || g.state === "DEAD");
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
			const matched = groups.filter((g) => g.state === "STABLE" && (g.totalLag ?? 0) > 10_000);
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
		// SIO-842: migrated from prose regex to typed awsFindings.alarms[], scoped to
		// the investigation focus so it no longer fires on any Kafka-named alarm
		// anywhere in the account (the old kafkaContext was unscoped).
		name: "aws-cloudwatch-anomaly-needs-kafka-lag",
		description:
			"AWS sub-agent reported a CloudWatch alarm in ALARM state referencing Kafka/MSK; correlate with kafka-agent consumer-group lag.",
		trigger: (state) => {
			const focusServices = state.investigationFocus?.services ?? [];
			const scopedAlarms = (getAwsFindings(state).alarms ?? []).filter(
				(a) => a.state === "ALARM" && isKafkaAlarm(a) && alarmReferencesFocus(a, focusServices),
			);
			if (scopedAlarms.length === 0) return null;
			return { context: { signal: "aws-cloudwatch-alarm-kafka", alarms: scopedAlarms } };
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

// SIO-788 (Phase C, 2026-05-18): exported for reuse by the elastic log-cluster
// extractor. Behaviour unchanged from the rules-engine deploy-vs-runtime path.
export function distinctiveTokens(text: string): Set<string> {
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

// SIO-1076: Orbit cross-project correlation. Readers mirror getGitLabMergedRequests
// -- they read the typed sibling extractFindings populated on the gitlab / elastic
// DataSourceResult; result.data stays prose for the aggregator/UI.
function getOrbitFindings(state: AgentStateType): OrbitFindings {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "gitlab");
	if (!result || result.status !== "success") return {};
	return result.orbitFindings ?? {};
}

function getElasticFindings(state: AgentStateType): ElasticFindings {
	const result = state.dataSourceResults.find((r) => r.dataSourceId === "elastic");
	if (!result || result.status !== "success") return {};
	return result.elasticFindings ?? {};
}

// An elastic observation timestamp is "after" an MR merge when it parses and is
// strictly later. Absence (no timestamp) is NOT after -- Orbit/elastic silence
// must never manufacture a post-merge correlation.
function postMerge(ts: string | undefined, mergedTs: number): boolean {
	if (!ts) return false;
	const t = Date.parse(ts);
	return Number.isFinite(t) && t > mergedTs;
}

// Does elastic show a post-merge error signal in a downstream service?
function elasticShowsPostMergeError(elastic: ElasticFindings, service: string, mergedTs: number): boolean {
	const apmHit = (elastic.apmServices ?? []).some(
		(a) => (a.errorRate ?? 0) > 0 && matchesFocus(a.serviceName, [service]) && postMerge(a.observedAt, mergedTs),
	);
	if (apmHit) return true;
	return (elastic.logClusters ?? []).some(
		(c) => c.service !== undefined && matchesFocus(c.service, [service]) && postMerge(c.lastSeen, mergedTs),
	);
}

// -- Rule: gated blast-radius pre-fetch --------------------------------------
// Cost gate. Fires only when BOTH a recent deploy AND an elastic error signal
// already exist, then re-fans to gitlab-agent to run the (billed) blast-radius
// traversal. No incident pays for a traversal unless a deploy and a runtime
// symptom already coincide. Not skipCoverageCheck: once blastRadius is present
// the idempotency check suppresses a repeat re-fan.
correlationRules.push({
	name: "orbit-deploy-needs-blast-radius",
	description:
		"A recent group-wide deploy MR coincides with an Elastic error signal, but cross-project blast radius has not been fetched; re-fan to gitlab-agent to run the Orbit blast-radius traversal.",
	trigger: (state) => {
		const orbit = getOrbitFindings(state);
		if (orbit.blastRadius && orbit.blastRadius.length > 0) return null; // already fetched
		const deploys = orbit.recentDeploys ?? [];
		if (deploys.length === 0) return null;
		const elastic = getElasticFindings(state);
		const hasElasticError =
			(elastic.apmServices ?? []).some((a) => (a.errorRate ?? 0) > 0) || (elastic.logClusters ?? []).length > 0;
		if (!hasElasticError) return null;
		const now = Date.now();
		const inWindow = deploys.filter((d) => {
			const ts = Date.parse(d.mergedAt);
			return Number.isFinite(ts) && now - ts <= DEPLOY_RUNTIME_WINDOW_MS;
		});
		if (inWindow.length === 0) return null;
		const services = new Set<string>();
		for (const a of elastic.apmServices ?? []) if ((a.errorRate ?? 0) > 0) services.add(a.serviceName);
		for (const c of elastic.logClusters ?? []) if (c.service) services.add(c.service);
		return {
			context: {
				requestBlastRadius: true,
				services: Array.from(services),
				deployMrs: inWindow.map((d) => d.mrId),
			},
		};
	},
	requiredAgent: "gitlab-agent",
	retry: { attempts: 1, timeoutMs: 30_000 },
});

// -- Rule: flagship blast-radius vs elastic ----------------------------------
// A shared-lib change imported by a downstream service, with a post-merge elastic
// error spike in that same service = strong shared-library root-cause correlation
// (impossible with per-project REST). Regular dispatch: re-fans to elastic-agent
// with the downstream services in context.services so the second turn confirms.
correlationRules.push({
	name: "orbit-deploy-blast-radius-vs-elastic",
	description:
		"A recent cross-project deploy MR changed a shared definition imported by downstream service X, and Elastic shows a post-merge error spike in X -- strong shared-library root-cause correlation.",
	trigger: (state) => {
		const blast = getOrbitFindings(state).blastRadius ?? [];
		if (blast.length === 0) return null;
		const elastic = getElasticFindings(state);
		const now = Date.now();
		for (const b of blast) {
			if (!b.mrMergedAt) continue;
			const mergedTs = Date.parse(b.mrMergedAt);
			if (!Number.isFinite(mergedTs) || now - mergedTs > DEPLOY_RUNTIME_WINDOW_MS) continue;
			const downstream = new Set<string>([...b.importedByProjects, ...b.importedByFiles.map((f) => f.project ?? "")]);
			const impacted: string[] = [];
			for (const svc of downstream) {
				if (!svc) continue;
				if (elasticShowsPostMergeError(elastic, svc, mergedTs)) impacted.push(svc);
			}
			if (impacted.length > 0) {
				return {
					context: {
						definition: b.definitionName,
						sourceProject: b.sourceProject,
						mrId: b.mrId,
						services: impacted,
					},
				};
			}
		}
		return null;
	},
	requiredAgent: "elastic-agent",
	retry: { attempts: 2, timeoutMs: 30_000 },
});

// -- Rule: pipeline failure vs incident --------------------------------------
// A focus-service project with repeated cross-project pipeline failures in the
// window; confirm the runtime symptom in that service via elastic.
const ORBIT_PIPELINE_FAILURE_MIN = 2;
correlationRules.push({
	name: "orbit-pipeline-failure-vs-incident",
	description:
		"A focus-service project shows repeated group-wide pipeline failures in the incident window; correlate with elastic-agent to confirm the runtime symptom in that service.",
	trigger: (state) => {
		const failures = getOrbitFindings(state).pipelineFailures ?? [];
		if (failures.length === 0) return null;
		const focusServices = state.investigationFocus?.services ?? [];
		const impacted: string[] = [];
		for (const f of failures) {
			if (f.failureCount < ORBIT_PIPELINE_FAILURE_MIN) continue;
			if (!f.project) continue;
			if (!matchesFocus(f.project, focusServices)) continue;
			impacted.push(f.project);
		}
		if (impacted.length === 0) return null;
		return { context: { signal: "orbit-pipeline-failures", services: impacted } };
	},
	requiredAgent: "elastic-agent",
	retry: { attempts: 2, timeoutMs: 30_000 },
});

// -- Rule: vulnerability introduced by a recent MR ---------------------------
// Self-signalling: a critical/high vuln on a focus project is a signal in itself.
// skipCoverageCheck -> straight to aggregate, caps confidence, emits a banner.
correlationRules.push({
	name: "orbit-vuln-introduced-by-recent-mr",
	description:
		"Orbit reports a critical/high vulnerability on a focus project (optionally tied to a recent MR); surface it to the human even if it is not the proven root cause.",
	trigger: (state) => {
		const vulns = getOrbitFindings(state).vulnerabilities ?? [];
		if (vulns.length === 0) return null;
		const focusServices = state.investigationFocus?.services ?? [];
		const flagged = vulns.filter(
			(v) =>
				/^(critical|high)$/i.test(v.severity) && matchesFocus(`${v.project ?? ""} ${v.title ?? ""}`, focusServices),
		);
		if (flagged.length === 0) return null;
		return {
			context: {
				signal: "orbit-vulnerability",
				vulnerabilities: flagged.map((v) => ({ severity: v.severity, project: v.project, title: v.title })),
			},
		};
	},
	requiredAgent: "gitlab-agent",
	retry: { attempts: 1, timeoutMs: 30_000 },
	skipCoverageCheck: true,
});
