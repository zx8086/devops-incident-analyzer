// src/server.ts

import { createCachedServerFactory } from "@devops-agent/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { config } from "./config";
import { registerPingHandlers } from "./lib/pingHandler";
import { registerAll } from "./lib/toolRegistry";
import { registerSqlppQueryGenerator } from "./prompts/sqlppQueryGenerator";
import { registerAllResources } from "./resources";
import type { PlaybookRegistry } from "./resources/playbookResource";

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

// SIO-1041/SIO-1044: record-once / replay-many factory. registerAll runs ONCE at boot against a
// throwaway template server; every request replays the recorded tool/resource/prompt tuples onto
// a fresh bare server. couchbase is the hardest adopter of this factory: playbook directory
// enumeration is async (fs.readdir/access), so it must be hoisted out to initDatasource
// (loadPlaybooks) well before this factory is created -- registerAll itself must be synchronous.
export function createMcpServerFactory(ds: CouchbaseServerDatasource): () => McpServer {
	return createCachedServerFactory({
		createBareServer,
		registerAll: (server) => {
			// Minimal hardcoded resource for debugging
			server.resource("test-playbook", "playbook://test.md", async (uri) => ({
				contents: [
					{
						uri: uri.href,
						mimeType: "text/markdown",
						text: "# Test",
					},
				],
			}));

			// Register all tools
			registerAll(server, ds.bucket);

			// Register our SQL++ query generator prompt
			registerSqlppQueryGenerator(server);

			// Register all Couchbase resources (sync -- playbooks already enumerated).
			// SIO-1052: capture the documentation handler for the docs:// fast path below.
			const docsHandler = registerAllResources(server, ds.bucket, ds.playbooks);

			// Add a public method to read resources by URI.
			// Assigned on the boot template only; tool handlers resolve it lazily off their
			// closure-captured server (the template), so replayed per-request instances never
			// read it. Do not move to createBareServer. SIO-1044
			// biome-ignore lint/suspicious/noExplicitAny: accessing internal MCP SDK resource registry
			const serverInternal = server as Record<string, any>;
			serverInternal.readResourceByUri = async (resourceUri: string) => {
				// SIO-1044: playbook:// fast path serving the boot-time playbook registry directly,
				// matching the pre-monorepo implementation's exact URI parsing and return shape.
				// SIO-1052 added the docs:// fast path and fixed the generic SDK-registry fallback below.
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

				// SIO-1052: generic fallback rewritten against SDK 1.29's actual internals, mirroring
				// its ReadResourceRequestSchema dispatch: _registeredResources is keyed BY uri string
				// (values carry readCallback + enabled), templates live in _registeredResourceTemplates
				// (resourceTemplate.uriTemplate.match). The old walk used .uri/.handler field names that
				// never existed, so it threw "No resource handler found" for every URI.
				interface RegisteredResource {
					enabled?: boolean;
					readCallback: (uri: URL, extra: Record<string, unknown>) => Promise<unknown>;
				}
				interface RegisteredResourceTemplate {
					resourceTemplate: { uriTemplate: { match: (uri: string) => Record<string, unknown> | null } };
					readCallback: (
						uri: URL,
						variables: Record<string, unknown>,
						extra: Record<string, unknown>,
					) => Promise<unknown>;
				}
				const registeredResources = (serverInternal._registeredResources ?? {}) as Record<string, RegisteredResource>;
				const exact = registeredResources[resourceUri];
				if (exact && exact.enabled !== false) {
					return await exact.readCallback(new URL(resourceUri), {});
				}
				const registeredTemplates = (serverInternal._registeredResourceTemplates ?? {}) as Record<
					string,
					RegisteredResourceTemplate
				>;
				for (const template of Object.values(registeredTemplates)) {
					const variables = template.resourceTemplate.uriTemplate.match(resourceUri);
					if (variables) {
						return await template.readCallback(new URL(resourceUri), variables, {});
					}
				}
				throw new Error(`No resource handler found for URI: ${resourceUri}`);
			};

			// Register ping handlers for both protocol and tool usage
			registerPingHandlers(server);

			// Register a minimal echo tool for debugging
			server.tool(
				"capella_echo",
				"Echoes back the input parameters for debugging",
				{},
				async (params: Record<string, unknown>) => {
					getDocLogger().info("EchoTool RAW params", { raw_params: JSON.stringify(params) });
					return { content: [{ type: "text", text: JSON.stringify(params) }] };
				},
			);
		},
	});
}
