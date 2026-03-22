<script lang="ts">
import Icon from "./Icon.svelte";

let {
	onSend,
	isStreaming = false,
	onStop,
}: { onSend: (msg: string) => void; isStreaming?: boolean; onStop?: () => void } = $props();

let value = $state("");
let textarea: HTMLTextAreaElement;

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		submit();
	}
}

function submit() {
	const trimmed = value.trim();
	if (!trimmed || isStreaming) return;
	onSend(trimmed);
	value = "";
	if (textarea) textarea.style.height = "auto";
}

function autoResize() {
	if (!textarea) return;
	textarea.style.height = "auto";
	textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
}
</script>

<div class="border-t border-gray-200 bg-white p-4">
  <div class="flex items-end gap-2 max-w-4xl mx-auto">
    <textarea
      bind:this={textarea}
      bind:value
      oninput={autoResize}
      onkeydown={handleKeydown}
      placeholder="Describe the incident or ask a question..."
      rows="1"
      disabled={isStreaming}
      class="flex-1 resize-none rounded-lg border border-gray-300 px-4 py-3 text-sm focus:border-tommy-accent-blue focus:outline-none focus:ring-1 focus:ring-tommy-accent-blue disabled:opacity-50"
    ></textarea>
    {#if isStreaming}
      <button onclick={onStop} class="rounded-lg bg-tommy-red p-3 text-white hover:bg-red-600 transition-colors">
        <Icon name="stop" size={18} />
      </button>
    {:else}
      <button onclick={submit} disabled={!value.trim()} class="rounded-lg bg-tommy-navy p-3 text-white hover:bg-tommy-dark-navy transition-colors disabled:opacity-30">
        <Icon name="send" size={18} />
      </button>
    {/if}
  </div>
</div>
