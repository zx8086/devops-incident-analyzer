<script lang="ts">
// apps/web/src/lib/components/FeedbackBar.svelte
import Icon from "./Icon.svelte";

let {
	content,
	feedback = null,
	onFeedback,
}: {
	content: string;
	feedback?: "up" | "down" | null;
	onFeedback: (value: "up" | "down") => void;
} = $props();

let copied = $state(false);

async function handleCopy() {
	try {
		await navigator.clipboard.writeText(content);
		copied = true;
		setTimeout(() => {
			copied = false;
		}, 2000);
	} catch {
		// clipboard API may be unavailable
	}
}
</script>

<div class="flex items-center gap-2 mt-3 p-2 bg-white border border-gray-200 rounded-lg shadow-sm animate-fade-in">
  <button
    onclick={handleCopy}
    class="flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors {copied ? 'text-green-600 bg-green-50' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}"
  >
    <Icon name="copy" class="w-3 h-3" />
    {copied ? "Copied" : "Copy"}
  </button>

  <div class="w-px h-4 bg-gray-200"></div>

  <span class="text-[0.625rem] text-gray-400">Helpful?</span>

  <button
    onclick={() => onFeedback("up")}
    class="p-1 rounded transition-colors {feedback === 'up' ? 'bg-green-100 text-green-600' : 'text-gray-400 hover:text-green-600 hover:bg-green-50'}"
    aria-label="Helpful"
  >
    <Icon name="thumbs-up" class="w-3.5 h-3.5" />
  </button>

  <button
    onclick={() => onFeedback("down")}
    class="p-1 rounded transition-colors {feedback === 'down' ? 'bg-red-100 text-red-600' : 'text-gray-400 hover:text-red-600 hover:bg-red-50'}"
    aria-label="Not helpful"
  >
    <Icon name="thumbs-down" class="w-3.5 h-3.5" />
  </button>
</div>
