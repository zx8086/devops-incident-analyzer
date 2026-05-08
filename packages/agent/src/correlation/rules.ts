// agent/src/correlation/rules.ts
import type { AgentName, AgentStateType } from "../state";

export interface CorrelationRule {
	name: string;
	description: string;
	trigger: (state: AgentStateType) => TriggerMatch | null;
	requiredAgent: AgentName;
	retry: { attempts: number; timeoutMs: number };
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
