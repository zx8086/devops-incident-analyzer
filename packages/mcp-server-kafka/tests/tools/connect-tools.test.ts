// tests/tools/connect-tools.test.ts
import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../src/config/schemas.ts";
import { ConnectService } from "../../src/services/connect-service.ts";
import type { KafkaService } from "../../src/services/kafka-service.ts";
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
		schemaRegistry: { enabled: false, url: "http://localhost:8081", apiKey: "", apiSecret: "" },
		ksql: { enabled: false, endpoint: "http://localhost:8088", apiKey: "", apiSecret: "" },
		connect: { enabled: true, url: "http://localhost:8083", apiKey: "", apiSecret: "" },
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

describe("Connect tool registration gating", () => {
	test("read-only when allowWrites=false", () => {
		const config = buildConfig();
		const server = new McpServer({ name: "test", version: "0" });
		const fakeKafka = {} as unknown as KafkaService;
		const connectService = new ConnectService(config);
		registerAllTools(server, fakeKafka, config, { connectService });
		const tools = listToolNames(server);
		expect(tools).toContain("connect_get_cluster_info");
		expect(tools).not.toContain("connect_pause_connector");
		expect(tools).not.toContain("connect_delete_connector");
	});

	test("writes registered when allowWrites=true, destructive still gated", () => {
		const config = buildConfig({ allowWrites: true, allowDestructive: false });
		const server = new McpServer({ name: "test", version: "0" });
		const fakeKafka = {} as unknown as KafkaService;
		const connectService = new ConnectService(config);
		registerAllTools(server, fakeKafka, config, { connectService });
		const tools = listToolNames(server);
		expect(tools).toContain("connect_pause_connector");
		expect(tools).toContain("connect_resume_connector");
		expect(tools).toContain("connect_restart_connector");
		expect(tools).not.toContain("connect_restart_connector_task");
		expect(tools).not.toContain("connect_delete_connector");
	});

	test("all writes + destructives registered when both flags true", () => {
		const config = buildConfig({ allowWrites: true, allowDestructive: true });
		const server = new McpServer({ name: "test", version: "0" });
		const fakeKafka = {} as unknown as KafkaService;
		const connectService = new ConnectService(config);
		registerAllTools(server, fakeKafka, config, { connectService });
		const tools = listToolNames(server);
		expect(tools).toContain("connect_pause_connector");
		expect(tools).toContain("connect_restart_connector");
		expect(tools).toContain("connect_restart_connector_task");
		expect(tools).toContain("connect_delete_connector");
	});
});
