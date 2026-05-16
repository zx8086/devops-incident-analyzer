// packages/agent/src/correlation/extractors/kafka.ts
import type { KafkaFindings, ToolOutput } from "@devops-agent/shared";
import { z } from "zod";

// SIO-771/772: file-private schemas describe the **tool output** shape (what
// the kafka MCP returns), not the **finding** shape (which lives in
// @devops-agent/shared). Each tool's parser is owned by this extractor.

const ListConsumerGroupsRowSchema = z.object({ id: z.string(), state: z.string() });
const ListConsumerGroupsWrapperSchema = z.object({ groups: z.array(z.unknown()) });

const GetConsumerGroupLagSchema = z.object({ groupId: z.string(), totalLag: z.number() });

const ListDlqTopicsRowSchema = z.object({
	name: z.string(),
	totalMessages: z.number(),
	recentDelta: z.number().nullable(),
});

export function extractKafkaFindings(outputs: ToolOutput[]): KafkaFindings {
	const byId = new Map<string, { id: string; state?: string; totalLag?: number }>();
	const dlqTopics: Array<z.infer<typeof ListDlqTopicsRowSchema>> = [];

	for (const o of outputs) {
		if (o.toolName === "kafka_list_consumer_groups") {
			const wrapper = ListConsumerGroupsWrapperSchema.safeParse(o.rawJson);
			if (!wrapper.success) continue;
			for (const g of wrapper.data.groups) {
				const parsed = ListConsumerGroupsRowSchema.safeParse(g);
				if (!parsed.success) continue;
				const existing = byId.get(parsed.data.id) ?? { id: parsed.data.id };
				existing.state = parsed.data.state;
				byId.set(parsed.data.id, existing);
			}
		} else if (o.toolName === "kafka_get_consumer_group_lag") {
			const parsed = GetConsumerGroupLagSchema.safeParse(o.rawJson);
			if (!parsed.success) continue;
			const existing = byId.get(parsed.data.groupId) ?? { id: parsed.data.groupId };
			existing.totalLag = parsed.data.totalLag;
			byId.set(parsed.data.groupId, existing);
		} else if (o.toolName === "kafka_list_dlq_topics") {
			if (!Array.isArray(o.rawJson)) continue;
			for (const t of o.rawJson) {
				const parsed = ListDlqTopicsRowSchema.safeParse(t);
				if (parsed.success) dlqTopics.push(parsed.data);
			}
		}
	}

	const findings: KafkaFindings = {};
	if (byId.size > 0) findings.consumerGroups = Array.from(byId.values());
	if (dlqTopics.length > 0) findings.dlqTopics = dlqTopics;
	return findings;
}
