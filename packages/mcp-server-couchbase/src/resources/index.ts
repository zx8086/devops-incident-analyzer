/* src/resources/index.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { config } from "../config";
import { registerDatabaseStructureResource } from "./databaseStructureResource";
import { registerMarkdownDocumentationResource } from "./documentationResource";
import { registerDocumentResource } from "./documentResource";
import { registerPlaybookResources } from "./playbookResource";
import { registerQueryResource } from "./queryResource";
import { registerSchemaResource } from "./schemaResource";

export async function registerAllResources(server: McpServer, bucket: Bucket): Promise<void> {
	// Register playbook resources first - this is important for proper URI registration
	await registerPlaybookResources(server);

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
