// tests/tools/wrap.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MultipleErrors } from "@platformatic/kafka";
import { z } from "zod";
import type { AppConfig } from "../../src/config/schemas.ts";
import { upstreamError } from "../../src/lib/errors.ts";
import { wrapHandler } from "../../src/tools/wrap.ts";
import { logger } from "../../src/utils/logger.ts";

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

	describe("error logging on handler throw", () => {
		let originalError: typeof logger.error;
		let errorSpy: ReturnType<typeof mock>;

		beforeEach(() => {
			originalError = logger.error.bind(logger);
			errorSpy = mock(() => {});
			(logger as unknown as { error: typeof errorSpy }).error = errorSpy;
		});

		afterEach(() => {
			(logger as unknown as { error: typeof originalError }).error = originalError;
		});

		test("logs error and returns isError response when handler throws", async () => {
			const failingHandler = async () => {
				throw new Error("upstream fetch failed");
			};
			const handler = wrapHandler("kafka_list_topics", makeConfig({}), failingHandler);
			const result = await handler({});

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("upstream fetch failed");
			expect(errorSpy).toHaveBeenCalledTimes(1);
			const [logArgs, logMsg] = (errorSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
				{ tool: string; error: string },
				string,
			];
			expect(logArgs.tool).toBe("kafka_list_topics");
			expect(logArgs.error).toContain("upstream fetch failed");
			expect(logMsg).toBe("Tool call error");
		});

		test("does not log error when handler succeeds", async () => {
			const handler = wrapHandler("kafka_list_topics", makeConfig({}), successHandler);
			const result = await handler({});

			expect(result.isError).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
		});
	});

	// SIO-716 regression (end-to-end): an upstream nginx HTML 503 from a Confluent
	// service flows through every layer of the new wire path:
	//   fetchUpstream (synthetic) -> upstreamError -> handler throws ->
	//   wrapHandler catches -> ResponseBuilder.error with structured arg ->
	//   sentinel + JSON appended to response text.
	// The agent's extractToolErrors then lifts the JSON back into a ToolError
	// (covered by sub-agent.test.ts), and findConfluent5xxToolErrors fires the
	// correlation rule on the structured fields (covered by sio-717-rules.test.ts).
	// This test owns the producer side of that chain.
	describe("SIO-716 e2e regression: upstream error -> sentinel wire payload", () => {
		test("ksql_list_queries handler throws upstreamError -> response carries sentinel + JSON", async () => {
			// Simulate what fetchUpstream throws when the upstream is misrouted and
			// returns nginx text/html 503 (the SIO-716 incident shape).
			const failingHandler = async () => {
				throw upstreamError("ksqlDB (ksql.dev.shared-services.eu.pvh.cloud) returned text/html error 503", {
					hostname: "ksql.dev.shared-services.eu.pvh.cloud",
					upstreamContentType: "text/html",
					statusCode: 503,
					upstreamBodyPreview: "<html>503 Service Temporarily Unavailable</html>",
				});
			};
			const handler = wrapHandler("ksql_list_queries", makeConfig({ ksqlEnabled: true }), failingHandler);
			const result = await handler({});

			expect(result.isError).toBe(true);
			const text = result.content[0]?.text ?? "";

			// Human-readable part: must mention service and hostname for log/transcript
			// readability (SIO-725).
			expect(text).toContain("ksqlDB");
			expect(text).toContain("ksql.dev.shared-services.eu.pvh.cloud");
			expect(text).toContain("503");

			// Sentinel + parseable JSON: the wire contract with the agent (SIO-728).
			expect(text).toContain("---STRUCTURED---");
			const jsonPart = text.split("\n---STRUCTURED---\n")[1] ?? "";
			const parsed = JSON.parse(jsonPart) as Record<string, unknown>;
			expect(parsed.hostname).toBe("ksql.dev.shared-services.eu.pvh.cloud");
			expect(parsed.upstreamContentType).toBe("text/html");
			expect(parsed.statusCode).toBe(503);
		});

		test("non-upstream errors do NOT get the sentinel (e.g. validation errors stay clean)", async () => {
			// internalError / invalidParams / invalidRequest don't carry upstream
			// metadata; the sentinel must not appear.
			const failingHandler = async () => {
				throw new Error("validation: missing required field 'topic'");
			};
			const handler = wrapHandler("kafka_list_topics", makeConfig({}), failingHandler);
			const result = await handler({});

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).not.toContain("---STRUCTURED---");
		});
	});

	// SIO-1190: the general throw path now appends the shared { _error } envelope when
	// the error classifies unambiguously (protocol code, HTTP status, validation, or a
	// conservative message shape). Prose stays FIRST; the SIO-728 sentinel stays LAST
	// so its split()[1] remains pure JSON. Unclassifiable errors stay unwrapped.
	describe("SIO-1190: shared _error envelope on the throw path", () => {
		function parseEnvelope(text: string): { kind: string; category: string; advice?: string; statusCode?: number } {
			const match = text.match(/\{"_error":.*?\}\}/);
			expect(match).not.toBeNull();
			return (JSON.parse(match?.[0] ?? "{}") as { _error: never })._error;
		}

		test("kafka protocol code (UNKNOWN_TOPIC_OR_PARTITION) -> not-found envelope, prose first", async () => {
			const child = Object.assign(new Error("protocol error 3"), { apiCode: 3 });
			const failingHandler = async () => {
				throw new MultipleErrors("Unknown topic audit-nonexistent.", [child]);
			};
			const handler = wrapHandler("kafka_describe_topic", makeConfig({}), failingHandler);
			const result = await handler({});

			expect(result.isError).toBe(true);
			const text = result.content[0]?.text ?? "";
			// normalizeError wraps via McpError, whose constructor bakes in the
			// "MCP error -32603: " prefix -- the prose still leads the text block.
			expect(text.startsWith("MCP error -32603: Unknown topic audit-nonexistent.")).toBe(true);
			const env = parseEnvelope(text);
			expect(env.kind).toBe("not-found");
			expect(env.category).toBe("not-found");
			expect(env.advice).toContain("Unknown topic");
		});

		test("client-side 'Unknown topic X.' message (no protocol code) -> not-found envelope", async () => {
			const failingHandler = async () => {
				throw new Error("Unknown topic zz-audit-nonexistent-topic-999999.");
			};
			const handler = wrapHandler("kafka_describe_topic", makeConfig({}), failingHandler);
			const result = await handler({});
			expect(parseEnvelope(result.content[0]?.text ?? "").kind).toBe("not-found");
		});

		test("'metadata failed N times' -> network envelope", async () => {
			const failingHandler = async () => {
				throw new Error("metadata failed 4 times");
			};
			const handler = wrapHandler("kafka_list_topics", makeConfig({}), failingHandler);
			const result = await handler({});
			expect(parseEnvelope(result.content[0]?.text ?? "").kind).toBe("network");
		});

		test("zod validation error -> bad-input envelope", async () => {
			const failingHandler = async () => {
				z.object({ topic: z.string() }).parse({});
				return { content: [{ type: "text" as const, text: "unreachable" }] };
			};
			const handler = wrapHandler("kafka_describe_topic", makeConfig({}), failingHandler);
			const result = await handler({});
			expect(parseEnvelope(result.content[0]?.text ?? "").kind).toBe("bad-input");
		});

		test("upstream 503 -> server-error envelope WITH statusCode, sentinel still last and parseable", async () => {
			const failingHandler = async () => {
				throw upstreamError("ksqlDB (ksql.prd.shared-services.eu.pvh.cloud) returned text/html error 503", {
					hostname: "ksql.prd.shared-services.eu.pvh.cloud",
					upstreamContentType: "text/html",
					statusCode: 503,
				});
			};
			const handler = wrapHandler("ksql_list_queries", makeConfig({ ksqlEnabled: true }), failingHandler);
			const result = await handler({});

			const text = result.content[0]?.text ?? "";
			const env = parseEnvelope(text);
			expect(env.kind).toBe("server-error");
			expect(env.statusCode).toBe(503);
			// SIO-728 wire contract preserved: sentinel LAST, split()[1] is pure JSON.
			const jsonPart = text.split("\n---STRUCTURED---\n")[1] ?? "";
			const parsed = JSON.parse(jsonPart) as Record<string, unknown>;
			expect(parsed.statusCode).toBe(503);
			expect(parsed.hostname).toBe("ksql.prd.shared-services.eu.pvh.cloud");
			// The envelope must come BEFORE the sentinel.
			expect(text.indexOf('"_error"')).toBeLessThan(text.indexOf("---STRUCTURED---"));
		});

		test("unclassifiable generic error stays unwrapped (no _error, no sentinel)", async () => {
			const failingHandler = async () => {
				throw new Error("Describing groups failed.");
			};
			const handler = wrapHandler("kafka_describe_consumer_group", makeConfig({}), failingHandler);
			const result = await handler({});
			const text = result.content[0]?.text ?? "";
			expect(text).toBe("MCP error -32603: Describing groups failed.");
			expect(text).not.toContain("_error");
			expect(text).not.toContain("---STRUCTURED---");
		});
	});
});
