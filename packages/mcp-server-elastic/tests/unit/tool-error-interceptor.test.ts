// tests/unit/tool-error-interceptor.test.ts
// SIO-1388: the central interceptor stamps the shared structured-error envelope on every tool.
// The load-bearing property under test is the NEGATIVE one: an unclassifiable error must be
// rethrown UNCHANGED. Stamping "unknown" would map to a degrading category and satisfy the agent's
// category gate (sub-agent.ts extractStructuredToolError), suppressing the existing regex fallback
// and asserting a confident-looking wrong answer -- the SIO-1159 confidence-cap regression.
import { describe, expect, test } from "bun:test";
import { buildToolErrorEnvelope, isDegradingCategory, TOOL_ERROR_KIND_TO_CATEGORY } from "@devops-agent/shared";
import { errors } from "@elastic/elasticsearch";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { classifyElasticErrorFromMessage } from "../../src/lib/classifyElasticError.js";
import { classifyForEnvelope, withStructuredToolError } from "../../src/lib/toolErrorInterceptor.js";

const { ResponseError } = errors;

// Mirrors the agent-side gate: extractStructuredToolError requires BOTH substrings before parsing.
// McpError prefixes its message ("MCP error -32602: {...}"), so a whole-string JSON.parse fails --
// exactly the SIO-1159 case the agent handles with extractEmbeddedErrorObject's brace scan. This
// helper reproduces that recovery so the test asserts what production actually does, not a stricter
// contract than production has.
function parseEnvelope(error: unknown): { kind?: string; category?: string; message?: string } | null {
	const raw = error instanceof Error ? error.message : String(error);
	if (!raw.includes('"_error"') || !raw.includes('"kind"')) return null;
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	return (JSON.parse(raw.slice(start, end + 1)) as { _error: { kind?: string; category?: string; message?: string } })
		._error;
}

const ok = async () => ({ content: [{ type: "text" as const, text: "ok" }] });
const throwing = (error: unknown) => async () => {
	throw error;
};

// Builds a real SDK ResponseError so the structural path (meta.body.error.type) is exercised
// rather than a hand-shaped stub that could drift from the SDK.
function esResponseError(type: string, statusCode: number): InstanceType<typeof ResponseError> {
	return new ResponseError({
		statusCode,
		body: { error: { type, reason: `${type}: simulated` } },
		headers: {},
		warnings: null,
		meta: {} as never,
	} as never);
}

describe("withStructuredToolError", () => {
	test("passes successful results through untouched", async () => {
		const wrapped = withStructuredToolError("elasticsearch_test", ok);
		expect(await wrapped({}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
	});

	test("stamps a structurally-classified ES error (index_not_found -> not-found)", async () => {
		const wrapped = withStructuredToolError(
			"elasticsearch_list_indices",
			throwing(esResponseError("index_not_found_exception", 404)),
		);
		const caught = await wrapped({}, {}).catch((e: unknown) => e);

		const envelope = parseEnvelope(caught);
		expect(envelope?.kind).toBe("not-found");
		// The whole point: this category must NOT drag confidence down.
		expect(envelope?.category).toBe(TOOL_ERROR_KIND_TO_CATEGORY["not-found"]);
		expect(isDegradingCategory(TOOL_ERROR_KIND_TO_CATEGORY["not-found"])).toBe(false);
	});

	test("stamps from MESSAGE TEXT when the raw error was discarded by a catch block", async () => {
		// The ~140-file reality: the tool rebuilt an McpError from error.message, so meta is gone
		// and only the SDK-copied type name survives in the text.
		const rebuilt = new Error("Failed to get index info: index_not_found_exception: no such index [logs-2026]");
		const wrapped = withStructuredToolError("elasticsearch_get_index_info", throwing(rebuilt));
		const envelope = parseEnvelope(await wrapped({}, {}).catch((e: unknown) => e));

		expect(envelope?.kind).toBe("not-found");
		expect(envelope?.message).toContain("elasticsearch_get_index_info");
	});

	test("SAFETY: an unclassifiable error is rethrown UNCHANGED, never stamped", async () => {
		const original = new Error("something went sideways in a way we do not recognize");
		const wrapped = withStructuredToolError("elasticsearch_test", throwing(original));
		const caught = await wrapped({}, {}).catch((e: unknown) => e);

		// Identity, not just shape: the original object must reach the existing regex fallback.
		expect(caught).toBe(original);
		expect(parseEnvelope(caught)).toBeNull();
	});

	test("IDEMPOTENT: an already-stamped envelope passes through without nesting", async () => {
		const preStamped = new McpError(
			-32602,
			JSON.stringify(
				buildToolErrorEnvelope({
					kind: "bad-query",
					message: "[elasticsearch_search] hand-written",
					advice: "keep me",
				}),
			),
		);
		const wrapped = withStructuredToolError("elasticsearch_search", throwing(preStamped));
		const caught = await wrapped({}, {}).catch((e: unknown) => e);

		expect(caught).toBe(preStamped);
		// Re-stamping would nest an envelope inside another's message and break JSON.parse agent-side.
		const envelope = parseEnvelope(caught);
		expect(envelope?.kind).toBe("bad-query");
		expect(envelope?.message).not.toContain('"_error"');
	});

	test("auth and throttle errors classify to their own kinds", async () => {
		const authWrapped = withStructuredToolError(
			"elasticsearch_search",
			throwing(esResponseError("security_exception", 403)),
		);
		expect(parseEnvelope(await authWrapped({}, {}).catch((e: unknown) => e))?.kind).toBe("auth-denied");

		const throttleWrapped = withStructuredToolError(
			"elasticsearch_search",
			throwing(esResponseError("circuit_breaking_exception", 429)),
		);
		expect(parseEnvelope(await throttleWrapped({}, {}).catch((e: unknown) => e))?.kind).toBe("throttled");
	});
});

describe("classifyElasticErrorFromMessage", () => {
	test("recognizes ES type names embedded in free text", () => {
		expect(classifyElasticErrorFromMessage("boom: index_not_found_exception here")).toBe("not-found");
		expect(classifyElasticErrorFromMessage("parsing_exception at line 2")).toBe("bad-query");
		expect(classifyElasticErrorFromMessage("security_exception: denied")).toBe("auth-denied");
	});

	test("returns unknown for text with no recognizable type, including empty", () => {
		expect(classifyElasticErrorFromMessage("connection reset by peer")).toBe("unknown");
		expect(classifyElasticErrorFromMessage("")).toBe("unknown");
	});

	test("does NOT match a type name embedded in a longer identifier", () => {
		// CodeRabbit (PR #595): a bare substring scan classified these as not-found. Since not-found
		// is non-degrading, a false positive would silently exempt a real failure from the
		// tool-error-rate cap -- the opposite of what this whole change is for.
		expect(classifyElasticErrorFromMessage("my_index_not_found_exception_copy")).toBe("unknown");
		expect(classifyElasticErrorFromMessage("prefixed_security_exception_handler fired")).toBe("unknown");
		// Real occurrences still match at word/punctuation boundaries.
		expect(classifyElasticErrorFromMessage("[index_not_found_exception] no such index")).toBe("not-found");
		expect(classifyElasticErrorFromMessage("index_not_found_exception")).toBe("not-found");
	});

	test("structural classification wins over message text", () => {
		// Message says not-found, structure says auth-denied. Structure must win -- otherwise a
		// misleading message could downgrade a real permission failure into an expected absence.
		const err = esResponseError("security_exception", 403);
		(err as { message: string }).message = "index_not_found_exception";
		expect(classifyForEnvelope(err)).toBe("auth-denied");
	});
});
