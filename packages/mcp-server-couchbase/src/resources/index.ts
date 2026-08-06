/* src/resources/index.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { config } from "../config";
import { registerDatabaseStructureResource } from "./databaseStructureResource";
import { type DocumentationHandler, registerMarkdownDocumentationResource } from "./documentationResource";
import { registerDocumentResource } from "./documentResource";
import { type PlaybookRegistry, registerPlaybookResources } from "./playbookResource";
import { registerQueryResource } from "./queryResource";
import type { ResourceRegistry } from "./resource-registry";
import { registerSchemaResource } from "./schemaResource";

// SIO-1044: sync -- playbooks is pre-enumerated once (loadPlaybooks, in initDatasource) so this
// can run inside registerAll under the cached server factory, which must stay synchronous.
// SIO-1052: returns the documentation handler (null when docs are disabled) so server.ts's
// readResourceByUri can serve scoped docs:// lookups directly (the SDK-registered docs resources
// only cover the exact root URI).
// SIO-1412: every registrar also records its resources in `registry` (couchbase's own
// ResourceRegistry), which backs readResourceByUri's generic fallback without SDK reach-in.
export function registerAllResources(
	server: McpServer,
	bucket: Bucket,
	playbooks: PlaybookRegistry | null,
	registry: ResourceRegistry,
): DocumentationHandler | null {
	// Register playbook resources first - this is important for proper URI registration
	registerPlaybookResources(server, playbooks, registry);

	// Register other resources
	registerDatabaseStructureResource(server, bucket, registry);
	registerSchemaResource(server, bucket, registry);
	registerDocumentResource(server, bucket, registry);
	registerQueryResource(server, bucket, registry);

	// Register the markdown documentation resource if configured
	if (config.documentation?.enabled) {
		return registerMarkdownDocumentationResource(
			server,
			bucket,
			{
				baseDirectory: config.documentation.baseDirectory || "./docs",
				fileExtension: config.documentation.fileExtension || ".md",
			},
			registry,
		);
	}
	return null;
}
