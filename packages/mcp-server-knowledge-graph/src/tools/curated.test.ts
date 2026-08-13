// src/tools/curated.test.ts
//
// SIO-967/SIO-968: the curated kg_* tools. Driven through a real Client <-> McpServer
// round-trip over an in-memory transport + InMemoryGraphStore, so registration, schemas,
// the wire shape (tools/call -> content[]), the loud-fail wording, and reader wiring are
// all exercised. SIO-968: the enabled gate is the registration ARG (the server's startup
// config), NOT a per-call process.env read.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _setGraphStoreForTesting, InMemoryGraphStore } from "@devops-agent/knowledge-graph";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerCuratedTools } from "./curated.ts";

async function connectedClient(enabled = true): Promise<Client> {
	const server = new McpServer({ name: "test", version: "0.0.0" });
	registerCuratedTools(server, enabled);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
	const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
	const block = res.content[0];
	return block && block.type === "text" ? block.text : JSON.stringify(res.content);
}

beforeEach(() => {
	_setGraphStoreForTesting(null);
});

afterEach(() => {
	_setGraphStoreForTesting(null);
});

describe("curated kg_* tools", () => {
	test("register the read-only tools", async () => {
		const client = await connectedClient();
		const names = (await client.listTools()).tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"kg_applied_changes",
			"kg_deployment_history",
			"kg_deployments_running_stack",
			// SIO-1204: reverse-IP cache lookup.
			"kg_ip_to_workload",
			// SIO-1204: persisted per-service network map.
			"kg_network_map",
			"kg_prior_root_causes",
			"kg_stack_instance_history",
			"kg_stacks_using_module",
			"kg_successful_prompts",
		]);
	});

	test("loud-fail when disabled: tells the model not to answer from prose", async () => {
		const out = await call(await connectedClient(false), "kg_stacks_using_module", { module: "lifecycle" });
		expect(out).toContain("KNOWLEDGE GRAPH UNAVAILABLE");
		expect(out).toContain("Do NOT answer from memory");
	});

	test("SIO-968 regression: enabled via the arg even when process.env is unset", async () => {
		// The bug: tools re-read process.env per call and reported "disabled" despite the
		// server booting enabled. Now the arg decides -- so an unset env must NOT disable it.
		const prev = process.env.KNOWLEDGE_GRAPH_ENABLED;
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		try {
			const store = new InMemoryGraphStore();
			store.stub("OF_STACK", [{ deployment: "eu-b2b" }]);
			_setGraphStoreForTesting(store);
			const out = await call(await connectedClient(true), "kg_deployments_running_stack", { stack: "slos" });
			expect(out).toContain("eu-b2b");
			expect(out).not.toContain("UNAVAILABLE");
		} finally {
			if (prev === undefined) delete process.env.KNOWLEDGE_GRAPH_ENABLED;
			else process.env.KNOWLEDGE_GRAPH_ENABLED = prev;
		}
	});

	test("kg_deployments_running_stack renders the reader rows", async () => {
		const store = new InMemoryGraphStore();
		store.stub("OF_STACK", [{ deployment: "eu-cld" }, { deployment: "us-cld" }]);
		_setGraphStoreForTesting(store);
		const out = await call(await connectedClient(), "kg_deployments_running_stack", { stack: "slos" });
		expect(out).toContain("Deployments running the slos stack: eu-cld, us-cld.");
	});

	test("empty result is reported as an authoritative graph result, not a guess invite", async () => {
		_setGraphStoreForTesting(new InMemoryGraphStore());
		const out = await call(await connectedClient(), "kg_stacks_using_module", { module: "nope" });
		expect(out).toContain("Graph queried");
		expect(out).toContain("do not substitute a guess from specs");
	});

	test("kg_stacks_using_module renders rows", async () => {
		const store = new InMemoryGraphStore();
		store.stub("USES_MODULE", [{ stack: "lifecycle-policies" }]);
		_setGraphStoreForTesting(store);
		expect(await call(await connectedClient(), "kg_stacks_using_module", { module: "lifecycle" })).toContain(
			"Stacks using the lifecycle module: lifecycle-policies.",
		);
	});

	test("kg_stack_instance_history renders outcome-tagged lines", async () => {
		const store = new InMemoryGraphStore();
		store.stub("TARGETS", [
			{ id: "c1", workflow: "slo-edit", summary: "tighten", outcome: "applied", mrUrl: "u9", createdAt: "x" },
		]);
		_setGraphStoreForTesting(store);
		const out = await call(await connectedClient(), "kg_stack_instance_history", {
			deployment: "eu-cld",
			stack: "slos",
		});
		expect(out).toContain("Recent changes to eu-cld/slos");
		expect(out).toContain("[applied] slo-edit: tighten (u9)");
	});

	// SIO-1026: prior root causes.
	test("kg_prior_root_causes renders prior incidents + resolving runbooks", async () => {
		const store = new InMemoryGraphStore();
		store.stub("RootCause {class:", [
			{
				incidentId: "inc1",
				summary: "kafka outage",
				severity: "high",
				description: "lag",
				runbook: "a.md",
				createdAt: "2026-06-30",
			},
		]);
		_setGraphStoreForTesting(store);
		const out = await call(await connectedClient(), "kg_prior_root_causes", { causeClass: "kafka-significant-lag" });
		expect(out).toContain("Prior incidents with the kafka-significant-lag root cause");
		expect(out).toContain("[high] kafka outage (incident inc1) resolved by a.md");
	});

	test("kg_prior_root_causes empty result is an authoritative graph result", async () => {
		_setGraphStoreForTesting(new InMemoryGraphStore());
		const out = await call(await connectedClient(), "kg_prior_root_causes", { causeClass: "nope" });
		expect(out).toContain("no prior incident recorded the nope root cause");
	});

	// SIO-1202: prompts that produced an applied change.
	test("kg_successful_prompts renders prompt -> outcome lines", async () => {
		const store = new InMemoryGraphStore();
		store.stub("MATCH (p:Prompt)", [
			{
				prompt: "widen the ILM policy retention to 30 days on eu-b2b",
				summary: "ilm retention widened",
				workflow: "ilm-rollout",
				mrUrl: "u1",
				createdAt: "2026-06-19",
			},
		]);
		_setGraphStoreForTesting(store);
		const out = await call(await connectedClient(), "kg_successful_prompts", {});
		expect(out).toContain("Prompts that produced applied changes");
		expect(out).toContain(
			'2026-06-19 — "widen the ILM policy retention to 30 days on eu-b2b" -> ilm-rollout: ilm retention widened (u1)',
		);
	});

	test("kg_successful_prompts empty result is an authoritative graph result", async () => {
		_setGraphStoreForTesting(new InMemoryGraphStore());
		const out = await call(await connectedClient(), "kg_successful_prompts", {});
		expect(out).toContain("no applied ConfigChange has a linked Prompt");
	});

	// SIO-1203: fallback -- applied changes whether or not they have a linked Prompt.
	test("kg_applied_changes renders a row with a prompt", async () => {
		const store = new InMemoryGraphStore();
		store.stub("MATCH (c:ConfigChange) WHERE c.outcome = 'applied'", [
			{
				prompt: "widen the ILM policy retention to 30 days on eu-b2b",
				summary: "ilm retention widened",
				workflow: "ilm-rollout",
				mrUrl: "u1",
				createdAt: "2026-07-10",
			},
		]);
		_setGraphStoreForTesting(store);
		const out = await call(await connectedClient(), "kg_applied_changes", {});
		expect(out).toContain("Applied changes");
		expect(out).toContain(
			'2026-07-10 — "widen the ILM policy retention to 30 days on eu-b2b" -> ilm-rollout: ilm retention widened (u1)',
		);
	});

	test("kg_applied_changes renders a pre-SIO-1038 row with no linked prompt", async () => {
		const store = new InMemoryGraphStore();
		store.stub("MATCH (c:ConfigChange) WHERE c.outcome = 'applied'", [
			{ prompt: null, summary: "ilm retention widened", workflow: "ilm-rollout", mrUrl: "u1", createdAt: "2026-06-20" },
		]);
		_setGraphStoreForTesting(store);
		const out = await call(await connectedClient(), "kg_applied_changes", {});
		expect(out).toContain("2026-06-20 — (no prompt recorded) -> ilm-rollout: ilm retention widened (u1)");
	});

	// SIO-1464: an MR-less lane change (fleet-upgrade/synthetics-push, SIO-1461) renders
	// without the trailing "(url)" instead of being dropped by an inner MR join.
	test("kg_applied_changes renders an MR-less fleet-upgrade row without an MR suffix", async () => {
		const store = new InMemoryGraphStore();
		store.stub("MATCH (c:ConfigChange) WHERE c.outcome = 'applied'", [
			{
				prompt: "In the eu-b2b deployment, upgrade the Elastic Fleet agents to version 9.5.1",
				summary: "fleet upgrade eu-b2b -> 9.5.1",
				workflow: "fleet-upgrade",
				mrUrl: null,
				createdAt: "2026-08-13",
			},
		]);
		_setGraphStoreForTesting(store);
		const out = await call(await connectedClient(), "kg_applied_changes", {});
		expect(out).toContain(
			'2026-08-13 — "In the eu-b2b deployment, upgrade the Elastic Fleet agents to version 9.5.1" -> fleet-upgrade: fleet upgrade eu-b2b -> 9.5.1',
		);
		expect(out).not.toContain("fleet upgrade eu-b2b -> 9.5.1 (");
	});

	test("kg_applied_changes empty result is an authoritative graph result", async () => {
		_setGraphStoreForTesting(new InMemoryGraphStore());
		const out = await call(await connectedClient(), "kg_applied_changes", {});
		expect(out).toContain("no applied ConfigChange recorded");
	});

	// SIO-1204: the persisted network map + reverse-IP cache tools.
	test("kg_network_map empty result names the accretion mechanism", async () => {
		_setGraphStoreForTesting(new InMemoryGraphStore());
		const out = await call(await connectedClient(), "kg_network_map", { service: "orders" });
		expect(out).toContain("no persisted network map for orders");
		expect(out).toContain("ec2_state/ingress_state");
	});

	test("kg_network_map renders the chain, placement, ips, and endpoints", async () => {
		const store = new InMemoryGraphStore();
		store.stub("RUNS_ON", [{ arn: "arn:task" }]);
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
		_setGraphStoreForTesting(store);
		const out = await call(await connectedClient(), "kg_network_map", { service: "orders" });
		expect(out).toContain("Network map for orders");
		expect(out).toContain("Workloads: arn:task");
		expect(out).toContain("- dns orders.internal A -> orders-alb");
		expect(out).toContain("- lb orders-alb (application/internal) -> tg orders-tg");
		expect(out).toContain("- placement: subnet subnet-1 (10.0.1.0/24) eu-west-1a in vpc prod (10.0.0.0/16)");
		expect(out).toContain("- ip 10.0.1.15 bound to arn:task (subnet subnet-1), verified t9");
		expect(out).toContain("- endpoint [kafka] b-1:9092");
	});

	test("kg_ip_to_workload empty result points at the live reverse-IP protocol", async () => {
		_setGraphStoreForTesting(new InMemoryGraphStore());
		const out = await call(await connectedClient(), "kg_ip_to_workload", { ip: "10.0.1.15" });
		expect(out).toContain("no cached binding for 10.0.1.15");
		expect(out).toContain("aws_ec2_describe_network_interfaces");
	});

	test("kg_ip_to_workload flags multiple valid owners for live disambiguation", async () => {
		const store = new InMemoryGraphStore();
		store.stub("BOUND_TO", [
			{ arn: "arn:task-a", lastVerified: "t9", discoveredBy: "network-map", tValid: "t0", tInvalid: "" },
			{ arn: "arn:task-b", lastVerified: "t8", discoveredBy: "network-map", tValid: "t0", tInvalid: "" },
		]);
		store.stub("IN_SUBNET", [{ subnetId: "subnet-1", vpcId: "vpc-1" }]);
		store.stub("RUNS_ON", [{ name: "orders" }]);
		_setGraphStoreForTesting(store);
		const out = await call(await connectedClient(), "kg_ip_to_workload", { ip: "10.0.1.15" });
		expect(out).toContain("MULTIPLE valid owners");
		expect(out).toContain("- arn:task-a, service orders, subnet subnet-1 / vpc vpc-1, verified t9");
		expect(out).toContain("Verify live before acting on this.");
	});
});
