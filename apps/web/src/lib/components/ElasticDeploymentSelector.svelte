<script lang="ts">
// SIO-649: Target Elastic Deployments sub-selector. Renders only when the parent has
// populated deployments (empty list hides the whole selector for single-deployment setups).
let {
	deployments,
	selected = $bindable([]),
}: {
	deployments: string[];
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
	selected = [...deployments];
}

function selectNone() {
	selected = [];
}
</script>

{#if deployments.length > 0}
  <div class="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b border-gray-200">
    <span class="text-xs font-medium text-gray-500">Target Elastic Deployments:</span>
    <div class="flex gap-1.5 flex-wrap">
      {#each deployments as id}
        <button
          onclick={() => toggle(id)}
          class="px-2.5 py-1 rounded-full text-xs font-medium transition-colors
            {selected.includes(id)
              ? 'bg-tommy-accent-blue text-white'
              : 'bg-white text-gray-600 border border-gray-300 hover:border-tommy-accent-blue'
            }"
          title={id}
        >
          {id}
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
