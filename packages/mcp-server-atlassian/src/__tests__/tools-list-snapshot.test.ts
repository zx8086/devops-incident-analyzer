// src/__tests__/tools-list-snapshot.test.ts
// SIO-1416: eval-safety lock for the sugar->registerTool sweep (series template
// from SIO-1414, C-1..C-8). The serialized tools/list -- name, description,
// inputSchema -- is the exact surface @langchain/mcp-adapters binds to the model,
// so ANY serialization drift shifts model behavior and prompt-cache hits. Each
// tool's description + inputSchema is hashed into tools-list-snapshot.json;
// annotations are stored inline (they are new in this sweep and reviewable in PR
// diffs -- clients read them as hints, the model never sees them).
//
// This is an upstream-proxy server: the real atlassian_* surface is discovered at
// boot, so the fixture locks the 4 custom tools plus 2 FAKE discovered tools
// (mirroring the factory-replay harness) that pin the proxy registration path's
// serialization (description passthrough + JSON-Schema -> zod shape conversion).
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
import type { AtlassianMcpProxy, ProxyToolInfo } from "../atlassian-client/index.js";
import type { Config } from "../config/index.js";
import { type AtlassianDatasource, createMcpServerFactory } from "../server.js";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "tools-list-snapshot.json");

// Registration never calls the proxy (handlers run only on tools/call), so a
// minimal stub is sufficient for a tools/list-only test.
const stubProxy = {
	callTool: async () => ({ content: [] }),
	listTools: async () => [],
} as unknown as AtlassianMcpProxy;

const fakeConfig = {
	application: { name: "atlassian-mcp-server", version: "0.0.0" },
	atlassian: { readOnly: true, incidentProjects: ["INC"] },
} as unknown as Config;

// Same fake discovery snapshot as factory-replay.test.ts: exercises the proxy
// registration path deterministically without a live upstream.
const fakeDiscoveredTools: ProxyToolInfo[] = [
	{
		name: "getIssue",
		description: "Fetch a Jira issue by key",
		inputSchema: { type: "object", properties: { issueKey: { type: "string" } }, required: ["issueKey"] },
	},
	{
		name: "searchIssues",
		description: "Search Jira issues by JQL",
		inputSchema: { type: "object", properties: { jql: { type: "string" } }, required: ["jql"] },
	},
];

function makeDatasource(): AtlassianDatasource {
	return {
		proxy: stubProxy,
		config: fakeConfig,
		discoveredTools: fakeDiscoveredTools,
		siteUrl: "https://example.atlassian.net",
	};
}

interface SnapshotEntry {
	surfaceHash: string;
	annotations?: Record<string, unknown>;
}

async function captureSnapshot(): Promise<Record<string, SnapshotEntry>> {
	const factory = createMcpServerFactory(makeDatasource());
	const server = factory();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "tools-list-snapshot", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	const { tools } = await client.listTools();
	await client.close();

	const snapshot: Record<string, SnapshotEntry> = {};
	for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
		// The hash covers exactly the LLM-visible fields. Key order inside
		// inputSchema is deterministic per construction (same registration code
		// path every boot), so plain JSON.stringify is a stable canonical form.
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

	const currentNames = Object.keys(current);
	const committedNames = Object.keys(committed);
	expect(currentNames).toEqual(committedNames);

	const drifted = currentNames.filter((name) => current[name]?.surfaceHash !== committed[name]?.surfaceHash);
	if (drifted.length > 0) {
		throw new Error(
			`LLM-visible surface (description/inputSchema serialization) drifted for: ${drifted.join(", ")}. ` +
				"If intentional, regenerate with REGEN_TOOLS_SNAPSHOT=1 bun test tools-list-snapshot and review the fixture diff (SIO-1416).",
		);
	}

	for (const name of currentNames) {
		expect(current[name]?.annotations).toEqual(committed[name]?.annotations);
	}
});
