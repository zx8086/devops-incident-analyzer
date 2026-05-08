// tests/tools/full-stack-tools.test.ts
import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../src/config/schemas.ts";
import { ConnectService } from "../../src/services/connect-service.ts";
import type { KafkaService } from "../../src/services/kafka-service.ts";
import { KsqlService } from "../../src/services/ksql-service.ts";
import { RestProxyService } from "../../src/services/restproxy-service.ts";
import { SchemaRegistryService } from "../../src/services/schema-registry-service.ts";
import { registerAllTools } from "../../src/tools/index.ts";

function buildFullStackConfig(kafkaOverrides: Partial<AppConfig["kafka"]> = {}): AppConfig {
	return {
		kafka: {
			provider: "local",
			clientId: "test",
			allowWrites: false,
			allowDestructive: false,
			consumeMaxMessages: 50,
			consumeTimeoutMs: 30000,
			...kafkaOverrides,
		},
		msk: { bootstrapBrokers: "", clusterArn: "", region: "eu-west-1", authMode: "none" },
		confluent: { bootstrapServers: "", apiKey: "", apiSecret: "", restEndpoint: "", clusterId: "" },
		local: { bootstrapServers: "localhost:9092" },
		schemaRegistry: { enabled: true, url: "http://x:8081", apiKey: "", apiSecret: "" },
		ksql: { enabled: true, endpoint: "http://x:8088", apiKey: "", apiSecret: "" },
		connect: { enabled: true, url: "http://x:8083", apiKey: "", apiSecret: "" },
		restproxy: { enabled: true, url: "http://x:8082", apiKey: "", apiSecret: "" },
		logging: { level: "silent", backend: "pino" },
		telemetry: { enabled: false, serviceName: "test", mode: "console", otlpEndpoint: "http://localhost:4318" },
		transport: {
			mode: "stdio",
			port: 3000,
			host: "127.0.0.1",
			path: "/mcp",
			sessionMode: "stateless",
			apiKey: "",
			allowedOrigins: "",
			idleTimeout: 120,
		},
	};
}

function listToolNames(server: McpServer): string[] {
	return Object.keys((server as unknown as { _registeredTools: object })._registeredTools);
}

const fakeKafka = {} as unknown as KafkaService;

describe("Full Confluent stack tool registration (B4 combo 5)", () => {
	test("baseline (15 kafka tools, no add-ons enabled)", () => {
		const server = new McpServer({ name: "test", version: "0" });
		const config = buildFullStackConfig();
		registerAllTools(server, fakeKafka, {
			...config,
			schemaRegistry: { ...config.schemaRegistry, enabled: false },
			ksql: { ...config.ksql, enabled: false },
			connect: { ...config.connect, enabled: false },
			restproxy: { ...config.restproxy, enabled: false },
		});
		expect(listToolNames(server).length).toBe(15);
	});

	test("full stack with allowWrites + allowDestructive registers exactly 55 tools", () => {
		const server = new McpServer({ name: "test", version: "0" });
		const config = buildFullStackConfig({ allowWrites: true, allowDestructive: true });
		registerAllTools(server, fakeKafka, config, {
			schemaRegistryService: new SchemaRegistryService(config),
			ksqlService: new KsqlService(config),
			connectService: new ConnectService(config),
			restProxyService: new RestProxyService(config),
		});
		const tools = listToolNames(server);
		// 15 kafka + 8 SR reads + 7 ksql + 4 connect reads + 3 connect writes + 2 connect destructive
		// + 3 SR writes + 4 SR destructive + 3 restproxy reads + 6 restproxy writes = 55
		expect(tools.length).toBe(55);
		// Spot-check representative tools from each gated group
		expect(tools).toContain("connect_pause_connector");
		expect(tools).toContain("connect_delete_connector");
		expect(tools).toContain("sr_register_schema");
		expect(tools).toContain("sr_hard_delete_subject");
		expect(tools).toContain("restproxy_list_topics");
		expect(tools).toContain("restproxy_produce");
		expect(tools).toContain("restproxy_delete_consumer");
	});

	test("full stack with allowWrites only (no destructive) registers 49 tools", () => {
		const server = new McpServer({ name: "test", version: "0" });
		const config = buildFullStackConfig({ allowWrites: true, allowDestructive: false });
		registerAllTools(server, fakeKafka, config, {
			schemaRegistryService: new SchemaRegistryService(config),
			ksqlService: new KsqlService(config),
			connectService: new ConnectService(config),
			restProxyService: new RestProxyService(config),
		});
		const tools = listToolNames(server);
		// 15 + 8 + 7 + 4 + 3 (connect writes) + 0 (no destructive) + 3 (SR writes) + 0 (no destructive)
		// + 3 (restproxy reads) + 6 (restproxy writes) = 49
		expect(tools.length).toBe(49);
		expect(tools).not.toContain("connect_delete_connector");
		expect(tools).not.toContain("sr_hard_delete_subject");
		expect(tools).toContain("restproxy_produce");
	});
});
