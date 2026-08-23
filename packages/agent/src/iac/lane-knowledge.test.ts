// agent/src/iac/lane-knowledge.test.ts
//
// SIO-1461: unit tests for the non-gitops-lane ConfigChange writer + outcome mappers.
// lane-knowledge.ts is a dependency-free leaf (no memory-backend import), so unlike
// graph-knowledge.test.ts this file needs no mock.module machinery -- just the
// KNOWLEDGE_GRAPH_ENABLED env save/restore and store injection.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _setGraphStoreForTesting, type GraphRow, InMemoryGraphStore } from "@devops-agent/knowledge-graph";
import {
	attachLaneChangeMr,
	attachLaneChangeMrBySummary,
	fleetChangeOutcome,
	type LaneChangeInput,
	reconcileChangeOutcome,
	recordLaneConfigChange,
	syntheticsChangeOutcome,
} from "./lane-knowledge.ts";

const prev = process.env.KNOWLEDGE_GRAPH_ENABLED;

function laneInput(over: Partial<LaneChangeInput> = {}): LaneChangeInput {
	return {
		id: "req-1",
		deployment: "eu-b2b",
		workflow: "drift-reconcile",
		outcome: "proposed",
		summary: "reconcile lifecycle-policies (reconcile-to-live)",
		mrUrl: "https://gitlab.com/x/-/merge_requests/9",
		stackInstanceId: "eu-b2b/lifecycle-policies",
		threadId: "thread-1",
		...over,
	};
}

beforeEach(() => {
	_setGraphStoreForTesting(null);
});

afterEach(() => {
	if (prev === undefined) delete process.env.KNOWLEDGE_GRAPH_ENABLED;
	else process.env.KNOWLEDGE_GRAPH_ENABLED = prev;
	_setGraphStoreForTesting(null);
});

describe("recordLaneConfigChange", () => {
	test("is a no-op when the graph is disabled", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		await recordLaneConfigChange(laneInput());
		expect(store.calls).toEqual([]);
	});

	test("is a no-op when the outcome is null (skipped/blocked)", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		await recordLaneConfigChange(laneInput({ outcome: null }));
		expect(store.calls).toEqual([]);
	});

	test("is a no-op when id or deployment is empty", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		await recordLaneConfigChange(laneInput({ id: "" }));
		await recordLaneConfigChange(laneInput({ deployment: "" }));
		expect(store.calls).toEqual([]);
	});

	test("is a no-op when workflow is empty (would drop the VIA_WORKFLOW edge)", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		await recordLaneConfigChange(laneInput({ workflow: "" }));
		expect(store.calls).toEqual([]);
	});

	test("is a no-op when outcome is not a valid ChangeOutcome", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		// A caller bypassing the type system (the exported seam) must not corrupt the graph.
		await recordLaneConfigChange(laneInput({ outcome: "bogus" as unknown as LaneChangeInput["outcome"] }));
		expect(store.calls).toEqual([]);
	});

	test("writes deployment + ConfigChange + CHANGED_BY + PROPOSED_IN + TARGETS for a reconcile MR", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		await recordLaneConfigChange(
			laneInput({ id: "req-1:lifecycle-policies:reconcile-to-live", workflow: "drift-reconcile" }),
		);
		expect(
			store.calls.some((c) => c.cypher.includes("MERGE (d:ElasticDeployment") && c.params?.name === "eu-b2b"),
		).toBe(true);
		expect(
			store.calls.some(
				(c) =>
					c.cypher.includes("MERGE (c:ConfigChange") && c.params?.id === "req-1:lifecycle-policies:reconcile-to-live",
			),
		).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("CHANGED_BY"))).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("PROPOSED_IN"))).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("VIA_WORKFLOW") && c.params?.name === "drift-reconcile")).toBe(
			true,
		);
		expect(store.calls.some((c) => c.cypher.includes("TARGETS") && c.params?.sid === "eu-b2b/lifecycle-policies")).toBe(
			true,
		);
	});

	test("writes ConfigChange WITHOUT PROPOSED_IN/TARGETS for a fleet/synthetics change (no MR, no stack)", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		await recordLaneConfigChange({
			id: "req-1",
			deployment: "eu-b2b",
			workflow: "fleet-upgrade",
			outcome: "applied",
			summary: "fleet upgrade eu-b2b -> 8.15.0",
			threadId: "thread-1",
		});
		expect(store.calls.some((c) => c.cypher.includes("MERGE (c:ConfigChange") && c.params?.id === "req-1")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("CHANGED_BY"))).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("VIA_WORKFLOW") && c.params?.name === "fleet-upgrade")).toBe(true);
		// No MR and no stackInstance were supplied, so those attachments must not be written.
		expect(store.calls.some((c) => c.cypher.includes("PROPOSED_IN"))).toBe(false);
		expect(store.calls.some((c) => c.cypher.includes("TARGETS"))).toBe(false);
		const change = store.calls.find((c) => c.cypher.includes("MERGE (c:ConfigChange"));
		expect(change?.params?.outcome).toBe("applied");
	});

	test("soft-fails (no throw) when the store throws", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		class ThrowingGraphStore extends InMemoryGraphStore {
			override async run<T extends GraphRow = GraphRow>(): Promise<T[]> {
				throw new Error("graph down");
			}
		}
		_setGraphStoreForTesting(new ThrowingGraphStore());
		// Must resolve (not reject) so the lane continues.
		await expect(recordLaneConfigChange(laneInput())).resolves.toBeUndefined();
	});
});

describe("attachLaneChangeMr (SIO-1527)", () => {
	const MR_URL = "https://gitlab.com/x/-/merge_requests/42";

	test("is a no-op when the graph is disabled", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		await attachLaneChangeMr("req-1", MR_URL);
		expect(store.calls).toHaveLength(0);
	});

	test("empty changeId or mrUrl is a no-op", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		await attachLaneChangeMr("", MR_URL);
		await attachLaneChangeMr("req-1", "");
		expect(store.calls).toHaveLength(0);
	});

	test("edge-only: MERGEs the MergeRequest + PROPOSED_IN and never touches ConfigChange properties", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		// The existence pre-check (no orphan MergeRequest when the trigger write soft-failed)
		// must see the trigger-time node.
		store.stub("MATCH (c:ConfigChange {id: $id}) RETURN c.id", [{ id: "req-1" }]);
		_setGraphStoreForTesting(store);
		await attachLaneChangeMr("req-1", MR_URL);
		expect(store.calls.some((c) => c.cypher.includes("MERGE (m:MergeRequest") && c.params?.url === MR_URL)).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("PROPOSED_IN") && c.params?.id === "req-1")).toBe(true);
		// The whole point vs recordIacChange: the ConfigChange node's summary/createdAt/outcome
		// must NOT be re-SET by this write.
		expect(store.calls.some((c) => c.cypher.includes("MERGE (c:ConfigChange"))).toBe(false);
		expect(store.calls.some((c) => c.cypher.includes("SET c."))).toBe(false);
	});

	test("writes nothing (no orphan MergeRequest) when the ConfigChange does not exist", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		await attachLaneChangeMr("req-unknown", MR_URL);
		expect(store.calls.some((c) => c.cypher.includes("MERGE (m:MergeRequest"))).toBe(false);
		expect(store.calls.some((c) => c.cypher.includes("PROPOSED_IN"))).toBe(false);
	});

	test("soft-fails (no throw) when the store throws", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		class ThrowingGraphStore extends InMemoryGraphStore {
			override async run<T extends GraphRow = GraphRow>(): Promise<T[]> {
				throw new Error("graph down");
			}
		}
		_setGraphStoreForTesting(new ThrowingGraphStore());
		await expect(attachLaneChangeMr("req-1", MR_URL)).resolves.toBeUndefined();
	});
});

describe("attachLaneChangeMrBySummary (SIO-1527 legacy-marker recovery)", () => {
	const MR_URL = "https://gitlab.com/x/-/merge_requests/42";
	const SUMMARY = "renovate eu-b2b -> renovate-eu-b2b-prometheus";

	test("recovers the newest proposed node by summary and attaches the MR", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("c.summary = $summary", [
			{ id: "req-old", createdAt: "2026-08-19T10:00:00.000Z" },
			{ id: "req-new", createdAt: "2026-08-20T10:00:00.000Z" },
		]);
		// The attach's own existence pre-check must also see the recovered node.
		store.stub("MATCH (c:ConfigChange {id: $id}) RETURN c.id", [{ id: "req-new" }]);
		_setGraphStoreForTesting(store);
		await attachLaneChangeMrBySummary("renovate", SUMMARY, MR_URL);
		expect(store.calls.some((c) => c.cypher.includes("PROPOSED_IN") && c.params?.id === "req-new")).toBe(true);
	});

	test("nearIso anchors selection to the marker's OWN trigger, not a newer re-trigger", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("c.summary = $summary", [
			{ id: "req-legacy", createdAt: "2026-08-19T10:00:05.000Z" },
			{ id: "req-newer-trigger", createdAt: "2026-08-22T09:00:00.000Z" },
		]);
		store.stub("MATCH (c:ConfigChange {id: $id}) RETURN c.id", [{ id: "req-legacy" }]);
		_setGraphStoreForTesting(store);
		// The legacy marker's triggerAtIso is seconds before its own node's createdAt.
		await attachLaneChangeMrBySummary("renovate", SUMMARY, MR_URL, "2026-08-19T10:00:00.000Z");
		expect(store.calls.some((c) => c.cypher.includes("PROPOSED_IN") && c.params?.id === "req-legacy")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("PROPOSED_IN") && c.params?.id === "req-newer-trigger")).toBe(
			false,
		);
	});

	test("equal createdAt resolves deterministically via the id tiebreak", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		for (const order of [0, 1]) {
			const store = new InMemoryGraphStore();
			const rows = [
				{ id: "req-a", createdAt: "2026-08-20T10:00:00.000Z" },
				{ id: "req-b", createdAt: "2026-08-20T10:00:00.000Z" },
			];
			store.stub("c.summary = $summary", order === 0 ? rows : [...rows].reverse());
			store.stub("MATCH (c:ConfigChange {id: $id}) RETURN c.id", [{ id: "req-a" }]);
			_setGraphStoreForTesting(store);
			await attachLaneChangeMrBySummary("renovate", SUMMARY, MR_URL);
			// Same winner regardless of row order returned by the store.
			expect(store.calls.some((c) => c.cypher.includes("PROPOSED_IN") && c.params?.id === "req-a")).toBe(true);
		}
	});

	test("no matching proposed node is a logged no-op", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		await attachLaneChangeMrBySummary("renovate", SUMMARY, MR_URL);
		expect(store.calls.some((c) => c.cypher.includes("MERGE (m:MergeRequest"))).toBe(false);
		expect(store.calls.some((c) => c.cypher.includes("PROPOSED_IN"))).toBe(false);
	});

	test("gated off and soft-failing like the id-keyed attach", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		await attachLaneChangeMrBySummary("renovate", SUMMARY, MR_URL);
		expect(store.calls).toHaveLength(0);

		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		class ThrowingGraphStore extends InMemoryGraphStore {
			override async run<T extends GraphRow = GraphRow>(): Promise<T[]> {
				throw new Error("graph down");
			}
		}
		_setGraphStoreForTesting(new ThrowingGraphStore());
		await expect(attachLaneChangeMrBySummary("renovate", SUMMARY, MR_URL)).resolves.toBeUndefined();
	});
});

describe("outcome mappers", () => {
	test("reconcileChangeOutcome: opened/reused -> proposed, skipped/blocked -> null", () => {
		expect(reconcileChangeOutcome("opened")).toBe("proposed");
		expect(reconcileChangeOutcome("reused")).toBe("proposed");
		expect(reconcileChangeOutcome("skipped")).toBeNull();
		expect(reconcileChangeOutcome("blocked")).toBeNull();
	});

	test("fleetChangeOutcome: applied/partial -> applied, dispatched -> proposed, failed -> failed, else null", () => {
		expect(fleetChangeOutcome("applied")).toBe("applied");
		expect(fleetChangeOutcome("partial")).toBe("applied");
		expect(fleetChangeOutcome("dispatched")).toBe("proposed");
		expect(fleetChangeOutcome("failed")).toBe("failed");
		expect(fleetChangeOutcome("skipped")).toBeNull();
		expect(fleetChangeOutcome("blocked")).toBeNull();
	});

	test("syntheticsChangeOutcome: pushed -> applied, failed -> failed, skipped/blocked -> null", () => {
		expect(syntheticsChangeOutcome("pushed")).toBe("applied");
		expect(syntheticsChangeOutcome("failed")).toBe("failed");
		expect(syntheticsChangeOutcome("skipped")).toBeNull();
		expect(syntheticsChangeOutcome("blocked")).toBeNull();
	});
});
