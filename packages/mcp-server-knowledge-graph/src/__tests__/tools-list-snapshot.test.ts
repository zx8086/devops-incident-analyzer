// src/__tests__/tools-list-snapshot.test.ts
// SIO-1415: eval-safety lock for the sugar->registerTool sweep (template from
// SIO-1414). The serialized tools/list -- name, description, inputSchema -- is the
// exact surface @langchain/mcp-adapters binds to the model, so ANY serialization
// drift shifts model behavior and prompt-cache hits. Each tool's description +
// inputSchema is hashed into tools-list-snapshot.json; annotations are stored
// inline. The fixture is captured with allowCypher: true so the gated
// kg_run_cypher surface is locked too.
//
// On an INTENTIONAL surface change: regenerate with
//   REGEN_TOOLS_SNAPSHOT=1 bun test tools-list-snapshot
// and review the fixture diff in the PR like any other code change.

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "../config.ts";
import { createMcpServerFactory } from "../server.ts";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "tools-list-snapshot.json");

// Registration never opens the graph store (lazy, inside handlers), so a
// disabled-graph config is sufficient -- same rationale as factory-replay.test.ts.
const fakeConfig: Config = {
	transport: { mode: "http", port: 0, host: "127.0.0.1", path: "/mcp" },
	graphPath: ".data/knowledge-graph-snapshot-test",
	knowledgeGraphEnabled: false,
	allowCypher: true,
};

interface SnapshotEntry {
	surfaceHash: string;
	annotations?: Record<string, unknown>;
}

async function captureSnapshot(): Promise<Record<string, SnapshotEntry>> {
	const server = createMcpServerFactory(fakeConfig)();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "tools-list-snapshot", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	const { tools } = await client.listTools();
	await client.close();

	const snapshot: Record<string, SnapshotEntry> = {};
	for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
		const surface = JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema });
		snapshot[tool.name] = {
			surfaceHash: createHash("sha256").update(surface).digest("hex"),
			...(tool.annotations !== undefined && { annotations: tool.annotations as Record<string, unknown> }),
		};
	}
	return snapshot;
}

test("serialized tools/list matches the committed snapshot (LLM-visible surface + annotations)", async () => {
	const current = await captureSnapshot();

	if (process.env.REGEN_TOOLS_SNAPSHOT === "1") {
		writeFileSync(FIXTURE_PATH, `${JSON.stringify(current, null, "\t")}\n`);
		console.log(`Regenerated ${FIXTURE_PATH} with ${Object.keys(current).length} tool(s).`);
		return;
	}

	const committed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, SnapshotEntry>;

	expect(Object.keys(current)).toEqual(Object.keys(committed));

	const drifted = Object.keys(current).filter((name) => current[name]?.surfaceHash !== committed[name]?.surfaceHash);
	if (drifted.length > 0) {
		throw new Error(
			`LLM-visible surface (description/inputSchema serialization) drifted for: ${drifted.join(", ")}. ` +
				"If intentional, regenerate with REGEN_TOOLS_SNAPSHOT=1 bun test tools-list-snapshot and review the fixture diff (SIO-1415).",
		);
	}

	for (const name of Object.keys(current)) {
		expect(current[name]?.annotations).toEqual(committed[name]?.annotations);
	}
});
