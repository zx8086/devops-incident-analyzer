// src/__tests__/tools-list-snapshot.test.ts
// SIO-1420: eval-safety lock for the sugar->registerTool sweep (series template
// from SIO-1414, C-1..C-8). The serialized tools/list -- name, description,
// inputSchema -- is the exact surface @langchain/mcp-adapters binds to the model,
// so ANY serialization drift shifts model behavior and prompt-cache hits. Each
// tool's description + inputSchema is hashed into tools-list-snapshot.json;
// annotations are stored inline (every aws tool is read-only by design: estates
// are reached via AssumeRole into DevOpsAgentReadOnly).
//
// On an INTENTIONAL surface change: regenerate with
//   REGEN_TOOLS_SNAPSHOT=1 bun test tools-list-snapshot
// and review the fixture diff in the PR like any other code change.

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCachedServerFactory } from "@devops-agent/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../config/schemas.ts";
import { registerAllTools } from "../tools/register.ts";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "tools-list-snapshot.json");

// Registration never calls AWS SDK clients (handlers run only on tools/call), so a
// minimal single-estate config is sufficient -- same as factory-replay.
const awsConfig: AwsConfig = {
	region: "eu-central-1",
	estates: {
		prod: {
			assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
			externalId: "aws-mcp-readonly-2026",
		},
	},
};

interface SnapshotEntry {
	surfaceHash: string;
	annotations?: Record<string, unknown>;
}

async function captureSnapshot(): Promise<Record<string, SnapshotEntry>> {
	const factory = createCachedServerFactory({
		createBareServer: () => new McpServer({ name: "aws-mcp-server", version: "0.0.0" }),
		registerAll: (server) => registerAllTools(server, awsConfig),
	});
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
				"If intentional, regenerate with REGEN_TOOLS_SNAPSHOT=1 bun test tools-list-snapshot and review the fixture diff (SIO-1420).",
		);
	}

	for (const name of currentNames) {
		expect(current[name]?.annotations).toEqual(committed[name]?.annotations);
	}
});
