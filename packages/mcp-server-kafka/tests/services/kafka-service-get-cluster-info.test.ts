// tests/services/kafka-service-get-cluster-info.test.ts
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
		getProvider: () => ({
			type: "local",
			name: "local-kafka",
			getClusterMetadata: async () => ({ brokerCount: 3 }),
		}),
	} as unknown as KafkaClientManager;
}

function topicSeries(count: number, prefix = "topic-"): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);
}

describe("KafkaService.getClusterInfo (SIO-735 — paginated)", () => {
	test("500 topics + default limit returns topicCount 500, 100 topics in page, truncated", async () => {
		const svc = new KafkaService(buildManager(topicSeries(500)));
		const r = await svc.getClusterInfo({ limit: 100, offset: 0 });

		expect(r.topicCount).toBe(500);
		expect((r.topics as { name: string }[]).length).toBe(100);
		expect(r.total).toBe(500);
		expect(r.truncated).toBe(true);
		expect(r.hint).toBeDefined();
		expect(r.provider).toBe("local");
		expect(r.providerName).toBe("local-kafka");
		expect(r.brokerCount).toBe(3);
	});

	test("prefix narrows topics to the matching subset", async () => {
		const all = [...topicSeries(450, "other-"), ...topicSeries(50, "DLQ_")];
		const svc = new KafkaService(buildManager(all));
		const r = await svc.getClusterInfo({ prefix: "DLQ_", limit: 100, offset: 0 });

		expect(r.topicCount).toBe(500); // unfiltered count for the aggregate
		expect(r.total).toBe(50);
		expect((r.topics as { name: string }[]).every((t) => t.name.startsWith("DLQ_"))).toBe(true);
		expect(r.truncated).toBe(false);
	});

	test("offset past the end returns past-the-end hint", async () => {
		const svc = new KafkaService(buildManager(topicSeries(10)));
		const r = await svc.getClusterInfo({ limit: 50, offset: 100 });

		expect(r.topicCount).toBe(10);
		expect(r.topics as { name: string }[]).toEqual([]);
		expect(r.hint).toContain("past the end");
	});

	test("admin listTopics failure still returns provider metadata with empty topics", async () => {
		const fakeAdmin = {
			listTopics: mock(async () => {
				throw new Error("boom");
			}),
		} as unknown as Admin;
		const mgr = {
			withAdmin: async <T>(fn: (admin: Admin) => Promise<T>): Promise<T> => fn(fakeAdmin),
			getProvider: () => ({
				type: "local",
				name: "local-kafka",
				getClusterMetadata: async () => ({ brokerCount: 1 }),
			}),
		} as unknown as KafkaClientManager;
		const svc = new KafkaService(mgr);
		const r = await svc.getClusterInfo({ limit: 100, offset: 0 });

		expect(r.topicCount).toBe(0);
		expect(r.topics as { name: string }[]).toEqual([]);
		expect(r.brokerCount).toBe(1);
	});
});
