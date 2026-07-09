// apps/web/src/lib/markdown.test.ts
// SIO-1042: pure TS tests, no Svelte render needed.
//
// Bun has no DOM (no `window`/`document`), so DOMPurify.isSupported is false here and
// renderMarkdown falls back to unsanitized marked output (see the isSupported guard in
// markdown.ts) -- there is no DOM shim dependency available to this package (only `dompurify`
// itself is an approved new dependency). These tests therefore lock in the escape-AT-SOURCE
// defenses in the custom renderer (codespan/link/table), which hold regardless of DOMPurify and
// are real fixes for XSS vectors that existed before this change. Full post-DOMPurify
// XSS-inertness (script tags, event-handler attrs, javascript: URIs neutralized by the sanitizer
// itself) can only be exercised in a real browser -- verified manually per the WS3 acceptance
// criteria, not asserted here.
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown.ts";

describe("renderMarkdown escape-at-source defenses", () => {
	test("escapes an XSS payload injected via inline codespan (no live tag/attribute)", () => {
		// Renderer.codespan previously interpolated raw text -- live XSS via inline code.
		// Fixed by escaping at source: the payload must render as inert TEXT, not a live tag.
		const html = renderMarkdown("`<img src=x onerror=alert(1)>`");
		expect(html).not.toContain("<img src=x onerror=alert(1)>");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});

	test("escapes HTML metacharacters in codespan text generally", () => {
		const html = renderMarkdown("`<script>alert(1)</script>`");
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
	});

	test("escapes href and title attributes on markdown links", () => {
		const html = renderMarkdown('[x](https://example.com/"><script>alert(1)</script> "t\'"le)');
		expect(html).not.toContain('"><script>');
	});

	test("preserves target=_blank and rel=noopener noreferrer on links", () => {
		const html = renderMarkdown("[safe link](https://example.com)");
		expect(html).toContain('target="_blank"');
		expect(html).toContain("noopener");
		expect(html).toContain("noreferrer");
		expect(html).toContain('href="https://example.com"');
	});

	test("renders plain text unchanged in substance", () => {
		const html = renderMarkdown("Hello **world**");
		expect(html).toContain("Hello");
		expect(html).toContain("<strong>world</strong>");
	});

	test("renders a fenced code block with syntax highlighting classes", () => {
		const html = renderMarkdown('```json\n{"a": 1}\n```');
		expect(html).toContain("hljs");
	});

	test("renders inline code as escaped text", () => {
		const html = renderMarkdown("`plain code`");
		expect(html).toContain("inline-code");
		expect(html).toContain("plain code");
	});

	test("renders a table with only left|center|right align values (allowlist)", () => {
		const html = renderMarkdown("| A | B |\n| :-- | :-: |\n| 1 | 2 |");
		expect(html).toContain("markdown-table");
		expect(html).toContain("text-align:left");
		expect(html).toContain("text-align:center");
	});

	test("does not throw when DOMPurify has no DOM available (SSR/test guard)", () => {
		// This is the exact path ChatMessage.test.ts exercises via svelte/server SSR rendering --
		// must not crash with "DOMPurify.sanitize is not a function".
		expect(() => renderMarkdown("<script>alert(1)</script>")).not.toThrow();
	});
});
