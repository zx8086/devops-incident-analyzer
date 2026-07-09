// shared/src/tracing/__tests__/server-tracing-factory.test.ts
import { afterEach, describe, expect, mock, test } from "bun:test";
import pino from "pino";
import { resetTracing } from "../langsmith.ts";
import { createServerTracing } from "../server-tracing-factory.ts";

function silentLogger() {
	return pino({ enabled: false });
}

describe("createServerTracing", () => {
	afterEach(() => {
		// initializeTracing flips a module-level singleton in langsmith.ts; reset it
		// so these tests don't bleed tracing-enabled state into other test files.
		resetTracing();
		delete process.env.TEST_LANGSMITH_PROJECT;
		delete process.env.LANGSMITH_PROJECT;
		delete process.env.LANGSMITH_TRACING;
		delete process.env.LANGSMITH_API_KEY;
		delete process.env.LANGCHAIN_API_KEY;
		delete process.env.LANGCHAIN_PROJECT;
	});

	test("initializeTracing prefers projectEnvVar over LANGSMITH_PROJECT and defaultProject", () => {
		process.env.TEST_LANGSMITH_PROJECT = "from-server-env";
		process.env.LANGSMITH_PROJECT = "from-generic-env";
		process.env.LANGSMITH_TRACING = "true";

		const { initializeTracing } = createServerTracing({
			dataSourceId: "kafka",
			projectEnvVar: "TEST_LANGSMITH_PROJECT",
			defaultProject: "kafka-mcp-server",
			log: silentLogger(),
		});

		initializeTracing({ apiKey: "test-key" });
		expect(process.env.LANGSMITH_PROJECT).toBe("from-server-env");
	});

	test("initializeTracing falls back to LANGSMITH_PROJECT when server env var unset", () => {
		process.env.LANGSMITH_PROJECT = "generic-project";
		process.env.LANGSMITH_TRACING = "true";

		const { initializeTracing } = createServerTracing({
			dataSourceId: "kafka",
			projectEnvVar: "TEST_LANGSMITH_PROJECT",
			defaultProject: "kafka-mcp-server",
			log: silentLogger(),
		});

		initializeTracing({ apiKey: "test-key" });
		expect(process.env.LANGSMITH_PROJECT).toBe("generic-project");
	});

	test("initializeTracing falls back to defaultProject when no env vars set", () => {
		process.env.LANGSMITH_TRACING = "true";

		const { initializeTracing } = createServerTracing({
			dataSourceId: "kafka",
			projectEnvVar: "TEST_LANGSMITH_PROJECT",
			defaultProject: "kafka-mcp-server",
			log: silentLogger(),
		});

		initializeTracing({ apiKey: "test-key" });
		expect(process.env.LANGSMITH_PROJECT).toBe("kafka-mcp-server");
	});

	test("traceToolCall returns handler result and logs start/completion", async () => {
		const infoLog = mock((_data: Record<string, unknown>, _msg?: string) => {});
		const errorLog = mock((_data: Record<string, unknown>, _msg?: string) => {});
		const log = { info: infoLog, error: errorLog } as unknown as ReturnType<typeof silentLogger>;

		const { traceToolCall } = createServerTracing({
			dataSourceId: "couchbase",
			projectEnvVar: "TEST_LANGSMITH_PROJECT",
			defaultProject: "couchbase-mcp-server",
			log,
		});

		const result = await traceToolCall("run_query", async () => "ok");

		expect(result).toBe("ok");
		expect(infoLog).toHaveBeenCalledTimes(2);
		expect(errorLog).not.toHaveBeenCalled();
		expect(infoLog.mock.calls[0]?.[0]).toMatchObject({ tool: "run_query", dataSource: "couchbase" });
	});

	test("traceToolCall logs failure and rethrows", async () => {
		const infoLog = mock((_data: Record<string, unknown>, _msg?: string) => {});
		const errorLog = mock((_data: Record<string, unknown>, _msg?: string) => {});
		const log = { info: infoLog, error: errorLog } as unknown as ReturnType<typeof silentLogger>;

		const { traceToolCall } = createServerTracing({
			dataSourceId: "konnect",
			projectEnvVar: "TEST_LANGSMITH_PROJECT",
			defaultProject: "konnect-mcp-server",
			log,
		});

		await expect(
			traceToolCall("failing_tool", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(errorLog).toHaveBeenCalledTimes(1);
		expect(errorLog.mock.calls[0]?.[0]).toMatchObject({ tool: "failing_tool", dataSource: "konnect" });
	});
});
