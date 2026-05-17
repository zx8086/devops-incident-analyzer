// apps/web/src/lib/components/KafkaFindingsCard.test.ts
// SIO-775: KafkaFindingsCard renders typed kafka findings inline in chat.
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import KafkaFindingsCard from "./KafkaFindingsCard.svelte";

describe("KafkaFindingsCard.svelte", () => {
	test("renders nothing when findings has no consumerGroups or dlqTopics", () => {
		const { body } = render(KafkaFindingsCard, { props: { findings: {} } });
		expect(body).not.toContain("Kafka findings");
		expect(body).not.toContain("Consumer groups");
		expect(body).not.toContain("DLQ topics");
	});

	test("renders DLQ topics with up-arrow when recentDelta > 0", () => {
		const { body } = render(KafkaFindingsCard, {
			props: {
				findings: {
					dlqTopics: [{ name: "orders.dlq", totalMessages: 17, recentDelta: 3 }],
				},
			},
		});
		expect(body).toContain("Kafka findings");
		expect(body).toContain("DLQ topics");
		expect(body).toContain("orders.dlq");
		expect(body).toContain("17");
		expect(body).toContain("▲");
		// No consumer-groups section when array is missing
		expect(body).not.toContain("Consumer groups");
	});

	test("renders DLQ topic with 'no baseline' when recentDelta is null", () => {
		const { body } = render(KafkaFindingsCard, {
			props: {
				findings: {
					dlqTopics: [{ name: "events.dlq", totalMessages: 5, recentDelta: null }],
				},
			},
		});
		expect(body).toContain("events.dlq");
		expect(body).toContain("no baseline");
	});

	test("renders both consumer groups and DLQ topics with full payload", () => {
		const { body } = render(KafkaFindingsCard, {
			props: {
				findings: {
					consumerGroups: [
						{ id: "pim-sink", state: "Stable", totalLag: 42 },
						{ id: "orders-consumer", state: "Rebalancing", totalLag: 1500 },
					],
					dlqTopics: [
						{ name: "orders.dlq", totalMessages: 17, recentDelta: 3 },
						{ name: "events.dlq", totalMessages: 200, recentDelta: -5 },
					],
				},
			},
		});
		expect(body).toContain("Consumer groups");
		expect(body).toContain("DLQ topics");
		expect(body).toContain("pim-sink");
		expect(body).toContain("orders-consumer");
		expect(body).toContain("orders.dlq");
		expect(body).toContain("events.dlq");
		expect(body).toContain("▲");
		expect(body).toContain("▼");
	});
});
