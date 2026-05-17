// packages/agent/src/__tests__/mcp-bridge-probe-budget.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { IdentityCard } from "@devops-agent/shared";
import {
	_getLoggerForTest,
	_pollServerHealthForTest,
	_probeServerForTest,
	_resetExpectedIdentityForTest,
	_resetUnreadyStreakForTest,
	_setServerUrlsForTest,
} from "../mcp-bridge.ts";

type LogCall = { fields: Record<string, unknown>; msg: string };
const captured: { warn: LogCall[]; info: LogCall[]; debug: LogCall[]; error: LogCall[] } = {
	warn: [],
	info: [],
	debug: [],
	error: [],
};

const logger = _getLoggerForTest();
const originalMethods = {
	warn: logger.warn.bind(logger),
	info: logger.info.bind(logger),
	debug: logger.debug.bind(logger),
	error: logger.error.bind(logger),
};

function patchLogger(): void {
	const make = (bucket: LogCall[]) => (fields: unknown, msg?: string) => {
		bucket.push({ fields: (fields as Record<string, unknown>) ?? {}, msg: msg ?? "" });
	};
	logger.warn = make(captured.warn) as typeof logger.warn;
	logger.info = make(captured.info) as typeof logger.info;
	logger.debug = make(captured.debug) as typeof logger.debug;
	logger.error = make(captured.error) as typeof logger.error;
}

function restoreLogger(): void {
	logger.warn = originalMethods.warn;
	logger.info = originalMethods.info;
	logger.debug = originalMethods.debug;
	logger.error = originalMethods.error;
}

function resetCapture(): void {
	captured.warn.length = 0;
	captured.info.length = 0;
	captured.debug.length = 0;
	captured.error.length = 0;
}

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

beforeEach(() => {
	_resetExpectedIdentityForTest();
	_resetUnreadyStreakForTest();
	_setServerUrlsForTest([]);
	resetCapture();
	patchLogger();
});

afterEach(() => {
	restoreLogger();
	_resetExpectedIdentityForTest();
	_resetUnreadyStreakForTest();
	_setServerUrlsForTest([]);
});

describe("SIO-782: probe budget tracks connectTimeoutFor", () => {
	test("/ready that resolves slowly still resolves to ready for kafka-mcp (35s budget)", async () => {
		const card = fixtureCard({ role: "kafka-proxy" });
		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(card);
			if (url.endsWith("/ready")) {
				await new Promise((resolve) => setTimeout(resolve, 200));
				return Response.json({ ready: true, components: { agentcoreUpstream: "ok" }, cachedAt: "" });
			}
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;

		const result = await _probeServerForTest("kafka-mcp", "http://localhost:3000/mcp");
		expect(result.state).toBe("ready");
	});

	test("/ready that throws synthesises unready with _probeTimeout tag", async () => {
		const card = fixtureCard();
		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(card);
			if (url.endsWith("/ready")) return Response.json({ ready: true, components: {}, cachedAt: "" });
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;
		await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");

		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(card);
			if (url.endsWith("/ready")) throw new Error("fake probe timeout");
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;

		const result = await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
		expect(result.state).toBe("unready");
		if (result.state === "unready") {
			expect(result.snapshot.components).toEqual({});
			expect(result.snapshot.errors?._probeTimeout).toBe("true");
			expect(result.snapshot.errors?._probe).toContain("fake probe timeout");
		}
	});
});

describe("SIO-782: unreadyStreak debounce", () => {
	test("three consecutive unready cycles emit exactly one warn (real upstream 503)", async () => {
		const card = fixtureCard();
		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(card);
			if (url.endsWith("/ready")) return Response.json({ ready: true, components: {}, cachedAt: "" });
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;
		await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
		resetCapture();

		_setServerUrlsForTest([["konnect-mcp", "http://localhost:9083/mcp"]]);
		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(card);
			if (url.endsWith("/ready"))
				return Response.json(
					{ ready: false, components: { upstream: "unreachable" }, errors: { upstream: "503" }, cachedAt: "" },
					{ status: 503 },
				);
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;

		await _pollServerHealthForTest();
		await _pollServerHealthForTest();
		await _pollServerHealthForTest();

		const degradedWarns = captured.warn.filter((c) => c.msg.includes("upstream degraded"));
		expect(degradedWarns.length).toBe(1);
		expect(degradedWarns[0]?.fields.streak).toBe(3);
		expect(degradedWarns[0]?.fields.probeTimeout).toBe(false);
	});

	test("probe-timeout synthetic snapshot logs at info, not warn, even at threshold", async () => {
		const card = fixtureCard();
		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(card);
			if (url.endsWith("/ready")) return Response.json({ ready: true, components: {}, cachedAt: "" });
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;
		await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
		resetCapture();

		_setServerUrlsForTest([["konnect-mcp", "http://localhost:9083/mcp"]]);
		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(card);
			if (url.endsWith("/ready")) throw new Error("simulated probe abort");
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;

		await _pollServerHealthForTest();
		await _pollServerHealthForTest();
		await _pollServerHealthForTest();

		const degradedWarns = captured.warn.filter((c) => c.msg.includes("upstream degraded"));
		expect(degradedWarns.length).toBe(0);
		const probeInfos = captured.info.filter((c) => c.msg.includes("probe timing out"));
		expect(probeInfos.length).toBe(1);
		expect(probeInfos[0]?.fields.probeTimeout).toBe(true);
		expect(probeInfos[0]?.fields.streak).toBe(3);
	});

	test("recovery resets the streak so the next failure starts fresh", async () => {
		const card = fixtureCard();
		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(card);
			if (url.endsWith("/ready")) return Response.json({ ready: true, components: {}, cachedAt: "" });
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;
		await _probeServerForTest("konnect-mcp", "http://localhost:9083/mcp");
		resetCapture();

		_setServerUrlsForTest([["konnect-mcp", "http://localhost:9083/mcp"]]);

		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(card);
			if (url.endsWith("/ready"))
				return Response.json({ ready: false, components: { x: "unreachable" }, cachedAt: "" }, { status: 503 });
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;
		await _pollServerHealthForTest();
		await _pollServerHealthForTest();

		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(card);
			if (url.endsWith("/ready")) return Response.json({ ready: true, components: {}, cachedAt: "" });
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;
		await _pollServerHealthForTest();

		global.fetch = mock(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response("ok");
			if (url.endsWith("/identity")) return Response.json(card);
			if (url.endsWith("/ready"))
				return Response.json({ ready: false, components: { x: "unreachable" }, cachedAt: "" }, { status: 503 });
			return new Response("404", { status: 404 });
		}) as unknown as typeof fetch;
		await _pollServerHealthForTest();
		await _pollServerHealthForTest();

		const degradedWarns = captured.warn.filter((c) => c.msg.includes("upstream degraded"));
		expect(degradedWarns.length).toBe(0);
	});
});
