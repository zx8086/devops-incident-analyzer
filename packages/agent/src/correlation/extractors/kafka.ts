// packages/agent/src/correlation/extractors/kafka.ts
import type { KafkaFindings, ToolOutput } from "@devops-agent/shared";
import { z } from "zod";

// SIO-771/772: file-private schemas describe the **tool output** shape (what
// the kafka MCP returns), not the **finding** shape (which lives in
// @devops-agent/shared). Each tool's parser is owned by this extractor.

// SIO-783: kafka-service.ts listConsumerGroups returns a bare Array<{id, state, ...}>.
// Accept either the bare array (production shape) or the {groups: [...]} wrapper
// (back-compat for any callers that wrap).
const ListConsumerGroupsRowSchema = z.object({ id: z.string(), state: z.string() });
const ListConsumerGroupsArraySchema = z.array(z.unknown());
const ListConsumerGroupsWrapperSchema = z.object({ groups: z.array(z.unknown()) });

// SIO-783: kafka-service.ts getConsumerGroupLag returns totalLag as a string ("0",
// "12345"). Accept string or number, coerce to number at parse time. Falls back to
// the raw value when the string isn't numeric (lets safeParse fail cleanly).
const GetConsumerGroupLagSchema = z.object({
	groupId: z.string(),
	totalLag: z.union([z.number(), z.string()]).transform((v, ctx) => {
		const n = typeof v === "number" ? v : Number(v);
		if (!Number.isFinite(n)) {
			ctx.addIssue({ code: "custom", message: "totalLag is not a finite number" });
			return z.NEVER;
		}
		return n;
	}),
});

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
			// SIO-783: prefer bare-array shape (real MCP output), fall back to wrapper.
			const arr = ListConsumerGroupsArraySchema.safeParse(o.rawJson);
			let rows: unknown[];
			if (arr.success) {
				rows = arr.data;
			} else {
				const wrapper = ListConsumerGroupsWrapperSchema.safeParse(o.rawJson);
				if (!wrapper.success) continue;
				rows = wrapper.data.groups;
			}
			for (const g of rows) {
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
