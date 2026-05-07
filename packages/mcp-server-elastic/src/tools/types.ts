/* src/tools/types.ts */

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CloudClient } from "../clients/cloudClient.js";

// Common Elasticsearch parameter types
export type ExpandWildcards = "open" | "closed" | "hidden" | "none" | "all";
export type WaitForActiveShards = "all" | number;
export type Conflicts = "abort" | "proceed";
export type SearchType = "query_then_fetch" | "dfs_query_then_fetch";

// Common request parameters
export interface CommonRequestParams {
	index?: string | string[];
	waitForActiveShards?: WaitForActiveShards;
	expandWildcards?: ExpandWildcards;
	ignoreUnavailable?: boolean;
	allowNoIndices?: boolean;
}

// Content types
export interface TextContent {
	type: "text";
	text: string;
	annotations?: {
		audience?: ("user" | "assistant")[];
		priority?: number;
		lastModified?: string;
	};
	_meta?: Record<string, unknown>;
}

// Search result type
export interface SearchResult {
	content: TextContent[];
	_meta?: Record<string, unknown>;
	structuredContent?: Record<string, unknown>;
	// Required for SDK CallToolResult assignability ($loose schema -> open index signature)
	[key: string]: unknown;
}

// Common response types
export interface ElasticsearchResponse {
	_index: string;
	_id: string;
	_version?: number;
	_shards?: {
		total: number;
		successful: number;
		failed: number;
	};
	result?: string;
}

// Error response type
export interface ElasticsearchError {
	error: {
		type: string;
		reason: string;
		status: number;
	};
}

export type ToolFunction = (server: McpServer, esClient: Client) => void;

// Tool registration function type
export type ToolRegistrationFunction = (server: McpServer, esClient: Client) => void;

// SIO-674: Parallel signature for tools that target the org-scoped Elastic Cloud API
// (api.elastic-cloud.com). Kept separate from ToolRegistrationFunction so the existing ES
// tools don't have to know about the cloud client.
export type CloudToolRegistrationFunction = (server: McpServer, cloudClient: CloudClient) => void;
