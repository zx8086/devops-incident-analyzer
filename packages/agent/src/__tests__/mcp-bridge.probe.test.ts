// packages/agent/src/__tests__/mcp-bridge.probe.test.ts
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { IdentityCard } from "@devops-agent/shared";
import { _probeServerForTest, _resetExpectedIdentityForTest } from "../mcp-bridge.ts";

const fixtureCard = (overrides: Partial<IdentityCard> = {}): IdentityCard => ({
	instanceId: "fixture-id",
	role: "konnect-mcp",
	version: "0.0.0",
	bootedAt: "2026-05-17T00:00:00.000Z",
	pid: 1,
	mode: "http",
	upstreamFingerprint: "abc123",
	...overrides,
});

afterEach(() => _resetExpectedIdentityForTest());

describe("probeServer", () => {
	test("/health 200 + /identity 200 (first time) + /ready 200 -> ready", async () => {
		const card = fixtureCard();
		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(card);
			if (url.endsWith("/ready")) return Response.json({ ready: true, components: {}, cachedAt: "" });
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;
		const result = await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
		expect(result.state).toBe("ready");
	});

	test("/health 503 -> down", async () => {
		global.fetch = mock(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
		const result = await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
		expect(result.state).toBe("down");
		expect(result.state === "down" && result.reason).toContain("503");
	});

	test("/health 200 + /identity 200 with different instanceId -> replaced", async () => {
		const old = fixtureCard({ instanceId: "old-id" });
		const newCard = fixtureCard({ instanceId: "new-id" });
		// first probe seeds expectedIdentity
		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(old);
			if (url.endsWith("/ready")) return Response.json({ ready: true, components: {}, cachedAt: "" });
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;
		await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
		// second probe returns a different instanceId
		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(newCard);
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;
		const result = await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
		expect(result.state).toBe("replaced");
		expect(result.state === "replaced" && result.reason).toContain("instanceId");
	});

	test("/identity returns wrong role -> misidentified", async () => {
		const seed = fixtureCard({ role: "konnect-mcp" });
		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(seed);
			if (url.endsWith("/ready")) return Response.json({ ready: true, components: {}, cachedAt: "" });
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;
		await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");

		const wrong = fixtureCard({ role: "elastic-mcp", instanceId: seed.instanceId });
		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(wrong);
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;
		const result = await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
		expect(result.state).toBe("misidentified");
	});

	test("/ready returns 503 -> unready (still has card)", async () => {
		const card = fixtureCard();
		// first probe to seed
		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(card);
			if (url.endsWith("/ready")) return Response.json({ ready: true, components: {}, cachedAt: "" });
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;
		await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");

		// now /ready returns 503
		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(card);
			if (url.endsWith("/ready"))
				return Response.json(
					{ ready: false, components: { foo: "unreachable" }, errors: { foo: "401" }, cachedAt: "" },
					{ status: 503 },
				);
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;
		const result = await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
		expect(result.state).toBe("unready");
	});

	test("/ready 404 (Phase B not deployed yet) -> ready", async () => {
		const card = fixtureCard();
		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(card);
			if (url.endsWith("/ready")) return new Response("not found", { status: 404 });
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;
		const result = await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
		expect(result.state).toBe("ready");
	});
});
