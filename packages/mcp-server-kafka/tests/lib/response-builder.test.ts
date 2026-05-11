// packages/mcp-server-kafka/tests/lib/response-builder.test.ts
//
// SIO-728: response-builder's structured-arg path produces output the agent's
// extractToolErrors can round-trip. The sentinel constant lives in both files;
// these tests guard the contract so the two cannot drift in silence.

import { describe, expect, test } from "bun:test";
import { ResponseBuilder } from "../../src/lib/response-builder.ts";

const SENTINEL = "\n---STRUCTURED---\n";

describe("ResponseBuilder.error", () => {
	test("without structured arg returns byte-identical pre-SIO-728 shape", () => {
		const out = ResponseBuilder.error("plain message");
		expect(out).toEqual({ content: [{ type: "text", text: "plain message" }], isError: true });
	});

	test("with empty-ish message but structured arg still emits the sentinel", () => {
		const out = ResponseBuilder.error("", { statusCode: 503 });
		const text = out.content[0]?.text ?? "";
		expect(text).toBe(`${SENTINEL}{"statusCode":503}`);
		expect(out.isError).toBe(true);
	});

	test("with structured arg appends sentinel + JSON in expected order", () => {
		const out = ResponseBuilder.error("Kafka Connect upstream returned text/html 503", {
			hostname: "connect.prd.shared-services.eu.pvh.cloud",
			upstreamContentType: "text/html",
			statusCode: 503,
		});
		const text = out.content[0]?.text ?? "";
		expect(text.startsWith("Kafka Connect upstream returned text/html 503")).toBe(true);
		expect(text).toContain(SENTINEL);
		// JSON suffix must be parseable and carry every passed field verbatim.
		const json = text.split(SENTINEL)[1] ?? "";
		const parsed = JSON.parse(json) as Record<string, unknown>;
		expect(parsed.hostname).toBe("connect.prd.shared-services.eu.pvh.cloud");
		expect(parsed.upstreamContentType).toBe("text/html");
		expect(parsed.statusCode).toBe(503);
	});

	test("undefined structured arg is treated the same as omitted", () => {
		const out = ResponseBuilder.error("plain", undefined);
		expect(out.content[0]?.text).toBe("plain");
		expect(out.content[0]?.text).not.toContain("---STRUCTURED---");
	});

	test("isError is always true regardless of structured presence", () => {
		expect(ResponseBuilder.error("a").isError).toBe(true);
		expect(ResponseBuilder.error("b", {}).isError).toBe(true);
		expect(ResponseBuilder.error("c", { hostname: "x" }).isError).toBe(true);
	});
});
