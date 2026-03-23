// shared/src/tracing/__tests__/langsmith.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { initializeTracing, isTracingActive, resetTracing } from "../langsmith.ts";

describe("LangSmith Tracing Initialization", () => {
	afterEach(() => {
		resetTracing();
		delete process.env.LANGSMITH_TRACING;
		delete process.env.LANGCHAIN_TRACING_V2;
		delete process.env.LANGSMITH_API_KEY;
		delete process.env.LANGCHAIN_API_KEY;
		delete process.env.LANGSMITH_ENDPOINT;
		delete process.env.LANGCHAIN_ENDPOINT;
		delete process.env.LANGSMITH_PROJECT;
		delete process.env.LANGCHAIN_PROJECT;
	});

	test("tracing is disabled by default", () => {
		expect(isTracingActive()).toBe(false);
	});

	test("tracing stays disabled without LANGSMITH_TRACING env var", () => {
		initializeTracing({ apiKey: "test-key" });
		expect(isTracingActive()).toBe(false);
	});

	test("tracing stays disabled without API key", () => {
		process.env.LANGSMITH_TRACING = "true";
		initializeTracing();
		expect(isTracingActive()).toBe(false);
	});

	test("tracing enables with env var and API key", () => {
		process.env.LANGSMITH_TRACING = "true";
		initializeTracing({ apiKey: "test-key" });
		expect(isTracingActive()).toBe(true);
	});

	test("sets all env vars when enabled", () => {
		process.env.LANGSMITH_TRACING = "true";
		initializeTracing({ apiKey: "test-key", project: "test-project", endpoint: "https://custom.endpoint" });

		expect(process.env.LANGSMITH_API_KEY).toBe("test-key");
		expect(process.env.LANGCHAIN_API_KEY).toBe("test-key");
		expect(process.env.LANGSMITH_PROJECT).toBe("test-project");
		expect(process.env.LANGCHAIN_PROJECT).toBe("test-project");
		expect(process.env.LANGSMITH_ENDPOINT).toBe("https://custom.endpoint");
		expect(process.env.LANGCHAIN_ENDPOINT).toBe("https://custom.endpoint");
	});

	test("respects LANGCHAIN_TRACING_V2 as alternative enable flag", () => {
		process.env.LANGCHAIN_TRACING_V2 = "true";
		initializeTracing({ apiKey: "test-key" });
		expect(isTracingActive()).toBe(true);
	});

	test("initialization is idempotent", () => {
		process.env.LANGSMITH_TRACING = "true";
		initializeTracing({ apiKey: "key-1", project: "project-1" });
		initializeTracing({ apiKey: "key-2", project: "project-2" });

		// First call wins
		expect(process.env.LANGSMITH_API_KEY).toBe("key-1");
		expect(process.env.LANGSMITH_PROJECT).toBe("project-1");
	});
});
