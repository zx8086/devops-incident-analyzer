// src/tools/custom/validate-incident-projects.ts
//
// SIO-1184: ATLASSIAN_INCIDENT_PROJECTS pointed at project keys that do not exist on the
// connected site (INC,OPS) for months without anyone noticing -- Jira's search API returns a
// clean empty result for nonexistent projects in JQL, so findLinkedIncidents/getIncidentHistory
// silently answered count:0 on every call. Validate configured keys against the live site once
// per process; drop keys that do not exist and fall back to the all-projects wildcard when none
// remain, surfacing what happened via a configWarning the caller embeds in the tool output.

import type { AtlassianMcpProxy } from "../../atlassian-client/index.js";
import { createContextLogger } from "../../utils/logger.js";
import { parseAtlassianTextContent } from "./parse-atlassian-content.js";

const log = createContextLogger("validate-incident-projects");

export interface EffectiveProjects {
	projects: string[];
	configWarning?: string;
}

interface ProjectSearchResponse {
	values?: { key?: string }[];
}

async function projectExists(proxy: AtlassianMcpProxy, key: string): Promise<boolean> {
	const result = await proxy.callTool("getVisibleJiraProjects", { searchString: key });
	const parsed = parseAtlassianTextContent<ProjectSearchResponse>(result as { content?: unknown }, {
		upstreamTool: "getVisibleJiraProjects",
		context: { searchString: key },
		log,
	});
	const values = parsed?.values ?? [];
	return values.some((p) => typeof p.key === "string" && p.key.toUpperCase() === key.toUpperCase());
}

// Config is boot-static, so a single-entry promise cache makes validation one-shot per process
// and race-safe under concurrent first calls.
let cache: { key: string; promise: Promise<EffectiveProjects> } | null = null;

export function resetEffectiveProjectsCacheForTests(): void {
	cache = null;
}

export function resolveEffectiveProjects(proxy: AtlassianMcpProxy, configured: string[]): Promise<EffectiveProjects> {
	// Empty config IS the wildcard (buildJql emits `project is not EMPTY`) -- nothing to validate.
	if (configured.length === 0) return Promise.resolve({ projects: [] });

	const cacheKey = configured.join(",");
	if (cache?.key === cacheKey) return cache.promise;

	const promise = (async (): Promise<EffectiveProjects> => {
		try {
			const missing: string[] = [];
			for (const key of configured) {
				if (!(await projectExists(proxy, key))) missing.push(key);
			}
			if (missing.length === 0) return { projects: configured };

			const existing = configured.filter((key) => !missing.includes(key));
			const configWarning =
				existing.length === 0
					? `Configured incident project(s) ${missing.join(", ")} do not exist on this Jira site; searched ALL projects instead. Fix ATLASSIAN_INCIDENT_PROJECTS.`
					: `Configured incident project(s) ${missing.join(", ")} do not exist on this Jira site and were ignored; searched ${existing.join(", ")}. Fix ATLASSIAN_INCIDENT_PROJECTS.`;
			log.warn({ configured, missing, effective: existing }, "ATLASSIAN_INCIDENT_PROJECTS names nonexistent projects");
			return { projects: existing, configWarning };
		} catch (error) {
			// Validation is best-effort: an upstream/auth failure must never change tool behavior.
			// Drop the cache entry so the next call retries instead of pinning the unvalidated
			// result for the process lifetime.
			const message = error instanceof Error ? error.message : String(error);
			log.warn({ configured, error: message }, "Incident-project validation failed; using configured list as-is");
			if (cache?.key === cacheKey) cache = null;
			return { projects: configured };
		}
	})();

	cache = { key: cacheKey, promise };
	return promise;
}
