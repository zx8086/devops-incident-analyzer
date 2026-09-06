// src/preflight.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	classifyPortOccupant,
	isPortInUse,
	type PortProbeResult,
	type ProbedIdentity,
	probeKnowledgeGraphIdentity,
} from "./preflight.ts";

const OWN = { pid: 4242, graphPath: "/store/a/knowledge-graph" };
const card = (over: Partial<ProbedIdentity> = {}): PortProbeResult => ({
	kind: "identity" as const,
	card: {
		instanceId: "inst-1",
		role: "knowledge-graph-mcp",
		pid: 999,
		upstreamFingerprint: OWN.graphPath,
		...over,
	},
});

describe("classifyPortOccupant", () => {
	test("a non-KG service on the port: warn, do not register its tools", () => {
		const v = classifyPortOccupant(card({ role: "elastic-mcp" }), OWN);
		expect(v.occupant).toBe("non-kg");
		expect(v.registerTools).toBe(false);
		expect(v.level).toBe("warn");
	});

	test("the process's own server (previous module graph): info, reuse", () => {
		const v = classifyPortOccupant(card({ pid: OWN.pid }), OWN);
		expect(v.occupant).toBe("self");
		expect(v.registerTools).toBe(true);
		expect(v.level).toBe("info");
	});

	test("another process on the SAME store: the SIO-987 lock-out warning, tools registered", () => {
		const v = classifyPortOccupant(card(), OWN);
		expect(v.occupant).toBe("kg-same-store");
		expect(v.registerTools).toBe(true);
		expect(v.level).toBe("warn");
		expect(v.message).toContain("LOCKED OUT");
	});

	test("another process on a DIFFERENT store: warn, do not register its tools", () => {
		const v = classifyPortOccupant(card({ upstreamFingerprint: "/store/b/knowledge-graph" }), OWN);
		expect(v.occupant).toBe("kg-other-store");
		expect(v.registerTools).toBe(false);
		expect(v.level).toBe("warn");
		expect(v.message).toContain("DIFFERENT store");
	});

	test("unidentifiable listener: legacy warning text, tools registered", () => {
		const v = classifyPortOccupant({ kind: "unavailable", reason: "identity returned 404" }, OWN);
		expect(v.occupant).toBe("unknown");
		expect(v.registerTools).toBe(true);
		expect(v.level).toBe("warn");
		expect(v.message).toContain("identity returned 404");
		expect(v.message).toContain("already running on this port");
	});
});

describe("probeKnowledgeGraphIdentity + isPortInUse against a real listener", () => {
	let server: Server;
	let port = 0;
	let mode: "identity" | "notfound" | "badjson" | "hang" = "identity";

	beforeAll(async () => {
		server = createServer((req, res) => {
			if (req.url !== "/identity") {
				res.writeHead(404).end();
				return;
			}
			if (mode === "hang") return;
			if (mode === "notfound") {
				res.writeHead(404).end("identity unavailable");
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				mode === "badjson"
					? '{"instanceId":"x"}'
					: JSON.stringify({
							instanceId: "i",
							role: "knowledge-graph-mcp",
							pid: 7,
							upstreamFingerprint: "/p",
							extra: 1,
						}),
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		port = (server.address() as AddressInfo).port;
	});
	afterAll(() => {
		server.closeAllConnections?.();
		server.close();
	});

	test("returns the validated identity card", async () => {
		mode = "identity";
		const r = await probeKnowledgeGraphIdentity({ host: "127.0.0.1", port });
		expect(r.kind).toBe("identity");
		if (r.kind === "identity") expect(r.card.pid).toBe(7);
	});

	test("a 404 is unavailable with the status in the reason", async () => {
		mode = "notfound";
		const r = await probeKnowledgeGraphIdentity({ host: "127.0.0.1", port });
		expect(r).toEqual({ kind: "unavailable", reason: "identity returned 404" });
	});

	test("a card missing required fields is unavailable", async () => {
		mode = "badjson";
		const r = await probeKnowledgeGraphIdentity({ host: "127.0.0.1", port });
		expect(r.kind).toBe("unavailable");
	});

	test("a listener that never answers is unavailable within the timeout", async () => {
		mode = "hang";
		const r = await probeKnowledgeGraphIdentity({ host: "127.0.0.1", port, timeoutMs: 100 });
		expect(r.kind).toBe("unavailable");
	});

	test("isPortInUse is true for the listener and false for a closed port", async () => {
		expect(await isPortInUse("127.0.0.1", port)).toBe(true);
		const spare = createServer();
		await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", resolve));
		const closedPort = (spare.address() as AddressInfo).port;
		await new Promise<void>((resolve) => spare.close(() => resolve()));
		expect(await isPortInUse("127.0.0.1", closedPort)).toBe(false);
	});
});
