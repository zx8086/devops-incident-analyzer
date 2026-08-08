// agent/src/iac/examples-tool.ts
//
// SIO-1450: the LOCAL agent-initiated examples-lookup tool for elastic-iac. Unlike
// knowledge/runbooks (always-on, graph-selected via runbook_selection), this is a tool the
// LLM calls itself -- mid-turn, after a tool error or when unsure how to structure a
// multi-step query -- so it costs one line in the prompt (name + description) instead of an
// always-loaded section. Matching is a plain keyword/substring pass over on-disk markdown
// files (no vector store -- volume is small and this doesn't need semantic search).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tool as createTool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { getAgentsDir } from "../paths.ts";

export const LOOKUP_EXAMPLES_TOOL = "lookup_examples";

const MAX_MATCHES = 3;

const LookupExamplesSchema = z.object({
	query: z.string().describe("What you're stuck on, e.g. 'cluster health check timed out'."),
	context: z
		.enum(["tool_error", "query_structure", "general"])
		.optional()
		.describe("Optional hint: why you're looking this up."),
});

type LookupExamplesArgs = z.infer<typeof LookupExamplesSchema>;

interface ParsedExample {
	heading: string;
	tags: string[];
	body: string;
}

// Each example file is a heading line, an optional "Tags: a, b, c" line (standard markdown
// spacing -- possibly separated from the heading by blank lines), then a free-text body. No
// frontmatter -- these are read by this keyword matcher, not the OKF knowledge loader, so
// there's no selection/trigger contract to satisfy.
function parseExample(content: string): ParsedExample {
	const lines = content.split("\n");
	const heading = (lines[0] ?? "").replace(/^#+\s*/, "").trim();
	let tags: string[] = [];
	// CodeRabbit (PR #638): only the metadata block immediately after the heading may declare
	// tags -- skip blank lines, then look at the FIRST non-blank line only. Scanning the whole
	// file (the prior findIndex-over-everything approach) let a body line that merely started
	// with "Tags:" (e.g. prose describing another file's frontmatter) be mistaken for the real
	// metadata line, silently swallowing genuine body content that preceded it.
	let bodyStart = 1;
	while (bodyStart < lines.length && lines[bodyStart]?.trim() === "") bodyStart++;
	const tagLine = lines[bodyStart]?.match(/^Tags:\s*(.+)$/i);
	if (tagLine?.[1]) {
		tags = tagLine[1].split(",").map((t) => t.trim().toLowerCase());
		bodyStart += 1;
	} else {
		bodyStart = 1;
	}
	const body = lines.slice(bodyStart).join("\n").trim();
	return { heading, tags, body };
}

// Common short English words that would otherwise trigger a false-positive match on nearly
// any query -- e.g. two unrelated headings both coincidentally containing "not" (SIO-1450
// regression). A curated stopword list of every such word is a losing game (there's always
// one more), so this pairs a short one with a length floor below: connective/function words
// are almost always < MIN_WORD_LENGTH characters, so the floor catches the general case and
// the list only needs to cover the handful of short words a query is likely to lead with.
const STOPWORDS = new Set(["a", "an", "the", "is", "are", "was", "were", "and", "or", "to", "of", "for", "in", "on"]);

// Below this length, a word is common enough (connectives, short function words) that a
// substring hit is more likely coincidence than signal. This is a coarse keyword matcher, not
// semantic search, so it leans on curated heading/tags plus this floor for precision rather
// than an exhaustive stopword list.
const MIN_WORD_LENGTH = 4;

// Match only against the curated heading + tags, not free body prose -- the body is
// illustrative detail, not a signal a query is expected to share words with. Matching body
// text let generic words (e.g. "question") false-positive on unrelated queries.
function matches(example: ParsedExample, query: string): boolean {
	const words = query
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length >= MIN_WORD_LENGTH && !STOPWORDS.has(w));
	const haystack = `${example.heading} ${example.tags.join(" ")}`.toLowerCase();
	return words.some((word) => haystack.includes(word));
}

const NO_MATCH_RESULT = "No matching example found.";

// Pure handler: read the agent's examples/ directory (if any), keyword-match against the
// query, return up to MAX_MATCHES blocks. Exported for tests.
export async function runExamplesLookup(agentName: string, args: LookupExamplesArgs): Promise<string> {
	const examplesDir = join(getAgentsDir(agentName), "examples");
	if (!existsSync(examplesDir)) return NO_MATCH_RESULT;

	const files = readdirSync(examplesDir).filter((f) => f.endsWith(".md"));
	const parsed = files.map((f) => parseExample(readFileSync(join(examplesDir, f), "utf-8")));
	const hits = parsed.filter((example) => matches(example, args.query)).slice(0, MAX_MATCHES);

	if (hits.length === 0) return NO_MATCH_RESULT;

	return hits.map((example) => `## ${example.heading}\n\n${example.body}`).join("\n\n");
}

export function createLookupExamplesTool(agentName: string): StructuredToolInterface {
	return createTool(async (args: unknown) => runExamplesLookup(agentName, LookupExamplesSchema.parse(args)), {
		name: LOOKUP_EXAMPLES_TOOL,
		description:
			"Look up a few-shot example of how a similar situation was resolved before. Use this after a " +
			"tool call errors, returns an empty/ambiguous result, or when you're unsure how to structure a " +
			"multi-step query. Pass a short description of what you're stuck on. Returns 0-3 matching " +
			"examples, or says explicitly that none matched -- an empty result is itself the answer, don't " +
			"retry with the same query.",
		schema: LookupExamplesSchema,
	}) as unknown as StructuredToolInterface;
}
