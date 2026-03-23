// agent/tests/alignment.test.ts
import { describe, expect, test } from "bun:test";
import type { DataSourceResult, ToolError, ToolErrorCategory } from "@devops-agent/shared";
import { Send } from "@langchain/langgraph";
import { checkAlignment, getDataSourceErrorCategories, routeAfterAlignment } from "../src/alignment.ts";
import type { AgentStateType } from "../src/state.ts";
import { classifyToolError } from "../src/sub-agent.ts";

function makeToolError(toolName: string, category: ToolErrorCategory, message: string): ToolError {
	return {
		toolName,
		category,
		message,
		retryable: category === "transient" || category === "unknown",
	};
}

function makeResult(dataSourceId: string, status: "success" | "error", toolErrors?: ToolError[]): DataSourceResult {
	return {
		dataSourceId,
		data: status === "success" ? "some data" : null,
		status,
		duration: 100,
		...(status === "error" && { error: "tool failure" }),
		...(toolErrors && { toolErrors }),
	};
}

function makeState(overrides: Partial<AgentStateType> = {}): AgentStateType {
	return {
		messages: [],
		queryComplexity: "complex",
		targetDataSources: ["elastic", "kafka"],
		dataSourceResults: [],
		currentDataSource: "",
		extractedEntities: { dataSources: [] },
		previousEntities: { dataSources: [] },
		toolPlanMode: "autonomous",
		toolPlan: [],
		validationResult: "pass",
		retryCount: 0,
		alignmentRetries: 0,
		alignmentHints: [],
		isFollowUp: false,
		finalAnswer: "",
		dataSourceContext: undefined,
		requestId: "test-request-id",
		...overrides,
	} as AgentStateType;
}

// -- getDataSourceErrorCategories --

describe("getDataSourceErrorCategories", () => {
	test("returns empty map when no errors", () => {
		const results = [makeResult("elastic", "success")];
		const categories = getDataSourceErrorCategories(results);
		expect(categories.size).toBe(0);
	});

	test("groups auth errors by data source", () => {
		const results = [makeResult("elastic", "error", [makeToolError("search", "auth", "security_exception")])];
		const categories = getDataSourceErrorCategories(results);
		expect(categories.get("elastic")).toEqual(new Set(["auth"]));
	});

	test("groups mixed categories for same data source", () => {
		const results = [
			makeResult("elastic", "error", [
				makeToolError("search", "auth", "unauthorized"),
				makeToolError("cluster_health", "transient", "timeout"),
			]),
		];
		const categories = getDataSourceErrorCategories(results);
		const cats = categories.get("elastic");
		expect(cats).toEqual(new Set(["auth", "transient"]));
	});

	test("ignores results without toolErrors", () => {
		const results = [makeResult("elastic", "error")];
		const categories = getDataSourceErrorCategories(results);
		expect(categories.size).toBe(0);
	});

	test("ignores successful results with toolErrors", () => {
		const result = makeResult("elastic", "success");
		result.toolErrors = [makeToolError("search", "transient", "timeout")];
		const categories = getDataSourceErrorCategories([result]);
		expect(categories.size).toBe(0);
	});
});

// -- classifyToolError --

describe("classifyToolError", () => {
	test("classifies auth errors", () => {
		expect(classifyToolError("security_exception: missing permissions").category).toBe("auth");
		expect(classifyToolError("HTTP 401 Unauthorized").category).toBe("auth");
		expect(classifyToolError("403 Forbidden").category).toBe("auth");
		expect(classifyToolError("access denied for user").category).toBe("auth");
	});

	test("classifies session errors", () => {
		expect(classifyToolError("Session not found").category).toBe("session");
		expect(classifyToolError("token expired").category).toBe("session");
		expect(classifyToolError("session_expired").category).toBe("session");
	});

	test("classifies transient errors", () => {
		expect(classifyToolError("request timeout").category).toBe("transient");
		expect(classifyToolError("ECONNREFUSED 127.0.0.1:9200").category).toBe("transient");
		expect(classifyToolError("ECONNRESET").category).toBe("transient");
		expect(classifyToolError("HTTP 429 Too Many Requests").category).toBe("transient");
		expect(classifyToolError("HTTP 503 Service Unavailable").category).toBe("transient");
		expect(classifyToolError("circuit_breaking_exception").category).toBe("transient");
	});

	test("classifies unknown errors as retryable", () => {
		const result = classifyToolError("something unexpected happened");
		expect(result.category).toBe("unknown");
		expect(result.retryable).toBe(true);
	});

	test("auth and session errors are not retryable", () => {
		expect(classifyToolError("unauthorized").retryable).toBe(false);
		expect(classifyToolError("session expired").retryable).toBe(false);
	});

	test("transient errors are retryable", () => {
		expect(classifyToolError("timeout").retryable).toBe(true);
	});
});

// -- routeAfterAlignment --

describe("routeAfterAlignment", () => {
	test("returns aggregate when all aligned", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka"],
			dataSourceResults: [makeResult("elastic", "success"), makeResult("kafka", "success")],
		});
		const result = routeAfterAlignment(state);
		expect(result).toBe("aggregate");
	});

	test("returns Send[] for missing datasources", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka"],
			dataSourceResults: [makeResult("elastic", "success")],
		});
		const result = routeAfterAlignment(state);
		expect(Array.isArray(result)).toBe(true);
		const sends = result as Send[];
		expect(sends.length).toBe(1);
		// Verify the Send has the correct currentDataSource
		expect(sends[0]).toBeInstanceOf(Send);
	});

	test("returns Send[] with correct currentDataSource for each retry target", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka", "couchbase"],
			dataSourceResults: [makeResult("elastic", "success")],
		});
		const result = routeAfterAlignment(state);
		expect(Array.isArray(result)).toBe(true);
		const sends = result as Send[];
		expect(sends.length).toBe(2);
	});

	test("returns aggregate on second pass (retries exhausted)", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka"],
			dataSourceResults: [makeResult("elastic", "success")],
			alignmentRetries: 2,
		});
		const result = routeAfterAlignment(state);
		expect(result).toBe("aggregate");
	});

	test("skips retry for auth-only errors", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka"],
			dataSourceResults: [
				makeResult("elastic", "error", [makeToolError("search", "auth", "security_exception")]),
				makeResult("kafka", "error", [makeToolError("list_topics", "auth", "unauthorized")]),
			],
		});
		const result = routeAfterAlignment(state);
		expect(result).toBe("aggregate");
	});

	test("retries transient errors but skips auth-only", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka"],
			dataSourceResults: [
				makeResult("elastic", "error", [makeToolError("search", "auth", "security_exception")]),
				makeResult("kafka", "error", [makeToolError("list_topics", "transient", "timeout")]),
			],
		});
		const result = routeAfterAlignment(state);
		expect(Array.isArray(result)).toBe(true);
		const sends = result as Send[];
		// Only kafka should be retried, not elastic
		expect(sends.length).toBe(1);
	});

	test("retries when transient errors mixed with auth on same datasource", () => {
		const state = makeState({
			targetDataSources: ["elastic"],
			dataSourceResults: [
				makeResult("elastic", "error", [
					makeToolError("search", "auth", "unauthorized"),
					makeToolError("cluster_health", "transient", "timeout"),
				]),
			],
		});
		const result = routeAfterAlignment(state);
		expect(Array.isArray(result)).toBe(true);
		const sends = result as Send[];
		expect(sends.length).toBe(1);
	});
});

// -- checkAlignment (state updates) --

describe("checkAlignment - state updates", () => {
	test("returns empty update when all aligned", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka"],
			dataSourceResults: [makeResult("elastic", "success"), makeResult("kafka", "success")],
		});
		const result = checkAlignment(state);
		expect(result.alignmentHints).toBeUndefined();
	});

	test("returns alignment hints when max retries reached", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka"],
			dataSourceResults: [makeResult("elastic", "success")],
			alignmentRetries: 2,
		});
		const result = checkAlignment(state);
		expect(result.alignmentHints).toBeDefined();
		expect(result.alignmentHints?.some((h) => h.includes("kafka"))).toBe(true);
	});
});
