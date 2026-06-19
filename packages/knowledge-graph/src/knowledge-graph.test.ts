// knowledge-graph/src/knowledge-graph.test.ts
import { describe, expect, test } from "bun:test";
import {
	ALTER_MIGRATIONS,
	buildGraphContext,
	buildIacGraphContext,
	changeHistoryForStackInstance,
	deploymentsRunningStack,
	EMBEDDING_DIM,
	InMemoryGraphStore,
	isKnowledgeGraphEnabled,
	linkCorrelation,
	linkResolution,
	linkStackModule,
	MIGRATIONS,
	priorChangesForDeployment,
	priorRelationshipsForServices,
	recordIacChange,
	recordIncident,
	recordPipeline,
	seedDeployments,
	seedModules,
	seedStackInstances,
	seedStacks,
	setChangeOutcome,
	similarIncidents,
	stacksUsingModule,
	upsertEntities,
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

	test("ALTER_MIGRATIONS add the outcome + EC columns for pre-existing graphs", () => {
		expect(ALTER_MIGRATIONS.some((m) => m.includes("ConfigChange ADD outcome"))).toBe(true);
		expect(ALTER_MIGRATIONS.some((m) => m.includes("ElasticDeployment ADD ecId"))).toBe(true);
		expect(ALTER_MIGRATIONS.some((m) => m.includes("ElasticDeployment ADD region"))).toBe(true);
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

	test("recordIncident sets embedding only when provided", async () => {
		const store = new InMemoryGraphStore();
		await recordIncident(store, { id: "inc1", severity: "high", services: ["svc-a"], embedding: [0.1, 0.2] });
		const merge = store.calls.find((c) => c.cypher.includes("MERGE (i:Incident"));
		expect(merge?.cypher).toContain("i.embedding = $embedding");
		expect(merge?.params?.embedding).toEqual([0.1, 0.2]);
		// AFFECTED_BY edge created
		expect(store.calls.some((c) => c.cypher.includes("AFFECTED_BY"))).toBe(true);
	});

	test("recordIncident omits embedding clause when absent", async () => {
		const store = new InMemoryGraphStore();
		await recordIncident(store, { id: "inc2" });
		const merge = store.calls.find((c) => c.cypher.includes("MERGE (i:Incident"));
		expect(merge?.cypher).not.toContain("embedding");
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

	test("buildGraphContext renders deps + similar incidents, empty when nothing", () => {
		expect(buildGraphContext([], [])).toBe("");
		const ctx = buildGraphContext(
			[{ from: "svc-a", to: "svc-b" }],
			[{ id: "inc1", summary: "kafka lag outage", severity: "high", distance: 0.1 }],
		);
		expect(ctx).toContain("## Knowledge Graph");
		expect(ctx).toContain("svc-a -> svc-b");
		expect(ctx).toContain("kafka lag outage");
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
