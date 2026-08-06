// src/__tests__/tools-list-snapshot.test.ts
// SIO-1419: eval-safety lock for the sugar->registerTool sweep (series template
// from SIO-1414, C-1..C-8). The serialized tools/list -- name, description,
// inputSchema -- is the exact surface @langchain/mcp-adapters binds to the model,
// so ANY serialization drift shifts model behavior and prompt-cache hits. Each
// tool's description + inputSchema is hashed into tools-list-snapshot.json;
// annotations are stored inline (clients read them as hints, the model never
// sees them).
//
// couchbase also converted resource + prompt sugar (10 + 1 sites), so this
// fixture additionally locks resources/list, resourceTemplates/list, and
// prompts/list VERBATIM (they are small; a raw diff is more reviewable than a
// hash). Captured with docs enabled and a stub playbook registry so the gated
// surfaces are locked too.
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
import type { Bucket } from "couchbase";
import { config } from "../config";
import { PlaybookHandler, type PlaybookRegistry } from "../resources/playbookResource.ts";
import { createMcpServerFactory } from "../server.ts";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "tools-list-snapshot.json");

const stubBucket = {} as unknown as Bucket;

function makePlaybooks(): PlaybookRegistry {
	const handler = new PlaybookHandler("/fake/playbook/dir", ".md");
	handler.playbookFiles = ["test1.md"];
	return { handler, resourceIds: ["test1"] };
}

interface SnapshotEntry {
	surfaceHash: string;
	annotations?: Record<string, unknown>;
}

interface Snapshot {
	tools: Record<string, SnapshotEntry>;
	resources: unknown[];
	resourceTemplates: unknown[];
	prompts: unknown[];
}

async function captureSnapshot(): Promise<Snapshot> {
	// Docs enabled so the 4 documentation resources register (registration reads no fs).
	const priorDocumentation = config.documentation;
	config.documentation = { enabled: true, baseDirectory: "./docs-snapshot-unused", fileExtension: ".md" };
	try {
		const factory = createMcpServerFactory({ bucket: stubBucket, playbooks: makePlaybooks() });
		const server = factory();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "tools-list-snapshot", version: "0.0.0" });
		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
		const { tools } = await client.listTools();
		const { resources } = await client.listResources();
		const { resourceTemplates } = await client.listResourceTemplates();
		const { prompts } = await client.listPrompts();
		await client.close();

		const toolEntries: Record<string, SnapshotEntry> = {};
		for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
			// The hash covers exactly the LLM-visible fields. Key order inside
			// inputSchema is deterministic per construction (same registration code
			// path every boot), so plain JSON.stringify is a stable canonical form.
			const surface = JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema });
			toolEntries[tool.name] = {
				surfaceHash: createHash("sha256").update(surface).digest("hex"),
				...(tool.annotations !== undefined && { annotations: tool.annotations as Record<string, unknown> }),
			};
		}
		return {
			tools: toolEntries,
			resources: [...resources].sort((a, b) => String(a.uri).localeCompare(String(b.uri))),
			resourceTemplates: [...resourceTemplates].sort((a, b) =>
				String(a.uriTemplate).localeCompare(String(b.uriTemplate)),
			),
			prompts: [...prompts]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((p) => ({ name: p.name, description: p.description, arguments: p.arguments })),
		};
	} finally {
		config.documentation = priorDocumentation;
	}
}

test("serialized tools+resources+prompts lists match the committed snapshot", async () => {
	const current = await captureSnapshot();

	if (process.env.REGEN_TOOLS_SNAPSHOT === "1") {
		writeFileSync(FIXTURE_PATH, `${JSON.stringify(current, null, "\t")}\n`);
		console.log(`Regenerated ${FIXTURE_PATH} with ${Object.keys(current.tools).length} tool(s).`);
		return;
	}

	const committed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Snapshot;

	const currentNames = Object.keys(current.tools);
	expect(currentNames).toEqual(Object.keys(committed.tools));

	const drifted = currentNames.filter((n) => current.tools[n]?.surfaceHash !== committed.tools[n]?.surfaceHash);
	if (drifted.length > 0) {
		throw new Error(
			`LLM-visible surface (description/inputSchema serialization) drifted for: ${drifted.join(", ")}. ` +
				"If intentional, regenerate with REGEN_TOOLS_SNAPSHOT=1 bun test tools-list-snapshot and review the fixture diff (SIO-1419).",
		);
	}
	for (const name of currentNames) {
		expect(current.tools[name]?.annotations).toEqual(committed.tools[name]?.annotations);
	}

	expect(current.resources).toEqual(committed.resources);
	expect(current.resourceTemplates).toEqual(committed.resourceTemplates);
	expect(current.prompts).toEqual(committed.prompts);
});
