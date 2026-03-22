// src/transport/__tests__/middleware.test.ts
import { describe, expect, test } from "bun:test";
import { withApiKeyAuth, withOriginValidation } from "../middleware.ts";

const okHandler = async (_req: Request) => Response.json({ ok: true });

describe("withOriginValidation", () => {
	test("passes when no Origin header present", async () => {
		const handler = withOriginValidation(okHandler, ["http://allowed.com"]);
		const res = await handler(new Request("http://localhost/mcp", { method: "POST" }));
		expect(res.status).toBe(200);
	});

	test("passes when origin is in allowed list", async () => {
		const handler = withOriginValidation(okHandler, ["http://allowed.com"]);
		const res = await handler(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: { Origin: "http://allowed.com" },
			}),
		);
		expect(res.status).toBe(200);
	});

	test("blocks when origin is not in allowed list", async () => {
		const handler = withOriginValidation(okHandler, ["http://allowed.com"]);
		const res = await handler(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: { Origin: "http://evil.com" },
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toBe("Origin not allowed");
	});

	test("passes all origins when no allowed list configured", async () => {
		const handler = withOriginValidation(okHandler);
		const res = await handler(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: { Origin: "http://anything.com" },
			}),
		);
		expect(res.status).toBe(200);
	});
});

describe("withApiKeyAuth", () => {
	test("passes when no API key configured", async () => {
		const handler = withApiKeyAuth(okHandler);
		const res = await handler(new Request("http://localhost/mcp", { method: "POST" }));
		expect(res.status).toBe(200);
	});

	test("passes when Bearer token matches", async () => {
		const handler = withApiKeyAuth(okHandler, "secret-key");
		const res = await handler(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: { Authorization: "Bearer secret-key" },
			}),
		);
		expect(res.status).toBe(200);
	});

	test("blocks when Bearer token is missing", async () => {
		const handler = withApiKeyAuth(okHandler, "secret-key");
		const res = await handler(new Request("http://localhost/mcp", { method: "POST" }));
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toBe("Unauthorized");
	});

	test("blocks when Bearer token is wrong", async () => {
		const handler = withApiKeyAuth(okHandler, "secret-key");
		const res = await handler(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: { Authorization: "Bearer wrong-key" },
			}),
		);
		expect(res.status).toBe(401);
	});
});

describe("middleware composition", () => {
	test("origin checked before auth", async () => {
		const handler = withApiKeyAuth(withOriginValidation(okHandler, ["http://allowed.com"]), "secret-key");
		const res = await handler(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: {
					Origin: "http://evil.com",
					Authorization: "Bearer secret-key",
				},
			}),
		);
		expect(res.status).toBe(403);
	});
});
