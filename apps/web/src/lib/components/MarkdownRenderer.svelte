<script lang="ts">
// apps/web/src/lib/components/MarkdownRenderer.svelte

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

let { content }: { content: string } = $props();

const renderer = new Renderer();

renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
	let highlighted: string;
	if (lang) {
		try {
			highlighted = hljs.highlight(text, { language: lang }).value;
		} catch {
			highlighted = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		}
	} else {
		highlighted = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}
	return `<pre class="hljs"><code class="language-${lang ?? ""}">${highlighted}</code></pre>`;
};

renderer.codespan = ({ text }: { text: string }) => {
	return `<code class="inline-code">${text}</code>`;
};

renderer.link = ({ href, title, text }: { href: string; title?: string | null; text: string }) => {
	const titleAttr = title ? ` title="${title}"` : "";
	return `<a href="${href}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
};

renderer.table = ({
	header,
	rows,
}: {
	header: { text: string; align: string | null }[];
	rows: { text: string; align: string | null }[][];
}) => {
	const alignStyle = (align: string | null) => (align ? ` style="text-align:${align}"` : "");
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

const html = $derived(marked.parse(content) as string);

function handleClick(e: MouseEvent) {
	const target = e.target as HTMLElement;
	if (target.classList.contains("code-copy")) {
		const code = decodeURIComponent(target.dataset.code ?? "");
		navigator.clipboard.writeText(code);
		target.textContent = "Copied";
		setTimeout(() => {
			target.textContent = "Copy";
		}, 2000);
	}
}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="markdown-content" onclick={handleClick}>
  {@html html}
</div>

<style>
  .markdown-content {
    color: #111827;
    line-height: 1.6;
    font-size: 0.75rem;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .markdown-content :global(h1) {
    font-size: 1rem;
    font-weight: 700;
    margin-bottom: 0.5rem;
    margin-top: 0.75rem;
    color: #111827;
    border-bottom: 1px solid #e5e7eb;
    padding-bottom: 0.375rem;
  }
  .markdown-content :global(h2) {
    font-size: 0.875rem;
    font-weight: 600;
    margin-bottom: 0.375rem;
    margin-top: 0.75rem;
    color: #111827;
  }
  .markdown-content :global(h3) {
    font-size: 0.8125rem;
    font-weight: 600;
    margin-bottom: 0.375rem;
    margin-top: 0.625rem;
    color: #1f2937;
  }
  .markdown-content :global(h4) {
    font-size: 0.75rem;
    font-weight: 500;
    margin-bottom: 0.25rem;
    margin-top: 0.5rem;
    color: #1f2937;
  }
  .markdown-content :global(h5),
  .markdown-content :global(h6) {
    font-size: 0.75rem;
    font-weight: 500;
    margin-bottom: 0.25rem;
    margin-top: 0.5rem;
    color: #374151;
  }

  .markdown-content :global(p) {
    margin-bottom: 0.5rem;
    line-height: 1.6;
  }
  .markdown-content :global(strong) {
    font-weight: 600;
    color: #111827;
  }
  .markdown-content :global(em) {
    font-style: italic;
  }

  .markdown-content :global(ul) {
    list-style-type: disc;
    list-style-position: outside;
    margin-bottom: 0.5rem;
    margin-left: 1.25rem;
    padding-left: 0;
  }
  .markdown-content :global(ul > li) {
    margin-bottom: 0.25rem;
  }
  .markdown-content :global(ol) {
    list-style-type: decimal;
    list-style-position: outside;
    margin-bottom: 0.5rem;
    margin-left: 1.25rem;
    padding-left: 0;
  }
  .markdown-content :global(ol > li) {
    margin-bottom: 0.25rem;
  }
  .markdown-content :global(li) {
    line-height: 1.6;
  }
  .markdown-content :global(li > ul),
  .markdown-content :global(li > ol) {
    margin-top: 0.25rem;
    margin-bottom: 0;
  }

  .markdown-content :global(pre) {
    background-color: #111827;
    color: #f3f4f6;
    border-radius: 0.375rem;
    padding: 0.75rem;
    margin-bottom: 0.625rem;
    overflow-x: auto;
    max-width: 100%;
    font-family: "SF Mono", Monaco, Inconsolata, "Roboto Mono", Consolas, "Courier New", monospace;
    line-height: 1.4;
  }
  .markdown-content :global(pre code) {
    background: transparent;
    color: inherit;
    padding: 0;
    border-radius: 0;
    font-size: 0.6875rem;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .markdown-content :global(.inline-code) {
    background-color: #f3f4f6;
    color: #1f2937;
    padding: 0.125rem 0.25rem;
    border-radius: 0.1875rem;
    font-size: 0.6875rem;
    font-family: "SF Mono", Monaco, Inconsolata, "Roboto Mono", Consolas, "Courier New", monospace;
    word-break: break-word;
  }
  .markdown-content :global(code:not(pre code):not(.inline-code)) {
    background-color: #f3f4f6;
    color: #1f2937;
    padding: 0.125rem 0.25rem;
    border-radius: 0.1875rem;
    font-size: 0.6875rem;
    font-family: "SF Mono", Monaco, Inconsolata, "Roboto Mono", Consolas, "Courier New", monospace;
  }

  .markdown-content :global(.table-container) {
    overflow-x: auto;
    margin-bottom: 0.625rem;
    width: 100%;
    -webkit-overflow-scrolling: touch;
  }
  .markdown-content :global(.markdown-table) {
    min-width: 100%;
    border-collapse: collapse;
    background: white;
    border-radius: 0.375rem;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  }
  .markdown-content :global(.markdown-table th) {
    background-color: #f9fafb;
    padding: 0.25rem 0.375rem;
    text-align: left;
    font-size: 0.5rem;
    font-weight: 600;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.025em;
    border-bottom: 1px solid #e5e7eb;
    white-space: nowrap;
  }
  .markdown-content :global(.markdown-table td) {
    padding: 0.25rem 0.375rem;
    font-size: 0.5rem;
    color: #111827;
    border-bottom: 1px solid #e5e7eb;
    white-space: nowrap;
  }
  .markdown-content :global(.markdown-table tr:last-child td) {
    border-bottom: 0;
  }
  .markdown-content :global(table:not(.markdown-table)) {
    min-width: 100%;
    border-collapse: collapse;
    background: white;
    border-radius: 0.375rem;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    margin-bottom: 0.625rem;
  }
  .markdown-content :global(table:not(.markdown-table) th) {
    background-color: #f9fafb;
    padding: 0.25rem 0.375rem;
    text-align: left;
    font-size: 0.5rem;
    font-weight: 600;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.025em;
    border-bottom: 1px solid #e5e7eb;
    white-space: nowrap;
  }
  .markdown-content :global(table:not(.markdown-table) td) {
    padding: 0.25rem 0.375rem;
    font-size: 0.5rem;
    color: #111827;
    border-bottom: 1px solid #e5e7eb;
    white-space: nowrap;
  }
  .markdown-content :global(table:not(.markdown-table) tr:last-child td) {
    border-bottom: 0;
  }

  .markdown-content :global(blockquote) {
    border-left: 3px solid #3b82f6;
    padding-left: 0.75rem;
    padding-top: 0.375rem;
    padding-bottom: 0.375rem;
    margin-bottom: 0.625rem;
    background-color: #eff6ff;
    font-style: italic;
    color: #374151;
  }

  .markdown-content :global(a) {
    color: #2563eb;
    text-decoration: underline;
    transition: color 0.2s ease;
  }
  .markdown-content :global(a:hover) {
    color: #1e40af;
  }

  .markdown-content :global(hr) {
    border: 0;
    border-top: 1px solid #d1d5db;
    margin: 1rem 0;
  }

  .markdown-content :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 0.375rem;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
    margin-bottom: 0.625rem;
  }

  .markdown-content :global(.hljs) { background: #111827; color: #e6e6e6; }
  .markdown-content :global(.hljs-keyword) { color: #569cd6; }
  .markdown-content :global(.hljs-string) { color: #ce9178; }
  .markdown-content :global(.hljs-number) { color: #b5cea8; }
  .markdown-content :global(.hljs-comment) { color: #6a9955; font-style: italic; }
  .markdown-content :global(.hljs-function) { color: #dcdcaa; }
  .markdown-content :global(.hljs-class) { color: #4ec9b0; }
  .markdown-content :global(.hljs-variable) { color: #9cdcfe; }
  .markdown-content :global(.hljs-operator) { color: #d4d4d4; }
  .markdown-content :global(.hljs-built_in) { color: #4fc1ff; }
  .markdown-content :global(.hljs-type) { color: #4ec9b0; }
  .markdown-content :global(.hljs-literal) { color: #569cd6; }
  .markdown-content :global(.hljs-punctuation) { color: #d4d4d4; }

  @media (max-width: 640px) {
    .markdown-content { font-size: 0.6875rem; }
    .markdown-content :global(h1) { font-size: 0.875rem; }
    .markdown-content :global(h2) { font-size: 0.8125rem; }
    .markdown-content :global(pre) { font-size: 0.625rem; padding: 0.5rem; }
    .markdown-content :global(.markdown-table th),
    .markdown-content :global(.markdown-table td) { padding: 0.375rem 0.5rem; font-size: 0.625rem; }
  }
</style>
