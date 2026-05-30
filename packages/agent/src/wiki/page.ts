// agent/src/wiki/page.ts
//
// LLM Wiki (EPIC 2 / SIO-847) page model + parsing. A compiled wiki page lives
// at memory/wiki/pages/<slug>.md with YAML frontmatter
//   { sources: [knowledge/...], related: [<slug>...], updated: ISO } and a body
// that cross-references other pages via [[wiki-links]].

import { parse } from "yaml";
import { z } from "zod";

export const WikiFrontmatterSchema = z
	.object({
		sources: z.array(z.string()).optional(),
		related: z.array(z.string()).optional(),
		updated: z.string().optional(),
	})
	.strict();
export type WikiFrontmatter = z.infer<typeof WikiFrontmatterSchema>;

export interface WikiPage {
	slug: string;
	frontmatter: WikiFrontmatter;
	body: string;
	// Slugs referenced via [[...]] in the body.
	links: string[];
	// True when no frontmatter block was present (lint flags this).
	hasFrontmatter: boolean;
}

// Extracts [[wiki-link]] slugs from a body. A link target may include a display
// alias ([[slug|Display]]); only the slug (before |) is returned.
export function extractWikiLinks(body: string): string[] {
	const links: string[] = [];
	const re = /\[\[([^\]]+)\]\]/g;
	let match: RegExpExecArray | null = re.exec(body);
	while (match !== null) {
		const raw = (match[1] ?? "").trim();
		const slug = (raw.split("|")[0] ?? "").trim();
		if (slug) links.push(slug);
		match = re.exec(body);
	}
	return links;
}

function slugFromFilename(filename: string): string {
	return filename.replace(/\.md$/, "");
}

// Parses a single wiki page's raw content. Frontmatter is optional; when present
// it must be a valid WikiFrontmatter (strict) or this throws with the slug.
export function parseWikiPage(filename: string, content: string): WikiPage {
	const slug = slugFromFilename(filename);
	const hasFm = content.startsWith("---\n") || content.startsWith("---\r\n");
	if (!hasFm) {
		return { slug, frontmatter: {}, body: content, links: extractWikiLinks(content), hasFrontmatter: false };
	}

	const afterOpening = content.indexOf("\n") + 1;
	const closingMatch = content.slice(afterOpening).match(/^---\r?\n?/m);
	if (!closingMatch || closingMatch.index === undefined) {
		throw new Error(`Wiki page ${filename}: frontmatter missing closing --- delimiter`);
	}
	const fmYaml = content.slice(afterOpening, afterOpening + closingMatch.index);
	const body = content.slice(afterOpening + closingMatch.index + closingMatch[0].length);

	let frontmatter: WikiFrontmatter;
	try {
		frontmatter = WikiFrontmatterSchema.parse(parse(fmYaml) ?? {});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Wiki page ${filename}: invalid frontmatter: ${message}`);
	}

	return { slug, frontmatter, body, links: extractWikiLinks(body), hasFrontmatter: true };
}
