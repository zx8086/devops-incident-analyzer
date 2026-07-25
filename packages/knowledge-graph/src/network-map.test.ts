// knowledge-graph/src/network-map.test.ts
import { describe, expect, test } from "bun:test";
import {
	ALTER_MIGRATIONS,
	InMemoryGraphStore,
	IpBindingRecordSchema,
	ipToWorkload,
	MIGRATIONS,
	NETWORK_DISCOVERED_BY,
	type NetworkTopologyRecord,
	NetworkTopologyRecordSchema,
	NODE_LABELS,
	networkMapForService,
	REL_TYPES,
	recordIpBinding,
	recordNetworkTopology,
	TOPOLOGY_KINDS,
} from "./index.ts";

const NETWORK_NODE_LABELS = ["Vpc", "Subnet", "LoadBalancer", "TargetGroup", "DnsRecord", "IpAddress", "Endpoint"];
const NETWORK_REL_TYPES = [
	"IN_VPC",
	"IN_SUBNET",
	"ATTACHED_TO",
	"HAS_TARGET_GROUP",
	"FORWARDS_TO",
	"FORWARDS_TO_IP",
	"RESOLVES_TO_LB",
	"HAS_ENDPOINT",
	"BOUND_TO",
];

const emptyRecord: NetworkTopologyRecord = {
	vpcs: [],
	subnets: [],
	loadBalancers: [],
	targetGroups: [],
	dnsRecords: [],
	endpoints: [],
	ipBindings: [],
};

function fullRecord(): NetworkTopologyRecord {
	return {
		vpcs: [{ id: "vpc-1", cidr: "10.0.0.0/16", accountId: "111122223333", region: "eu-west-1", name: "prod" }],
		subnets: [{ id: "subnet-1", cidr: "10.0.1.0/24", az: "eu-west-1a", vpcId: "vpc-1" }],
		loadBalancers: [
			{
				arn: "arn:lb-1",
				name: "orders-alb",
				dnsName: "orders.eu.elb.amazonaws.com",
				type: "application",
				scheme: "internal",
				subnetIds: ["subnet-1"],
			},
		],
		targetGroups: [
			{
				arn: "arn:tg-1",
				name: "orders-tg",
				port: 8080,
				protocol: "HTTP",
				loadBalancerArn: "arn:lb-1",
				targets: [
					{ id: "arn:aws:ecs:eu-west-1:1:service/prod/orders", isIp: false },
					{ id: "10.0.1.15", isIp: true },
				],
			},
		],
		dnsRecords: [
			{ name: "orders.internal", type: "A", target: "orders.eu.elb.amazonaws.com", loadBalancerArn: "arn:lb-1" },
		],
		endpoints: [{ service: "orders", host: "b-1.kafka.eu", port: 9092, protocol: "tcp", datasource: "kafka" }],
		ipBindings: [
			{
				ip: "10.0.1.15",
				workloadArn: "arn:aws:ecs:eu-west-1:1:task/prod/abc",
				subnetId: "subnet-1",
				confidence: 0.9,
				discoveredBy: NETWORK_DISCOVERED_BY,
			},
		],
	};
}

describe("SIO-1207 network-map schema", () => {
	test("MIGRATIONS include the 7 node tables and 9 rel tables born with lifecycle columns", () => {
		for (const label of NETWORK_NODE_LABELS) {
			expect(MIGRATIONS.some((m) => m.includes(`NODE TABLE IF NOT EXISTS ${label}(`))).toBe(true);
		}
		for (const rel of NETWORK_REL_TYPES) {
			const ddl = MIGRATIONS.find((m) => m.includes(`REL TABLE IF NOT EXISTS ${rel}(`));
			expect(ddl).toBeDefined();
			// Born with the full RUNS_ON-style lifecycle set (a future sweep is additive).
			for (const col of [
				"discoveredBy STRING DEFAULT ''",
				"tValid STRING DEFAULT ''",
				"tInvalid STRING DEFAULT ''",
				"consecutiveMisses INT64 DEFAULT 0",
			]) {
				expect(ddl).toContain(col);
			}
		}
	});

	test("rel tables carry the specified endpoint pairs", () => {
		const pairs: Record<string, string> = {
			IN_VPC: "FROM Subnet TO Vpc",
			IN_SUBNET: "FROM IpAddress TO Subnet",
			ATTACHED_TO: "FROM LoadBalancer TO Subnet",
			HAS_TARGET_GROUP: "FROM LoadBalancer TO TargetGroup",
			FORWARDS_TO: "FROM TargetGroup TO AwsResource",
			FORWARDS_TO_IP: "FROM TargetGroup TO IpAddress",
			RESOLVES_TO_LB: "FROM DnsRecord TO LoadBalancer",
			HAS_ENDPOINT: "FROM Service TO Endpoint",
			BOUND_TO: "FROM IpAddress TO AwsResource",
		};
		for (const [rel, pair] of Object.entries(pairs)) {
			expect(MIGRATIONS.find((m) => m.includes(`REL TABLE IF NOT EXISTS ${rel}(`))).toContain(pair);
		}
	});

	test("HAS_ENDPOINT and BOUND_TO mirror OBSERVED_IN's provenance columns", () => {
		const hasEndpoint = MIGRATIONS.find((m) => m.includes("REL TABLE IF NOT EXISTS HAS_ENDPOINT("));
		const boundTo = MIGRATIONS.find((m) => m.includes("REL TABLE IF NOT EXISTS BOUND_TO("));
		for (const col of ["confidence DOUBLE", "evidence STRING", "lastVerified STRING"]) {
			expect(hasEndpoint).toContain(col);
			expect(boundTo).toContain(col);
		}
		// BOUND_TO also records the incident that taught us the binding.
		expect(boundTo).toContain("incidentId STRING DEFAULT ''");
		expect(hasEndpoint).not.toContain("incidentId");
	});

	test("no ALTER_MIGRATIONS entries exist for the network tables (born complete)", () => {
		for (const name of [...NETWORK_NODE_LABELS, ...NETWORK_REL_TYPES]) {
			expect(ALTER_MIGRATIONS.some((m) => m.includes(`ALTER TABLE ${name} `))).toBe(false);
		}
	});

	test("NODE_LABELS / REL_TYPES include the new entries; TOPOLOGY_KINDS is untouched", () => {
		for (const label of NETWORK_NODE_LABELS) expect(NODE_LABELS).toContain(label as (typeof NODE_LABELS)[number]);
		for (const rel of NETWORK_REL_TYPES) expect(REL_TYPES).toContain(rel as (typeof REL_TYPES)[number]);
		expect(NETWORK_DISCOVERED_BY).toBe("network-map");
		// v1 is per-incident-write only: the sweep registry keeps its original 4 kinds.
		expect(Object.keys(TOPOLOGY_KINDS).sort()).toEqual(["consumes-from", "depends-on", "routes-to", "runs-on"]);
	});

	test("NetworkTopologyRecordSchema requires all seven arrays and rejects unknown keys", () => {
		expect(NetworkTopologyRecordSchema.safeParse(emptyRecord).success).toBe(true);
		expect(NetworkTopologyRecordSchema.safeParse(fullRecord()).success).toBe(true);
		const { ipBindings: _dropped, ...missingArray } = emptyRecord;
		expect(NetworkTopologyRecordSchema.safeParse(missingArray).success).toBe(false);
		expect(NetworkTopologyRecordSchema.safeParse({ ...emptyRecord, extra: true }).success).toBe(false);
		// nested strictness: a vpc without an id, an endpoint without a datasource.
		expect(NetworkTopologyRecordSchema.safeParse({ ...emptyRecord, vpcs: [{ cidr: "10.0.0.0/16" }] }).success).toBe(
			false,
		);
		expect(
			NetworkTopologyRecordSchema.safeParse({ ...emptyRecord, endpoints: [{ service: "orders", host: "h" }] }).success,
		).toBe(false);
	});

	test("IpBindingRecordSchema requires ip/workloadArn/confidence/discoveredBy", () => {
		const ok = { ip: "10.0.1.15", workloadArn: "arn:task", confidence: 0.9, discoveredBy: "network-map" };
		expect(IpBindingRecordSchema.safeParse(ok).success).toBe(true);
		expect(IpBindingRecordSchema.safeParse({ ...ok, ip: "" }).success).toBe(false);
		expect(IpBindingRecordSchema.safeParse({ ...ok, workloadArn: undefined }).success).toBe(false);
		expect(IpBindingRecordSchema.safeParse({ ...ok, confidence: undefined }).success).toBe(false);
		expect(IpBindingRecordSchema.safeParse({ ...ok, discoveredBy: "" }).success).toBe(false);
		expect(IpBindingRecordSchema.safeParse({ ...ok, unknown: "x" }).success).toBe(false);
	});
});

describe("SIO-1207 recordNetworkTopology", () => {
	test("MERGEs parents before children across the full record", async () => {
		const store = new InMemoryGraphStore();
		await recordNetworkTopology(store, fullRecord(), "inc-1");
		const cyphers = store.calls.map((c) => c.cypher);
		const vpcIdx = cyphers.findIndex((cy) => cy.includes("MERGE (v:Vpc {id: $id}) SET"));
		const subnetIdx = cyphers.findIndex((cy) => cy.includes("MERGE (s:Subnet {id: $id}) SET"));
		const lbIdx = cyphers.findIndex((cy) => cy.includes("MERGE (lb:LoadBalancer {arn: $arn}) SET"));
		const tgIdx = cyphers.findIndex((cy) => cy.includes("MERGE (tg:TargetGroup {arn: $arn}) SET"));
		const dnsIdx = cyphers.findIndex((cy) => cy.includes("MERGE (d:DnsRecord {id: $id}) SET"));
		const endpointIdx = cyphers.findIndex((cy) => cy.includes("MERGE (e:Endpoint {id: $id}) SET"));
		const bindingIdx = cyphers.findIndex((cy) => cy.includes("BOUND_TO"));
		expect(vpcIdx).toBeGreaterThanOrEqual(0);
		expect(vpcIdx).toBeLessThan(subnetIdx);
		expect(subnetIdx).toBeLessThan(lbIdx);
		expect(lbIdx).toBeLessThan(tgIdx);
		expect(tgIdx).toBeLessThan(dnsIdx);
		expect(dnsIdx).toBeLessThan(endpointIdx);
		expect(endpointIdx).toBeLessThan(bindingIdx);
	});

	test("structural edges carry the network stamp, keep-first tValid backfill, and tInvalid = ''", async () => {
		const store = new InMemoryGraphStore();
		await recordNetworkTopology(store, fullRecord());
		for (const rel of [
			"IN_VPC",
			"ATTACHED_TO",
			"HAS_TARGET_GROUP",
			"FORWARDS_TO",
			"FORWARDS_TO_IP",
			"RESOLVES_TO_LB",
		]) {
			const edge = store.calls.find((c) => c.cypher.includes(`MERGE (a)-[r:${rel}]->(b)`));
			// consecutiveMisses = 0 is the revival stamp, matching recordTopologyEdges.
			expect(edge?.cypher).toContain("SET r.discoveredBy = $discoveredBy, r.tInvalid = '', r.consecutiveMisses = 0");
			expect(edge?.params?.discoveredBy).toBe(NETWORK_DISCOVERED_BY);
			// keep-first tValid: the SIO-1104 conditional-WHERE backfill, NOT coalesce-in-SET
			// (the columns are born DEFAULT '', where coalesce-in-SET is a proven no-op).
			const backfill = store.calls.find(
				(c) => c.cypher.includes(`-[r:${rel}]->`) && c.cypher.includes("coalesce(r.tValid, '') = ''"),
			);
			expect(backfill?.cypher).toContain("SET r.tValid = $now");
			expect(backfill?.params?.now).toBeDefined();
		}
	});

	test("targets route by isIp: FORWARDS_TO_IP to IpAddress, FORWARDS_TO to AwsResource", async () => {
		const store = new InMemoryGraphStore();
		await recordNetworkTopology(store, fullRecord());
		const toIp = store.calls.find((c) => c.cypher.includes("MERGE (a)-[r:FORWARDS_TO_IP]->(b)"));
		expect(toIp?.cypher).toContain("(b:IpAddress {ip: $to})");
		expect(toIp?.params?.to).toBe("10.0.1.15");
		const toResource = store.calls.find((c) => c.cypher.includes("MERGE (a)-[r:FORWARDS_TO]->(b)"));
		expect(toResource?.cypher).toContain("(b:AwsResource {arn: $to})");
		expect(toResource?.params?.to).toBe("arn:aws:ecs:eu-west-1:1:service/prod/orders");
	});

	test("DnsRecord id is caller-composed as name:type and RESOLVES_TO_LB links the LB", async () => {
		const store = new InMemoryGraphStore();
		await recordNetworkTopology(store, fullRecord());
		const dns = store.calls.find((c) => c.cypher.includes("MERGE (d:DnsRecord"));
		expect(dns?.params?.id).toBe("orders.internal:A");
		const edge = store.calls.find((c) => c.cypher.includes("MERGE (a)-[r:RESOLVES_TO_LB]->(b)"));
		expect(edge?.params).toMatchObject({ from: "orders.internal:A", to: "arn:lb-1" });
	});

	test("endpoints MERGE the Service first and HAS_ENDPOINT carries the OBSERVED_IN provenance SET", async () => {
		const store = new InMemoryGraphStore();
		await recordNetworkTopology(store, fullRecord());
		const cyphers = store.calls.map((c) => c.cypher);
		const serviceIdx = cyphers.indexOf("MERGE (s:Service {name: $name})");
		const endpointIdx = cyphers.findIndex((cy) => cy.includes("MERGE (e:Endpoint"));
		expect(serviceIdx).toBeGreaterThanOrEqual(0);
		expect(serviceIdx).toBeLessThan(endpointIdx);
		// Endpoint id = "<host>:<port>".
		const endpoint = store.calls.find((c) => c.cypher.includes("MERGE (e:Endpoint"));
		expect(endpoint?.params?.id).toBe("b-1.kafka.eu:9092");
		const edge = store.calls.find((c) => c.cypher.includes("MERGE (s)-[o:HAS_ENDPOINT]->(e)"));
		expect(edge?.cypher).toContain(
			"SET o.confidence = $confidence, o.discoveredBy = $discoveredBy, o.evidence = $evidence, o.lastVerified = $now, o.tInvalid = ''",
		);
		expect(edge?.params?.discoveredBy).toBe(NETWORK_DISCOVERED_BY);
		expect(edge?.params?.confidence).toBe(0.7);
		// keep-first tValid backfill on the just-merged edge.
		const backfill = store.calls.find(
			(c) => c.cypher.includes("[o:HAS_ENDPOINT]->") && c.cypher.includes("coalesce(o.tValid, '') = ''"),
		);
		expect(backfill?.cypher).toContain("SET o.tValid = $now");
	});

	test("a portless endpoint keys the Endpoint by bare host", async () => {
		const store = new InMemoryGraphStore();
		await recordNetworkTopology(store, {
			...emptyRecord,
			endpoints: [{ service: "orders", host: "es.internal", datasource: "elastic" }],
		});
		const endpoint = store.calls.find((c) => c.cypher.includes("MERGE (e:Endpoint"));
		expect(endpoint?.params?.id).toBe("es.internal");
	});

	test("ipBindings route through recordIpBinding with the call-level incidentId fallback", async () => {
		const store = new InMemoryGraphStore();
		await recordNetworkTopology(store, fullRecord(), "inc-1");
		const bound = store.calls.find((c) => c.cypher.includes("MERGE (i)-[b:BOUND_TO]->(r)"));
		expect(bound?.params?.incidentId).toBe("inc-1");
		// a binding's own incidentId wins over the call-level fallback.
		const own = new InMemoryGraphStore();
		const record = fullRecord();
		record.ipBindings = record.ipBindings.map((b) => ({ ...b, incidentId: "inc-own" }));
		await recordNetworkTopology(own, record, "inc-1");
		const ownBound = own.calls.find((c) => c.cypher.includes("MERGE (i)-[b:BOUND_TO]->(r)"));
		expect(ownBound?.params?.incidentId).toBe("inc-own");
	});

	test("rejects a malformed record at the boundary before any write", async () => {
		const store = new InMemoryGraphStore();
		await expect(
			recordNetworkTopology(store, { ...emptyRecord, vpcs: [{ cidr: "10.0.0.0/16" }] } as never),
		).rejects.toThrow();
		await expect(recordNetworkTopology(store, { ...emptyRecord, extra: true } as never)).rejects.toThrow();
		expect(store.calls).toEqual([]);
	});

	test("an all-empty record writes nothing", async () => {
		const store = new InMemoryGraphStore();
		await recordNetworkTopology(store, emptyRecord);
		expect(store.calls).toEqual([]);
	});

	test("values are bound, never interpolated into the Cypher", async () => {
		const store = new InMemoryGraphStore();
		const evil = '"}) DETACH DELETE n //';
		await recordNetworkTopology(store, { ...emptyRecord, vpcs: [{ id: evil }] });
		expect(store.calls.every((c) => !c.cypher.includes(evil))).toBe(true);
		expect(store.calls.some((c) => c.params?.id === evil)).toBe(true);
	});
});

describe("SIO-1207 recordIpBinding", () => {
	const binding = {
		ip: "10.0.1.15",
		workloadArn: "arn:aws:ecs:eu-west-1:1:task/prod/abc",
		subnetId: "subnet-1",
		confidence: 0.9,
		discoveredBy: NETWORK_DISCOVERED_BY,
		evidence: "eni-attachment",
		incidentId: "inc-1",
	};

	test("one-owner conflict invalidation fires BEFORE the new BOUND_TO MERGE", async () => {
		const store = new InMemoryGraphStore();
		await recordIpBinding(store, binding);
		const inval = store.calls.find((c) => c.cypher.includes("r.arn <> $arn"));
		expect(inval?.cypher).toContain("WHERE r.arn <> $arn AND b.tInvalid = ''");
		expect(inval?.cypher).toContain("SET b.tInvalid = $now");
		// supersession note appended to evidence, never silently dropped; coalesce
		// guards a NULL evidence column from nulling the whole concatenation.
		expect(inval?.cypher).toContain("b.evidence = coalesce(b.evidence, '') + ' | superseded: rebound to ' + $arn");
		const invalIdx = store.calls.findIndex((c) => c.cypher.includes("r.arn <> $arn"));
		const mergeIdx = store.calls.findIndex((c) => c.cypher.includes("MERGE (i)-[b:BOUND_TO]->(r)"));
		expect(invalIdx).toBeGreaterThanOrEqual(0);
		expect(invalIdx).toBeLessThan(mergeIdx);
	});

	test("BOUND_TO MERGE bumps lastVerified, clears tInvalid, and backfills keep-first tValid", async () => {
		const store = new InMemoryGraphStore();
		await recordIpBinding(store, binding);
		const merge = store.calls.find((c) => c.cypher.includes("MERGE (i)-[b:BOUND_TO]->(r)"));
		expect(merge?.cypher).toContain("b.lastVerified = $now");
		expect(merge?.cypher).toContain("b.tInvalid = ''");
		expect(merge?.params).toMatchObject({
			ip: "10.0.1.15",
			arn: "arn:aws:ecs:eu-west-1:1:task/prod/abc",
			confidence: 0.9,
			discoveredBy: NETWORK_DISCOVERED_BY,
			evidence: "eni-attachment",
			incidentId: "inc-1",
		});
		// keep-first tValid: the conditional-WHERE backfill runs AFTER the merge.
		const backfill = store.calls.find(
			(c) => c.cypher.includes("[b:BOUND_TO]->") && c.cypher.includes("coalesce(b.tValid, '') = ''"),
		);
		expect(backfill?.cypher).toContain("SET b.tValid = $now");
		const mergeIdx = store.calls.findIndex((c) => c.cypher.includes("MERGE (i)-[b:BOUND_TO]->(r)"));
		const backfillIdx = store.calls.findIndex((c) => c.cypher.includes("coalesce(b.tValid, '') = ''"));
		expect(backfillIdx).toBeGreaterThan(mergeIdx);
	});

	test("IN_SUBNET is written only when the caller provided subnetId", async () => {
		const withSubnet = new InMemoryGraphStore();
		await recordIpBinding(withSubnet, binding);
		const edge = withSubnet.calls.find((c) => c.cypher.includes("IN_SUBNET"));
		expect(edge?.cypher).toContain("MERGE (i)-[r:IN_SUBNET]->(s)");
		expect(edge?.params).toMatchObject({ ip: "10.0.1.15", id: "subnet-1" });

		const without = new InMemoryGraphStore();
		await recordIpBinding(without, { ...binding, subnetId: undefined });
		expect(without.calls.some((c) => c.cypher.includes("IN_SUBNET"))).toBe(false);
		expect(without.calls.some((c) => c.cypher.includes("MERGE (s:Subnet"))).toBe(false);
	});

	test("createdAt drives the write timestamp when provided", async () => {
		const store = new InMemoryGraphStore();
		const createdAt = "2026-07-01T00:00:00.000Z";
		await recordIpBinding(store, { ...binding, createdAt });
		const merge = store.calls.find((c) => c.cypher.includes("MERGE (i)-[b:BOUND_TO]->(r)"));
		expect(merge?.params?.now).toBe(createdAt);
	});

	test("no-ops on a missing ip or workloadArn", async () => {
		const store = new InMemoryGraphStore();
		await recordIpBinding(store, { ...binding, ip: "" });
		await recordIpBinding(store, { ...binding, workloadArn: "" });
		expect(store.calls).toEqual([]);
	});
});

describe("SIO-1207 ipToWorkload", () => {
	test("[] on an empty ip without querying", async () => {
		const store = new InMemoryGraphStore();
		expect(await ipToWorkload(store, "")).toEqual([]);
		expect(store.calls).toEqual([]);
	});

	test("default query filters currently-valid BOUND_TO edges; empty result short-circuits", async () => {
		const store = new InMemoryGraphStore();
		expect(await ipToWorkload(store, "10.0.1.15")).toEqual([]);
		expect(store.calls).toHaveLength(1);
		expect(store.calls[0]?.cypher).toContain("b.tInvalid = ''");
		expect(store.calls[0]?.cypher).not.toContain("$asOf");
		expect(store.calls[0]?.params).toEqual({ ip: "10.0.1.15" });
	});

	test("asOf switches BOUND_TO (and context hops) to the bi-temporal window", async () => {
		const store = new InMemoryGraphStore();
		const asOf = "2026-07-10T00:00:00.000Z";
		store.stub("BOUND_TO", [
			{
				arn: "arn:task",
				lastVerified: "2026-07-09T00:00:00.000Z",
				discoveredBy: "network-map",
				tValid: "t0",
				tInvalid: "",
			},
		]);
		await ipToWorkload(store, "10.0.1.15", asOf);
		const bound = store.calls.find((c) => c.cypher.includes("BOUND_TO"));
		expect(bound?.cypher).toContain("b.tValid <= $asOf AND (b.tInvalid = '' OR b.tInvalid > $asOf)");
		expect(bound?.params).toMatchObject({ ip: "10.0.1.15", asOf });
		const subnet = store.calls.find((c) => c.cypher.includes("IN_SUBNET"));
		expect(subnet?.cypher).toContain("sn.tValid <= $asOf AND (sn.tInvalid = '' OR sn.tInvalid > $asOf)");
		const runsOn = store.calls.find((c) => c.cypher.includes("RUNS_ON"));
		expect(runsOn?.cypher).toContain("r.tValid <= $asOf AND (r.tInvalid = '' OR r.tInvalid > $asOf)");
	});

	test("ambiguous multi-subnet placement emits empty subnet/VPC context", async () => {
		// The IpAddress node is keyed by the bare ip: a private IP reused across VPCs
		// carries several valid IN_SUBNET edges, and no single placement is correct.
		const store = new InMemoryGraphStore();
		store.stub("BOUND_TO", [
			{ arn: "arn:task-a", lastVerified: "t1", discoveredBy: "network-map", tValid: "t0", tInvalid: "" },
		]);
		store.stub("IN_SUBNET", [
			{ subnetId: "subnet-1", vpcId: "vpc-1" },
			{ subnetId: "subnet-9", vpcId: "vpc-9" },
		]);
		store.stub("RUNS_ON", [{ name: "orders" }]);
		const hits = await ipToWorkload(store, "10.0.1.15");
		expect(hits).toHaveLength(1);
		expect(hits[0]?.subnetId).toBe("");
		expect(hits[0]?.vpcId).toBe("");
	});

	test("shapes hits with per-hit service and subnet/VPC context, empty strings when absent", async () => {
		const store = new InMemoryGraphStore();
		store.stub("BOUND_TO", [
			{
				arn: "arn:task-a",
				lastVerified: "2026-07-09T00:00:00.000Z",
				discoveredBy: "network-map",
				tValid: "t0",
				tInvalid: "",
			},
			{ arn: "arn:task-b", lastVerified: null, discoveredBy: null, tValid: null, tInvalid: null },
		]);
		store.stub("IN_SUBNET", [{ subnetId: "subnet-1", vpcId: "vpc-1" }]);
		store.stub("RUNS_ON", [{ name: "orders" }]);
		const hits = await ipToWorkload(store, "10.0.1.15");
		expect(hits).toEqual([
			{
				ip: "10.0.1.15",
				workloadArn: "arn:task-a",
				service: "orders",
				subnetId: "subnet-1",
				vpcId: "vpc-1",
				lastVerified: "2026-07-09T00:00:00.000Z",
				discoveredBy: "network-map",
				tValid: "t0",
				tInvalid: "",
			},
			{
				ip: "10.0.1.15",
				workloadArn: "arn:task-b",
				service: "orders",
				subnetId: "subnet-1",
				vpcId: "vpc-1",
				lastVerified: "",
				discoveredBy: "",
				tValid: "",
				tInvalid: "",
			},
		]);
	});
});

describe("SIO-1207 networkMapForService", () => {
	test("empty service returns the empty map without querying", async () => {
		const store = new InMemoryGraphStore();
		const map = await networkMapForService(store, "");
		expect(map).toEqual({
			service: "",
			workloads: [],
			targetGroups: [],
			loadBalancers: [],
			dnsRecords: [],
			placements: [],
			ipAddresses: [],
			endpoints: [],
		});
		expect(store.calls).toEqual([]);
	});

	test("with no RUNS_ON workloads the AWS layers are skipped but endpoints still read", async () => {
		const store = new InMemoryGraphStore();
		const map = await networkMapForService(store, "orders");
		expect(map.workloads).toEqual([]);
		expect(map.targetGroups).toEqual([]);
		// only the anchor query + the endpoints query ran.
		expect(store.calls).toHaveLength(2);
		expect(store.calls[0]?.cypher).toContain("RUNS_ON");
		expect(store.calls[1]?.cypher).toContain("HAS_ENDPOINT");
		expect(store.calls.some((c) => c.cypher.includes("FORWARDS_TO"))).toBe(false);
	});

	test("assembles the full chain from stubbed layers, with per-IP subnet context", async () => {
		const store = new InMemoryGraphStore();
		store.stub("RUNS_ON", [{ arn: "arn:task" }, { arn: "arn:task" }]); // dup -> deduped
		store.stub("[f:FORWARDS_TO]", [
			{ arn: "arn:tg-1", name: "orders-tg", port: 8080, protocol: "HTTP", workloadArn: "arn:task" },
		]);
		store.stub("HAS_TARGET_GROUP", [
			{
				arn: "arn:lb-1",
				name: "orders-alb",
				dnsName: "x.elb",
				type: "application",
				scheme: "internal",
				targetGroupArn: "arn:tg-1",
			},
		]);
		store.stub("RESOLVES_TO_LB", [
			{ name: "orders.internal", type: "A", target: "x.elb", loadBalancerArn: "arn:lb-1" },
		]);
		store.stub("IN_VPC", [
			{
				loadBalancerArn: "arn:lb-1",
				subnetId: "subnet-1",
				subnetCidr: "10.0.1.0/24",
				az: "eu-west-1a",
				vpcId: "vpc-1",
				vpcCidr: "10.0.0.0/16",
				vpcName: "prod",
			},
		]);
		store.stub("BOUND_TO", [
			{ ip: "10.0.1.15", workloadArn: "arn:task", lastVerified: "t9", discoveredBy: "network-map" },
		]);
		store.stub("IN_SUBNET", [{ ip: "10.0.1.15", subnetId: "subnet-1" }]);
		store.stub("HAS_ENDPOINT", [
			{
				id: "b-1:9092",
				host: "b-1",
				port: 9092,
				protocol: "tcp",
				datasource: "kafka",
				confidence: 0.7,
				lastVerified: "t9",
			},
		]);

		const map = await networkMapForService(store, "orders");
		expect(map.workloads).toEqual(["arn:task"]);
		expect(map.targetGroups).toEqual([
			{ arn: "arn:tg-1", name: "orders-tg", port: 8080, protocol: "HTTP", workloadArn: "arn:task" },
		]);
		expect(map.loadBalancers).toEqual([
			{
				arn: "arn:lb-1",
				name: "orders-alb",
				dnsName: "x.elb",
				type: "application",
				scheme: "internal",
				targetGroupArn: "arn:tg-1",
			},
		]);
		expect(map.dnsRecords).toEqual([
			{ name: "orders.internal", type: "A", target: "x.elb", loadBalancerArn: "arn:lb-1" },
		]);
		expect(map.placements).toEqual([
			{
				loadBalancerArn: "arn:lb-1",
				subnetId: "subnet-1",
				subnetCidr: "10.0.1.0/24",
				az: "eu-west-1a",
				vpcId: "vpc-1",
				vpcCidr: "10.0.0.0/16",
				vpcName: "prod",
			},
		]);
		expect(map.ipAddresses).toEqual([
			{
				ip: "10.0.1.15",
				workloadArn: "arn:task",
				subnetId: "subnet-1",
				lastVerified: "t9",
				discoveredBy: "network-map",
			},
		]);
		expect(map.endpoints).toEqual([
			{
				id: "b-1:9092",
				host: "b-1",
				port: 9092,
				protocol: "tcp",
				datasource: "kafka",
				confidence: 0.7,
				lastVerified: "t9",
			},
		]);
	});

	test("asOf applies the bi-temporal window to every hop, incl. both placement edges", async () => {
		const store = new InMemoryGraphStore();
		const asOf = "2026-07-10T00:00:00.000Z";
		store.stub("RUNS_ON", [{ arn: "arn:task" }]);
		store.stub("[f:FORWARDS_TO]", [{ arn: "arn:tg-1", name: "", port: 0, protocol: "", workloadArn: "arn:task" }]);
		store.stub("HAS_TARGET_GROUP", [
			{ arn: "arn:lb-1", name: "", dnsName: "", type: "", scheme: "", targetGroupArn: "arn:tg-1" },
		]);
		await networkMapForService(store, "orders", asOf);
		const runsOn = store.calls.find((c) => c.cypher.includes("RUNS_ON"));
		expect(runsOn?.cypher).toContain("r.tValid <= $asOf AND (r.tInvalid = '' OR r.tInvalid > $asOf)");
		expect(runsOn?.params).toMatchObject({ name: "orders", asOf });
		const bound = store.calls.find((c) => c.cypher.includes("BOUND_TO"));
		expect(bound?.cypher).toContain("b.tValid <= $asOf AND (b.tInvalid = '' OR b.tInvalid > $asOf)");
		const placement = store.calls.find((c) => c.cypher.includes("IN_VPC"));
		expect(placement?.cypher).toContain("at.tValid <= $asOf AND (at.tInvalid = '' OR at.tInvalid > $asOf)");
		expect(placement?.cypher).toContain("iv.tValid <= $asOf AND (iv.tInvalid = '' OR iv.tInvalid > $asOf)");
	});
});
