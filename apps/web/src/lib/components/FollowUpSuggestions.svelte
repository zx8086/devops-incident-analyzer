<script lang="ts">
  import Icon from "./Icon.svelte";

  let { suggestions, onSelect }: {
    suggestions: string[];
    onSelect: (s: string) => void;
  } = $props();
</script>

{#if suggestions.length > 0}
  <div class="mt-3 p-3 rounded-lg bg-gradient-to-r from-tommy-cream to-tommy-offwhite border border-gray-200 animate-fade-slide-up">
    <div class="flex items-center gap-1.5 mb-2 text-xs font-medium text-gray-600">
      <Icon name="lightbulb" size={14} />
      <span>Suggested follow-ups</span>
    </div>
    <div class="grid gap-1.5">
      {#each suggestions as suggestion, i}
        <button
          onclick={() => onSelect(suggestion)}
          class="text-left px-3 py-2 rounded-lg text-sm text-gray-700 bg-white border border-gray-200 hover:border-tommy-accent-blue hover:bg-blue-50 transition-all animate-cascade-in animation-delay-{(i + 1) * 75}"
        >
          {suggestion}
        </button>
      {/each}
    </div>
  </div>
{/if}
