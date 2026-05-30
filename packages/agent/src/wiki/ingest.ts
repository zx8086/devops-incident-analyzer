// agent/src/wiki/ingest.ts
//
// LLM Wiki ingest path (EPIC 2 / SIO-847). Produces a file-diff PROPOSAL for a
// new or updated wiki page plus the index.md/log.md deltas. It never writes the
// working tree: the proposal is handed to the EPIC 1 PR flow for human review.

import { stringify } from "yaml";
import type { WikiFrontmatter } from "./page.ts";

export interface WikiFileProposal {
	// Path relative to the agent dir, e.g. "memory/wiki/pages/kafka-lag.md".
	path: string;
	contents: string;
}

export interface WikiUpdateInput {
	slug: string;
	title: string;
	// Compiled prose body (may contain [[wiki-links]]).
	body: string;
	sources: string[];
	related?: string[];
	// Current index.md / log.md contents, if they exist, to append to.
	currentIndexMd?: string;
	currentLogMd?: string;
	// One-line summary for the index catalog.
	summary: string;
	// Injectable for deterministic tests; defaults to now.
	now?: Date;
}

function renderPage(input: WikiUpdateInput, iso: string): string {
	const frontmatter: WikiFrontmatter = {
		sources: input.sources,
		...(input.related && input.related.length > 0 ? { related: input.related } : {}),
		updated: iso,
	};
	// stringify emits trailing newline; trim then re-wrap in the --- fences.
	const fm = stringify(frontmatter).trimEnd();
	return `---\n${fm}\n---\n\n# ${input.title}\n\n${input.body.trim()}\n`;
}

function upsertIndexEntry(currentIndexMd: string | undefined, slug: string, summary: string): string {
	const header = "# Wiki Index\n";
	const entry = `- [[${slug}]] -- ${summary}`;
	if (!currentIndexMd || currentIndexMd.trim() === "") {
		return `${header}\n${entry}\n`;
	}
	// Replace an existing line for this slug, else append.
	const lines = currentIndexMd.split("\n");
	const idx = lines.findIndex((l) => l.includes(`[[${slug}]]`));
	if (idx >= 0) {
		lines[idx] = entry;
		return lines.join("\n");
	}
	const trimmed = currentIndexMd.replace(/\n+$/, "");
	return `${trimmed}\n${entry}\n`;
}

function appendLogEntry(currentLogMd: string | undefined, slug: string, iso: string): string {
	const header = "# Wiki Log\n";
	const entry = `- ${iso} ingested/updated [[${slug}]]`;
	if (!currentLogMd || currentLogMd.trim() === "") {
		return `${header}\n${entry}\n`;
	}
	const trimmed = currentLogMd.replace(/\n+$/, "");
	return `${trimmed}\n${entry}\n`;
}

// Builds the set of file proposals for ingesting/updating one wiki page. Returns
// the page, the updated index, and the appended log -- all as proposals, never
// writes. The caller (EPIC 1) stages these on a branch and opens a PR.
export function proposeWikiUpdate(input: WikiUpdateInput): WikiFileProposal[] {
	const iso = (input.now ?? new Date()).toISOString();
	return [
		{ path: `memory/wiki/pages/${input.slug}.md`, contents: renderPage(input, iso) },
		{ path: "memory/wiki/index.md", contents: upsertIndexEntry(input.currentIndexMd, input.slug, input.summary) },
		{ path: "memory/wiki/log.md", contents: appendLogEntry(input.currentLogMd, input.slug, iso) },
	];
}
