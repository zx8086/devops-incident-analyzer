// apps/web/src/lib/markdown.ts
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import { Marked, Renderer } from "marked";

hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("yaml", yaml);

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const renderer = new Renderer();

renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
	let highlighted: string;
	if (lang) {
		try {
			highlighted = hljs.highlight(text, { language: lang }).value;
		} catch {
			highlighted = escapeHtml(text);
		}
	} else {
		highlighted = escapeHtml(text);
	}
	return `<pre class="hljs"><code class="language-${lang ?? ""}">${highlighted}</code></pre>`;
};

// SIO-1042: previously interpolated raw text here -- live XSS via inline code (DOMPurify is a
// backstop for the rest of the pipeline, but escaping at source keeps this renderer safe standalone).
renderer.codespan = ({ text }: { text: string }) => {
	return `<code class="inline-code">${escapeAttr(text)}</code>`;
};

renderer.link = ({ href, title, text }: { href: string; title?: string | null; text: string }) => {
	const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
	return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
};

renderer.table = ({
	header,
	rows,
}: {
	header: { text: string; align: string | null }[];
	rows: { text: string; align: string | null }[][];
}) => {
	const alignStyle = (align: string | null) =>
		align === "left" || align === "center" || align === "right" ? ` style="text-align:${align}"` : "";
	let out = '<div class="table-container"><table class="markdown-table"><thead><tr>';
	for (const cell of header) {
		out += `<th${alignStyle(cell.align)}>${cell.text}</th>`;
	}
	out += "</tr></thead><tbody>";
	for (const row of rows) {
		out += "<tr>";
		for (const cell of row) {
			out += `<td${alignStyle(cell.align)}>${cell.text}</td>`;
		}
		out += "</tr>";
	}
	out += "</tbody></table></div>";
	return out;
};

const marked = new Marked({ renderer, breaks: true });

// SIO-1042: markdown is always client-born from SSE state ($state([]) start), so sanitization
// only needs to run in the browser. Plain `dompurify` (not isomorphic-dompurify) has no `window`
// in SSR/tests -- DOMPurify.isSupported is false there and `sanitize` is literally undefined
// (NOT a graceful pass-through), so guard explicitly rather than call it unconditionally. This is
// safe because MarkdownRenderer's {@html html} only ever reaches a real DOM in the browser; SSR
// output for this content is not what ships to users. Upgrade to isomorphic-dompurify only if
// server-rendered markdown ever needs to be sanitized before reaching a client.
export function renderMarkdown(content: string): string {
	const raw = marked.parse(content) as string;
	return DOMPurify.isSupported ? DOMPurify.sanitize(raw, { ADD_ATTR: ["target"] }) : raw;
}
