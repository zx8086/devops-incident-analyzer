<script lang="ts">
// apps/web/src/lib/components/MarkdownRenderer.svelte

import { renderMarkdown } from "$lib/markdown.ts";

let { content }: { content: string } = $props();

// SIO-1042: $derived can't be throttled, so this is $state seeded with a leading-edge parse
// (correct first paint for static consumers -- a cheap "" parse at SSR) plus a trailing-edge
// throttle for streaming updates. Caps re-parses at ~8/s during token-by-token SSE streaming.
// The initial-value-only capture the compiler warns about is intentional: the $effect below
// owns every subsequent update.
// svelte-ignore state_referenced_locally
let html = $state(renderMarkdown(content));
const THROTTLE_MS = 120;
let lastRun = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

$effect(() => {
	void content; // dependency registration
	const elapsed = performance.now() - lastRun;
	if (elapsed >= THROTTLE_MS) {
		html = renderMarkdown(content);
		lastRun = performance.now();
	} else if (timer === null) {
		// Trailing-edge: reads the latest `content` at fire time so the final streamed token is
		// never dropped even if several updates land inside one throttle window.
		timer = setTimeout(() => {
			timer = null;
			html = renderMarkdown(content);
			lastRun = performance.now();
		}, THROTTLE_MS - elapsed);
	}
});

$effect(() => () => {
	if (timer !== null) clearTimeout(timer);
});

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
  /* SIO-1717: consecutive items sat flush, so a long bulleted report (a fleet
     daily digest runs to a dozen findings) read as a wall of text. Spacing
     BETWEEN items only -- a margin on every li would also pad the first and
     last, growing every single-item list for nothing. */
  .markdown-content :global(li) {
    line-height: 1.6;
  }
  .markdown-content :global(li + li) {
    margin-top: 0.3rem;
  }
  /* SIO-1722: inside a digest body the findings are a LIST OF SEPARATE EVENTS,
     not prose bullets -- each one is a distinct resource with its own severity.
     A hairline between siblings gives the eye a row boundary to land on, which
     the severity badge then colours. Scoped to .digest-body (set by PiFleetPane
     on the anchor row only) so ordinary markdown lists are untouched. */
  :global(.digest-body) .markdown-content :global(li + li) {
    margin-top: 0.4rem;
    padding-top: 0.4rem;
    border-top: 1px solid rgb(0 0 0 / 0.06);
  }
  :global(.digest-body) .markdown-content :global(li > ul > li + li),
  :global(.digest-body) .markdown-content :global(li > ol > li + li) {
    border-top-color: rgb(0 0 0 / 0.04);
  }
  /* A finding row carries a severity badge, which already reads as the row
     marker -- the disc next to it was a second bullet saying the same thing.
     Dropped, and the freed indent becomes a HANGING indent: a wrapped finding
     (resource names run 50+ chars, so most wrap) used to start back under the
     badge, which made one finding look like two. */
  :global(.digest-body) .markdown-content :global(li > ul),
  :global(.digest-body) .markdown-content :global(li > ol) {
    list-style: none;
    margin-left: 0.25rem;
  }
  /* Left flush, and deliberately NO hanging indent. Two techniques were tried
     and both made it worse: a negative `text-indent` shifts the badge itself
     (an inline-block) off the left edge and clips it, and `display:flex` makes
     the prose its own flex item, so every finding broke onto a second line
     under an otherwise empty badge row. The hairline above already marks where
     a row starts, so a wrapped line needs no second cue. */
  :global(.digest-body) .markdown-content :global(li > ul > li),
  :global(.digest-body) .markdown-content :global(li > ol > li) {
    padding-left: 0;
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
