// apps/web/src/lib/markdown.ts

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import DOMPurify from "isomorphic-dompurify";
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

// SIO-1042 assumed markdown was always client-born from SSE state, so plain `dompurify` with a
// browser-only guard was enough -- outside a browser `sanitize` is undefined and the guard fell
// through to RAW html. SIO-1709 met the upgrade condition that comment named: the fleet pane
// server-renders spoke replies, which are agent-authored text about production AWS accounts, so
// an unsanitized SSR path is now reachable by untrusted input (an agent echoing a hostile log
// line or resource tag). isomorphic-dompurify sanitizes in BOTH environments, so there is no
// environment-dependent branch left to get wrong.
export function renderMarkdown(content: string): string {
	const raw = marked.parse(content) as string;
	return DOMPurify.sanitize(raw, { ADD_ATTR: ["target"] });
}
