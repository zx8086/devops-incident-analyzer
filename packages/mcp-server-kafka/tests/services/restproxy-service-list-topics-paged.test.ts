// tests/services/restproxy-service-list-topics-paged.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppConfig } from "../../src/config/schemas";
import { RestProxyService } from "../../src/services/restproxy-service";

let originalFetch: typeof globalThis.fetch;
const baseConfig = {
	restproxy: { enabled: true, url: "http://rest:8082", apiKey: "", apiSecret: "" },
} as unknown as AppConfig;

function mockFetch(status: number, body: unknown = "") {
	globalThis.fetch = mock(() =>
		Promise.resolve(
			new Response(typeof body === "string" ? body : JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/vnd.kafka.v2+json" },
			}),
		),
	) as unknown as typeof globalThis.fetch;
}

function topicSeries(count: number, prefix = "topic-"): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);
}

describe("RestProxyService.listTopicsPaged (SIO-736)", () => {
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("500-topic upstream + default limit returns 100 + truncated + hint", async () => {
		mockFetch(200, topicSeries(500));
		const svc = new RestProxyService(baseConfig);
		const r = await svc.listTopicsPaged({ limit: 100, offset: 0 });

		expect(r.topics.length).toBe(100);
		expect(r.total).toBe(500);
		expect(r.truncated).toBe(true);
		expect(r.hint).toContain("prefix");
	});

	test("prefix narrows the result set", async () => {
		mockFetch(200, [...topicSeries(450, "other-"), ...topicSeries(50, "DLQ_")]);
		const svc = new RestProxyService(baseConfig);
		const r = await svc.listTopicsPaged({ prefix: "DLQ_", limit: 100, offset: 0 });

		expect(r.total).toBe(50);
		expect(r.topics.every((t) => t.name.startsWith("DLQ_"))).toBe(true);
		expect(r.truncated).toBe(false);
	});

	test("offset past the end returns past-the-end hint", async () => {
		mockFetch(200, topicSeries(10));
		const svc = new RestProxyService(baseConfig);
		const r = await svc.listTopicsPaged({ limit: 50, offset: 100 });

		expect(r.topics).toEqual([]);
		expect(r.total).toBe(10);
		expect(r.hint).toContain("past the end");
	});

	test("hits GET /topics with v2 content-type headers", async () => {
		mockFetch(200, topicSeries(5));
		const svc = new RestProxyService(baseConfig);
		await svc.listTopicsPaged({ limit: 100, offset: 0 });
		const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		expect(call[0]).toBe("http://rest:8082/topics");
		expect((call[1] as RequestInit).method).toBe("GET");
		const headers = new Headers((call[1] as RequestInit).headers);
		expect(headers.get("Accept")).toBe("application/vnd.kafka.v2+json");
	});
});
