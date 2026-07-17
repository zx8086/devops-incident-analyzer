// agent/src/kg-retention.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { _setGraphStoreForTesting, type GraphStore } from "@devops-agent/knowledge-graph";
import { purgeCronEnabled, runUncuratedPurgeSweep, uncuratedRetentionDays } from "./kg-retention.ts";

interface RunCall {
	cypher: string;
	params?: Record<string, unknown>;
}

function stubStore(calls: RunCall[], countRows: Record<string, unknown>[] = []): GraphStore {
	return {
		init: async () => undefined,
		run: async (cypher: string, params?: Record<string, unknown>) => {
			calls.push({ cypher, params });
			if (cypher.includes("count(i) AS n")) return countRows;
			return [];
		},
		close: async () => undefined,
	} as GraphStore;
}

afterEach(() => {
	_setGraphStoreForTesting(null);
});

describe("SIO-1135 uncuratedRetentionDays", () => {
	test("defaults to 30 when unset or blank or non-numeric", () => {
		expect(uncuratedRetentionDays({} as NodeJS.ProcessEnv)).toBe(30);
		expect(uncuratedRetentionDays({ KG_UNCURATED_RETENTION_DAYS: "" } as NodeJS.ProcessEnv)).toBe(30);
		expect(uncuratedRetentionDays({ KG_UNCURATED_RETENTION_DAYS: "nope" } as NodeJS.ProcessEnv)).toBe(30);
	});
	test("parses an explicit numeric window, including 0 (disable)", () => {
		expect(uncuratedRetentionDays({ KG_UNCURATED_RETENTION_DAYS: "7" } as NodeJS.ProcessEnv)).toBe(7);
		expect(uncuratedRetentionDays({ KG_UNCURATED_RETENTION_DAYS: "0" } as NodeJS.ProcessEnv)).toBe(0);
	});
});

describe("SIO-1135 purgeCronEnabled", () => {
	test("defaults OFF and requires BOTH the cron flag and KNOWLEDGE_GRAPH_ENABLED", () => {
		expect(purgeCronEnabled({} as NodeJS.ProcessEnv)).toBe(false);
		expect(purgeCronEnabled({ KG_PURGE_CRON_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(false);
		expect(purgeCronEnabled({ KNOWLEDGE_GRAPH_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(false);
		expect(
			purgeCronEnabled({ KG_PURGE_CRON_ENABLED: "true", KNOWLEDGE_GRAPH_ENABLED: "true" } as NodeJS.ProcessEnv),
		).toBe(true);
		expect(purgeCronEnabled({ KG_PURGE_CRON_ENABLED: "1", KNOWLEDGE_GRAPH_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(
			true,
		);
	});
});

describe("SIO-1135 runUncuratedPurgeSweep", () => {
	test("skips when the knowledge graph is disabled", async () => {
		const result = await runUncuratedPurgeSweep({ env: {} as NodeJS.ProcessEnv });
		expect(result).toEqual({ skipped: "kg-disabled" });
	});

	test("skips when the retention window is non-positive (disabled)", async () => {
		const result = await runUncuratedPurgeSweep({
			env: { KNOWLEDGE_GRAPH_ENABLED: "true", KG_UNCURATED_RETENTION_DAYS: "0" } as NodeJS.ProcessEnv,
		});
		expect(result).toEqual({ skipped: "retention-disabled", retentionDays: 0 });
	});

	test("purges with a computed cutoff and returns counts", async () => {
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls, [{ n: 2 }]));
		const result = await runUncuratedPurgeSweep({
			env: { KNOWLEDGE_GRAPH_ENABLED: "true", KG_UNCURATED_RETENTION_DAYS: "30" } as NodeJS.ProcessEnv,
		});
		expect(result.incidents).toBe(2);
		expect(result.retentionDays).toBe(30);
		// The cutoff is an ISO string bound as $cutoff on every purge statement.
		const cutoff = calls.find((c) => c.cypher.includes("count(i) AS n"))?.params?.cutoff;
		expect(typeof cutoff).toBe("string");
		expect(String(cutoff)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});
