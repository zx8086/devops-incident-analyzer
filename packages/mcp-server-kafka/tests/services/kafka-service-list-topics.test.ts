// tests/services/kafka-service-list-topics.test.ts
import { describe, expect, mock, test } from "bun:test";
import type { Admin } from "@platformatic/kafka";
import type { KafkaClientManager } from "../../src/services/client-manager.ts";
import { KafkaService } from "../../src/services/kafka-service.ts";

function buildManager(topicNames: string[]): KafkaClientManager {
	const fakeAdmin = {
		listTopics: mock(async () => topicNames),
	} as unknown as Admin;
	return {
		withAdmin: async <T>(fn: (admin: Admin) => Promise<T>): Promise<T> => fn(fakeAdmin),
	} as unknown as KafkaClientManager;
}

function topicSeries(count: number, prefix = "topic-"): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);
}

describe("KafkaService.listTopicsPaged (SIO-731)", () => {
	test("500 topics + default limit returns 100, truncated with hint", async () => {
		const svc = new KafkaService(buildManager(topicSeries(500)));
		const r = await svc.listTopicsPaged({ limit: 100, offset: 0 });

		expect(r.topics.length).toBe(100);
		expect(r.total).toBe(500);
		expect(r.truncated).toBe(true);
		expect(r.hint).toBeDefined();
		expect(r.hint).toContain("prefix");
		expect(r.hint).toContain("offset");
	});

	test("500 topics + limit 500 returns everything, no truncation, no hint", async () => {
		const svc = new KafkaService(buildManager(topicSeries(500)));
		const r = await svc.listTopicsPaged({ limit: 500, offset: 0 });

		expect(r.topics.length).toBe(500);
		expect(r.total).toBe(500);
		expect(r.truncated).toBe(false);
		expect(r.hint).toBeUndefined();
	});

	test("prefix narrows the result set (50 of 500 match 'user-')", async () => {
		const others = topicSeries(450, "other-");
		const users = topicSeries(50, "user-");
		const svc = new KafkaService(buildManager([...others, ...users]));
		const r = await svc.listTopicsPaged({ prefix: "user-", limit: 100, offset: 0 });

		expect(r.topics.length).toBe(50);
		expect(r.total).toBe(50);
		expect(r.truncated).toBe(false);
		expect(r.topics.every((t) => t.name.startsWith("user-"))).toBe(true);
	});

	test("prefix + default limit: 50 matches under default 100 -> not truncated", async () => {
		const svc = new KafkaService(buildManager([...topicSeries(450, "other-"), ...topicSeries(50, "user-")]));
		const r = await svc.listTopicsPaged({ prefix: "user-", limit: 100, offset: 0 });

		expect(r.topics.length).toBe(50);
		expect(r.truncated).toBe(false);
	});

	test("offset + limit slices a middle window", async () => {
		const all = topicSeries(500); // sorted: topic-0000 .. topic-0499
		const svc = new KafkaService(buildManager(all));
		const r = await svc.listTopicsPaged({ limit: 50, offset: 100 });

		expect(r.topics.length).toBe(50);
		expect(r.topics[0]?.name).toBe("topic-0100");
		expect(r.topics[49]?.name).toBe("topic-0149");
		expect(r.total).toBe(500);
		expect(r.truncated).toBe(true);
	});

	test("offset near the end returns the partial tail, not truncated", async () => {
		const svc = new KafkaService(buildManager(topicSeries(500)));
		const r = await svc.listTopicsPaged({ limit: 50, offset: 480 });

		expect(r.topics.length).toBe(20);
		expect(r.topics[0]?.name).toBe("topic-0480");
		expect(r.topics[19]?.name).toBe("topic-0499");
		expect(r.truncated).toBe(false);
		expect(r.hint).toBeUndefined();
	});

	test("empty cluster returns clean zero shape, no hint", async () => {
		const svc = new KafkaService(buildManager([]));
		const r = await svc.listTopicsPaged({ limit: 100, offset: 0 });

		expect(r.topics).toEqual([]);
		expect(r.total).toBe(0);
		expect(r.truncated).toBe(false);
		expect(r.hint).toBeUndefined();
	});

	test("offset past the end emits 'past the end' hint", async () => {
		const svc = new KafkaService(buildManager(topicSeries(500)));
		const r = await svc.listTopicsPaged({ limit: 50, offset: 1000 });

		expect(r.topics).toEqual([]);
		expect(r.total).toBe(500);
		expect(r.truncated).toBe(false);
		expect(r.hint).toBeDefined();
		expect(r.hint).toContain("past the end");
		expect(r.hint).toContain("500");
	});

	test("prefix applied before regex filter — both narrow to the same set", async () => {
		// 50 'T_*' topics, 10 of which end in '_DLQ'; plus 100 unrelated.
		const tDlq = topicSeries(10, "T_dlq_"); // T_dlq_0000..0009
		const tNorm = topicSeries(40, "T_norm_");
		const unrelated = topicSeries(100, "z-other-");
		const svc = new KafkaService(buildManager([...unrelated, ...tNorm, ...tDlq]));

		const r = await svc.listTopicsPaged({ prefix: "T_", filter: "^T_dlq_", limit: 100, offset: 0 });

		expect(r.topics.length).toBe(10);
		expect(r.total).toBe(10);
		expect(r.topics.every((t) => t.name.startsWith("T_dlq_"))).toBe(true);
	});

	test("sort determinism: shuffled admin output produces sorted result", async () => {
		const sorted = topicSeries(20);
		const shuffled = [...sorted].sort(() => Math.random() - 0.5);
		const svc = new KafkaService(buildManager(shuffled));
		const r = await svc.listTopicsPaged({ limit: 100, offset: 0 });

		expect(r.topics.map((t) => t.name)).toEqual(sorted);
	});
});
