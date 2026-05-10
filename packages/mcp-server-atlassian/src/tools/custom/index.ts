// src/tools/custom/index.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AtlassianMcpProxy } from "../../atlassian-client/index.js";
import { registerFindLinkedIncidents } from "./find-linked-incidents.js";
import { registerGetIncidentHistory } from "./get-incident-history.js";
import { registerGetJiraIssue } from "./get-jira-issue.js";
import { registerGetRunbookForAlert } from "./get-runbook-for-alert.js";

export interface CustomToolsOptions {
	incidentProjects: string[];
	siteUrl?: string;
}

// SIO-706: tools registered here OVERRIDE the upstream-proxied versions of the same name.
// proxy/index.ts must skip these when registering generic forwarders, otherwise both
// versions land on the McpServer and the second registration throws.
export const CUSTOM_OVERRIDDEN_UPSTREAM_TOOLS = new Set<string>(["getJiraIssue"]);

export function registerCustomTools(server: McpServer, proxy: AtlassianMcpProxy, opts: CustomToolsOptions): number {
	registerFindLinkedIncidents(server, proxy, opts.incidentProjects, opts.siteUrl);
	registerGetRunbookForAlert(server, proxy, opts.siteUrl);
	registerGetIncidentHistory(server, proxy, opts.incidentProjects);
	registerGetJiraIssue(server, proxy);
	return 4;
}
