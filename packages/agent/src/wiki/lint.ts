// agent/src/wiki/lint.ts
//
// LLM Wiki integrity linter (EPIC 2 / SIO-847). Pure and CI-friendly: validates
// the compiled wiki under memory/wiki/ for dead [[links]], orphan pages (not in
// index.md), missing frontmatter, and stale `updated` vs source mtime. Used by
// the wiki-lint skill and a root `wiki:lint` script.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseWikiPage, type WikiPage } from "./page.ts";

export interface WikiLintIssue {
	slug: string;
	kind: "dead_link" | "orphan" | "missing_frontmatter" | "stale_source" | "missing_source";
	detail: string;
}

export interface WikiLintResult {
	ok: boolean;
	issues: WikiLintIssue[];
	pageCount: number;
}

export interface WikiLintInput {
	// Absolute paths to memory/wiki/pages/*.md
	pagePaths: string[];
	// Raw memory/wiki/index.md content (for orphan detection), if present.
	indexMd?: string;
	// Base dir for resolving frontmatter `sources` paths (agent-relative, e.g.
	// "knowledge/..."). When omitted, source freshness/existence checks are skipped.
	sourceRoot?: string;
}

function loadPages(pagePaths: string[]): WikiPage[] {
	const pages: WikiPage[] = [];
	for (const path of pagePaths) {
		if (!existsSync(path)) continue;
		pages.push(parseWikiPage(basename(path), readFileSync(path, "utf-8")));
	}
	return pages;
}

export function lintWiki(input: WikiLintInput): WikiLintResult {
	const pages = loadPages(input.pagePaths);
	const slugs = new Set(pages.map((p) => p.slug));
	const issues: WikiLintIssue[] = [];

	for (const page of pages) {
		if (!page.hasFrontmatter) {
			issues.push({ slug: page.slug, kind: "missing_frontmatter", detail: "page has no frontmatter block" });
		}

		// Dead links: a [[target]] that is not an existing page slug.
		for (const link of page.links) {
			if (!slugs.has(link)) {
				issues.push({ slug: page.slug, kind: "dead_link", detail: `[[${link}]] has no matching page` });
			}
		}

		// Orphan: a page never referenced from index.md.
		if (input.indexMd !== undefined && !input.indexMd.includes(page.slug)) {
			issues.push({ slug: page.slug, kind: "orphan", detail: "page is not listed in index.md" });
		}

		// Source freshness: each declared source must exist; if a page declares an
		// `updated` timestamp older than the source's mtime, it is stale.
		if (input.sourceRoot) {
			for (const source of page.frontmatter.sources ?? []) {
				const sourcePath = join(input.sourceRoot, source);
				if (!existsSync(sourcePath)) {
					issues.push({ slug: page.slug, kind: "missing_source", detail: `source not found: ${source}` });
					continue;
				}
				const updated = page.frontmatter.updated ? Date.parse(page.frontmatter.updated) : Number.NaN;
				if (!Number.isNaN(updated)) {
					const sourceMtime = statSync(sourcePath).mtimeMs;
					if (sourceMtime > updated) {
						issues.push({
							slug: page.slug,
							kind: "stale_source",
							detail: `source ${source} changed after page's updated=${page.frontmatter.updated}`,
						});
					}
				}
			}
		}
	}

	return { ok: issues.length === 0, issues, pageCount: pages.length };
}

// Formats a lint result for human/CI output.
export function formatWikiLint(result: WikiLintResult): string {
	if (result.ok) return `Wiki OK: ${result.pageCount} page(s), no issues.`;
	const lines = [`Wiki lint found ${result.issues.length} issue(s) across ${result.pageCount} page(s):`];
	for (const issue of result.issues) {
		lines.push(`  [${issue.kind}] ${issue.slug}: ${issue.detail}`);
	}
	return lines.join("\n");
}
