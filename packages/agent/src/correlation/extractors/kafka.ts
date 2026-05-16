// packages/agent/src/correlation/extractors/kafka.ts
import type { KafkaFindings, ToolOutput } from "@devops-agent/shared";

interface ListConsumerGroupsRawGroup {
	id: unknown;
	state?: unknown;
}

function isRecord(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null && !Array.isArray(x);
}

function extractListConsumerGroupsEntries(rawJson: unknown): Array<{ id: string; state: string }> {
	if (!isRecord(rawJson) || !Array.isArray(rawJson.groups)) return [];
	const out: Array<{ id: string; state: string }> = [];
	for (const g of rawJson.groups as ListConsumerGroupsRawGroup[]) {
		if (!isRecord(g)) continue;
		if (typeof g.id !== "string" || typeof g.state !== "string") continue;
		out.push({ id: g.id, state: g.state });
	}
	return out;
}

function extractGetConsumerGroupLagEntry(rawJson: unknown): { id: string; totalLag: number } | null {
	if (!isRecord(rawJson)) return null;
	const id = rawJson.groupId;
	const totalLag = rawJson.totalLag;
	if (typeof id !== "string" || typeof totalLag !== "number") return null;
	return { id, totalLag };
}

export function extractKafkaFindings(outputs: ToolOutput[]): KafkaFindings {
	const byId = new Map<string, { id: string; state?: string; totalLag?: number }>();

	for (const o of outputs) {
		if (o.toolName === "kafka_list_consumer_groups") {
			for (const entry of extractListConsumerGroupsEntries(o.rawJson)) {
				const existing = byId.get(entry.id) ?? { id: entry.id };
				existing.state = entry.state;
				byId.set(entry.id, existing);
			}
		} else if (o.toolName === "kafka_get_consumer_group_lag") {
			const entry = extractGetConsumerGroupLagEntry(o.rawJson);
			if (!entry) continue;
			const existing = byId.get(entry.id) ?? { id: entry.id };
			existing.totalLag = entry.totalLag;
			byId.set(entry.id, existing);
		}
	}

	const findings: KafkaFindings = {};
	if (byId.size > 0) findings.consumerGroups = Array.from(byId.values());
	return findings;
}
