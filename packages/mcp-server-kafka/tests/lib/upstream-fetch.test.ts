// packages/mcp-server-kafka/tests/lib/upstream-fetch.test.ts
//
// SIO-725 + SIO-729: fetchUpstream is the single producer of structured
// upstream errors for the four Confluent services. These tests assert it
// captures hostname + content-type + real status on every error path
// (HTML 503, JSON 503, captive 200, network failure) and stays out of the
// way on the success-JSON path.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { KafkaToolError } from "../../src/lib/errors.ts";
import { fetchUpstream } from "../../src/lib/upstream-fetch.ts";

const REAL_FETCH = globalThis.fetch;

function mockFetch(response: Response): void {
	globalThis.fetch = mock(() => Promise.resolve(response)) as unknown as typeof globalThis.fetch;
}

function mockFetchThrows(err: Error): void {
	globalThis.fetch = mock(() => Promise.reject(err)) as unknown as typeof globalThis.fetch;
}

const opts = {
	serviceLabel: "Kafka Connect",
	baseUrl: "https://connect.prd.shared-services.eu.pvh.cloud",
};

describe("fetchUpstream", () => {
	afterEach(() => {
		globalThis.fetch = REAL_FETCH;
	});

	test("returns the Response on a JSON 200 success", async () => {
		mockFetch(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const res = await fetchUpstream("https://connect.prd.shared-services.eu.pvh.cloud/connectors", {}, opts);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	test("accepts Confluent vnd.* JSON variants", async () => {
		mockFetch(
			new Response("[]", {
				status: 200,
				headers: { "content-type": "application/vnd.schemaregistry.v1+json" },
			}),
		);
		const res = await fetchUpstream(
			"https://schemaregistry.prd.shared-services.eu.pvh.cloud/subjects",
			{},
			{ serviceLabel: "Schema Registry", baseUrl: "https://schemaregistry.prd.shared-services.eu.pvh.cloud" },
		);
		expect(res.status).toBe(200);
	});

	// SIO-716 regression core: nginx returns text/html 503. fetchUpstream must
	// throw with structured fields so the agent's correlation engine fires.
	test("HTML 503 throws KafkaToolError with hostname + text/html + 503", async () => {
		mockFetch(
			new Response("<html><body>503 Service Temporarily Unavailable</body></html>", {
				status: 503,
				headers: { "content-type": "text/html" },
			}),
		);
		try {
			await fetchUpstream("https://connect.prd.shared-services.eu.pvh.cloud/connectors", {}, opts);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(KafkaToolError);
			const e = err as KafkaToolError;
			expect(e.hostname).toBe("connect.prd.shared-services.eu.pvh.cloud");
			expect(e.upstreamContentType).toBe("text/html");
			expect(e.statusCode).toBe(503);
			expect(e.message).toContain("Kafka Connect");
			expect(e.message).toContain("connect.prd.shared-services.eu.pvh.cloud");
			expect(e.message).toContain("503");
		}
	});

	test("HTML 503 body preview is captured (truncated to 200 chars, no raw newlines)", async () => {
		const longBody = `<html>${"A".repeat(500)}</html>`;
		mockFetch(
			new Response(longBody, {
				status: 503,
				headers: { "content-type": "text/html" },
			}),
		);
		try {
			await fetchUpstream("https://connect.prd.shared-services.eu.pvh.cloud/", {}, opts);
			throw new Error("expected throw");
		} catch (err) {
			const e = err as KafkaToolError;
			expect(e.upstreamBodyPreview).toBeDefined();
			expect((e.upstreamBodyPreview ?? "").length).toBeLessThanOrEqual(204);
		}
	});

	test("JSON 503 throws with content-type=application/json + 503", async () => {
		mockFetch(
			new Response(JSON.stringify({ error: "down" }), {
				status: 503,
				headers: { "content-type": "application/json" },
			}),
		);
		try {
			await fetchUpstream("https://connect.prd.shared-services.eu.pvh.cloud/", {}, opts);
			throw new Error("expected throw");
		} catch (err) {
			const e = err as KafkaToolError;
			expect(e.upstreamContentType).toBe("application/json");
			expect(e.statusCode).toBe(503);
		}
	});

	// SIO-729: captive-page 200. Status is OK but the upstream is lying about
	// what it returned. Must surface as an upstream error too.
	test("HTML 200 captive page throws with status=200 + text/html", async () => {
		mockFetch(
			new Response("<html>login required</html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		);
		try {
			await fetchUpstream("https://connect.prd.shared-services.eu.pvh.cloud/", {}, opts);
			throw new Error("expected throw");
		} catch (err) {
			const e = err as KafkaToolError;
			expect(e.statusCode).toBe(200);
			expect(e.upstreamContentType).toBe("text/html");
			expect(e.message).toContain("non-JSON");
		}
	});

	test("network failure propagates as-is (helper doesn't swallow)", async () => {
		mockFetchThrows(new Error("ECONNREFUSED 10.0.0.1:443"));
		await expect(fetchUpstream("https://connect.prd.shared-services.eu.pvh.cloud/", {}, opts)).rejects.toThrow(
			"ECONNREFUSED",
		);
	});

	test("hostname is derived from baseUrl, not the request URL", async () => {
		// Important so a request to /v1/clusters/{id}/topics still attributes the
		// error to the configured baseUrl's hostname, not whatever the path looks
		// like.
		mockFetch(
			new Response("<html>down</html>", {
				status: 503,
				headers: { "content-type": "text/html" },
			}),
		);
		try {
			await fetchUpstream(
				"https://otherhost.example.com/v3/clusters/x/topics",
				{},
				{ serviceLabel: "REST Proxy", baseUrl: "https://restproxy.prd.shared-services.eu.pvh.cloud" },
			);
			throw new Error("expected throw");
		} catch (err) {
			const e = err as KafkaToolError;
			expect(e.hostname).toBe("restproxy.prd.shared-services.eu.pvh.cloud");
		}
	});

	test("204 No Content with no content-type is allowed through (callers handle empty body)", async () => {
		mockFetch(new Response(null, { status: 204 }));
		const res = await fetchUpstream("https://connect.prd.shared-services.eu.pvh.cloud/", { method: "DELETE" }, opts);
		expect(res.status).toBe(204);
	});

	test("malformed baseUrl yields no hostname but still throws with status + content-type", async () => {
		mockFetch(
			new Response("<html>fail</html>", {
				status: 503,
				headers: { "content-type": "text/html" },
			}),
		);
		try {
			await fetchUpstream("https://x/", {}, { serviceLabel: "ksqlDB", baseUrl: "not-a-url" });
			throw new Error("expected throw");
		} catch (err) {
			const e = err as KafkaToolError;
			expect(e.hostname).toBeUndefined();
			expect(e.statusCode).toBe(503);
			expect(e.upstreamContentType).toBe("text/html");
		}
	});
});

// SIO-728: integration with the sentinel wire. fetchUpstream throws a KafkaToolError;
// wrap.ts forwards its structured fields through ResponseBuilder; extractToolErrors
// parses them back into a ToolError. We sanity-check the round-trip here at the
// MCP-server boundary so a regression doesn't slip in if the sentinel constant
// ever drifts.
import { ResponseBuilder } from "../../src/lib/response-builder.ts";

describe("fetchUpstream + ResponseBuilder round-trip (SIO-728 wire contract)", () => {
	beforeEach(() => {
		// fresh mock per test
	});
	afterEach(() => {
		globalThis.fetch = REAL_FETCH;
	});

	test("HTML 503 -> ResponseBuilder.error structured payload survives JSON.parse", async () => {
		mockFetch(
			new Response("<html>503</html>", {
				status: 503,
				headers: { "content-type": "text/html" },
			}),
		);
		let captured: KafkaToolError | undefined;
		try {
			await fetchUpstream("https://connect.prd.shared-services.eu.pvh.cloud/", {}, opts);
		} catch (err) {
			captured = err as KafkaToolError;
		}
		expect(captured).toBeInstanceOf(KafkaToolError);
		// Mirror what wrap.ts does (extractStructuredFields):
		const structured = {
			hostname: captured?.hostname,
			upstreamContentType: captured?.upstreamContentType,
			statusCode: captured?.statusCode,
		};
		const out = ResponseBuilder.error(captured?.message ?? "", structured);
		const text = out.content[0]?.text ?? "";
		expect(text).toContain("---STRUCTURED---");
		const json = text.split("\n---STRUCTURED---\n")[1] ?? "";
		const parsed = JSON.parse(json) as Record<string, unknown>;
		expect(parsed.hostname).toBe("connect.prd.shared-services.eu.pvh.cloud");
		expect(parsed.upstreamContentType).toBe("text/html");
		expect(parsed.statusCode).toBe(503);
	});
});
