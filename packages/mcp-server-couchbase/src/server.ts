// src/server.ts

import { createCachedServerFactory } from "@devops-agent/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { config } from "./config";
import { registerPingHandlers } from "./lib/pingHandler";
import { registerAll } from "./lib/toolRegistry";
import { registerSqlppQueryGenerator } from "./prompts/sqlppQueryGenerator";
import { registerAllResources } from "./resources";
import type { DocumentationHandler } from "./resources/documentationResource";
import type { PlaybookRegistry } from "./resources/playbookResource";
import { ResourceRegistry } from "./resources/resource-registry";
import { couchbaseToolAnnotations } from "./tools/tool-classification";

// SIO-1044: playbooks is pre-enumerated once in initDatasource (loadPlaybooks, async/fs-bound) so
// registerAll below can stay fully synchronous, as required by createCachedServerFactory.
export interface CouchbaseServerDatasource {
	bucket: Bucket;
	playbooks: PlaybookRegistry | null;
}

// Sync -- allocates a bare McpServer with no tools/resources/prompts.
function createBareServer(): McpServer {
	return new McpServer({
		name: config.server.name,
		version: config.server.version,
	});
}

function getDocLogger() {
	const { createContextLogger } = require("./utils/logger");
	return createContextLogger("EchoTool");
}

// SIO-1412: the readResourceByUri implementation, exported so the fallback regression
// test can exercise it directly (it is otherwise only reachable off the boot template
// server captured in tool-handler closures). Fast paths first (playbook://, docs://),
// then the generic fallback against couchbase's OWN ResourceRegistry.
export function buildReadResourceByUri(
	ds: CouchbaseServerDatasource,
	docsHandler: DocumentationHandler | null,
	registry: ResourceRegistry,
): (resourceUri: string) => Promise<unknown> {
	return async (resourceUri: string) => {
		// SIO-1044: playbook:// fast path serving the boot-time playbook registry directly,
		// matching the pre-monorepo implementation's exact URI parsing and return shape.
		// SIO-1052 added the docs:// fast path.
		const protocol = resourceUri.split("://")[0];
		const rest = resourceUri.split("://")[1] || "";
		if (protocol === "playbook" && ds.playbooks) {
			if (rest === "") {
				return ds.playbooks.handler.listPlaybooks();
			}
			return ds.playbooks.handler.getPlaybook(rest);
		}

		// SIO-1052: docs:// fast path. The SDK-registered docs resources only cover the exact
		// root URI ("docs://"); scoped lookups (docs://<scope>[/<collection>[/<file>]]) dispatch
		// straight to the DocumentationHandler, mirroring the playbook fast path above.
		if (protocol === "docs" && docsHandler) {
			const parts = rest === "" ? [] : rest.split("/");
			const [scope = "", collection = ""] = parts;
			if (parts.length === 0) {
				return docsHandler.listDocumentation();
			}
			if (parts.length === 1) {
				return docsHandler.getScopeDocumentation(scope);
			}
			if (parts.length === 2) {
				return docsHandler.getCollectionDocumentation(scope, collection);
			}
			return docsHandler.getDocumentationFile(scope, collection, parts.slice(2).join("/"));
		}

		// SIO-1412: generic fallback walks couchbase's OWN ResourceRegistry (populated
		// explicitly at registration time) instead of the SDK's private
		// _registeredResources/_registeredResourceTemplates fields, whose reverse-
		// engineered shape already broke once on an SDK internals change (SIO-1052).
		// Unknown URIs throw the same -32602 McpError the SDK's real resources/read
		// handler throws.
		return registry.read(resourceUri);
	};
}

// SIO-1041/SIO-1044: record-once / replay-many factory. registerAll runs ONCE at boot against a
// throwaway template server; every request replays the recorded tool/resource/prompt tuples onto
// a fresh bare server. couchbase is the hardest adopter of this factory: playbook directory
// enumeration is async (fs.readdir/access), so it must be hoisted out to initDatasource
// (loadPlaybooks) well before this factory is created -- registerAll itself must be synchronous.
export function createMcpServerFactory(ds: CouchbaseServerDatasource): () => McpServer {
	return createCachedServerFactory({
		createBareServer,
		registerAll: (server) => {
			// SIO-1412: couchbase's own resource bookkeeping, populated alongside every SDK
			// registration below; backs the readResourceByUri generic fallback.
			const registry = new ResourceRegistry();

			// Minimal hardcoded resource for debugging
			const readTestPlaybook = async (uri: URL) => ({
				contents: [
					{
						uri: uri.href,
						mimeType: "text/markdown",
						text: "# Test",
					},
				],
			});
			server.registerResource("test-playbook", "playbook://test.md", {}, readTestPlaybook);
			registry.addExact("playbook://test.md", readTestPlaybook);

			// Register all tools
			registerAll(server, ds.bucket);

			// Register our SQL++ query generator prompt
			registerSqlppQueryGenerator(server);

			// Register all Couchbase resources (sync -- playbooks already enumerated).
			// SIO-1052: capture the documentation handler for the docs:// fast path.
			const docsHandler = registerAllResources(server, ds.bucket, ds.playbooks, registry);

			// Add a public method to read resources by URI.
			// Assigned on the boot template only; tool handlers resolve it lazily off their
			// closure-captured server (the template), so replayed per-request instances never
			// read it. Do not move to createBareServer. SIO-1044
			const serverWithReader = server as McpServer & { readResourceByUri?: (uri: string) => Promise<unknown> };
			serverWithReader.readResourceByUri = buildReadResourceByUri(ds, docsHandler, registry);

			// Register ping handlers for both protocol and tool usage
			registerPingHandlers(server);

			// Register a minimal echo tool for debugging
			server.registerTool(
				"capella_echo",
				{
					description: "Echoes back the input parameters for debugging",
					inputSchema: {},
					annotations: couchbaseToolAnnotations("capella_echo"),
				},
				async (params: Record<string, unknown>) => {
					getDocLogger().info("EchoTool RAW params", { raw_params: JSON.stringify(params) });
					return { content: [{ type: "text", text: JSON.stringify(params) }] };
				},
			);
		},
	});
}
