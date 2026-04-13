<script lang="ts">
let {
	dataSources,
	connected = [],
	selected = $bindable([]),
}: {
	dataSources: string[];
	connected: string[];
	selected: string[];
} = $props();

const labels: Record<string, string> = {
	elastic: "Elastic",
	kafka: "Kafka",
	couchbase: "Capella",
	konnect: "Konnect",
	gitlab: "GitLab",
};

function isConnected(id: string): boolean {
	return connected.includes(id);
}

function toggle(id: string) {
	if (!isConnected(id)) return;
	if (selected.includes(id)) {
		selected = selected.filter((s) => s !== id);
	} else {
		selected = [...selected, id];
	}
}

function selectAll() {
	selected = dataSources.filter((ds) => isConnected(ds));
}

function selectNone() {
	selected = [];
}
</script>

{#if dataSources.length > 0}
  <div class="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b border-gray-200">
    <span class="text-xs font-medium text-gray-500">Target:</span>
    <div class="flex gap-1.5 flex-wrap">
      {#each dataSources as ds}
        <button
          onclick={() => toggle(ds)}
          disabled={!isConnected(ds)}
          class="px-2.5 py-1 rounded-full text-xs font-medium transition-colors
            {!isConnected(ds)
              ? 'bg-red-50 text-gray-400 border border-red-300 cursor-not-allowed line-through decoration-red-300'
              : selected.includes(ds)
                ? 'bg-tommy-accent-blue text-white'
                : 'bg-white text-gray-600 border border-gray-300 hover:border-tommy-accent-blue'
            }"
          title={isConnected(ds) ? labels[ds] ?? ds : `${labels[ds] ?? ds} - not connected`}
        >
          {labels[ds] ?? ds}
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
