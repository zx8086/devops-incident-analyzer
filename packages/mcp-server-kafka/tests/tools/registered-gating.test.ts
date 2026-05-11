// tests/tools/registered-gating.test.ts
import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppConfig } from "../../src/config/schemas.ts";
import { ConnectService } from "../../src/services/connect-service.ts";
import type { KafkaService } from "../../src/services/kafka-service.ts";
import { KsqlService } from "../../src/services/ksql-service.ts";
import { RestProxyService } from "../../src/services/restproxy-service.ts";
import { SchemaRegistryService } from "../../src/services/schema-registry-service.ts";
import { registerAllTools } from "../../src/tools/index.ts";

// SIO-732: registered-set lint + acceptance test.
// Complements SIO-730's source-set test (prompts-tags.test.ts) by walking the
// tools actually registered on McpServer for several gate permutations. Asserts:
//   1. Every visible description matches /^\[(READ|WRITE|DESTRUCTIVE)\] / — catches
//      any future server.tool(...) call that bypasses the prompts module.
//   2. The set of visible tool *names* matches the expected set per permutation —
//      catches regressions in registration-time gating itself.

const TAG_REGEX = /^\[(READ|WRITE|DESTRUCTIVE)\] /;

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

interface RegisteredTool {
	name: string;
	description: string;
}

function buildServer(config: AppConfig): McpServer {
	const server = new McpServer({ name: "test", version: "0" });
	const fakeKafka = {} as unknown as KafkaService;
	registerAllTools(server, fakeKafka, config, {
		schemaRegistryService: new SchemaRegistryService(config),
		ksqlService: new KsqlService(config),
		connectService: new ConnectService(config),
		restProxyService: new RestProxyService(config),
	});
	return server;
}

function listRegisteredTools(server: McpServer): RegisteredTool[] {
	const reg = (server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;
	return Object.entries(reg).map(([name, t]) => ({ name, description: t.description ?? "" }));
}

const WRITE_GATED_NAMES = [
	"kafka_produce_message",
	"kafka_create_topic",
	"kafka_alter_topic_config",
	"kafka_register_schema",
	"kafka_set_schema_config",
	"ksql_execute_statement",
	"connect_pause_connector",
	"connect_resume_connector",
	"connect_restart_connector",
	"sr_register_schema",
	"sr_check_compatibility",
	"sr_set_compatibility",
	"restproxy_produce",
	"restproxy_create_consumer",
	"restproxy_subscribe",
	"restproxy_consume",
	"restproxy_commit_offsets",
	"restproxy_delete_consumer",
];

const DESTRUCTIVE_GATED_NAMES = [
	"kafka_delete_topic",
	"kafka_reset_consumer_group_offsets",
	"kafka_delete_schema_subject",
	"connect_restart_connector_task",
	"connect_delete_connector",
	"sr_soft_delete_subject",
	"sr_soft_delete_subject_version",
	"sr_hard_delete_subject",
	"sr_hard_delete_subject_version",
];

describe("registered-set tag invariant (SIO-732 / SIO-730 companion)", () => {
	test("every visible tool description starts with [READ]/[WRITE]/[DESTRUCTIVE] (writes off, destructive off)", () => {
		const server = buildServer(buildConfig());
		const tools = listRegisteredTools(server);
		const violations = tools
			.filter((t) => !TAG_REGEX.test(t.description))
			.map((t) => `${t.name}: ${t.description.slice(0, 60)}...`);
		expect(violations).toEqual([]);
		expect(tools.length).toBeGreaterThan(0);
	});

	test("every visible tool description starts with the tag prefix (writes on, destructive on)", () => {
		const server = buildServer(buildConfig({ allowWrites: true, allowDestructive: true }));
		const tools = listRegisteredTools(server);
		const violations = tools
			.filter((t) => !TAG_REGEX.test(t.description))
			.map((t) => `${t.name}: ${t.description.slice(0, 60)}...`);
		expect(violations).toEqual([]);
	});

	test("every visible tool description starts with the tag prefix (writes on, destructive off)", () => {
		const server = buildServer(buildConfig({ allowWrites: true, allowDestructive: false }));
		const tools = listRegisteredTools(server);
		const violations = tools
			.filter((t) => !TAG_REGEX.test(t.description))
			.map((t) => `${t.name}: ${t.description.slice(0, 60)}...`);
		expect(violations).toEqual([]);
	});
});

describe("registration-time gating membership (SIO-732 acceptance)", () => {
	test("allowDestructive=false hides every destructive tool from tools/list", () => {
		const server = buildServer(buildConfig({ allowWrites: true, allowDestructive: false }));
		const names = new Set(listRegisteredTools(server).map((t) => t.name));
		for (const dest of DESTRUCTIVE_GATED_NAMES) {
			expect(names.has(dest)).toBe(false);
		}
	});

	test("allowWrites=false hides every write tool from tools/list", () => {
		const server = buildServer(buildConfig({ allowWrites: false, allowDestructive: false }));
		const names = new Set(listRegisteredTools(server).map((t) => t.name));
		for (const write of WRITE_GATED_NAMES) {
			expect(names.has(write)).toBe(false);
		}
	});

	test("allowWrites=true + allowDestructive=true registers every gated tool", () => {
		const server = buildServer(buildConfig({ allowWrites: true, allowDestructive: true }));
		const names = new Set(listRegisteredTools(server).map((t) => t.name));
		for (const write of WRITE_GATED_NAMES) {
			expect(names.has(write)).toBe(true);
		}
		for (const dest of DESTRUCTIVE_GATED_NAMES) {
			expect(names.has(dest)).toBe(true);
		}
	});
});
