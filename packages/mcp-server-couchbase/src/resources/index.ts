/* src/resources/index.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { config } from "../config";
import { registerDatabaseStructureResource } from "./databaseStructureResource";
import { registerMarkdownDocumentationResource } from "./documentationResource";
import { registerDocumentResource } from "./documentResource";
import { type PlaybookRegistry, registerPlaybookResources } from "./playbookResource";
import { registerQueryResource } from "./queryResource";
import { registerSchemaResource } from "./schemaResource";

// SIO-1044: sync -- playbooks is pre-enumerated once (loadPlaybooks, in initDatasource) so this
// can run inside registerAll under the cached server factory, which must stay synchronous.
export function registerAllResources(server: McpServer, bucket: Bucket, playbooks: PlaybookRegistry | null): void {
	// Register playbook resources first - this is important for proper URI registration
	registerPlaybookResources(server, playbooks);

	// Register other resources
	registerDatabaseStructureResource(server, bucket);
	registerSchemaResource(server, bucket);
	registerDocumentResource(server, bucket);
	registerQueryResource(server, bucket);

	// Register the markdown documentation resource if configured
	if (config.documentation?.enabled) {
		registerMarkdownDocumentationResource(server, bucket, {
			baseDirectory: config.documentation.baseDirectory || "./docs",
			fileExtension: config.documentation.fileExtension || ".md",
		});
	}
}
