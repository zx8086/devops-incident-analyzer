// knowledge-graph/src/knowledge-graph.test.ts
import { describe, expect, test } from "bun:test";
import {
	ALTER_MIGRATIONS,
	bindingsForServices,
	blastRadiusForServices,
	buildGraphContext,
	buildIacGraphContext,
	changeHistoryForStackInstance,
	deploymentsRunningStack,
	EMBEDDING_DIM,
	flagBindingForReview,
	hasBinding,
	InMemoryGraphStore,
	incidentById,
	invalidateBinding,
	invalidateBindingByHuman,
	isKnowledgeGraphEnabled,
	linkCorrelation,
	linkResolution,
	linkStackModule,
	MIGRATIONS,
	priorChangesForDeployment,
	priorRelationshipsForServices,
	priorRootCauses,
	proposedChangesWithMr,
	purgeUncuratedIncidents,
	recordIacChange,
	recordIacPrompt,
	recordIncident,
	recordPipeline,
	recordRootCause,
	recordServiceBinding,
	recordTopologyEdges,
	repairChangeMrUrl,
	rootCauseForIncident,
	seedDeployments,
	seedModules,
	seedStackInstances,
	seedStacks,
	serviceNames,
	setChangeOutcome,
	setIncidentEmbedding,
	similarIncidents,
	stacksUsingModule,
	sweepStaleTopology,
	upsertEntities,
	validTopologyEdges,
} from "./index.ts";
import { DEPLOYMENT_INVENTORY, parseModuleSources } from "./seed-iac.ts";

describe("schema", () => {
	test("MIGRATIONS are idempotent node/rel DDL", () => {
		expect(MIGRATIONS.length).toBeGreaterThan(0);
		expect(MIGRATIONS.every((m) => m.includes("IF NOT EXISTS"))).toBe(true);
		expect(MIGRATIONS.some((m) => m.startsWith("CREATE NODE TABLE"))).toBe(true);
		expect(MIGRATIONS.some((m) => m.startsWith("CREATE REL TABLE"))).toBe(true);
		// embedding column dimension matches the Titan v2 constant
		expect(MIGRATIONS.some((m) => m.includes(`DOUBLE[${EMBEDDING_DIM}]`))).toBe(true);
	});

	// SIO-965: three-layer node/rel tables + the tolerant outcome column migration.
	test("MIGRATIONS include the SIO-965 three-layer tables", () => {
		for (const label of ["Module", "Stack", "StackInstance", "Workflow", "Session", "Pipeline"]) {
			expect(MIGRATIONS.some((m) => m.includes(`NODE TABLE IF NOT EXISTS ${label}(`))).toBe(true);
		}
		for (const rel of ["USES_MODULE", "OF_STACK", "ON_DEPLOYMENT", "TARGETS", "VIA_WORKFLOW", "IN_SESSION", "RAN"]) {
			expect(MIGRATIONS.some((m) => m.includes(`REL TABLE IF NOT EXISTS ${rel}(`))).toBe(true);
		}
	});

	// SIO-1038: the verbatim-prompt Prompt node + PROMPTED_IN rel.
	test("MIGRATIONS include the SIO-1038 Prompt node + PROMPTED_IN rel", () => {
		const node = MIGRATIONS.find((m) => m.includes("NODE TABLE IF NOT EXISTS Prompt("));
		const rel = MIGRATIONS.find((m) => m.includes("REL TABLE IF NOT EXISTS PROMPTED_IN("));
		expect(node).toBeDefined();
		expect(node).toContain("text STRING");
		expect(rel).toContain("FROM Prompt TO Session");
	});

	// SIO-1026: RootCause node + HAS_ROOT_CAUSE rel. Per-incident metadata
	// (confidence, createdAt) lives on the EDGE, not the shared node, so a repeat
	// cause class cannot overwrite an earlier incident's values.
	test("MIGRATIONS include the SIO-1026 RootCause node + HAS_ROOT_CAUSE rel", () => {
		const node = MIGRATIONS.find((m) => m.includes("NODE TABLE IF NOT EXISTS RootCause("));
		const rel = MIGRATIONS.find((m) => m.includes("REL TABLE IF NOT EXISTS HAS_ROOT_CAUSE("));
		expect(node).toBeDefined();
		expect(rel).toBeDefined();
		// shared node = identity only.
		expect(node).not.toContain("confidence");
		expect(node).not.toContain("createdAt");
		// per-incident metadata on the edge.
		expect(rel).toContain("confidence");
		expect(rel).toContain("createdAt");
	});

	test("ALTER_MIGRATIONS add the outcome + EC columns for pre-existing graphs", () => {
		expect(ALTER_MIGRATIONS.some((m) => m.includes("ConfigChange ADD outcome"))).toBe(true);
		expect(ALTER_MIGRATIONS.some((m) => m.includes("ElasticDeployment ADD ecId"))).toBe(true);
		expect(ALTER_MIGRATIONS.some((m) => m.includes("ElasticDeployment ADD region"))).toBe(true);
	});

	// SIO-1104 (5a): topology lifecycle columns -- fresh graphs via CREATE, existing
	// graphs via the tolerant rel-table ALTERs (verified on lbug 0.14.3).
	test("MIGRATIONS include RUNS_ON and lifecycle columns on the topology rel tables", () => {
		const runsOn = MIGRATIONS.find((m) => m.includes("REL TABLE IF NOT EXISTS RUNS_ON("));
		expect(runsOn).toBeDefined();
		expect(runsOn).toContain("FROM Service TO AwsResource");
		for (const rel of ["DEPENDS_ON", "PRODUCES_TO", "CONSUMES_FROM", "ROUTES_TO", "RUNS_ON"]) {
			const ddl = MIGRATIONS.find((m) => m.includes(`REL TABLE IF NOT EXISTS ${rel}(`));
			expect(ddl).toContain("discoveredBy STRING");
			expect(ddl).toContain("tValid STRING");
			expect(ddl).toContain("tInvalid STRING");
			expect(ddl).toContain("consecutiveMisses INT64");
		}
	});

	test("ALTER_MIGRATIONS backfill lifecycle columns on the pre-Stage-5 rel tables", () => {
		for (const rel of ["DEPENDS_ON", "PRODUCES_TO", "CONSUMES_FROM", "ROUTES_TO"]) {
			for (const col of ["discoveredBy", "tValid", "tInvalid", "consecutiveMisses"]) {
				expect(ALTER_MIGRATIONS.some((m) => m.includes(`${rel} ADD ${col}`))).toBe(true);
			}
		}
		// RUNS_ON is born with its columns; no ALTER needed.
		expect(ALTER_MIGRATIONS.some((m) => m.includes("RUNS_ON"))).toBe(false);
	});
});

describe("isKnowledgeGraphEnabled", () => {
	test("respects the env flag", () => {
		expect(isKnowledgeGraphEnabled({} as NodeJS.ProcessEnv)).toBe(false);
		expect(isKnowledgeGraphEnabled({ KNOWLEDGE_GRAPH_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
		expect(isKnowledgeGraphEnabled({ KNOWLEDGE_GRAPH_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(true);
	});
});

describe("writer (parameterized, injection-safe)", () => {
	test("upsertEntities merges nodes and dependency edges with bound params", async () => {
		const store = new InMemoryGraphStore();
		await upsertEntities(store, {
			services: ["svc-a"],
			kafkaTopics: ["orders"],
			dependencies: [{ from: "svc-a", to: "svc-b" }],
		});
		// every call binds values via params; the cypher never contains the value
		const malicious = store.calls.find((c) => c.cypher.includes("DROP"));
		expect(malicious).toBeUndefined();
		expect(store.calls.some((c) => c.cypher.includes("MERGE (n:Service") && c.params?.value === "svc-a")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("MERGE (n:KafkaTopic") && c.params?.value === "orders")).toBe(
			true,
		);
		expect(
			store.calls.some(
				(c) => c.cypher.includes("DEPENDS_ON") && c.params?.from === "svc-a" && c.params?.to === "svc-b",
			),
		).toBe(true);
	});

	test("a service name with Cypher metacharacters is bound, never interpolated", async () => {
		const store = new InMemoryGraphStore();
		const evil = '"}) DETACH DELETE n //';
		await upsertEntities(store, { services: [evil] });
		const call = store.calls[0];
		expect(call?.cypher).toBe("MERGE (n:Service {name: $value})");
		expect(call?.params?.value).toBe(evil);
	});

	test("linkCorrelation creates both findings and the relationship with props", async () => {
		const store = new InMemoryGraphStore();
		await linkCorrelation(store, {
			findingA: "kafka:lag",
			findingB: "elastic:errors",
			ruleName: "kafka-significant-lag",
			confidence: 0.8,
		});
		const rel = store.calls.find((c) => c.cypher.includes("CORRELATES_WITH"));
		expect(rel?.params).toEqual({
			a: "kafka:lag",
			b: "elastic:errors",
			rule: "kafka-significant-lag",
			confidence: 0.8,
		});
	});

	test("recordIncident writes the embedding via the drop/set/recreate path when provided", async () => {
		const store = new InMemoryGraphStore();
		await recordIncident(store, { id: "inc1", severity: "high", services: ["svc-a"], embedding: [0.1, 0.2] });
		// SIO-1100: identity MERGE no longer carries the embedding (it backs the HNSW
		// index, which rejects an inline SET); it is written by setIncidentEmbedding.
		const identity = store.calls.find((c) => c.cypher.includes("MERGE (i:Incident") && c.cypher.includes("severity"));
		expect(identity?.cypher).not.toContain("embedding");
		const emb = store.calls.find((c) => c.cypher.includes("SET i.embedding"));
		expect(emb?.params?.embedding).toEqual([0.1, 0.2]);
		expect(store.calls.some((c) => c.cypher.includes("DROP_VECTOR_INDEX"))).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("CREATE_VECTOR_INDEX"))).toBe(true);
		// AFFECTED_BY edge created
		expect(store.calls.some((c) => c.cypher.includes("AFFECTED_BY"))).toBe(true);
	});

	test("recordIncident writes no embedding path when absent", async () => {
		const store = new InMemoryGraphStore();
		await recordIncident(store, { id: "inc2" });
		expect(store.calls.some((c) => c.cypher.includes("embedding"))).toBe(false);
		expect(store.calls.some((c) => c.cypher.includes("VECTOR_INDEX"))).toBe(false);
	});

	// SIO-1026: RootCause writer. The shared node holds only identity; per-incident
	// confidence/createdAt/ruleName live on the HAS_ROOT_CAUSE edge.
	test("recordRootCause sets identity on the node and per-incident metadata on the edge", async () => {
		const store = new InMemoryGraphStore();
		await recordRootCause(store, {
			id: "rc-hash",
			incidentId: "inc1",
			class: "kafka-significant-lag",
			description: "consumer lag > 10K",
			confidence: 0.72,
			ruleName: "kafka-significant-lag",
		});
		// node carries identity only -- no confidence/createdAt.
		const node = store.calls.find((c) => c.cypher.includes("MERGE (rc:RootCause"));
		expect(node?.params).toEqual({ id: "rc-hash", class: "kafka-significant-lag", description: "consumer lag > 10K" });
		expect(node?.cypher).not.toContain("confidence");
		// edge carries the per-incident metadata.
		const edge = store.calls.find((c) => c.cypher.includes("MERGE (i)-[r:HAS_ROOT_CAUSE]"));
		expect(edge?.cypher).toContain("r.confidence = $confidence");
		expect(edge?.params).toEqual({
			incidentId: "inc1",
			id: "rc-hash",
			ruleName: "kafka-significant-lag",
			confidence: 0.72,
			createdAt: expect.any(String),
		});
	});

	test("recordRootCause drops any prior HAS_ROOT_CAUSE edge for the incident (single-valued)", async () => {
		const store = new InMemoryGraphStore();
		await recordRootCause(store, { id: "rc-hash", incidentId: "inc1", ruleName: "r" });
		const del = store.calls.find((c) => c.cypher.includes("DELETE r"));
		expect(del?.cypher).toContain("MATCH (i:Incident {id: $incidentId})-[r:HAS_ROOT_CAUSE]->");
		expect(del?.params).toEqual({ incidentId: "inc1" });
	});

	test("recordRootCause is a no-op without an id or incidentId", async () => {
		const store = new InMemoryGraphStore();
		await recordRootCause(store, { id: "", incidentId: "inc1" });
		await recordRootCause(store, { id: "rc", incidentId: "" });
		expect(store.calls).toEqual([]);
	});

	test("linkResolution links incident to runbooks", async () => {
		const store = new InMemoryGraphStore();
		await linkResolution(store, "inc1", ["kafka-consumer-lag.md"]);
		expect(
			store.calls.some((c) => c.cypher.includes("RESOLVED_BY") && c.params?.filename === "kafka-consumer-lag.md"),
		).toBe(true);
	});

	// SIO-954: IaC change recorder.
	test("recordIacChange merges deployment, config-change, and MR with bound params", async () => {
		const store = new InMemoryGraphStore();
		await recordIacChange(store, {
			id: "req-1",
			deployment: "eu-b2b",
			workflow: "ilm-rollout",
			filePaths: ["lifecycle-policies/metrics.json"],
			summary: "[eu-b2b] metrics: warm",
			mrUrl: "https://gitlab.com/x/-/merge_requests/9",
		});
		expect(
			store.calls.some((c) => c.cypher.includes("MERGE (d:ElasticDeployment") && c.params?.name === "eu-b2b"),
		).toBe(true);
		const change = store.calls.find((c) => c.cypher.includes("MERGE (c:ConfigChange"));
		expect(change?.params?.id).toBe("req-1");
		expect(change?.params?.workflow).toBe("ilm-rollout");
		expect(change?.params?.filePath).toBe("lifecycle-policies/metrics.json");
		expect(store.calls.some((c) => c.cypher.includes("CHANGED_BY"))).toBe(true);
		expect(
			store.calls.some(
				(c) => c.cypher.includes("PROPOSED_IN") && c.params?.url === "https://gitlab.com/x/-/merge_requests/9",
			),
		).toBe(true);
	});

	test("recordIacChange collapses multi-file paths and skips the MR when absent", async () => {
		const store = new InMemoryGraphStore();
		await recordIacChange(store, {
			id: "req-2",
			deployment: "eu-b2b",
			workflow: "ilm-rollout",
			filePaths: ["a.json", "b.json", "c.json"],
		});
		const change = store.calls.find((c) => c.cypher.includes("MERGE (c:ConfigChange"));
		expect(change?.params?.filePath).toBe("a.json (+2 more)");
		expect(store.calls.some((c) => c.cypher.includes("MergeRequest"))).toBe(false);
	});

	test("recordIacChange is a no-op without an id or deployment", async () => {
		const store = new InMemoryGraphStore();
		await recordIacChange(store, { id: "", deployment: "eu-b2b" });
		await recordIacChange(store, { id: "req-3", deployment: "" });
		expect(store.calls).toEqual([]);
	});

	// SIO-1038: verbatim prompt writer.
	test("recordIacPrompt merges the Prompt node with the RAW text bound as a param", async () => {
		const store = new InMemoryGraphStore();
		const prompt = "Delete environments/eu-b2b/lifecycle-policies/.alerts-ilm-policy.json -- contact a@b.com";
		await recordIacPrompt(store, { id: "req-1", text: prompt, agent: "elastic-iac", threadId: "thread-abc" });
		const merge = store.calls.find((c) => c.cypher.includes("MERGE (p:Prompt"));
		expect(merge?.params?.id).toBe("req-1");
		// RAW + FULL: bound verbatim, not interpolated, not redacted.
		expect(merge?.params?.text).toBe(prompt);
		expect(merge?.params?.agent).toBe("elastic-iac");
		expect(store.calls.some((c) => c.cypher.includes("PROMPTED_IN") && c.params?.tid === "thread-abc")).toBe(true);
	});

	test("recordIacPrompt skips the Session link when threadId is absent", async () => {
		const store = new InMemoryGraphStore();
		await recordIacPrompt(store, { id: "req-2", text: "no thread" });
		expect(store.calls.some((c) => c.cypher.includes("MERGE (p:Prompt"))).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("PROMPTED_IN"))).toBe(false);
	});

	test("recordIacPrompt is a no-op without an id", async () => {
		const store = new InMemoryGraphStore();
		await recordIacPrompt(store, { id: "", text: "x" });
		expect(store.calls).toEqual([]);
	});

	test("recordIacPrompt binds Cypher metacharacters instead of interpolating them", async () => {
		const store = new InMemoryGraphStore();
		const nasty = "') DELETE (n) //";
		await recordIacPrompt(store, { id: "req-3", text: nasty });
		const merge = store.calls.find((c) => c.cypher.includes("MERGE (p:Prompt"));
		expect(merge?.params?.text).toBe(nasty);
		expect(merge?.cypher.includes(nasty)).toBe(false);
	});

	// SIO-965: three-layer attachments + outcome on recordIacChange.
	test("recordIacChange writes the SIO-965 edges when the attachments are present", async () => {
		const store = new InMemoryGraphStore();
		await recordIacChange(store, {
			id: "req-9",
			deployment: "eu-cld",
			workflow: "slo-edit",
			filePaths: ["environments/eu-cld/slos/latency.json"],
			summary: "tighten latency SLO",
			stackInstanceId: "eu-cld/slos",
			threadId: "thread-abc",
			outcome: "proposed",
		});
		const change = store.calls.find((c) => c.cypher.includes("MERGE (c:ConfigChange"));
		expect(change?.cypher).toContain("c.outcome = $outcome");
		expect(change?.params?.outcome).toBe("proposed");
		expect(store.calls.some((c) => c.cypher.includes("VIA_WORKFLOW") && c.params?.name === "slo-edit")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("IN_SESSION") && c.params?.tid === "thread-abc")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("TARGETS") && c.params?.sid === "eu-cld/slos")).toBe(true);
	});

	test("recordIacChange defaults outcome to proposed and skips absent attachments", async () => {
		const store = new InMemoryGraphStore();
		await recordIacChange(store, { id: "req-10", deployment: "eu-cld", filePaths: ["x.json"] });
		const change = store.calls.find((c) => c.cypher.includes("MERGE (c:ConfigChange"));
		expect(change?.params?.outcome).toBe("proposed");
		expect(store.calls.some((c) => c.cypher.includes("VIA_WORKFLOW"))).toBe(false);
		expect(store.calls.some((c) => c.cypher.includes("IN_SESSION"))).toBe(false);
		expect(store.calls.some((c) => c.cypher.includes("TARGETS"))).toBe(false);
	});

	test("recordPipeline merges Pipeline + RAN with a stringified id; no-op without mrUrl/id", async () => {
		const store = new InMemoryGraphStore();
		await recordPipeline(store, { mrUrl: "https://gl/mr/1", pipelineId: 148, status: "success" });
		expect(store.calls.some((c) => c.cypher.includes("MERGE (pl:Pipeline") && c.params?.id === "148")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("RAN"))).toBe(true);
		const empty = new InMemoryGraphStore();
		await recordPipeline(empty, { mrUrl: "", pipelineId: 1 });
		await recordPipeline(empty, { mrUrl: "https://gl/mr/1", pipelineId: "" });
		expect(empty.calls).toEqual([]);
	});

	test("setChangeOutcome sets the outcome with bound params; no-op without an id", async () => {
		const store = new InMemoryGraphStore();
		await setChangeOutcome(store, "req-1", "applied");
		expect(store.calls[0]?.cypher).toContain("SET c.outcome = $outcome");
		expect(store.calls[0]?.params).toEqual({ id: "req-1", outcome: "applied" });
		const empty = new InMemoryGraphStore();
		await setChangeOutcome(empty, "", "failed");
		expect(empty.calls).toEqual([]);
	});

	// SIO-1062: re-key a ConfigChange's MergeRequest from a poisoned "[409] {...}" blob url to the
	// MR's real web_url. MERGE-first so a crash mid-repair leaves both links; the bad node's
	// DETACH DELETE is best-effort (lbug support unverified).
	test("repairChangeMrUrl merges the good url, re-links PROPOSED_IN, unlinks + detach-deletes the bad", async () => {
		const store = new InMemoryGraphStore();
		const bad = '[409] {"message":["Another open merge request already exists for this source branch: !256"]}';
		const good = "https://gl/-/merge_requests/256";
		await repairChangeMrUrl(store, "req-1", bad, good);
		expect(store.calls[0]?.cypher).toContain("MERGE (m:MergeRequest");
		expect(store.calls[0]?.params).toEqual({ url: good });
		expect(store.calls[1]?.cypher).toContain("MERGE (c)-[:PROPOSED_IN]->(m)");
		expect(store.calls[1]?.params).toEqual({ id: "req-1", url: good });
		expect(store.calls[2]?.cypher).toContain("DELETE r");
		expect(store.calls[2]?.params).toEqual({ id: "req-1", bad });
		expect(store.calls[3]?.cypher).toContain("DETACH DELETE m");
		expect(store.calls[3]?.params).toEqual({ bad });
	});

	test("repairChangeMrUrl is a no-op on missing args or identical urls, and survives a DETACH DELETE failure", async () => {
		const empty = new InMemoryGraphStore();
		await repairChangeMrUrl(empty, "", "bad", "good");
		await repairChangeMrUrl(empty, "req-1", "", "good");
		await repairChangeMrUrl(empty, "req-1", "bad", "");
		await repairChangeMrUrl(empty, "req-1", "same", "same");
		expect(empty.calls).toEqual([]);

		const store = new InMemoryGraphStore();
		const failingStore = {
			run: async (cypher: string, params?: Record<string, unknown>) => {
				if (cypher.includes("DETACH DELETE")) throw new Error("DETACH DELETE unsupported");
				return store.run(cypher, params);
			},
		} as unknown as InMemoryGraphStore;
		await expect(repairChangeMrUrl(failingStore, "req-1", "bad", "good")).resolves.toBeUndefined();
		expect(store.calls).toHaveLength(3); // the three repair writes landed before the failed delete
	});

	test("seed* writers + linkStackModule merge the repo skeleton (idempotent MERGE)", async () => {
		const store = new InMemoryGraphStore();
		await seedModules(store, ["slo", "lifecycle"]);
		await seedStacks(store, ["slos", "lifecycle-policies"]);
		await linkStackModule(store, "slos", "slo");
		await seedDeployments(store, [{ name: "eu-cld", ecId: "eda974d", region: "Frankfurt" }]);
		await seedStackInstances(store, [{ deployment: "eu-cld", stack: "slos" }]);
		expect(store.calls.some((c) => c.cypher.includes("MERGE (n:Module") && c.params?.value === "slo")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("MERGE (n:Stack") && c.params?.value === "slos")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("USES_MODULE") && c.params?.module === "slo")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("ElasticDeployment") && c.params?.ecId === "eda974d")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("OF_STACK") && c.params?.id === "eu-cld/slos")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("ON_DEPLOYMENT") && c.params?.id === "eu-cld/slos")).toBe(true);
		// every write is MERGE (re-runnable), never CREATE
		expect(store.calls.every((c) => !c.cypher.includes("CREATE "))).toBe(true);
	});

	// SIO-1135: the in-memory fake can't execute DELETE, but it can assert the STATEMENT
	// SHAPE -- edges (one per Incident-touching type) before nodes, all bound to $cutoff,
	// all filtered on ticketKey = '' -- and the guards. Real deletion is covered by the
	// ladybug integration test.
	test("purgeUncuratedIncidents deletes edges-then-node, filtered on uncurated + cutoff", async () => {
		const store = new InMemoryGraphStore();
		// The count query must report doomed incidents or the purge early-returns.
		store.stub("count(i) AS n", [{ n: 2 }]);
		const result = await purgeUncuratedIncidents(store, "2025-01-01T00:00:00.000Z");
		expect(result.incidents).toBe(2);

		const deletes = store.calls.filter((c) => c.cypher.includes("DELETE"));
		// four edge DELETEs (one per Incident-touching type) + one node DELETE.
		const edgeDeletes = deletes.filter((c) => c.cypher.includes("DELETE r"));
		expect(edgeDeletes.map((c) => c.cypher)).toEqual([
			expect.stringContaining("[r:AFFECTED_BY]"),
			expect.stringContaining("[r:DISCOVERED_DURING]"),
			expect.stringContaining("[r:RESOLVED_BY]"),
			expect.stringContaining("[r:HAS_ROOT_CAUSE]"),
		]);
		expect(edgeDeletes).toHaveLength(4);
		expect(deletes.some((c) => c.cypher.trim().endsWith("DELETE i"))).toBe(true);
		// every delete is bound to $cutoff and scoped to uncurated rows -- never interpolated.
		// SIO-1136: the uncurated predicate matches BOTH ticketKey = '' and NULL (legacy rows).
		for (const c of deletes) {
			expect(c.params?.cutoff).toBe("2025-01-01T00:00:00.000Z");
			expect(c.cypher).toContain("i.ticketKey IS NULL OR i.ticketKey = ''");
			expect(c.cypher).toContain("i.createdAt < $cutoff");
			expect(c.cypher).not.toContain("DETACH");
		}
		// The node DELETE runs AFTER every edge DELETE (edges-then-node ordering).
		const cyphers = store.calls.map((c) => c.cypher);
		const lastEdgeIdx = cyphers.findLastIndex((cy) => cy.includes("DELETE r"));
		const nodeIdx = cyphers.findIndex((cy) => cy.trim().endsWith("DELETE i"));
		expect(nodeIdx).toBeGreaterThan(lastEdgeIdx);
	});

	test("purgeUncuratedIncidents is a no-op on an empty or invalid cutoff", async () => {
		const store = new InMemoryGraphStore();
		expect(await purgeUncuratedIncidents(store, "")).toEqual({ incidents: 0, edges: 0 });
		expect(await purgeUncuratedIncidents(store, "not-a-date")).toEqual({ incidents: 0, edges: 0 });
		// Neither the count nor any DELETE ran.
		expect(store.calls).toHaveLength(0);
	});

	test("purgeUncuratedIncidents no-ops when nothing is stale (count 0)", async () => {
		const store = new InMemoryGraphStore();
		store.stub("count(i) AS n", [{ n: 0 }]);
		const result = await purgeUncuratedIncidents(store, "2025-01-01T00:00:00.000Z");
		expect(result).toEqual({ incidents: 0, edges: 0 });
		// only the count query ran; no DELETE.
		expect(store.calls.some((c) => c.cypher.includes("DELETE"))).toBe(false);
	});
});

describe("reader", () => {
	test("priorRelationshipsForServices maps rows to dependencies", async () => {
		const store = new InMemoryGraphStore();
		store.stub("DEPENDS_ON", [{ from: "svc-a", to: "svc-b" }]);
		const deps = await priorRelationshipsForServices(store, ["svc-a"]);
		expect(deps).toEqual([{ from: "svc-a", to: "svc-b" }]);
	});

	test("similarIncidents returns [] for an empty embedding without querying", async () => {
		const store = new InMemoryGraphStore();
		const result = await similarIncidents(store, []);
		expect(result).toEqual([]);
		expect(store.calls).toEqual([]);
	});

	// SIO-1135/1133: incidentById returns the node fields + services (via AFFECTED_BY) so
	// a curation-time kg-incident mirror fact matches incidentFromAnnotations byte-for-byte.
	test("incidentById returns node fields and services from AFFECTED_BY", async () => {
		const store = new InMemoryGraphStore();
		store.stub("RETURN i.id AS id, i.summary AS summary, i.severity AS severity LIMIT 1", [
			{ id: "inc-1", summary: "kafka lag", severity: "high" },
		]);
		store.stub("-[:AFFECTED_BY]->(i:Incident {id: $id}) RETURN s.name AS name", [{ name: "svc-a" }, { name: "svc-b" }]);
		expect(await incidentById(store, "inc-1")).toEqual({
			id: "inc-1",
			summary: "kafka lag",
			severity: "high",
			services: ["svc-a", "svc-b"],
		});
	});

	test("incidentById returns null when the id is missing or the node is absent", async () => {
		const store = new InMemoryGraphStore();
		expect(await incidentById(store, "")).toBeNull();
		expect(store.calls).toHaveLength(0);
		// no stub for the node query -> [] -> null
		expect(await incidentById(store, "nope")).toBeNull();
	});

	// SIO-1100: graphEnrich writes this turn's embedding before the lookup, so the
	// current incident must be excluded or it returns itself at distance ~0.
	test("similarIncidents excludes excludeId and re-caps to limit", async () => {
		const store = new InMemoryGraphStore();
		store.stub("QUERY_VECTOR_INDEX", [
			{ id: "self", summary: "s0", severity: "high", distance: 0 },
			{ id: "hist-1", summary: "s1", severity: "high", distance: 0.2 },
			{ id: "hist-2", summary: "s2", severity: "low", distance: 0.4 },
			{ id: "hist-3", summary: "s3", severity: "low", distance: 0.6 },
		]);
		const result = await similarIncidents(store, [0.1, 0.2], 3, "self");
		expect(result.map((r) => r.id)).toEqual(["hist-1", "hist-2", "hist-3"]);
		// over-fetches by one when excluding
		expect(store.calls[0]?.params?.limit).toBe(4);
	});

	test("buildGraphContext renders deps + similar incidents, empty when nothing", () => {
		expect(buildGraphContext([], [])).toBe("");
		const ctx = buildGraphContext(
			[{ from: "svc-a", to: "svc-b" }],
			[{ id: "inc1", summary: "kafka lag outage", severity: "high", distance: 0.1, ticketKey: "" }],
		);
		expect(ctx).toContain("## Knowledge Graph");
		expect(ctx).toContain("svc-a -> svc-b");
		expect(ctx).toContain("kafka lag outage");
	});

	// SIO-1026: a similar incident annotated with its prior root cause.
	test("buildGraphContext appends the prior root cause when present", () => {
		const ctx = buildGraphContext(
			[],
			[
				{
					id: "inc1",
					summary: "kafka lag outage",
					severity: "high",
					distance: 0.1,
					ticketKey: "",
					rootCause: { class: "kafka-significant-lag", description: "consumer lag > 10K" },
				},
			],
		);
		expect(ctx).toContain("kafka lag outage");
		expect(ctx).toContain("prior root cause: consumer lag > 10K");
	});

	// SIO-1104 (5b): "what resolved it" runbooks, capped at 3 rendered.
	test("buildGraphContext appends resolving runbooks capped at 3", () => {
		const ctx = buildGraphContext(
			[],
			[
				{
					id: "inc1",
					summary: "kafka lag outage",
					severity: "high",
					distance: 0.1,
					ticketKey: "",
					rootCause: { class: "kafka-significant-lag", description: "consumer lag > 10K" },
					resolvedBy: ["rb-1.md", "rb-2.md", "rb-3.md", "rb-4.md"],
				},
			],
		);
		expect(ctx).toContain("resolved by rb-1.md, rb-2.md, rb-3.md");
		expect(ctx).not.toContain("rb-4.md");
	});

	test("buildGraphContext renders no runbook clause for an empty resolvedBy", () => {
		const ctx = buildGraphContext(
			[],
			[
				{
					id: "inc1",
					summary: "kafka lag outage",
					severity: "high",
					distance: 0.1,
					ticketKey: "",
					rootCause: { class: "kafka-significant-lag", description: "consumer lag > 10K" },
					resolvedBy: [],
				},
			],
		);
		expect(ctx).toContain("prior root cause: consumer lag > 10K");
		expect(ctx).not.toContain("resolved by");
	});

	// SIO-954: IaC change-history reader.
	test("priorChangesForDeployment maps rows, [] for an empty deployment", async () => {
		const store = new InMemoryGraphStore();
		store.stub("CHANGED_BY", [
			{ id: "req-1", workflow: "ilm-rollout", summary: "metrics warm", mrUrl: "u1", createdAt: "2026-06-19" },
		]);
		const changes = await priorChangesForDeployment(store, "eu-b2b");
		expect(changes).toEqual([
			{ id: "req-1", workflow: "ilm-rollout", summary: "metrics warm", mrUrl: "u1", createdAt: "2026-06-19" },
		]);
		expect(await priorChangesForDeployment(store, "")).toEqual([]);
	});

	test("buildIacGraphContext renders recent changes, empty when none", () => {
		expect(buildIacGraphContext("eu-b2b", [])).toBe("");
		const ctx = buildIacGraphContext("eu-b2b", [
			{ id: "req-1", workflow: "ilm-rollout", summary: "metrics warm", mrUrl: "u1", createdAt: "2026-06-19" },
		]);
		expect(ctx).toContain("## Knowledge Graph");
		expect(ctx).toContain("Recent changes to eu-b2b");
		expect(ctx).toContain("ilm-rollout: metrics warm (u1)");
	});

	// SIO-965: the two-arg form must stay byte-identical (back-compat with SIO-954).
	test("buildIacGraphContext two-arg form is unchanged when extra is omitted", () => {
		const changes = [
			{ id: "req-1", workflow: "ilm-rollout", summary: "metrics warm", mrUrl: "u1", createdAt: "2026-06-19" },
		];
		expect(buildIacGraphContext("eu-b2b", changes)).toBe(buildIacGraphContext("eu-b2b", changes, {}));
	});

	test("buildIacGraphContext renders the SIO-965 extra sections", () => {
		const ctx = buildIacGraphContext("eu-cld", [], {
			stackInstanceChanges: [
				{ id: "c1", workflow: "slo-edit", summary: "tighten latency", outcome: "applied", mrUrl: "u9", createdAt: "x" },
			],
			alsoRunningStack: { stack: "slos", deployments: ["us-cld", "ap-cld"] },
		});
		expect(ctx).toContain("Recent changes to this stack");
		expect(ctx).toContain("[applied] slo-edit: tighten latency (u9)");
		expect(ctx).toContain("Other deployments running the slos stack");
		expect(ctx).toContain("us-cld, ap-cld");
	});

	test("changeHistoryForStackInstance maps rows, coalesces missing outcome, [] for empty id", async () => {
		const store = new InMemoryGraphStore();
		store.stub("TARGETS", [
			{ id: "c1", workflow: "slo-edit", summary: "tighten", outcome: null, mrUrl: "u9", createdAt: "2026-06-19" },
		]);
		const changes = await changeHistoryForStackInstance(store, "eu-cld/slos");
		expect(changes).toEqual([
			{ id: "c1", workflow: "slo-edit", summary: "tighten", outcome: "proposed", mrUrl: "u9", createdAt: "2026-06-19" },
		]);
		expect(await changeHistoryForStackInstance(store, "")).toEqual([]);
	});

	// SIO-1053: enumeration source for the KG reconcile sweep.
	test("proposedChangesWithMr filters proposed, joins PROPOSED_IN, drops mrUrl-less rows", async () => {
		const store = new InMemoryGraphStore();
		store.stub("PROPOSED_IN", [
			{ id: "c1", mrUrl: "https://gitlab.com/x/-/merge_requests/264", outcome: "proposed" },
			{ id: "c2", mrUrl: null, outcome: "proposed" }, // no MR url -> dropped
			{ id: "c3", mrUrl: "https://gitlab.com/x/-/merge_requests/265", outcome: null }, // coalesces to proposed
		]);
		const rows = await proposedChangesWithMr(store);
		expect(rows).toEqual([
			{ id: "c1", mrUrl: "https://gitlab.com/x/-/merge_requests/264", outcome: "proposed" },
			{ id: "c3", mrUrl: "https://gitlab.com/x/-/merge_requests/265", outcome: "proposed" },
		]);
		// The query must constrain to still-proposed changes and join the MR node.
		const call = store.calls.find((c) => c.cypher.includes("PROPOSED_IN"));
		expect(call?.cypher).toContain("c.outcome = 'proposed'");
		expect(call?.cypher).toContain("MergeRequest");
	});

	test("stacksUsingModule / deploymentsRunningStack map rows, [] for empty input", async () => {
		const store = new InMemoryGraphStore();
		store.stub("USES_MODULE", [{ stack: "lifecycle-policies" }]);
		expect(await stacksUsingModule(store, "lifecycle")).toEqual(["lifecycle-policies"]);
		expect(await stacksUsingModule(store, "")).toEqual([]);
		const store2 = new InMemoryGraphStore();
		store2.stub("OF_STACK", [{ deployment: "eu-cld" }, { deployment: "us-cld" }]);
		expect(await deploymentsRunningStack(store2, "slos")).toEqual(["eu-cld", "us-cld"]);
		expect(await deploymentsRunningStack(store2, "")).toEqual([]);
	});

	// SIO-1026: RootCause readers.
	test("rootCauseForIncident maps the linked cause, null when none / empty id", async () => {
		const store = new InMemoryGraphStore();
		store.stub("[r:HAS_ROOT_CAUSE]", [
			{
				id: "rc1",
				class: "kafka-significant-lag",
				description: "lag>10K",
				confidence: 0.7,
				ruleName: "kafka-significant-lag",
			},
		]);
		expect(await rootCauseForIncident(store, "inc1")).toEqual({
			id: "rc1",
			class: "kafka-significant-lag",
			description: "lag>10K",
			confidence: 0.7,
			ruleName: "kafka-significant-lag",
		});
		expect(await rootCauseForIncident(store, "")).toBeNull();
		const empty = new InMemoryGraphStore();
		expect(await rootCauseForIncident(empty, "inc-none")).toBeNull();
	});

	test("priorRootCauses collapses runbook fan-out per incident, [] for empty class", async () => {
		const store = new InMemoryGraphStore();
		// two rows for the same incident (one per runbook) + a second incident
		store.stub("RootCause {class:", [
			{
				incidentId: "inc1",
				summary: "kafka outage",
				severity: "high",
				description: "lag",
				runbook: "a.md",
				createdAt: "2026-06-30",
			},
			{
				incidentId: "inc1",
				summary: "kafka outage",
				severity: "high",
				description: "lag",
				runbook: "b.md",
				createdAt: "2026-06-30",
			},
			{
				incidentId: "inc2",
				summary: "older lag",
				severity: "medium",
				description: "lag",
				runbook: null,
				createdAt: "2026-06-01",
			},
		]);
		const prior = await priorRootCauses(store, "kafka-significant-lag");
		expect(prior).toEqual([
			{ incidentId: "inc1", summary: "kafka outage", severity: "high", description: "lag", runbooks: ["a.md", "b.md"] },
			{ incidentId: "inc2", summary: "older lag", severity: "medium", description: "lag", runbooks: [] },
		]);
		expect(await priorRootCauses(store, "")).toEqual([]);
	});

	// SIO-1026 (CodeRabbit): the limit bounds DISTINCT INCIDENTS, not joined rows --
	// a single incident with many runbooks must not crowd out newer incidents.
	test("priorRootCauses limits distinct incidents, not the runbook fan-out", async () => {
		const store = new InMemoryGraphStore();
		// inc1 has 3 runbook rows; inc2 has 1. With limit=1 we must get inc1 with all
		// 3 runbooks -- not 1 row of inc1 truncated, and inc2 correctly excluded.
		store.stub("RootCause {class:", [
			{
				incidentId: "inc1",
				summary: "a",
				severity: "high",
				description: "lag",
				runbook: "a.md",
				createdAt: "2026-06-30",
			},
			{
				incidentId: "inc1",
				summary: "a",
				severity: "high",
				description: "lag",
				runbook: "b.md",
				createdAt: "2026-06-30",
			},
			{
				incidentId: "inc1",
				summary: "a",
				severity: "high",
				description: "lag",
				runbook: "c.md",
				createdAt: "2026-06-30",
			},
			{
				incidentId: "inc2",
				summary: "b",
				severity: "low",
				description: "lag",
				runbook: "d.md",
				createdAt: "2026-06-01",
			},
		]);
		const prior = await priorRootCauses(store, "kafka-significant-lag", 1);
		expect(prior).toHaveLength(1);
		expect(prior[0]).toEqual({
			incidentId: "inc1",
			summary: "a",
			severity: "high",
			description: "lag",
			runbooks: ["a.md", "b.md", "c.md"],
		});
	});
});

// SIO-965: pure seeder helpers (no network).
describe("seed-iac helpers", () => {
	test("parseModuleSources extracts module names, dedupes, handles multi-module stacks", () => {
		expect(parseModuleSources('module "slos" {\n  source = "../../modules/slo"\n}')).toEqual(["slo"]);
		expect(
			parseModuleSources(
				'module "deployments" {\n  source   = "../../modules/deployment"\n}\nmodule "tf" {\n  source = "../../modules/traffic-filter"\n}',
			),
		).toEqual(["deployment", "traffic-filter"]);
		// a duplicate source line collapses to one
		expect(parseModuleSources('source = "../../modules/slo"\nsource = "../../modules/slo"')).toEqual(["slo"]);
		// no module sources -> empty
		expect(parseModuleSources('resource "x" "y" {}')).toEqual([]);
	});

	test("DEPLOYMENT_INVENTORY covers the 10 known clusters with ecId + region", () => {
		expect(Object.keys(DEPLOYMENT_INVENTORY)).toHaveLength(10);
		expect(DEPLOYMENT_INVENTORY["eu-cld"]).toEqual({ ecId: "eda974d", region: "Frankfurt" });
	});
});

describe("InMemoryGraphStore", () => {
	test("init/close toggle initialized and record nothing", async () => {
		const store = new InMemoryGraphStore();
		await store.init();
		expect(store.initialized).toBe(true);
		await store.close();
		expect(store.initialized).toBe(false);
	});
});

// SIO-1100: telemetry-binding substrate.
describe("SIO-1100 telemetry bindings", () => {
	test("MIGRATIONS include TelemetrySource/Alias nodes + OBSERVED_IN/RESOLVES_TO/DISCOVERED_DURING rels", () => {
		for (const label of ["TelemetrySource", "Alias"]) {
			expect(MIGRATIONS.some((m) => m.includes(`NODE TABLE IF NOT EXISTS ${label}(`))).toBe(true);
		}
		const observed = MIGRATIONS.find((m) => m.includes("REL TABLE IF NOT EXISTS OBSERVED_IN("));
		expect(observed).toContain("FROM Service TO TelemetrySource");
		// bi-temporal + provenance columns on the edge
		for (const col of ["confidence", "discoveredBy", "evidence", "lastVerified", "tValid", "tInvalid"]) {
			expect(observed).toContain(col);
		}
		expect(MIGRATIONS.find((m) => m.includes("REL TABLE IF NOT EXISTS RESOLVES_TO("))).toContain(
			"FROM Alias TO Service",
		);
		expect(MIGRATIONS.find((m) => m.includes("REL TABLE IF NOT EXISTS DISCOVERED_DURING("))).toContain(
			"FROM TelemetrySource TO Incident",
		);
	});

	test("recordServiceBinding MERGEs Service + TelemetrySource + OBSERVED_IN with bound params", async () => {
		const store = new InMemoryGraphStore();
		await recordServiceBinding(store, {
			service: "orders",
			serviceNormalized: "order",
			datasource: "aws",
			kind: "logGroup",
			resourceId: "/ecs/orders-prd",
			locator: "prod",
			confidence: 0.7,
			discoveredBy: "resolve-identifiers",
			incidentId: "inc-1",
		});
		// composed TelemetrySource id
		const source = store.calls.find((c) => c.cypher.includes("MERGE (t:TelemetrySource"));
		expect(source?.params?.id).toBe("aws:logGroup:/ecs/orders-prd");
		// OBSERVED_IN edge sets lastVerified + clears tInvalid, params bound
		const edge = store.calls.find((c) => c.cypher.includes("OBSERVED_IN"));
		expect(edge?.cypher).toContain("o.tInvalid = ''");
		expect(edge?.params?.service).toBe("orders");
		expect(edge?.params?.confidence).toBe(0.7);
		// provenance edge to the incident
		expect(store.calls.some((c) => c.cypher.includes("DISCOVERED_DURING") && c.params?.iid === "inc-1")).toBe(true);
		// no interpolation: the resourceId never appears raw in a cypher string
		expect(store.calls.every((c) => !c.cypher.includes("/ecs/orders-prd"))).toBe(true);
	});

	test("recordServiceBinding writes an Alias RESOLVES_TO edge only when aliasRaw differs", async () => {
		const withAlias = new InMemoryGraphStore();
		await recordServiceBinding(withAlias, {
			service: "orders",
			serviceNormalized: "order",
			aliasRaw: "prices-api-v2",
			datasource: "konnect",
			kind: "konnectService",
			resourceId: "svc-123",
			confidence: 0.7,
			discoveredBy: "resolve-identifiers",
		});
		expect(withAlias.calls.some((c) => c.cypher.includes("MERGE (a:Alias") && c.params?.name === "prices-api-v2")).toBe(
			true,
		);
		expect(withAlias.calls.some((c) => c.cypher.includes("RESOLVES_TO"))).toBe(true);

		const noAlias = new InMemoryGraphStore();
		await recordServiceBinding(noAlias, {
			service: "orders",
			serviceNormalized: "order",
			aliasRaw: "orders",
			datasource: "elastic",
			kind: "serviceName",
			resourceId: "orders",
			confidence: 0.7,
			discoveredBy: "resolve-identifiers",
		});
		expect(noAlias.calls.some((c) => c.cypher.includes("RESOLVES_TO"))).toBe(false);
	});

	test("recordServiceBinding invalidates prior RESOLVES_TO edges to a different service", async () => {
		const store = new InMemoryGraphStore();
		await recordServiceBinding(store, {
			service: "orders",
			serviceNormalized: "order",
			aliasRaw: "prices-api-v2",
			datasource: "konnect",
			kind: "konnectService",
			resourceId: "svc-123",
			confidence: 0.7,
			discoveredBy: "resolve-identifiers",
		});
		// The invalidation MATCH sets tInvalid on other-service RESOLVES_TO edges from
		// this alias BEFORE the new MERGE, and it precedes the MERGE.
		const inval = store.calls.find((c) => c.cypher.includes("RESOLVES_TO") && c.cypher.includes("s.name <> $service"));
		expect(inval?.cypher).toContain("SET r.tInvalid = $now");
		expect(inval?.params?.service).toBe("orders");
		const invalIdx = store.calls.findIndex((c) => c.cypher.includes("s.name <> $service"));
		const mergeIdx = store.calls.findIndex((c) => c.cypher.includes("MERGE (a)-[r:RESOLVES_TO]"));
		expect(invalIdx).toBeLessThan(mergeIdx);
	});

	test("recordServiceBinding no-ops on missing required fields", async () => {
		const store = new InMemoryGraphStore();
		await recordServiceBinding(store, {
			service: "",
			serviceNormalized: "",
			datasource: "aws",
			kind: "logGroup",
			resourceId: "",
			confidence: 0.7,
			discoveredBy: "human",
		});
		expect(store.calls).toHaveLength(0);
	});

	test("setIncidentEmbedding drops the index, sets only the embedding, recreates the index", async () => {
		const store = new InMemoryGraphStore();
		await setIncidentEmbedding(store, "inc-1", [0.1, 0.2]);
		// Kuzu forbids SET on an indexed column: drop -> set -> recreate.
		expect(store.calls.some((c) => c.cypher.includes("DROP_VECTOR_INDEX"))).toBe(true);
		const merge = store.calls.find((c) => c.cypher.includes("SET i.embedding"));
		expect(merge?.cypher).toContain("MERGE (i:Incident {id: $id}) SET i.embedding = $embedding");
		expect(merge?.cypher).not.toContain("severity");
		expect(merge?.params?.embedding).toEqual([0.1, 0.2]);
		expect(store.calls.some((c) => c.cypher.includes("CREATE_VECTOR_INDEX"))).toBe(true);
		// drop precedes set precedes create
		const idxDrop = store.calls.findIndex((c) => c.cypher.includes("DROP_VECTOR_INDEX"));
		const idxSet = store.calls.findIndex((c) => c.cypher.includes("SET i.embedding"));
		const idxCreate = store.calls.findIndex((c) => c.cypher.includes("CREATE_VECTOR_INDEX"));
		expect(idxDrop).toBeLessThan(idxSet);
		expect(idxSet).toBeLessThan(idxCreate);

		const empty = new InMemoryGraphStore();
		await setIncidentEmbedding(empty, "inc-1", []);
		expect(empty.calls).toHaveLength(0);
	});

	test("bindingsForServices returns [] for empty services and shapes rows otherwise", async () => {
		const empty = new InMemoryGraphStore();
		expect(await bindingsForServices(empty, [], [])).toEqual([]);

		const store = new InMemoryGraphStore();
		store.stub("OBSERVED_IN", [
			{
				service: "orders",
				datasource: "aws",
				kind: "logGroup",
				resourceId: "/ecs/orders",
				locator: "prod",
				confidence: 0.7,
				discoveredBy: "resolve-identifiers",
				lastVerified: "2026-07-14T00:00:00Z",
			},
		]);
		const rows = await bindingsForServices(store, ["orders"], ["order"]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ service: "orders", datasource: "aws", kind: "logGroup", confidence: 0.7 });
		// query filters currently-valid edges and orders by recency
		const q = store.calls[0]?.cypher ?? "";
		expect(q).toContain("o.tInvalid = ''");
		expect(q).toContain("ORDER BY o.lastVerified DESC");
	});

	// SIO-1104 (5c): as-of time-travel reads.
	test("bindingsForServices default query is byte-identical when asOf is omitted", async () => {
		const store = new InMemoryGraphStore();
		await bindingsForServices(store, ["orders"], ["order"]);
		// direct query (call 0) + alias query (call 1): legacy currently-valid form, no $asOf
		expect(store.calls[0]?.cypher).toContain("o.tInvalid = ''");
		expect(store.calls[0]?.cypher).not.toContain("$asOf");
		expect(store.calls[0]?.params).toEqual({ names: ["orders"], limit: 40 });
		expect(store.calls[1]?.cypher).toContain("o.tInvalid = '' AND rr.tInvalid = ''");
		expect(store.calls[1]?.cypher).not.toContain("$asOf");
		expect(store.calls[1]?.params).toEqual({ normalized: ["order"], limit: 40 });
	});

	test("bindingsForServices with asOf filters both hops bi-temporally", async () => {
		const store = new InMemoryGraphStore();
		const asOf = "2026-07-10T00:00:00.000Z";
		await bindingsForServices(store, ["orders"], ["order"], 40, asOf);
		// direct query (call 0): OBSERVED_IN as-of window
		const direct = store.calls[0];
		expect(direct?.cypher).toContain("o.tValid <= $asOf AND (o.tInvalid = '' OR o.tInvalid > $asOf)");
		expect(direct?.params).toMatchObject({ names: ["orders"], asOf });
		// alias query (call 1): the RESOLVES_TO hop gets the same window
		const alias = store.calls[1];
		expect(alias?.cypher).toContain("rr.tValid <= $asOf AND (rr.tInvalid = '' OR rr.tInvalid > $asOf)");
		expect(alias?.params).toMatchObject({ normalized: ["order"], asOf });
	});

	test("hasBinding returns true only when a valid edge count is positive", async () => {
		const present = new InMemoryGraphStore();
		present.stub("count(o)", [{ n: 1 }]);
		expect(await hasBinding(present, "orders", "logGroup", "/ecs/orders")).toBe(true);

		const absent = new InMemoryGraphStore();
		absent.stub("count(o)", [{ n: 0 }]);
		expect(await hasBinding(absent, "orders", "logGroup", "/ecs/orders")).toBe(false);

		// missing args short-circuit without a query
		const store = new InMemoryGraphStore();
		expect(await hasBinding(store, "", "logGroup", "")).toBe(false);
		expect(store.calls).toHaveLength(0);
	});
});

// SIO-1103: staleness writers.
describe("SIO-1103 staleness (invalidateBinding / flagBindingForReview)", () => {
	test("invalidateBinding sets tInvalid + appends reason, only for non-human bindings", async () => {
		const store = new InMemoryGraphStore();
		await invalidateBinding(store, "orders", "aws", "logGroup", "/ecs/orders", "empty on reuse");
		const call = store.calls[0];
		expect(call?.cypher).toContain("o.tInvalid = $now");
		expect(call?.cypher).toContain("o.discoveredBy <> 'human'");
		expect(call?.cypher).toContain("invalidated: ");
		// full (datasource, kind, resourceId) identity is matched (cross-source isolation)
		expect(call?.cypher).toContain("datasource: $datasource");
		expect(call?.params).toMatchObject({
			service: "orders",
			datasource: "aws",
			kind: "logGroup",
			resourceId: "/ecs/orders",
			reason: "empty on reuse",
		});
		// no-ops on missing required fields
		const empty = new InMemoryGraphStore();
		await invalidateBinding(empty, "", "aws", "logGroup", "", "x");
		expect(empty.calls).toHaveLength(0);
	});

	test("flagBindingForReview appends a note without invalidating, only for human bindings", async () => {
		const store = new InMemoryGraphStore();
		await flagBindingForReview(store, "orders", "aws", "logGroup", "/ecs/orders", "looked empty once");
		const call = store.calls[0];
		expect(call?.cypher).toContain("o.discoveredBy = 'human'");
		expect(call?.cypher).toContain("flagged-for-review");
		// crucially does NOT set tInvalid (edge stays valid)
		expect(call?.cypher).not.toContain("tInvalid = $now");
	});

	// SIO-1127: a human explicit-invalidate sets tInvalid on ANY currently-valid edge --
	// unlike invalidateBinding it does NOT exclude discoveredBy = 'human' (an explicit human
	// verdict overrides a prior human confirmation).
	test("invalidateBindingByHuman sets tInvalid on any edge, without the human exclusion", async () => {
		const store = new InMemoryGraphStore();
		await invalidateBindingByHuman(store, "orders", "aws", "logGroup", "/ecs/orders", "vestigial config");
		const call = store.calls[0];
		expect(call?.cypher).toContain("o.tInvalid = $now");
		expect(call?.cypher).toContain("invalidated-by-human: ");
		// The distinguishing property: NO discoveredBy filter (would refuse human edges).
		expect(call?.cypher).not.toContain("o.discoveredBy");
		expect(call?.cypher).toContain("datasource: $datasource"); // full-identity match preserved
		expect(call?.params).toMatchObject({
			service: "orders",
			datasource: "aws",
			kind: "logGroup",
			resourceId: "/ecs/orders",
			reason: "vestigial config",
		});
		// no-ops on missing required fields
		const empty = new InMemoryGraphStore();
		await invalidateBindingByHuman(empty, "", "aws", "logGroup", "", "x");
		expect(empty.calls).toHaveLength(0);
	});
});

// SIO-1103: shared-infra blast radius reader.
describe("SIO-1103 blastRadiusForServices", () => {
	test("[] for empty services", async () => {
		expect(await blastRadiusForServices(new InMemoryGraphStore(), [])).toEqual([]);
	});

	test("collects depends-on + shared-topic + shared-telemetry neighbours, excluding self", async () => {
		const store = new InMemoryGraphStore();
		store.stub("DEPENDS_ON", [{ n: "payments" }]);
		store.stub("PRODUCES_TO", [{ n: "refunds", t: "events" }]);
		store.stub("OBSERVED_IN", [{ n: "audit", id: "aws:logGroup:/ecs/shared" }]);
		const hits = await blastRadiusForServices(store, ["orders"]);
		expect(hits).toContainEqual({ service: "orders", neighbour: "payments", via: "depends-on", sharedResource: "" });
		expect(hits).toContainEqual({
			service: "orders",
			neighbour: "refunds",
			via: "kafka-topic",
			sharedResource: "events",
		});
		expect(hits).toContainEqual({
			service: "orders",
			neighbour: "audit",
			via: "telemetry-source",
			sharedResource: "aws:logGroup:/ecs/shared",
		});
		// the telemetry query filters currently-valid edges
		expect(store.calls.some((c) => c.cypher.includes("o1.tInvalid = '' AND o2.tInvalid = ''"))).toBe(true);
	});

	test("de-dupes and never returns the focus service itself", async () => {
		const store = new InMemoryGraphStore();
		// a self-edge and a duplicate neighbour
		store.stub("DEPENDS_ON", [{ n: "orders" }, { n: "payments" }, { n: "payments" }]);
		const hits = await blastRadiusForServices(store, ["orders"]);
		expect(hits.some((h) => h.neighbour === "orders")).toBe(false);
		expect(hits.filter((h) => h.neighbour === "payments")).toHaveLength(1);
	});

	// SIO-1104 (5c): the telemetry-source hop honors asOf; default stays byte-identical.
	test("asOf switches the telemetry query to the bi-temporal window", async () => {
		const store = new InMemoryGraphStore();
		const asOf = "2026-07-10T00:00:00.000Z";
		await blastRadiusForServices(store, ["orders"], 25, asOf);
		const tele = store.calls.find((c) => c.cypher.includes("OBSERVED_IN"));
		expect(tele?.cypher).toContain("o1.tValid <= $asOf AND (o1.tInvalid = '' OR o1.tInvalid > $asOf)");
		expect(tele?.cypher).toContain("o2.tValid <= $asOf AND (o2.tInvalid = '' OR o2.tInvalid > $asOf)");
		expect(tele?.params).toMatchObject({ name: "orders", asOf });
		// SIO-1104 (5a): the depends-on hop is lifecycle-managed too, so it gets the
		// same window; produces-to (not sweep-managed) stays unfiltered.
		const deps = store.calls.find((c) => c.cypher.includes("DEPENDS_ON"));
		expect(deps?.cypher).toContain("r.tValid <= $asOf AND (r.tInvalid = '' OR r.tInvalid > $asOf)");
		expect(deps?.params).toEqual({ name: "orders", asOf });
		const topics = store.calls.find((c) => c.cypher.includes("PRODUCES_TO"));
		expect(topics?.cypher).not.toContain("$asOf");
	});

	// SIO-1104 (5a): default blast-radius + prior-relationships reads exclude
	// invalidated DEPENDS_ON edges (the sweep can retire them now).
	test("depends-on reads filter to currently-valid edges by default", async () => {
		const store = new InMemoryGraphStore();
		await blastRadiusForServices(store, ["orders"]);
		const deps = store.calls.find((c) => c.cypher.includes("DEPENDS_ON"));
		expect(deps?.cypher).toContain("r.tInvalid = ''");
		expect(deps?.cypher).not.toContain("$asOf");
		const prior = new InMemoryGraphStore();
		await priorRelationshipsForServices(prior, ["orders"]);
		expect(prior.calls[0]?.cypher).toContain("r.tInvalid = ''");
	});

	// SIO-1104 (5a): shared-AwsResource fan-in via the topology sweep's RUNS_ON edges.
	test("collects aws-resource neighbours via currently-valid RUNS_ON edges", async () => {
		const store = new InMemoryGraphStore();
		store.stub("RUNS_ON", [{ n: "billing", id: "arn:aws:ecs:eu-west-1:1:service/prod/shared" }]);
		const hits = await blastRadiusForServices(store, ["orders"]);
		expect(hits).toContainEqual({
			service: "orders",
			neighbour: "billing",
			via: "aws-resource",
			sharedResource: "arn:aws:ecs:eu-west-1:1:service/prod/shared",
		});
		const aws = store.calls.find((c) => c.cypher.includes("RUNS_ON"));
		expect(aws?.cypher).toContain("r1.tInvalid = '' AND r2.tInvalid = ''");
	});
});

// SIO-1104 (5a): topology writers + readers.
describe("SIO-1104 topology writer", () => {
	test("recordTopologyEdges maps kinds to labels/keys and stamps lifecycle columns", async () => {
		const store = new InMemoryGraphStore();
		await recordTopologyEdges(store, [
			{ kind: "runs-on", from: "orders", to: "arn:aws:ecs:eu-west-1:1:service/prod/orders" },
			{ kind: "routes-to", from: "/api/orders", to: "orders" },
		]);
		// runs-on endpoints: Service.name -> AwsResource.arn
		expect(store.calls.some((c) => c.cypher === "MERGE (a:Service {name: $from})" && c.params?.from === "orders")).toBe(
			true,
		);
		expect(
			store.calls.some(
				(c) =>
					c.cypher === "MERGE (b:AwsResource {arn: $to})" &&
					c.params?.to === "arn:aws:ecs:eu-west-1:1:service/prod/orders",
			),
		).toBe(true);
		const runsOn = store.calls.find((c) => c.cypher.includes("MERGE (a)-[r:RUNS_ON]->(b)"));
		expect(runsOn?.cypher).toContain("SET r.discoveredBy = $discoveredBy, r.tInvalid = '', r.consecutiveMisses = 0");
		expect(runsOn?.params?.discoveredBy).toBe("topology-job");
		// keep-first tValid backfill is a separate conditional statement
		const backfill = store.calls.find(
			(c) => c.cypher.includes("[r:RUNS_ON]") && c.cypher.includes("coalesce(r.tValid, '') = ''"),
		);
		expect(backfill?.cypher).toContain("SET r.tValid = $now");
		expect(backfill?.params?.now).toBeDefined();
		// routes-to endpoints: ApiRoute.path -> Service.name
		expect(
			store.calls.some((c) => c.cypher === "MERGE (a:ApiRoute {path: $from})" && c.params?.from === "/api/orders"),
		).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("MERGE (a)-[r:ROUTES_TO]->(b)"))).toBe(true);
	});

	test("recordTopologyEdges skips empty endpoints and unknown kinds", async () => {
		const store = new InMemoryGraphStore();
		await recordTopologyEdges(store, [
			{ kind: "runs-on", from: "", to: "arn:x" },
			{ kind: "runs-on", from: "orders", to: "" },
			{ kind: "produces-to" as never, from: "orders", to: "events" },
		]);
		expect(store.calls).toHaveLength(0);
	});

	test("validTopologyEdges reads only sweep-owned currently-valid edges", async () => {
		const store = new InMemoryGraphStore();
		store.stub("AS misses", [{ from: "orders", to: "arn:x", misses: 2 }]);
		const edges = await validTopologyEdges(store, "runs-on");
		expect(edges).toEqual([{ from: "orders", to: "arn:x", consecutiveMisses: 2 }]);
		const q = store.calls[0];
		expect(q?.cypher).toContain("(a:Service)-[r:RUNS_ON]->(b:AwsResource)");
		expect(q?.cypher).toContain("r.discoveredBy = $discoveredBy AND r.tInvalid = ''");
		expect(q?.params).toEqual({ discoveredBy: "topology-job" });
	});

	test("sweepStaleTopology bumps misses below K and invalidates at K", async () => {
		const store = new InMemoryGraphStore();
		store.stub("AS misses", [
			{ from: "gone", to: "arn:gone", misses: 2 },
			{ from: "flaky", to: "arn:flaky", misses: 0 },
			{ from: "alive", to: "arn:alive", misses: 1 },
		]);
		const result = await sweepStaleTopology(store, "runs-on", [{ from: "alive", to: "arn:alive" }], {
			maxMisses: 3,
			now: "2026-07-15T00:00:00.000Z",
		});
		expect(result).toEqual({ checked: 3, missed: 2, invalidated: 1 });
		// gone: 2 + 1 = 3 >= K -> invalidated
		const invalidate = store.calls.find((c) => c.cypher.includes("r.tInvalid = $now"));
		expect(invalidate?.params).toMatchObject({
			from: "gone",
			to: "arn:gone",
			misses: 3,
			now: "2026-07-15T00:00:00.000Z",
		});
		expect(invalidate?.cypher).toContain("r.discoveredBy = $discoveredBy AND r.tInvalid = ''");
		// flaky: 0 + 1 = 1 < K -> increment only
		const bump = store.calls.find((c) => c.params?.from === "flaky" && c.cypher.includes("SET r.consecutiveMisses"));
		expect(bump?.cypher).not.toContain("r.tInvalid = $now");
		expect(bump?.params?.misses).toBe(1);
		// alive was re-observed this sweep -> untouched
		expect(store.calls.some((c) => c.params?.from === "alive" && c.cypher.includes("SET"))).toBe(false);
	});

	test("serviceNames returns canonical names, dropping empties", async () => {
		const store = new InMemoryGraphStore();
		store.stub("MATCH (s:Service) RETURN s.name", [{ name: "orders" }, { name: "" }]);
		expect(await serviceNames(store)).toEqual(["orders"]);
	});
});
