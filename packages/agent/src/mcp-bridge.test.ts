import { describe, expect, test } from "bun:test";
import { serializeMcpConnectError, _withTimeoutForTest as withTimeout } from "./mcp-bridge.ts";

// SIO-705: pino's default JSON serializer drops non-enumerable Error fields.
// The styles-v3 production run logged `Failed to connect to MCP server` with
// `error:{}` because `result.reason` (an Error instance) was passed directly
// as a pino property. The serializer below extracts `.message` plus any
// AggregateError children and `cause` chain so transport-layer detail isn't
// lost.
describe("serializeMcpConnectError (SIO-705)", () => {
	test("extracts message and name from a plain Error", () => {
		const out = serializeMcpConnectError(new Error("connection refused"), "http://localhost:9080/mcp");
		expect(out.error).toBe("connection refused");
		expect(out.errorName).toBe("Error");
		expect(out.url).toBe("http://localhost:9080/mcp");
	});

	test("preserves the subclass name", () => {
		class TimeoutError extends Error {
			override name = "TimeoutError";
		}
		const out = serializeMcpConnectError(new TimeoutError("op timed out"), "http://x/mcp");
		expect(out.error).toBe("op timed out");
		expect(out.errorName).toBe("TimeoutError");
	});

	test("flattens AggregateError children into cause", () => {
		const agg = new AggregateError(
			[new Error("ENOTFOUND localhost"), new Error("ECONNREFUSED 127.0.0.1:9083")],
			"All connection attempts failed",
		);
		const out = serializeMcpConnectError(agg, "http://localhost:9083/mcp");
		expect(out.error).toBe("All connection attempts failed");
		expect(out.cause).toContain("ENOTFOUND");
		expect(out.cause).toContain("ECONNREFUSED");
	});

	test("walks the cause chain on standard Error", () => {
		const inner = new Error("socket hang up");
		const outer = new Error("fetch failed", { cause: inner });
		const out = serializeMcpConnectError(outer, "http://x/mcp");
		expect(out.error).toBe("fetch failed");
		expect(out.cause).toBe("socket hang up");
	});

	test("falls back to String() for non-Error rejections", () => {
		const out = serializeMcpConnectError("plain string reason", "http://x/mcp");
		expect(out.error).toBe("plain string reason");
		expect(out.errorName).toBeUndefined();
	});

	test("survives an Error with empty message by using the name", () => {
		const e = new Error();
		e.name = "AbortError";
		const out = serializeMcpConnectError(e, "http://x/mcp");
		expect(out.error).toBe("AbortError");
	});
});

describe("withTimeout (SIO-680/682)", () => {
	test("resolves with value when promise settles before timeout", async () => {
		const result = await withTimeout(Promise.resolve(42), 100, "fast-call");
		expect(result).toBe(42);
	});

	test("rejects with descriptive error when promise never settles", async () => {
		const neverResolves = new Promise<number>(() => {});
		await expect(withTimeout(neverResolves, 50, "stuck-call")).rejects.toThrow(/stuck-call timed out after 50ms/);
	});

	test("propagates the original error when promise rejects before timeout", async () => {
		const fails = Promise.reject(new Error("connection refused"));
		await expect(withTimeout(fails, 1000, "failing-call")).rejects.toThrow(/connection refused/);
	});
});
