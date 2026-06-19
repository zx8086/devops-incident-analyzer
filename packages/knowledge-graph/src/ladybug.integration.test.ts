// knowledge-graph/src/ladybug.integration.test.ts
//
// SIO-850: integration test against the REAL embedded LadybugDB engine. lbug is
// an OPTIONAL native dependency; this suite skips when it is not installed/built
// (bun blocks the package's native postinstall by default), so it is a no-op on
// machines that have not opted into the graph, and a real round-trip where they
// have. It caught the prepare()/execute() parameter-binding contract that the
// in-memory fake could not.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	changeHistoryForStackInstance,
	deploymentsRunningStack,
	priorChangesForDeployment,
	priorRelationshipsForServices,
	stacksUsingModule,
	topology,
} from "./reader.ts";
import { LadybugStore } from "./store.ts";
import {
	linkStackModule,
	recordIacChange,
	recordIncident,
	recordPipeline,
	seedDeployments,
	seedModules,
	seedStackInstances,
	seedStacks,
	setChangeOutcome,
	upsertEntities,
} from "./writer.ts";

// Detect whether the lbug native module is actually loadable (installed AND its
// entry points materialized). Skip the suite otherwise.
async function lbugLoadable(): Promise<boolean> {
	try {
		const specifier: string = "lbug";
		await import(specifier);
		return true;
	} catch {
		return false;
	}
}

const available = await lbugLoadable();
const dir = available ? mkdtempSync(join(tmpdir(), "lbug-it-")) : "";
afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!available)("LadybugStore (real embedded engine)", () => {
	test("init -> parameterized write -> read round-trip", async () => {
		const store = new LadybugStore(join(dir, "db"));
		await store.init();

		await upsertEntities(store, {
			services: ["svc-a", "svc-b"],
			dependencies: [{ from: "svc-a", to: "svc-b" }],
		});
		await recordIncident(store, { id: "inc-1", severity: "high", summary: "kafka lag", services: ["svc-a"] });

		// reader read-back
		expect(await priorRelationshipsForServices(store, ["svc-a"])).toEqual([{ from: "svc-a", to: "svc-b" }]);
		expect(await topology(store)).toContainEqual({ from: "svc-a", to: "svc-b" });

		// raw parameterized read
		const incidents = await store.run<{ id: string; severity: string }>(
			"MATCH (i:Incident {id: $id}) RETURN i.id AS id, i.severity AS severity",
			{ id: "inc-1" },
		);
		expect(incidents).toEqual([{ id: "inc-1", severity: "high" }]);

		await store.close();
	});

	test("MERGE is idempotent (re-running does not duplicate)", async () => {
		const store = new LadybugStore(join(dir, "db2"));
		await store.init();
		await upsertEntities(store, { services: ["svc-x"] });
		await upsertEntities(store, { services: ["svc-x"] });
		const rows = await store.run<{ n: number }>("MATCH (s:Service {name: $name}) RETURN count(s) AS n", {
			name: "svc-x",
		});
		expect(Number(rows[0]?.n)).toBe(1);
		await store.close();
	});

	// SIO-954/SIO-965: IaC round-trips against the real engine. Both share ONE store
	// (db3) deliberately -- the embedded lbug Database is never close()d (its native
	// finalizer segfaults Bun at teardown; see store.ts), so each extra Database
	// instance leaks a handle that is finalized at process exit. Keeping the IaC
	// round-trips on a single DB holds the file's total at three and avoids tipping
	// that finalizer over. SIO-965 additionally exercises the ALTER_MIGRATIONS outcome
	// column and the new blast-radius Cypher on the real binder.
	test("IaC change-history + three-layer round-trip", async () => {
		const store = new LadybugStore(join(dir, "db3"));
		await store.init();

		// SIO-954: deployment change history.
		await recordIacChange(store, {
			id: "req-1",
			deployment: "eu-b2b",
			workflow: "ilm-rollout",
			filePaths: ["lifecycle-policies/metrics.json"],
			summary: "metrics warm replicas 0",
			mrUrl: "https://gitlab.com/x/-/merge_requests/9",
			createdAt: "2026-06-19T00:00:00.000Z",
		});
		const changes = await priorChangesForDeployment(store, "eu-b2b");
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({
			id: "req-1",
			workflow: "ilm-rollout",
			summary: "metrics warm replicas 0",
			mrUrl: "https://gitlab.com/x/-/merge_requests/9",
		});

		// SIO-965: seed a slice of the repo skeleton (two stacks sharing modules across
		// two deployments), then a change targeting eu-cld/slos with pipeline + outcome.
		await seedModules(store, ["slo", "lifecycle"]);
		await seedStacks(store, ["slos", "lifecycle-policies"]);
		await linkStackModule(store, "slos", "slo");
		await linkStackModule(store, "lifecycle-policies", "lifecycle");
		await seedDeployments(store, [
			{ name: "eu-cld", ecId: "eda974d", region: "Frankfurt" },
			{ name: "us-cld", ecId: "971a5b5", region: "N. Virginia" },
		]);
		await seedStackInstances(store, [
			{ deployment: "eu-cld", stack: "slos" },
			{ deployment: "us-cld", stack: "slos" },
		]);

		// Blast-radius reads.
		expect(await stacksUsingModule(store, "slo")).toEqual(["slos"]);
		expect(await deploymentsRunningStack(store, "slos")).toEqual(["eu-cld", "us-cld"]);

		await recordIacChange(store, {
			id: "req-42",
			deployment: "eu-cld",
			workflow: "slo-edit",
			filePaths: ["environments/eu-cld/slos/latency.json"],
			summary: "tighten latency SLO",
			mrUrl: "https://gitlab.com/x/-/merge_requests/42",
			stackInstanceId: "eu-cld/slos",
			threadId: "thread-xyz",
			outcome: "proposed",
			createdAt: "2026-06-19T01:00:00.000Z",
		});
		await recordPipeline(store, {
			mrUrl: "https://gitlab.com/x/-/merge_requests/42",
			pipelineId: 148,
			status: "success",
		});
		await setChangeOutcome(store, "req-42", "applied");

		const stackChanges = await changeHistoryForStackInstance(store, "eu-cld/slos");
		expect(stackChanges).toHaveLength(1);
		expect(stackChanges[0]).toMatchObject({
			id: "req-42",
			workflow: "slo-edit",
			summary: "tighten latency SLO",
			outcome: "applied",
			mrUrl: "https://gitlab.com/x/-/merge_requests/42",
		});

		// Pipeline + RAN read-back.
		const pipelines = await store.run<{ id: string; status: string }>(
			"MATCH (m:MergeRequest {url: $url})-[:RAN]->(pl:Pipeline) RETURN pl.id AS id, pl.status AS status",
			{ url: "https://gitlab.com/x/-/merge_requests/42" },
		);
		expect(pipelines).toEqual([{ id: "148", status: "success" }]);

		await store.close();
	});
});
