// tests/tools/wrap.test.ts
import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../../src/config/schemas.ts";
import { wrapHandler } from "../../src/tools/wrap.ts";

function makeConfig(
	overrides: Partial<{
		allowWrites: boolean;
		allowDestructive: boolean;
		schemaRegistryEnabled: boolean;
		ksqlEnabled: boolean;
	}>,
): AppConfig {
	return {
		kafka: {
			provider: "local",
			clientId: "test",
			allowWrites: overrides.allowWrites ?? false,
			allowDestructive: overrides.allowDestructive ?? false,
			consumeMaxMessages: 50,
			consumeTimeoutMs: 30000,
		},
		msk: { bootstrapBrokers: "", clusterArn: "", region: "eu-west-1" },
		confluent: {
			bootstrapServers: "",
			apiKey: "",
			apiSecret: "",
			restEndpoint: "",
			clusterId: "",
		},
		local: { bootstrapServers: "localhost:9092" },
		schemaRegistry: {
			enabled: overrides.schemaRegistryEnabled ?? false,
			url: "http://localhost:8081",
			apiKey: "",
			apiSecret: "",
		},
		ksql: {
			enabled: overrides.ksqlEnabled ?? false,
			endpoint: "http://localhost:8088",
			apiKey: "",
			apiSecret: "",
		},
		logging: { level: "silent", backend: "pino" },
		telemetry: {
			enabled: false,
			serviceName: "test",
			mode: "console",
			otlpEndpoint: "http://localhost:4318",
		},
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

const successHandler = async () => ({
	content: [{ type: "text" as const, text: "ok" }],
});

describe("wrapHandler", () => {
	describe("feature gates", () => {
		test.each([
			{ tool: "kafka_list_schemas", config: { schemaRegistryEnabled: false }, error: "Schema Registry is not enabled" },
			{ tool: "ksql_list_streams", config: { ksqlEnabled: false }, error: "ksqlDB is not enabled" },
		])("blocks $tool when feature disabled", async ({ tool, config, error }) => {
			const handler = wrapHandler(tool, makeConfig(config), successHandler);
			const result = await handler({});
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain(error);
		});

		test.each([
			{ tool: "kafka_list_schemas", config: { schemaRegistryEnabled: true } },
			{ tool: "ksql_list_streams", config: { ksqlEnabled: true } },
		])("allows $tool when feature enabled", async ({ tool, config }) => {
			const handler = wrapHandler(tool, makeConfig(config), successHandler);
			const result = await handler({});
			expect(result.isError).toBeUndefined();
		});
	});

	describe("permission gates", () => {
		test.each([
			{ tool: "kafka_produce_message", config: { allowWrites: false }, error: "Write operations are disabled" },
			{ tool: "kafka_delete_topic", config: { allowDestructive: false }, error: "Destructive operations are disabled" },
		])("blocks $tool when permission disabled", async ({ tool, config, error }) => {
			const handler = wrapHandler(tool, makeConfig(config), successHandler);
			const result = await handler({});
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain(error);
		});

		test.each([
			{ tool: "kafka_produce_message", config: { allowWrites: true } },
			{ tool: "kafka_delete_topic", config: { allowDestructive: true } },
		])("allows $tool when permission enabled", async ({ tool, config }) => {
			const handler = wrapHandler(tool, makeConfig(config), successHandler);
			const result = await handler({});
			expect(result.isError).toBeUndefined();
		});
	});

	describe("schema registry write/destructive permission gates", () => {
		test.each([
			{
				tool: "kafka_register_schema",
				config: { schemaRegistryEnabled: true, allowWrites: false },
				error: "Write operations are disabled",
			},
			{
				tool: "kafka_delete_schema_subject",
				config: { schemaRegistryEnabled: true, allowDestructive: false },
				error: "Destructive operations are disabled",
			},
		])("blocks $tool when feature enabled but permission disabled", async ({ tool, config, error }) => {
			const handler = wrapHandler(tool, makeConfig(config), successHandler);
			const result = await handler({});
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain(error);
		});

		test.each([
			{ tool: "kafka_register_schema", config: { schemaRegistryEnabled: true, allowWrites: true } },
			{ tool: "kafka_delete_schema_subject", config: { schemaRegistryEnabled: true, allowDestructive: true } },
		])("allows $tool when feature and permission enabled", async ({ tool, config }) => {
			const handler = wrapHandler(tool, makeConfig(config), successHandler);
			const result = await handler({});
			expect(result.isError).toBeUndefined();
		});
	});

	describe("ksql write permission gates", () => {
		test("blocks ksql_execute_statement when ksql enabled but writes disabled", async () => {
			const config = makeConfig({ ksqlEnabled: true, allowWrites: false });
			const handler = wrapHandler("ksql_execute_statement", config, successHandler);
			const result = await handler({});
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("Write operations are disabled");
		});

		test("allows ksql_execute_statement when ksql and writes enabled", async () => {
			const config = makeConfig({ ksqlEnabled: true, allowWrites: true });
			const handler = wrapHandler("ksql_execute_statement", config, successHandler);
			const result = await handler({});
			expect(result.isError).toBeUndefined();
		});
	});

	describe("feature gate takes precedence over permission gate", () => {
		test.each([
			{
				tool: "kafka_register_schema",
				config: { schemaRegistryEnabled: false, allowWrites: false },
				error: "Schema Registry is not enabled",
			},
			{
				tool: "ksql_execute_statement",
				config: { ksqlEnabled: false, allowWrites: false },
				error: "ksqlDB is not enabled",
			},
		])("$tool feature gate fires before permission gate", async ({ tool, config, error }) => {
			const handler = wrapHandler(tool, makeConfig(config), successHandler);
			const result = await handler({});
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain(error);
		});
	});

	describe("read tools pass through", () => {
		test.each([{ tool: "kafka_list_topics" }, { tool: "kafka_describe_cluster" }])("$tool always works", async ({
			tool,
		}) => {
			const handler = wrapHandler(tool, makeConfig({}), successHandler);
			const result = await handler({});
			expect(result.isError).toBeUndefined();
		});
	});
});
