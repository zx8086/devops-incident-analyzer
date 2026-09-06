// apps/web/src/lib/server/knowledge-graph-server.test.ts

import { beforeEach, describe, expect, test } from "bun:test";
import type { PortProbeResult } from "@devops-agent/mcp-server-knowledge-graph";
import {
	_resetKnowledgeGraphServerSlotForTest,
	getKnowledgeGraphMcpUrl,
	type KnowledgeGraphApp,
	type MountDeps,
	mountKnowledgeGraphServer,
} from "./knowledge-graph-server.ts";

const ENABLED = { KNOWLEDGE_GRAPH_ENABLED: "true", KNOWLEDGE_GRAPH_MCP_PORT: "9187" } as NodeJS.ProcessEnv;
const OWN_PATH = "/store/a/knowledge-graph";

interface Harness {
	deps: MountDeps;
	starts: number;
	closes: number;
	probes: number;
	logs: Array<{ level: "info" | "warn"; message: string }>;
}

function harness(over: Partial<MountDeps> = {}, opts: { portInUse?: boolean; probe?: PortProbeResult } = {}): Harness {
	const h: Harness = { starts: 0, closes: 0, probes: 0, logs: [], deps: {} };
	const app: KnowledgeGraphApp = {
		transport: {
			listen: { mode: "http", port: 9187 },
			closeAll: async () => {
				h.closes += 1;
			},
		},
	};
	h.deps = {
		env: ENABLED,
		pid: 4242,
		graphPath: () => OWN_PATH,
		isPortInUse: async () => opts.portInUse ?? false,
		probe: async () => {
			h.probes += 1;
			return opts.probe ?? { kind: "unavailable", reason: "no probe configured" };
		},
		start: async () => {
			h.starts += 1;
			return app;
		},
		log: {
			info: (_fields: unknown, message: string) => {
				h.logs.push({ level: "info", message });
			},
			warn: (_fields: unknown, message: string) => {
				h.logs.push({ level: "warn", message });
			},
		},
		...over,
	};
	return h;
}

const kgCard = (over: Partial<{ pid: number; role: string; upstreamFingerprint: string }> = {}): PortProbeResult => ({
	kind: "identity",
	card: { instanceId: "i-1", role: "knowledge-graph-mcp", pid: 999, upstreamFingerprint: OWN_PATH, ...over },
});

describe("mountKnowledgeGraphServer", () => {
	beforeEach(() => _resetKnowledgeGraphServerSlotForTest());

	test("does nothing when the knowledge graph is disabled", async () => {
		const h = harness({ env: { KNOWLEDGE_GRAPH_ENABLED: "false" } as NodeJS.ProcessEnv });
		await mountKnowledgeGraphServer(h.deps);
		expect(h.starts).toBe(0);
		expect(getKnowledgeGraphMcpUrl()).toBeUndefined();
	});

	test("starts the server once and exposes its URL", async () => {
		const h = harness();
		await mountKnowledgeGraphServer(h.deps);
		expect(h.starts).toBe(1);
		expect(getKnowledgeGraphMcpUrl()).toBe("http://127.0.0.1:9187");
	});

	test("a second mount (re-evaluated module graph) reuses the running server instead of probing or starting", async () => {
		const h = harness();
		await mountKnowledgeGraphServer(h.deps);
		await mountKnowledgeGraphServer(h.deps);
		expect(h.starts).toBe(1);
		expect(h.probes).toBe(0);
		expect(getKnowledgeGraphMcpUrl()).toBe("http://127.0.0.1:9187");
		expect(
			h.logs.some((l) => l.level === "info" && /reusing in-process knowledge-graph MCP server/.test(l.message)),
		).toBe(true);
		expect(h.logs.some((l) => /already running on this port/.test(l.message))).toBe(false);
	});

	test("two mounts racing a pending start share the same start", async () => {
		let release: (app: KnowledgeGraphApp) => void = () => undefined;
		const h = harness({
			start: () => {
				h.starts += 1;
				return new Promise<KnowledgeGraphApp>((resolve) => {
					release = resolve;
				});
			},
		});
		const first = mountKnowledgeGraphServer(h.deps);
		const second = mountKnowledgeGraphServer(h.deps);
		// start() is only reached after the async port probe; let it be called before releasing.
		await new Promise((resolve) => setTimeout(resolve, 10));
		release({ transport: { listen: { mode: "http", port: 9187 }, closeAll: async () => undefined } });
		await Promise.all([first, second]);
		expect(h.starts).toBe(1);
		expect(getKnowledgeGraphMcpUrl()).toBe("http://127.0.0.1:9187");
	});

	test("a start failure clears the URL and the slot so a later mount tries again", async () => {
		let fail = true;
		const h = harness({
			start: async () => {
				h.starts += 1;
				if (fail) throw new Error("boom");
				return { transport: { listen: { mode: "http", port: 9187 }, closeAll: async () => undefined } };
			},
		});
		await mountKnowledgeGraphServer(h.deps);
		expect(getKnowledgeGraphMcpUrl()).toBeUndefined();
		expect(h.logs.some((l) => l.level === "warn" && /failed to start/.test(l.message))).toBe(true);
		fail = false;
		await mountKnowledgeGraphServer(h.deps);
		expect(h.starts).toBe(2);
		expect(getKnowledgeGraphMcpUrl()).toBe("http://127.0.0.1:9187");
	});

	test("losing the probe-to-bind race (EADDRINUSE) classifies the occupant instead of a generic failure", async () => {
		const h = harness(
			{
				start: async () => {
					h.starts += 1;
					throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
				},
			},
			{ probe: kgCard({ role: "elastic-mcp" }) },
		);
		await mountKnowledgeGraphServer(h.deps);
		expect(h.probes).toBe(1);
		expect(getKnowledgeGraphMcpUrl()).toBeUndefined();
		expect(h.logs.some((l) => /non-KG service/.test(l.message))).toBe(true);
	});

	test("port in use by a non-KG service: no start, no tools", async () => {
		const h = harness({}, { portInUse: true, probe: kgCard({ role: "elastic-mcp" }) });
		await mountKnowledgeGraphServer(h.deps);
		expect(h.starts).toBe(0);
		expect(getKnowledgeGraphMcpUrl()).toBeUndefined();
	});

	test("port in use by another process on the SAME store: lock-out warning, read tools registered", async () => {
		const h = harness({}, { portInUse: true, probe: kgCard() });
		await mountKnowledgeGraphServer(h.deps);
		expect(h.starts).toBe(0);
		expect(getKnowledgeGraphMcpUrl()).toBe("http://127.0.0.1:9187");
		expect(h.logs.some((l) => l.level === "warn" && /LOCKED OUT/.test(l.message))).toBe(true);
	});

	test("port in use by this process (no slot): info, tools registered", async () => {
		const h = harness({}, { portInUse: true, probe: kgCard({ pid: 4242 }) });
		await mountKnowledgeGraphServer(h.deps);
		expect(h.starts).toBe(0);
		expect(getKnowledgeGraphMcpUrl()).toBe("http://127.0.0.1:9187");
		expect(h.logs.every((l) => l.level === "info")).toBe(true);
	});

	test("a host:port change between mounts closes the previous listener and starts on the new key", async () => {
		const h = harness();
		await mountKnowledgeGraphServer(h.deps);
		await mountKnowledgeGraphServer({ ...h.deps, env: { ...ENABLED, KNOWLEDGE_GRAPH_MCP_PORT: "9188" } });
		expect(h.closes).toBe(1);
		expect(h.starts).toBe(2);
		expect(getKnowledgeGraphMcpUrl()).toBe("http://127.0.0.1:9188");
	});

	test("a 0.0.0.0 bind host is probed and advertised on 127.0.0.1", async () => {
		const h = harness({ env: { ...ENABLED, KNOWLEDGE_GRAPH_MCP_HOST: "0.0.0.0" } });
		await mountKnowledgeGraphServer(h.deps);
		expect(getKnowledgeGraphMcpUrl()).toBe("http://127.0.0.1:9187");
	});
});
