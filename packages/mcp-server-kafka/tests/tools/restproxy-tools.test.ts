// tests/tools/restproxy-tools.test.ts
import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../src/config/schemas.ts";
import type { KafkaService } from "../../src/services/kafka-service.ts";
import { RestProxyService } from "../../src/services/restproxy-service.ts";
import { registerAllTools } from "../../src/tools/index.ts";

function buildConfig(
	kafkaOverrides: Partial<AppConfig["kafka"]> = {},
	restproxyOverrides: Partial<AppConfig["restproxy"]> = {},
): AppConfig {
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
		connect: { enabled: false, url: "http://localhost:8083", apiKey: "", apiSecret: "" },
		restproxy: {
			enabled: true,
			url: "http://localhost:8082",
			apiKey: "",
			apiSecret: "",
			...restproxyOverrides,
		},
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

const REST_PROXY_READ_TOOLS = ["restproxy_list_topics", "restproxy_get_topic", "restproxy_get_partitions"];

const REST_PROXY_WRITE_TOOLS = [
	"restproxy_produce",
	"restproxy_create_consumer",
	"restproxy_subscribe",
	"restproxy_consume",
	"restproxy_commit_offsets",
	"restproxy_delete_consumer",
];

describe("REST Proxy tool registration gating", () => {
	test("no restproxy_* tools when service not provided", () => {
		const config = buildConfig();
		const server = new McpServer({ name: "test", version: "0" });
		const fakeKafka = {} as unknown as KafkaService;
		// no restProxyService in options
		registerAllTools(server, fakeKafka, config);
		const tools = listToolNames(server);
		for (const tool of [...REST_PROXY_READ_TOOLS, ...REST_PROXY_WRITE_TOOLS]) {
			expect(tools).not.toContain(tool);
		}
	});

	test("only 3 read tools when service provided and allowWrites=false", () => {
		const config = buildConfig({ allowWrites: false });
		const server = new McpServer({ name: "test", version: "0" });
		const fakeKafka = {} as unknown as KafkaService;
		const restProxyService = new RestProxyService(config);
		registerAllTools(server, fakeKafka, config, { restProxyService });
		const tools = listToolNames(server);
		for (const tool of REST_PROXY_READ_TOOLS) {
			expect(tools).toContain(tool);
		}
		for (const tool of REST_PROXY_WRITE_TOOLS) {
			expect(tools).not.toContain(tool);
		}
	});

	test("all 9 tools when service provided and allowWrites=true", () => {
		const config = buildConfig({ allowWrites: true });
		const server = new McpServer({ name: "test", version: "0" });
		const fakeKafka = {} as unknown as KafkaService;
		const restProxyService = new RestProxyService(config);
		registerAllTools(server, fakeKafka, config, { restProxyService });
		const tools = listToolNames(server);
		for (const tool of [...REST_PROXY_READ_TOOLS, ...REST_PROXY_WRITE_TOOLS]) {
			expect(tools).toContain(tool);
		}
	});
});
