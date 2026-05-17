<script lang="ts">
type ProbeState = "ready" | "unready" | "down" | "replaced" | "misidentified";

let {
	dataSources,
	connected = [],
	states = {},
	selected = $bindable([]),
}: {
	dataSources: string[];
	connected: string[];
	states: Record<string, ProbeState>;
	selected: string[];
} = $props();

const labels: Record<string, string> = {
	elastic: "Elastic",
	kafka: "Kafka",
	couchbase: "Capella",
	konnect: "Konnect",
	gitlab: "GitLab",
	atlassian: "Atlassian",
	aws: "AWS",
};

function stateFor(id: string): ProbeState {
	return states[id] ?? (connected.includes(id) ? "ready" : "down");
}

function isInteractive(id: string): boolean {
	const s = stateFor(id);
	return s === "ready" || s === "unready" || s === "replaced";
}

function classFor(id: string, isSelected: boolean): string {
	const s = stateFor(id);
	if (s === "down") {
		return "bg-red-50 text-gray-400 border border-red-300 cursor-not-allowed line-through decoration-red-300";
	}
	if (s === "misidentified") {
		return "bg-red-100 text-red-900 border border-red-700 cursor-not-allowed";
	}
	if (s === "unready") {
		return isSelected
			? "bg-tommy-accent-blue text-white border border-yellow-500"
			: "bg-yellow-50 text-yellow-900 border border-yellow-500 hover:border-yellow-600";
	}
	if (s === "replaced") {
		return "bg-yellow-100 text-yellow-900 border border-yellow-500 animate-pulse";
	}
	// ready
	return isSelected
		? "bg-tommy-accent-blue text-white"
		: "bg-white text-gray-600 border border-gray-300 hover:border-tommy-accent-blue";
}

function titleFor(id: string): string {
	const label = labels[id] ?? id;
	const s = stateFor(id);
	if (s === "down") return `${label} - not connected`;
	if (s === "misidentified") return `${label} - wrong server on this port. Check env config.`;
	if (s === "unready") return `${label} - upstream degraded`;
	if (s === "replaced") return `${label} - process replaced, reloading tools`;
	return label;
}

function toggle(id: string) {
	if (!isInteractive(id)) return;
	if (selected.includes(id)) {
		selected = selected.filter((s) => s !== id);
	} else {
		selected = [...selected, id];
	}
}

function selectAll() {
	selected = dataSources.filter(isInteractive);
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
          disabled={!isInteractive(ds)}
          class="px-2.5 py-1 rounded-full text-xs font-medium transition-colors {classFor(ds, selected.includes(ds))}"
          title={titleFor(ds)}
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
