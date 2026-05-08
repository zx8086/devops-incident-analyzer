// tests/tools/schema-tools.test.ts
import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../src/config/schemas.ts";
import type { KafkaService } from "../../src/services/kafka-service.ts";
import { SchemaRegistryService } from "../../src/services/schema-registry-service.ts";
import { registerAllTools } from "../../src/tools/index.ts";

function buildConfig(kafkaOverrides: Partial<AppConfig["kafka"]> = {}): AppConfig {
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
		schemaRegistry: { enabled: true, url: "http://x", apiKey: "", apiSecret: "" },
		ksql: { enabled: false, endpoint: "http://localhost:8088", apiKey: "", apiSecret: "" },
		connect: { enabled: false, url: "http://localhost:8083", apiKey: "", apiSecret: "" },
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

describe("Schema Registry write/destructive tool registration gating", () => {
	test("read-only when allowWrites=false: existing kafka_* tools present, no sr_* tools", () => {
		const config = buildConfig();
		const server = new McpServer({ name: "test", version: "0" });
		const fakeKafka = {} as unknown as KafkaService;
		const schemaRegistryService = new SchemaRegistryService(config);
		registerAllTools(server, fakeKafka, config, { schemaRegistryService });
		const tools = listToolNames(server);

		// existing kafka_* schema tools must still be present
		expect(tools).toContain("kafka_list_schemas");
		expect(tools).toContain("kafka_register_schema");
		expect(tools).toContain("kafka_delete_schema_subject");

		// none of the new gated sr_* tools
		expect(tools).not.toContain("sr_register_schema");
		expect(tools).not.toContain("sr_check_compatibility");
		expect(tools).not.toContain("sr_set_compatibility");
		expect(tools).not.toContain("sr_soft_delete_subject");
		expect(tools).not.toContain("sr_soft_delete_subject_version");
		expect(tools).not.toContain("sr_hard_delete_subject");
		expect(tools).not.toContain("sr_hard_delete_subject_version");
	});

	test("write tools registered when allowWrites=true, destructive tools still gated", () => {
		const config = buildConfig({ allowWrites: true, allowDestructive: false });
		const server = new McpServer({ name: "test", version: "0" });
		const fakeKafka = {} as unknown as KafkaService;
		const schemaRegistryService = new SchemaRegistryService(config);
		registerAllTools(server, fakeKafka, config, { schemaRegistryService });
		const tools = listToolNames(server);

		// write tools present
		expect(tools).toContain("sr_register_schema");
		expect(tools).toContain("sr_check_compatibility");
		expect(tools).toContain("sr_set_compatibility");

		// destructive tools absent
		expect(tools).not.toContain("sr_soft_delete_subject");
		expect(tools).not.toContain("sr_soft_delete_subject_version");
		expect(tools).not.toContain("sr_hard_delete_subject");
		expect(tools).not.toContain("sr_hard_delete_subject_version");

		// existing kafka_* tools unaffected
		expect(tools).toContain("kafka_list_schemas");
	});

	test("all 7 new tools registered when both flags true", () => {
		const config = buildConfig({ allowWrites: true, allowDestructive: true });
		const server = new McpServer({ name: "test", version: "0" });
		const fakeKafka = {} as unknown as KafkaService;
		const schemaRegistryService = new SchemaRegistryService(config);
		registerAllTools(server, fakeKafka, config, { schemaRegistryService });
		const tools = listToolNames(server);

		// all 7 new tools present
		expect(tools).toContain("sr_register_schema");
		expect(tools).toContain("sr_check_compatibility");
		expect(tools).toContain("sr_set_compatibility");
		expect(tools).toContain("sr_soft_delete_subject");
		expect(tools).toContain("sr_soft_delete_subject_version");
		expect(tools).toContain("sr_hard_delete_subject");
		expect(tools).toContain("sr_hard_delete_subject_version");

		// existing kafka_* tools unaffected
		expect(tools).toContain("kafka_list_schemas");
	});
});
