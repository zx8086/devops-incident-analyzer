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
import { logger } from "./utils/logger";

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

			// Register all Couchbase resources (sync -- playbooks already enumerated)
			registerAllResources(server, ds.bucket, ds.playbooks);

			// Add a public method to read resources by URI.
			// Assigned on the boot template only; tool handlers resolve it lazily off their
			// closure-captured server (the template), so replayed per-request instances never
			// read it. Do not move to createBareServer. SIO-1044
			// biome-ignore lint/suspicious/noExplicitAny: accessing internal MCP SDK resource registry
			const serverInternal = server as Record<string, any>;
			serverInternal.readResourceByUri = async (resourceUri: string) => {
				// SIO-1044 final review: restore the playbook:// fast path that used to live at the
				// end of the old resources/playbookResource.ts (deleted by this branch; see
				// `git show 0f8f098:packages/mcp-server-couchbase/src/resources/playbookResource.ts`).
				// The generic registry walk below uses `.uri`/`.handler` field names that do not exist
				// on SDK 1.29's `_registeredResources` (keyed BY uri, values carry `readCallback`), so
				// it never finds a match for playbook:// URIs -- this fast path serves them directly
				// off the boot-time playbook registry, matching the old implementation's exact URI
				// parsing and return shape. The generic walk remains the fallback for other protocols
				// (docs:// stays broken pre-existing -- fixing the registry-walk field names is an
				// out-of-scope follow-up).
				const protocol = resourceUri.split("://")[0];
				const rest = resourceUri.split("://")[1] || "";
				if (protocol === "playbook" && ds.playbooks) {
					if (rest === "") {
						return ds.playbooks.handler.listPlaybooks();
					}
					return ds.playbooks.handler.getPlaybook(rest);
				}

				// Some SDK versions store resources as a Map (iterable), others as a plain object (not iterable).
				const resourceMap =
					serverInternal._resources || serverInternal.resources || serverInternal._registeredResources;
				if (!resourceMap) {
					logger.error("No resource registry found on server instance.");
					throw new Error(
						"No resource registry found on server instance (tried _resources, resources, _registeredResources)",
					);
				}
				interface InternalResource {
					uri?: string;
					template?: { match: (uri: string) => Record<string, string> | null };
					handler: (href: { href: string }, params: Record<string, unknown>) => Promise<unknown>;
				}
				let resourcesIterable: Iterable<InternalResource>;
				if (resourceMap instanceof Map) {
					resourcesIterable = resourceMap.values();
				} else if (typeof resourceMap === "object") {
					resourcesIterable = Object.values(resourceMap);
				} else {
					throw new Error("Resource registry is not iterable");
				}
				for (const resource of resourcesIterable) {
					if (resource.template?.match) {
						const match = resource.template.match(resourceUri);
						if (match) {
							return await resource.handler({ href: resourceUri }, match);
						}
					}
					if (resource.uri && resource.uri === resourceUri) {
						return await resource.handler({ href: resourceUri }, {});
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
