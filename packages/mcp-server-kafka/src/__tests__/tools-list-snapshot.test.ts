// src/__tests__/tools-list-snapshot.test.ts
// SIO-1421: eval-safety lock for the sugar->registerTool sweep (series template
// from SIO-1414, C-1..C-8). The serialized tools/list -- name, description,
// inputSchema -- is the exact surface @langchain/mcp-adapters binds to the model,
// so ANY serialization drift shifts model behavior and prompt-cache hits. Each
// tool's description + inputSchema is hashed into tools-list-snapshot.json;
// annotations are stored inline. Captured with ALL feature gates enabled
// (schema registry + ksqlDB + Connect + REST Proxy) so the full 61-tool surface
// is locked, mirroring the factory-replay gates-enabled harness.
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
import type { AppConfig } from "../config/schemas.ts";
import type { ConnectService } from "../services/connect-service.ts";
import type { KafkaService } from "../services/kafka-service.ts";
import type { KsqlService } from "../services/ksql-service.ts";
import type { RestProxyService } from "../services/restproxy-service.ts";
import type { SchemaRegistryService } from "../services/schema-registry-service.ts";
import { registerAllTools, type ToolRegistrationOptions } from "../tools/index.ts";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "tools-list-snapshot.json");

// Registration never calls Kafka/HTTP clients (handlers run only on tools/call),
// so stub services are sufficient -- same idiom as factory-replay.test.ts.
const kafkaService = {} as unknown as KafkaService;

const gatesEnabledConfig = {
	kafka: {
		provider: "local",
		clientId: "tools-list-snapshot",
		allowWrites: true,
		allowDestructive: true,
		consumeMaxMessages: 100,
		consumeTimeoutMs: 5000,
		toolTimeoutMs: 5000,
	},
	msk: { bootstrapBrokers: "", clusterArn: "", region: "", authMode: "iam" },
	confluent: { bootstrapServers: "", apiKey: "", apiSecret: "", restEndpoint: "", clusterId: "" },
	local: { bootstrapServers: "localhost:9092" },
	schemaRegistry: { enabled: true, url: "http://schema-registry:8081", apiKey: "", apiSecret: "" },
	ksql: { enabled: true, endpoint: "http://ksql-server:8088", apiKey: "", apiSecret: "" },
	connect: { enabled: true, url: "http://connect:8083", apiKey: "", apiSecret: "" },
	restproxy: { enabled: true, url: "http://kafka-rest:8082", apiKey: "", apiSecret: "" },
	logging: { level: "silent", backend: "pino" },
	telemetry: {
		enabled: false,
		serviceName: "kafka-mcp-server",
		mode: "console",
		otlpEndpoint: "http://localhost:4318",
	},
	transport: {
		mode: "stdio",
		port: 9081,
		host: "0.0.0.0",
		path: "/mcp",
		sessionMode: "stateless",
		apiKey: "",
		allowedOrigins: "",
		idleTimeout: 30,
		drainTimeoutMs: 0,
	},
} as unknown as AppConfig;

const toolOptions: ToolRegistrationOptions = {
	schemaRegistryService: {} as unknown as SchemaRegistryService,
	ksqlService: {} as unknown as KsqlService,
	connectService: {} as unknown as ConnectService,
	restProxyService: {} as unknown as RestProxyService,
};

interface SnapshotEntry {
	surfaceHash: string;
	annotations?: Record<string, unknown>;
}

async function captureSnapshot(): Promise<Record<string, SnapshotEntry>> {
	const factory = createCachedServerFactory({
		createBareServer: () => new McpServer({ name: "@devops-agent/mcp-server-kafka", version: "0.0.0" }),
		registerAll: (server) => registerAllTools(server, kafkaService, gatesEnabledConfig, toolOptions),
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
				"If intentional, regenerate with REGEN_TOOLS_SNAPSHOT=1 bun test tools-list-snapshot and review the fixture diff (SIO-1421).",
		);
	}

	for (const name of currentNames) {
		expect(current[name]?.annotations).toEqual(committed[name]?.annotations);
	}
});
