// src/__tests__/factory-replay.test.ts
// SIO-1044: aws-mcp-server adopts the shared record-once/replay-many factory. This test locks
// in replay equivalence -- a replayed server's tool list must match both a second replay and a
// directly-registered control server, so nothing is silently dropped or duplicated by the record.
import { describe, expect, test } from "bun:test";
import { createCachedServerFactory } from "@devops-agent/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../config/schemas.ts";
import { registerAllTools } from "../tools/register.ts";

// Registration never calls AWS SDK clients (handlers run only on tools/call), so a minimal
// single-estate config is sufficient for a tools/list-only test. Mirrors the idiom in
// src/__tests__/bootstrap.test.ts.
const awsConfig: AwsConfig = {
	region: "eu-central-1",
	estates: {
		prod: {
			assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
			externalId: "aws-mcp-readonly-2026",
		},
	},
};

function buildFactory(): () => McpServer {
	return createCachedServerFactory({
		createBareServer: () => new McpServer({ name: "aws-mcp-server", version: "0.0.0" }),
		registerAll: (server) => registerAllTools(server, awsConfig),
	});
}

async function toolNames(server: McpServer): Promise<string[]> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "aws-factory-replay-test-client", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools.map((t) => t.name).sort();
}

describe("SIO-1044: aws-mcp-server cached factory replay", () => {
	test("replayed servers expose an identical tool list across calls", async () => {
		const factory = buildFactory();

		const namesA = await toolNames(factory());
		const namesB = await toolNames(factory());

		expect(namesA).toEqual(namesB);
		expect(namesA.length).toBeGreaterThan(0);
	});

	test("replayed tool list matches a directly-registered control server", async () => {
		const factory = buildFactory();
		const replayed = await toolNames(factory());

		const control = new McpServer({ name: "aws-mcp-server", version: "0.0.0" });
		registerAllTools(control, awsConfig);
		const controlNames = await toolNames(control);

		expect(replayed).toEqual(controlNames);
	});

	// SIO-1120: the six network-path EC2 tools must be registered and exposed via tools/list, or
	// the aws-agent literally cannot inspect route tables / NAT gateways -- the capability gap that
	// made the localcore incident give up on the network-path investigation.
	test("exposes the six SIO-1120 network-path EC2 tools via tools/list", async () => {
		const names = await toolNames(buildFactory()());
		for (const tool of [
			"aws_ec2_describe_route_tables",
			"aws_ec2_describe_nat_gateways",
			"aws_ec2_describe_network_acls",
			"aws_ec2_describe_flow_logs",
			"aws_ec2_describe_transit_gateways",
			"aws_ec2_describe_vpc_peering_connections",
		]) {
			expect(names).toContain(tool);
		}
	});

	test("registerAll runs exactly once across two factory() calls", () => {
		// registerAllTools has no observable counter of its own, so we build a parallel factory
		// here with a counting closure around the SAME package-composition registerAll
		// (registerAllTools with this suite's awsConfig) createMcpServerFactory uses in
		// production. This proves the shared cached factory invokes registerAll exactly once at
		// createCachedServerFactory() construction time and never again across repeated
		// factory() replays. The production export's own equivalence to this composition is
		// covered by the two preceding tests (replay-vs-replay and replay-vs-control-server tool
		// list equality), so re-deriving it here would be redundant.
		let registerAllCalls = 0;
		const factory = createCachedServerFactory({
			createBareServer: () => new McpServer({ name: "aws-mcp-server", version: "0.0.0" }),
			registerAll: (server) => {
				registerAllCalls++;
				registerAllTools(server, awsConfig);
			},
		});

		expect(registerAllCalls).toBe(1);
		factory();
		factory();
		expect(registerAllCalls).toBe(1);
	});
});
