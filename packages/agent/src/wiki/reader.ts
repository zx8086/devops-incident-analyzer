// agent/src/wiki/reader.ts
//
// LLM Wiki read path (EPIC 2 / SIO-847). Selects the most relevant compiled
// pages for the current investigation and renders them for prompt injection.
// The wiki is a retrieval-augmented layer over the static knowledge/ base:
// knowledge/ is raw/authoritative, memory/wiki/ is compiled/cross-linked.

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { LoadedAgent } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import { parseWikiPage, type WikiPage } from "./page.ts";

const logger = getLogger("agent:wiki-reader");

// How many topic pages to inline at most (index.md is always included on top).
const MAX_PAGES = 3;

export interface WikiFocus {
	services: string[];
	datasources: string[];
}

function loadPages(agent: LoadedAgent): WikiPage[] {
	const paths = agent.memory?.wiki.pagePaths ?? [];
	const pages: WikiPage[] = [];
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			pages.push(parseWikiPage(basename(path), readFileSync(path, "utf-8")));
		} catch (err) {
			// A malformed page should not break analysis; lint surfaces it separately.
			logger.warn({ path, error: err instanceof Error ? err.message : String(err) }, "skipping unparseable wiki page");
		}
	}
	return pages;
}

// Scores a page by token overlap between the focus (services + datasources) and
// the page slug + body. Deterministic; the LLM is not consulted here.
function scorePage(page: WikiPage, focus: WikiFocus): number {
	const terms = [...focus.services, ...focus.datasources].map((t) => t.toLowerCase()).filter((t) => t.length > 0);
	if (terms.length === 0) return 0;
	const haystack = `${page.slug} ${page.body}`.toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (haystack.includes(term)) score += 1;
	}
	return score;
}

// Returns up to MAX_PAGES pages whose content overlaps the focus, best first.
// Empty focus -> no pages (the index alone carries the catalog).
export function selectWikiPages(focus: WikiFocus, agent: LoadedAgent): WikiPage[] {
	const pages = loadPages(agent);
	return pages
		.map((page) => ({ page, score: scorePage(page, focus) }))
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, MAX_PAGES)
		.map((s) => s.page);
}

// Renders the wiki section for the orchestrator prompt: the index catalog (when
// present) plus the selected pages. Empty string when nothing relevant exists.
export function buildWikiSection(focus: WikiFocus, agent: LoadedAgent): string {
	const indexMd = agent.memory?.wiki.indexMd?.trim();
	const pages = selectWikiPages(focus, agent);
	if (!indexMd && pages.length === 0) return "";

	const sections: string[] = ["\n\n---\n\n## Wiki"];
	if (indexMd) sections.push(`### Index\n\n${indexMd}`);
	for (const page of pages) {
		sections.push(`### ${page.slug}\n\n${page.body.trim()}`);
	}
	return sections.join("\n\n");
}
