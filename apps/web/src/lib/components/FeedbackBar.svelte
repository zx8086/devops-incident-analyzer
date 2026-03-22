<script lang="ts">
import Icon from "./Icon.svelte";

let {
	feedback,
	content,
	onFeedback,
}: {
	feedback?: "up" | "down" | null;
	content: string;
	onFeedback: (score: "up" | "down") => void;
} = $props();

let copied = $state(false);

async function copyContent() {
	await navigator.clipboard.writeText(content);
	copied = true;
	setTimeout(() => (copied = false), 2000);
}
</script>

<div class="flex items-center gap-2 mt-2 text-gray-400">
  <button onclick={copyContent} class="p-1 hover:text-gray-600 transition-colors" title="Copy response">
    {#if copied}
      <span class="text-xs text-green-600">Copied</span>
    {:else}
      <Icon name="copy" size={14} />
    {/if}
  </button>

  <span class="text-gray-300">|</span>
  <span class="text-xs">Helpful?</span>

  <button
    onclick={() => onFeedback("up")}
    class="p-1 transition-colors {feedback === 'up' ? 'text-green-600' : 'hover:text-gray-600'}"
  >
    <Icon name="thumbs-up" size={14} />
  </button>

  <button
    onclick={() => onFeedback("down")}
    class="p-1 transition-colors {feedback === 'down' ? 'text-red-600' : 'hover:text-gray-600'}"
  >
    <Icon name="thumbs-down" size={14} />
  </button>
</div>
