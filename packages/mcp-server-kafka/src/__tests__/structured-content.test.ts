// src/__tests__/structured-content.test.ts
// SIO-1422: kafka_get_consumer_group_lag and kafka_list_consumer_groups now declare outputSchema
// + return structuredContent via ResponseBuilder.successTyped. This goes through the real
// registerTool handler via an in-process MCP client: the SDK enforces structuredContent against
// the declared outputSchema on every successful call, so a passing callTool() is itself proof
// the schema matches the real payload shape. Also asserts content[0].text stays exactly what
// ResponseBuilder.success would have produced pre-SIO-1422 (byte-identical LLM-visible output).
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config/schemas.ts";
import type { KafkaService } from "../services/kafka-service.ts";
import { registerReadTools } from "../tools/read/tools.ts";
import { registerExtendedReadTools } from "../tools/read/tools-extended.ts";

const config: AppConfig = {
	kafka: {
		provider: "local",
		clientId: "structured-content-test",
		allowWrites: false,
		allowDestructive: false,
		consumeMaxMessages: 100,
		consumeTimeoutMs: 5000,
		toolTimeoutMs: 5000,
	},
	msk: { bootstrapBrokers: "", clusterArn: "", region: "", authMode: "iam" },
	confluent: { bootstrapServers: "", apiKey: "", apiSecret: "", restEndpoint: "", clusterId: "" },
	local: { bootstrapServers: "localhost:9092" },
	schemaRegistry: { enabled: false, url: "", apiKey: "", apiSecret: "" },
	ksql: { enabled: false, endpoint: "", apiKey: "", apiSecret: "" },
	connect: { enabled: false, url: "", apiKey: "", apiSecret: "" },
	restproxy: { enabled: false, url: "", apiKey: "", apiSecret: "" },
	logging: { level: "silent", backend: "pino" },
	telemetry: {
		enabled: false,
		serviceName: "kafka-mcp-server",
		mode: "console",
		otlpEndpoint: "http://localhost:4318",
	},
	transport: {
		mode: "stdio",
		port: 9081,
		host: "0.0.0.0",
		path: "/mcp",
		sessionMode: "stateless",
		apiKey: "",
		allowedOrigins: "",
		idleTimeout: 30,
		drainTimeoutMs: 0,
	},
};

async function buildClient(service: KafkaService) {
	const server = new McpServer({ name: "kafka-structured-content-test", version: "0.0.0" });
	registerReadTools(server, service, config);
	registerExtendedReadTools(server, service, config);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "kafka-structured-content-test-client", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	return client;
}

describe("SIO-1422: kafka structuredContent round-trip", () => {
	test("kafka_get_consumer_group_lag: structuredContent matches text, SDK validation passes", async () => {
		const lagResult = {
			groupId: "orders-consumer",
			groupState: "Stable",
			topics: [
				{
					topic: "orders",
					partitions: [{ partition: 0, committedOffset: "100", latestOffset: "150", lag: "50" }],
					totalLag: "50",
				},
			],
			totalLag: "50",
		};
		const service = { getConsumerGroupLag: async () => lagResult } as unknown as KafkaService;
		const client = await buildClient(service);

		const result = await client.callTool({
			name: "kafka_get_consumer_group_lag",
			arguments: { groupId: "orders-consumer" },
		});
		await client.close();

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual(lagResult);
		const content = result.content as Array<{ type: "text"; text: string }>;
		expect(content[0]?.text).toBe(JSON.stringify(lagResult, undefined, 2));
	});

	test("kafka_list_consumer_groups: array success wraps into { groups } for structuredContent, text stays the bare array", async () => {
		const groups = [{ id: "orders-consumer", state: "Stable", groupType: "consumer", protocolType: "consumer" }];
		const service = { listConsumerGroups: async () => groups } as unknown as KafkaService;
		const client = await buildClient(service);

		const result = await client.callTool({ name: "kafka_list_consumer_groups", arguments: {} });
		await client.close();

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({ groups });
		const content = result.content as Array<{ type: "text"; text: string }>;
		expect(content[0]?.text).toBe(JSON.stringify(groups, undefined, 2));
		expect(JSON.parse(content[0]?.text ?? "null")).toEqual(groups);
	});

	test("kafka_list_consumer_groups: InvalidFilterError envelope validates as structuredContent too", async () => {
		const service = {
			listConsumerGroups: async () => {
				const { InvalidFilterError } = await import("../lib/filter.ts");
				throw new InvalidFilterError("(bad", "unterminated group");
			},
		} as unknown as KafkaService;
		const client = await buildClient(service);

		const result = await client.callTool({
			name: "kafka_list_consumer_groups",
			arguments: { filter: "(bad" },
		});
		await client.close();

		// invalidFilterEnvelope returns on a status:"success" path (ResponseBuilder.successTyped,
		// not .error) -- isError stays unset even though the payload is a { _error } envelope.
		expect(result.isError).toBeFalsy();
		const structured = result.structuredContent as { _error: { kind: string; category: string } };
		expect(structured._error.kind).toBe("not-found");
	});
});
