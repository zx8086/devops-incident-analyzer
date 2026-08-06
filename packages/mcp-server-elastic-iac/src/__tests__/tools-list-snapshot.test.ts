// src/__tests__/tools-list-snapshot.test.ts
// SIO-1417: eval-safety lock for the sugar->registerTool sweep (series template
// from SIO-1414, C-1..C-8). The serialized tools/list -- name, description,
// inputSchema -- is the exact surface @langchain/mcp-adapters binds to the model,
// so ANY serialization drift shifts model behavior and prompt-cache hits. Each
// tool's description + inputSchema is hashed into tools-list-snapshot.json;
// annotations are stored inline (they are new in this sweep and reviewable in PR
// diffs -- clients read them as hints, the model never sees them).
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

// Registration never calls GitLab/Elastic Cloud/task (handlers run only on
// tools/call), so a minimal stub config is sufficient -- same as factory-replay.
const fakeConfig: Config = {
	transport: { mode: "http", port: 0, host: "127.0.0.1", path: "/mcp" },
	repository: {
		gitlabBaseUrl: "https://gitlab.example.com",
		projectId: "1",
		workspaceDir: "/tmp/elastic-iac-tools-list-snapshot-test",
	},
	gitops: {
		baseUrl: "https://gitlab.example.com",
		project: "example/elastic-iac",
		token: undefined,
	},
	taskBin: "task",
	gitlabToken: undefined,
	elasticCloudApiKey: undefined,
	elasticCloudBaseUrl: "https://api.elastic-cloud.com",
	clusterDeployments: [],
};

interface SnapshotEntry {
	surfaceHash: string;
	annotations?: Record<string, unknown>;
}

async function captureSnapshot(): Promise<Record<string, SnapshotEntry>> {
	const factory = createMcpServerFactory(fakeConfig);
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
				"If intentional, regenerate with REGEN_TOOLS_SNAPSHOT=1 bun test tools-list-snapshot and review the fixture diff (SIO-1417).",
		);
	}

	for (const name of currentNames) {
		expect(current[name]?.annotations).toEqual(committed[name]?.annotations);
	}
});
