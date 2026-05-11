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
	test("baseline (10 core read tools, no add-ons enabled, no writes/destructive)", () => {
		// SIO-732: core writes (3) and destructive (2) are now registration-gated.
		// With allowWrites=false and allowDestructive=false, only the 10 read tools
		// (7 base + 3 extended) are visible.
		const server = new McpServer({ name: "test", version: "0" });
		const config = buildFullStackConfig();
		registerAllTools(server, fakeKafka, {
			...config,
			schemaRegistry: { ...config.schemaRegistry, enabled: false },
			ksql: { ...config.ksql, enabled: false },
			connect: { ...config.connect, enabled: false },
			restproxy: { ...config.restproxy, enabled: false },
		});
		const tools = listToolNames(server);
		expect(tools.length).toBe(10);
		expect(tools).not.toContain("kafka_produce_message");
		expect(tools).not.toContain("kafka_delete_topic");
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
		// 10 core reads + 3 core writes + 2 core destructive
		// + 5 schema reads + 2 schema writes + 1 schema destructive
		// + 3 sr_* writes + 4 sr_* destructive
		// + 6 ksql reads + 1 ksql write
		// + 4 connect reads + 3 connect writes + 2 connect destructive
		// + 3 restproxy reads + 6 restproxy writes = 55
		expect(tools.length).toBe(55);
		// Spot-check representative tools from each gated group
		expect(tools).toContain("kafka_produce_message");
		expect(tools).toContain("kafka_delete_topic");
		expect(tools).toContain("kafka_register_schema");
		expect(tools).toContain("kafka_delete_schema_subject");
		expect(tools).toContain("ksql_execute_statement");
		expect(tools).toContain("connect_pause_connector");
		expect(tools).toContain("connect_delete_connector");
		expect(tools).toContain("sr_register_schema");
		expect(tools).toContain("sr_hard_delete_subject");
		expect(tools).toContain("restproxy_list_topics");
		expect(tools).toContain("restproxy_produce");
		expect(tools).toContain("restproxy_delete_consumer");
	});

	test("full stack with allowWrites only (no destructive) registers 46 tools", () => {
		// SIO-732: with destructive off, kafka_delete_topic, kafka_reset_consumer_group_offsets,
		// kafka_delete_schema_subject, connect_restart_connector_task, connect_delete_connector,
		// and the 4 sr_*_delete_subject* tools (9 total) are excluded.
		const server = new McpServer({ name: "test", version: "0" });
		const config = buildFullStackConfig({ allowWrites: true, allowDestructive: false });
		registerAllTools(server, fakeKafka, config, {
			schemaRegistryService: new SchemaRegistryService(config),
			ksqlService: new KsqlService(config),
			connectService: new ConnectService(config),
			restProxyService: new RestProxyService(config),
		});
		const tools = listToolNames(server);
		// 55 - 2 core destructive - 1 schema destructive - 2 connect destructive - 4 sr destructive = 46
		expect(tools.length).toBe(46);
		expect(tools).not.toContain("kafka_delete_topic");
		expect(tools).not.toContain("kafka_reset_consumer_group_offsets");
		expect(tools).not.toContain("kafka_delete_schema_subject");
		expect(tools).not.toContain("connect_delete_connector");
		expect(tools).not.toContain("connect_restart_connector_task");
		expect(tools).not.toContain("sr_hard_delete_subject");
		expect(tools).toContain("kafka_produce_message");
		expect(tools).toContain("kafka_register_schema");
		expect(tools).toContain("ksql_execute_statement");
		expect(tools).toContain("restproxy_produce");
	});
});
