<script lang="ts">
  import { marked } from "marked";

  let { content }: { content: string } = $props();

  const rendered = $derived(marked.parse(content, { async: false }) as string);
</script>

<div class="markdown-content">
  {@html rendered}
</div>

<style>
  .markdown-content :global(h1) { font-size: 1.5rem; font-weight: 600; margin: 1rem 0 0.5rem; }
  .markdown-content :global(h2) { font-size: 1.25rem; font-weight: 600; margin: 1rem 0 0.5rem; }
  .markdown-content :global(h3) { font-size: 1.1rem; font-weight: 600; margin: 0.75rem 0 0.25rem; }
  .markdown-content :global(p) { margin: 0.5rem 0; line-height: 1.6; }
  .markdown-content :global(ul), .markdown-content :global(ol) { margin: 0.5rem 0; padding-left: 1.5rem; }
  .markdown-content :global(li) { margin: 0.25rem 0; }
  .markdown-content :global(code) { background: #f3f4f6; padding: 0.125rem 0.375rem; border-radius: 0.25rem; font-size: 0.875rem; }
  .markdown-content :global(pre) { background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 0.5rem; overflow-x: auto; margin: 0.75rem 0; }
  .markdown-content :global(pre code) { background: none; padding: 0; color: inherit; }
  .markdown-content :global(table) { width: 100%; border-collapse: collapse; margin: 0.75rem 0; font-size: 0.875rem; }
  .markdown-content :global(th) { background: #f9fafb; padding: 0.5rem; text-align: left; border-bottom: 2px solid #e5e7eb; font-weight: 600; }
  .markdown-content :global(td) { padding: 0.5rem; border-bottom: 1px solid #e5e7eb; }
  .markdown-content :global(blockquote) { border-left: 3px solid #d1d5db; padding-left: 1rem; margin: 0.75rem 0; color: #6b7280; }
  .markdown-content :global(strong) { font-weight: 600; }
</style>
