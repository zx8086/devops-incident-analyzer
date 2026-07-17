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
	bindingsForServices,
	changeHistoryForStackInstance,
	deploymentsRunningStack,
	hasBinding,
	incidentById,
	priorChangesForDeployment,
	priorRelationshipsForServices,
	proposedChangesWithMr,
	rootCauseForIncident,
	stacksUsingModule,
	topology,
} from "./reader.ts";
import { EMBEDDING_DIM } from "./schema.ts";
import { LadybugStore } from "./store.ts";
import {
	invalidateBindingByHuman,
	linkIncidentTicket,
	linkResolution,
	linkStackModule,
	purgeUncuratedIncidents,
	recordIacChange,
	recordIncident,
	recordPipeline,
	recordRootCause,
	recordServiceBinding,
	seedDeployments,
	seedModules,
	seedStackInstances,
	seedStacks,
	setChangeOutcome,
	setIncidentEmbedding,
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

// SIO-1100: skip the real-engine suite in CI. lbug loads there (so lbugLoadable()
// is true), but (a) the vector extension can't download without network, so the
// similarity round-trips can't be validated, and (b) lbug's native finalizer
// segfaults Bun at process teardown (SIO-954) -- a non-deterministic crash that
// fails the whole Test job. This is a LOCAL-DEV real-engine check; CI coverage for
// the same writers/readers comes from the deterministic InMemoryGraphStore unit
// tests. Run it locally (unset CI) to exercise the actual binder.
const inCi = process.env.CI === "true" || process.env.CI === "1";
const available = !inCi && (await lbugLoadable());
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

		// SIO-1100: telemetry-binding round-trip against the real binder (validates the
		// new DDL applied in init() + the OBSERVED_IN/RESOLVES_TO reader queries, which
		// the in-memory fake cannot). Reuses this store to respect the handle-count cap.
		// Incident.embedding is a fixed DOUBLE[1024] column (Titan v2), so the vector
		// must be exactly EMBEDDING_DIM long -- a shorter list is rejected by the binder.
		await setIncidentEmbedding(
			store,
			"inc-1",
			Array.from({ length: EMBEDDING_DIM }, () => 0.01),
		);
		await recordServiceBinding(store, {
			service: "svc-a",
			serviceNormalized: "svc-a",
			aliasRaw: "svc-a-prd", // exercises the Alias + RESOLVES_TO path
			datasource: "aws",
			kind: "logGroup",
			resourceId: "/ecs/svc-a-prd",
			locator: "prod",
			confidence: 0.7,
			discoveredBy: "resolve-identifiers",
			incidentId: "inc-1",
		});

		// direct-name lookup
		const direct = await bindingsForServices(store, ["svc-a"], ["svc-a"]);
		expect(direct).toHaveLength(1);
		expect(direct[0]).toMatchObject({ service: "svc-a", datasource: "aws", kind: "logGroup", confidence: 0.7 });
		// alias-hop lookup: the Alias node (svc-a-prd) stores the SERVICE's normalized
		// form (svc-a) and RESOLVES_TO svc-a, so a lookup that knows only that
		// normalized form (not the direct service name) still reaches the binding.
		const viaAlias = await bindingsForServices(store, ["nope"], ["svc-a"]);
		expect(viaAlias.some((b) => b.resourceId === "/ecs/svc-a-prd")).toBe(true);

		// hasBinding gate
		expect(await hasBinding(store, "svc-a", "logGroup", "/ecs/svc-a-prd")).toBe(true);
		expect(await hasBinding(store, "svc-a", "logGroup", "/does/not/exist")).toBe(false);

		// re-record bumps lastVerified + keeps a single edge (MERGE idempotency)
		await recordServiceBinding(store, {
			service: "svc-a",
			serviceNormalized: "svc-a",
			datasource: "aws",
			kind: "logGroup",
			resourceId: "/ecs/svc-a-prd",
			locator: "prod",
			confidence: 0.9,
			discoveredBy: "resolve-identifiers",
		});
		const edgeCount = await store.run<{ n: number }>(
			"MATCH (:Service {name: 'svc-a'})-[o:OBSERVED_IN]->(:TelemetrySource {id: 'aws:logGroup:/ecs/svc-a-prd'}) RETURN count(o) AS n",
		);
		expect(Number(edgeCount[0]?.n)).toBe(1);

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

	// SIO-1053: the KG reconcile enumeration + terminal advance against the real engine.
	// proposedChangesWithMr must return only still-proposed changes that have an MR, and once
	// setChangeOutcome advances one to a terminal outcome it must drop out of the enumeration.
	test("proposedChangesWithMr enumerate -> setChangeOutcome terminal advance round-trip", async () => {
		const store = new LadybugStore(join(dir, "db4"));
		await store.init();

		// One proposed change WITH an MR (re-checkable), one proposed change WITHOUT an MR (skipped).
		// req-a also TARGETS a stack instance so the panel read-back below can find it.
		await recordIacChange(store, {
			id: "req-a",
			deployment: "eu-b2b",
			workflow: "ilm-rollout",
			filePaths: ["lifecycle-policies/alerts.json"],
			summary: "alerts add 90d delete",
			mrUrl: "https://gitlab.com/x/-/merge_requests/264",
			stackInstanceId: "eu-b2b/lifecycle-policies",
			outcome: "proposed",
			createdAt: "2026-07-10T00:00:00.000Z",
		});
		await recordIacChange(store, {
			id: "req-nomr",
			deployment: "eu-b2b",
			workflow: "ilm-rollout",
			filePaths: ["lifecycle-policies/logs.json"],
			summary: "logs proposal not yet MR'd",
			outcome: "proposed",
			createdAt: "2026-07-10T00:05:00.000Z",
		});

		const proposed = await proposedChangesWithMr(store);
		expect(proposed).toEqual([
			{ id: "req-a", mrUrl: "https://gitlab.com/x/-/merge_requests/264", outcome: "proposed" },
		]);

		// The reconciler advances req-a to its true terminal outcome; it must then drop from the enum.
		await setChangeOutcome(store, "req-a", "applied");
		expect(await proposedChangesWithMr(store)).toEqual([]);

		// And the panel query now reads the terminal outcome (req-a TARGETS this stack instance).
		const history = await changeHistoryForStackInstance(store, "eu-b2b/lifecycle-policies");
		const reconciled = history.find((c) => c.id === "req-a");
		expect(reconciled?.outcome).toBe("applied");

		await store.close();
	});

	// SIO-1135: purge removes only STALE + UNCURATED incidents, cascading their edges,
	// while curated incidents and fresh uncurated incidents (and their edges) survive.
	// Real-engine only: the in-memory fake cannot execute DELETE against the vector-indexed
	// Incident table, which is exactly the risk this test guards.
	test("purgeUncuratedIncidents deletes stale uncurated incidents + edges only", async () => {
		const store = new LadybugStore(join(dir, "db-purge"));
		await store.init();

		// old + uncurated (should be purged), with an AFFECTED_BY, a HAS_ROOT_CAUSE, and a RESOLVED_BY.
		await recordIncident(store, {
			id: "inc-old-uncurated",
			severity: "high",
			summary: "old uncurated",
			services: ["svc-x"],
			createdAt: "2020-01-01T00:00:00.000Z",
		});
		await recordRootCause(store, {
			id: "rc-old",
			incidentId: "inc-old-uncurated",
			class: "kafka-lag",
			description: "old cause",
			confidence: 0.8,
			ruleName: "kafka-lag",
		});
		await linkResolution(store, "inc-old-uncurated", ["kafka-consumer-lag.md"]);

		// old + curated (ticketKey set) -- must SURVIVE despite being old.
		await recordIncident(store, {
			id: "inc-old-curated",
			severity: "high",
			summary: "old curated",
			services: ["svc-y"],
			createdAt: "2020-01-01T00:00:00.000Z",
		});
		await linkIncidentTicket(store, "inc-old-curated", "DEVOPS-1");

		// fresh + uncurated -- newer than the cutoff, must SURVIVE.
		await recordIncident(store, {
			id: "inc-fresh-uncurated",
			severity: "low",
			summary: "fresh uncurated",
			services: ["svc-z"],
			createdAt: "2030-01-01T00:00:00.000Z",
		});

		// incidentById returns services (SIO-1135/1133 mirror-fact + request-id lookup source).
		expect(await incidentById(store, "inc-old-uncurated")).toEqual({
			id: "inc-old-uncurated",
			summary: "old uncurated",
			severity: "high",
			services: ["svc-x"],
		});

		const cutoff = "2025-01-01T00:00:00.000Z";
		const result = await purgeUncuratedIncidents(store, cutoff);
		expect(result.incidents).toBe(1); // only inc-old-uncurated
		expect(result.edges).toBe(3); // AFFECTED_BY + HAS_ROOT_CAUSE + RESOLVED_BY

		// The stale uncurated incident and ALL its edges are gone.
		expect(await incidentById(store, "inc-old-uncurated")).toBeNull();
		expect(await rootCauseForIncident(store, "inc-old-uncurated")).toBeNull();
		const orphanEdges = await store.run<{ n: number }>(
			"MATCH (:Service)-[r:AFFECTED_BY]->(:Incident {id: 'inc-old-uncurated'}) RETURN count(r) AS n",
		);
		expect(Number(orphanEdges[0]?.n ?? 0)).toBe(0);

		// Curated (old) and fresh (uncurated) incidents survive untouched.
		expect((await incidentById(store, "inc-old-curated"))?.id).toBe("inc-old-curated");
		expect((await incidentById(store, "inc-fresh-uncurated"))?.id).toBe("inc-fresh-uncurated");

		// An empty cutoff is a no-op guard (must never wipe everything).
		expect(await purgeUncuratedIncidents(store, "")).toEqual({ incidents: 0, edges: 0 });
		expect((await incidentById(store, "inc-fresh-uncurated"))?.id).toBe("inc-fresh-uncurated");

		await store.close();
	});

	// SIO-1136 (CodeRabbit PR #404): legacy rows created before the CREATE-DDL default carry
	// ticketKey = NULL (not ''). The purge predicate is `IS NULL OR = ''`, so the NULL path
	// must be exercised on the real engine -- the '' path alone would miss the regression.
	test("purgeUncuratedIncidents removes legacy NULL-ticketKey rows", async () => {
		const store = new LadybugStore(join(dir, "db-purge-null"));
		await store.init();

		await recordIncident(store, {
			id: "inc-null-legacy",
			severity: "high",
			summary: "legacy null ticketKey",
			services: ["svc-n"],
			createdAt: "2020-01-01T00:00:00.000Z",
		});
		// Force the legacy shape: an explicit NULL ticketKey (recordIncident now defaults to '').
		await store.run("MATCH (i:Incident {id: 'inc-null-legacy'}) SET i.ticketKey = NULL");
		const before = await store.run<{ tk: string | null }>(
			"MATCH (i:Incident {id: 'inc-null-legacy'}) RETURN i.ticketKey AS tk",
		);
		expect(before[0]?.tk == null).toBe(true); // NULL, not ''

		const result = await purgeUncuratedIncidents(store, "2025-01-01T00:00:00.000Z");
		expect(result.incidents).toBe(1);
		expect(await incidentById(store, "inc-null-legacy")).toBeNull();

		await store.close();
	});

	// SIO-1127: invalidateBindingByHuman must retire even a HUMAN-confirmed edge (the
	// distinguishing behavior vs invalidateBinding, which refuses discoveredBy = 'human').
	// Real-engine only: proves the tInvalid SET lands and bindingsForServices stops surfacing
	// it -- the in-memory fake cannot execute the WHERE/SET.
	test("invalidateBindingByHuman retires a human-confirmed binding", async () => {
		const store = new LadybugStore(join(dir, "db-inv-human"));
		await store.init();

		await recordServiceBinding(store, {
			service: "localcore-service",
			serviceNormalized: "localcoreservice",
			datasource: "kafka",
			kind: "topic",
			resourceId: "orders.events",
			locator: "",
			confidence: 1.0,
			discoveredBy: "human", // a HUMAN-confirmed edge
			evidence: "human-confirmed",
		});
		// Present before invalidation.
		expect(await hasBinding(store, "localcore-service", "topic", "orders.events")).toBe(true);

		await invalidateBindingByHuman(store, "localcore-service", "kafka", "topic", "orders.events", "vestigial config");

		// hasBinding filters tInvalid = '' -> now gone (a human edge invalidateBinding would refuse).
		expect(await hasBinding(store, "localcore-service", "topic", "orders.events")).toBe(false);
		expect(await bindingsForServices(store, ["localcore-service"], ["localcore-service"])).toHaveLength(0);

		await store.close();
	});
});
