// src/tools/custom/index.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AtlassianMcpProxy } from "../../atlassian-client/index.js";
import { registerFindLinkedIncidents } from "./find-linked-incidents.js";
import { registerGetIncidentHistory } from "./get-incident-history.js";
import { registerGetRunbookForAlert } from "./get-runbook-for-alert.js";

export interface CustomToolsOptions {
	incidentProjects: string[];
	siteUrl?: string;
}

export function registerCustomTools(
	server: McpServer,
	proxy: AtlassianMcpProxy,
	opts: CustomToolsOptions,
): number {
	registerFindLinkedIncidents(server, proxy, opts.incidentProjects, opts.siteUrl);
	registerGetRunbookForAlert(server, proxy, opts.siteUrl);
	registerGetIncidentHistory(server, proxy, opts.incidentProjects);
	return 3;
}
