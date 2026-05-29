<script lang="ts">
// SIO-836: Target AWS Estates sub-selector. Renders only when the parent has populated
// estates (empty list hides the whole selector). Mirrors ElasticDeploymentSelector; the
// region badge is display-only -- only the estate id is added to `selected`.
let {
	estates,
	selected = $bindable([]),
}: {
	estates: { id: string; region: string }[];
	selected: string[];
} = $props();

function toggle(id: string) {
	if (selected.includes(id)) {
		selected = selected.filter((s) => s !== id);
	} else {
		selected = [...selected, id];
	}
}

function selectAll() {
	selected = estates.map((e) => e.id);
}

function selectNone() {
	selected = [];
}
</script>

{#if estates.length > 0}
  <div class="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b border-gray-200">
    <span class="text-xs font-medium text-gray-500">Target AWS Estates:</span>
    <div class="flex gap-1.5 flex-wrap">
      {#each estates as estate}
        <button
          onclick={() => toggle(estate.id)}
          class="px-2.5 py-1 rounded-full text-xs font-medium transition-colors
            {selected.includes(estate.id)
              ? 'bg-tommy-accent-blue text-white'
              : 'bg-white text-gray-600 border border-gray-300 hover:border-tommy-accent-blue'
            }"
          title={estate.region ? `${estate.id} (${estate.region})` : estate.id}
        >
          {estate.id}{#if estate.region}<span class="ml-1 text-[10px] opacity-70">{estate.region}</span>{/if}
        </button>
      {/each}
    </div>
    <div class="flex gap-1 ml-auto">
      <button onclick={selectAll} class="text-[10px] text-gray-400 hover:text-gray-600">All</button>
      <span class="text-gray-300">|</span>
      <button onclick={selectNone} class="text-[10px] text-gray-400 hover:text-gray-600">None</button>
    </div>
  </div>
{/if}
