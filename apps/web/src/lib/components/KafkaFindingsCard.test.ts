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

	// SIO-785 follow-up (2026-05-18): new sections — cluster, connectors, ksqlQueries.
	test("renders cluster summary tile when findings.cluster is set", () => {
		const { body } = render(KafkaFindingsCard, {
			props: {
				findings: {
					cluster: { provider: "msk", brokerCount: 3, topicCount: 42, controllerId: 2 },
				},
			},
		});
		expect(body).toContain("Kafka findings");
		expect(body).toContain("msk");
		expect(body).toContain("3"); // brokerCount
		expect(body).toContain("42"); // topicCount
		expect(body).toContain("Controller");
	});

	test("renders Connect connectors section with state dots + per-state aggregate", () => {
		const { body } = render(KafkaFindingsCard, {
			props: {
				findings: {
					connectors: [
						{ name: "C_SINK_COUCHBASE_ARTICLES_V3", state: "RUNNING", type: "sink", taskFailures: 0 },
						{ name: "C_SOURCE_PIM_VARIANTS", state: "FAILED", type: "source", taskFailures: 1 },
					],
				},
			},
		});
		expect(body).toContain("Connect connectors");
		expect(body).toContain("C_SINK_COUCHBASE_ARTICLES_V3");
		expect(body).toContain("C_SOURCE_PIM_VARIANTS");
		expect(body).toContain("1 task fail");
		// State counts: "1 RUNNING" + "1 FAILED" in some order.
		expect(body).toMatch(/RUNNING|FAILED/);
	});

	test("renders ksqlDB queries with status count compaction when distribution is mixed", () => {
		const { body } = render(KafkaFindingsCard, {
			props: {
				findings: {
					ksqlQueries: [
						{
							id: "CSAS_S_PRIVATE_SINK_PIM_VARIANTS_V3_4859",
							state: "RUNNING",
							queryType: "PERSISTENT",
							statusCount: { RUNNING: 1, UNRESPONSIVE: 2 },
						},
					],
				},
			},
		});
		expect(body).toContain("ksqlDB queries");
		expect(body).toContain("CSAS_S_PRIVATE_SINK_PIM_VARIANTS_V3_4859");
		// statusCount compacted as "1R 2U"
		expect(body).toContain("1R");
		expect(body).toContain("2U");
	});

	test("renders nothing when ALL findings sections are empty including new ones", () => {
		const { body } = render(KafkaFindingsCard, { props: { findings: {} } });
		expect(body).not.toContain("Kafka findings");
		expect(body).not.toContain("Connect connectors");
		expect(body).not.toContain("ksqlDB queries");
	});

	test("renders both consumer groups and DLQ topics with full payload", () => {
		const { body } = render(KafkaFindingsCard, {
			props: {
				findings: {
					consumerGroups: [
						{ id: "pim-sink", state: "STABLE", totalLag: 42 },
						{ id: "orders-consumer", state: "PREPARING_REBALANCE", totalLag: 1500 },
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
