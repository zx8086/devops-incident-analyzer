// agent/src/message-content-chokepoint.test.ts

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getWorkspaceRoot } from "./paths.ts";

// SIO-1222: enforcement. SIO-1217/1218 added extractTextFromContent / extractStreamDeltaText and
// converted most call sites, but nothing stopped the raw idiom from regrowing -- and it did: ten
// sites survived that round, three of them reachable with no model involvement at all (an
// attachment turn gives the last HumanMessage block-array content, built in
// apps/web/src/lib/server/agent.ts).
//
// This test fails the build when a message's `content` is read raw. It is deliberately a source
// scan rather than a lint rule: biome cannot tell a BaseMessage.content from an MCP tool result's
// content, and the MCP servers read the latter legitimately.

const ROOT = getWorkspaceRoot();

// Only the two trees that handle LangChain messages. packages/mcp-server-* is excluded
// wholesale: those read `result.content[0].text` off the MCP wire protocol, which is a
// different type with a guaranteed shape and must not be flagged.
const SCAN_ROOTS = ["packages/agent/src", "apps/web/src"];

// Raw reads of a message's content. Each pattern is the shape that produced a real bug:
//   String(x.content)          -> "[object Object]"                     (SIO-1217)
//   JSON.stringify(x.content)  -> a JSON blob shown to a user or a model (SIO-1222)
//   x.content as string        -> a lie to the type system
//
// Two details keep this precise rather than merely strict:
//   - `(?!\s*:)` skips `JSON.stringify({ content: "..." })`, an object literal with a
//     `content` KEY rather than a read of a message's content.
//   - ARGS matches the call's own argument list, tolerating ONE level of nesting. It must
//     tolerate that level so a cast like `String((m as { content: unknown }).content)` is
//     caught; it must not tolerate more, or `truncateToolOutput(JSON.stringify(v), N).content`
//     would match on a `.content` that belongs to the OUTER call's result.
// `[^()]` is a NEGATED class, so it already spans newlines -- combined with the whole-file scan
// below, a call split across lines is matched without needing an explicit `[\s\S]`.
const ARGS = String.raw`(?:[^()]|\([^()]*\))*`;
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; why: string }> = [
	{
		pattern: new RegExp(String.raw`\bString\(${ARGS}\bcontent\b(?!\s*:)`),
		why: "String() on message content yields [object Object]",
	},
	{
		pattern: new RegExp(String.raw`\bJSON\.stringify\(${ARGS}\bcontent\b(?!\s*:)`),
		why: "JSON.stringify() on message content leaks block JSON (and attachment base64)",
	},
	{ pattern: /\.content\s+as\s+string/, why: "content is not a string; cast hides the block-array case" },
];

// Per-LINE opt-out, not a per-file one: a file that legitimately reads ToolMessage content
// usually ALSO reads AIMessage content (sub-agent.ts does both), so exempting whole files
// would silently stop checking the lines that matter. Put this marker on the offending line
// or the line above it, with a reason.
const OPT_OUT = "content-ok:";

// The marker counts when it is on the line itself or anywhere in the comment block directly
// above it -- an exemption usually needs a sentence or two of justification, and requiring
// the marker on the last comment line would put it away from the explanation.
function isOptedOut(lines: string[], index: number): boolean {
	if (lines[index]?.includes(OPT_OUT)) return true;
	for (let i = index - 1; i >= 0; i--) {
		const line = lines[i]?.trimStart() ?? "";
		if (!line.startsWith("//")) return false;
		if (line.includes(OPT_OUT)) return true;
	}
	return false;
}

// The chokepoint itself is the one whole-file exemption -- it is the implementation.
const ALLOWED = new Set(["packages/agent/src/message-utils.ts"]);

// Scans WHOLE-file text rather than line by line: a per-line scan misses
// `String(\n  msg.content\n)`, and a formatter can produce that split at any time. Extracted so
// the opt-out and line-attribution behaviour can be tested against synthetic sources instead of
// only against whatever happens to be in the tree.
function scanText(rel: string, text: string): string[] {
	const found: string[] = [];
	const lines = text.split("\n");
	for (const { pattern, why } of FORBIDDEN) {
		const rx = new RegExp(pattern.source, "gm");
		for (const match of text.matchAll(rx)) {
			const index = match.index ?? 0;
			// Anchor the line number on the `content` token, NOT on match.index. For a call split
			// across lines match.index points at `String(` / `JSON.stringify(`, so an opt-out marker
			// beside `message.content` would be ignored and a commented-out `.content` on a later
			// line could be reported. lastIndexOf is right for all three patterns: two end at the
			// `content` token, and `.content as string` starts with it.
			const contentOffset = Math.max(0, match[0].lastIndexOf("content"));
			const lineNo = text.slice(0, index + contentOffset).split("\n").length - 1;
			const line = lines[lineNo] ?? "";
			if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
			if (isOptedOut(lines, lineNo)) continue;
			found.push(`${rel}:${lineNo + 1}  ${why}\n    ${match[0].replace(/\s+/g, " ").trim()}`);
		}
	}
	return found;
}

function walk(dir: string, out: string[] = []): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry === "node_modules" || entry === ".svelte-kit" || entry.startsWith(".")) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			walk(full, out);
		} else if (/\.(ts|svelte)$/.test(entry) && !entry.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out;
}

describe("message content must go through message-utils", () => {
	const files = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, r)));

	test("the scan actually found source files", () => {
		// Guards against a silently-passing test if a path moves.
		expect(files.length).toBeGreaterThan(100);
	});

	test("no source file reads a message's content raw", () => {
		const violations = files.flatMap((file) => {
			const rel = relative(ROOT, file);
			return ALLOWED.has(rel) ? [] : scanText(rel, readFileSync(file, "utf-8"));
		});
		expect(
			violations,
			`Read message content via extractTextFromContent (complete messages) or extractStreamDeltaText\n` +
				`(streaming deltas) from packages/agent/src/message-utils.ts instead.\n` +
				`If the value is genuinely NOT a LangChain message (e.g. an MCP ToolMessage result), add\n` +
				`"// ${OPT_OUT} <reason>" on the line or the line above it.\n\n` +
				violations.join("\n\n"),
		).toEqual([]);
	});

	// SIO-1222 review: line attribution on a SPLIT call. match.index lands on `String(`, so
	// anchoring there made an opt-out beside `message.content` invisible and let a commented-out
	// `.content` further down be reported. These pin both directions.
	describe("line attribution on a call split across lines", () => {
		test("reports the line holding .content, not the line holding String(", () => {
			const src = ["const a = 1;", "const text = String(", "\tmessage.content,", ");"].join("\n");
			const found = scanText("synthetic.ts", src);
			expect(found).toHaveLength(1);
			// `message.content` is on line 3, `String(` on line 2.
			expect(found[0]).toContain("synthetic.ts:3");
		});

		test("honours an opt-out marker on the .content line of a split call", () => {
			const src = [
				"const text = String(",
				"\t// content-ok: ToolMessage body, not an AIMessage",
				"\tmessage.content,",
				");",
			].join("\n");
			expect(scanText("synthetic.ts", src)).toEqual([]);
		});

		test("still ignores a commented-out .content read", () => {
			const src = ["// const text = String(message.content);", "const ok = 1;"].join("\n");
			expect(scanText("synthetic.ts", src)).toEqual([]);
		});

		test("flags a split JSON.stringify on its .content line", () => {
			const src = ["const t = JSON.stringify(", "\tlastMessage.content,", ");"].join("\n");
			const found = scanText("synthetic.ts", src);
			expect(found).toHaveLength(1);
			expect(found[0]).toContain("synthetic.ts:2");
		});
	});

	// The scan is only worth having if it actually catches the shapes that shipped as bugs.
	test("the patterns match the real historical violations", () => {
		const historical = [
			'const query = lastMessage ? String((lastMessage as { content: unknown }).content ?? "") : "";',
			'if (m?.getType() === "human") return typeof m.content === "string" ? m.content : JSON.stringify(m.content);',
			'return typeof m.content === "string" ? m.content : JSON.stringify(m.content);',
			"const text = String(response.content);",
			"const answer = msg.content as string;",
			// SIO-1222 review: a formatter can split a long call across lines at any time. The
			// per-line scan this replaced would have missed exactly this shape.
			"const text = String(\n\tmessage.content,\n);",
			"const t = JSON.stringify(\n\tlastMessage.content,\n);",
		];
		for (const line of historical) {
			expect(
				FORBIDDEN.some(({ pattern }) => pattern.test(line)),
				`should have been flagged: ${line}`,
			).toBe(true);
		}
	});

	// ...and only those. A false positive on an MCP tool result would make the test useless.
	test("the patterns do not flag legitimate non-message reads", () => {
		const legitimate = [
			"const text = result.content[0].text;",
			"const answer = extractTextFromContent(response.content);",
			'const body = JSON.stringify({ content: "hello" });',
			"return String(error);",
			"const n = String(count);",
			// The `.content` belongs to truncateToolOutput's RESULT, not to stringify's argument.
			// This is the shape from absence-judge.ts's evidence digest.
			"const s = truncateToolOutput(JSON.stringify(value), CAP).content;",
		];
		for (const line of legitimate) {
			expect(
				FORBIDDEN.some(({ pattern }) => pattern.test(line)),
				`false positive on: ${line}`,
			).toBe(false);
		}
	});
});
