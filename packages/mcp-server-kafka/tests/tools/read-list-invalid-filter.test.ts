// tests/tools/read-list-invalid-filter.test.ts
import { describe, expect, mock, test } from "bun:test";
import { isDegradingCategory } from "@devops-agent/shared";
import type { Admin } from "@platformatic/kafka";
import type { KafkaClientManager } from "../../src/services/client-manager.ts";
import { KafkaService } from "../../src/services/kafka-service.ts";
import { listConsumerGroups, listTopics } from "../../src/tools/read/operations.ts";

// SIO-1105: a metacharacter-bearing filter (e.g. "foo(?bar") must NOT throw
// "Invalid regular expression" (-32603). The list ops catch the invalid regex
// (validated in the service via compileFilterOrThrow) and return the SIO-1087
// structured { _error } envelope with a NON-degrading not-found category, so
// isDegradingCategory() treats a routine bad filter as a discovery outcome
// rather than a tool malfunction.

// A real KafkaService over a fake Admin so the actual regex-validation path runs.
function buildService(topicNames: string[], groupIds: string[]): KafkaService {
	const fakeAdmin = {
		listTopics: mock(async () => topicNames),
		listGroups: mock(
			async () =>
				new Map(groupIds.map((id) => [id, { id, state: "STABLE", groupType: "consumer", protocolType: "consumer" }])),
		),
	} as unknown as Admin;
	const manager = {
		withAdmin: async <T>(fn: (admin: Admin) => Promise<T>): Promise<T> => fn(fakeAdmin),
	} as unknown as KafkaClientManager;
	return new KafkaService(manager);
}

function assertNonDegradingNoDataEnvelope(result: unknown) {
	expect(result).toBeObject();
	const envelope = result as { _error?: { kind?: string; category?: string; message?: string; advice?: string } };
	expect(envelope._error).toBeDefined();
	expect(envelope._error?.kind).toBe("not-found");
	expect(envelope._error?.category).toBe("not-found");
	expect(isDegradingCategory(envelope._error?.category as never)).toBe(false);
	// The advice steers the caller toward 'prefix' / escaping instead of a raw regex.
	expect(envelope._error?.advice).toContain("prefix");
}

describe("kafka_list_topics op with a metacharacter filter (SIO-1105)", () => {
	test("returns a structured non-degrading no-data envelope, does not throw", async () => {
		const svc = buildService(["orders", "payments"], []);
		const result = await listTopics(svc, { filter: "foo(?bar" });
		assertNonDegradingNoDataEnvelope(result);
	});

	test("a valid filter still returns the normal paged shape", async () => {
		const svc = buildService(["orders-us", "orders-eu", "payments"], []);
		const result = await listTopics(svc, { filter: "^orders-" });
		expect(result).toHaveProperty("topics");
		const paged = result as { topics: { name: string }[]; total: number };
		expect(paged.total).toBe(2);
		expect(paged.topics.every((t) => t.name.startsWith("orders-"))).toBe(true);
	});
});

describe("kafka_list_consumer_groups op with a metacharacter filter (SIO-1105)", () => {
	test("returns a structured non-degrading no-data envelope, does not throw", async () => {
		const svc = buildService([], ["group-a", "group-b"]);
		const result = await listConsumerGroups(svc, { filter: "foo(?bar" });
		assertNonDegradingNoDataEnvelope(result);
	});

	test("a valid filter still returns the normal group list", async () => {
		const svc = buildService([], ["orders-consumer", "payments-consumer"]);
		const result = await listConsumerGroups(svc, { filter: "^orders-" });
		expect(Array.isArray(result)).toBe(true);
		const groups = result as { id: string }[];
		expect(groups.map((g) => g.id)).toEqual(["orders-consumer"]);
	});
});
