<script lang="ts">
// apps/web/src/lib/components/StreamingProgress.svelte
import Icon from "./Icon.svelte";

// The incident pipeline and the elastic-iac maker graph run different node ids, so the
// step labels are selected per agent. Both id sets are already emitted by the server SSE
// pump (PIPELINE_NODES) into activeNodes/completedNodes; only the matching labels differ.
const INCIDENT_NODES = [
	{ id: "classify", activeLabel: "Classifying", completeLabel: "Classified" },
	{ id: "entityExtractor", activeLabel: "Extracting", completeLabel: "Extracted" },
	{ id: "queryDataSource", activeLabel: "Querying", completeLabel: "Queried" },
	{ id: "align", activeLabel: "Aligning", completeLabel: "Aligned" },
	{ id: "aggregate", activeLabel: "Analyzing", completeLabel: "Analyzed" },
	{ id: "validate", activeLabel: "Validating", completeLabel: "Validated" },
] as const;

// elastic-iac maker happy path (version-upgrade / tier-resize / ilm-rollout). bootstrap,
// classifyIacIntent, watchPipeline and teardown are plumbing/covered elsewhere and omitted.
const IAC_MAKER_NODES = [
	{ id: "parseIntent", activeLabel: "Parsing", completeLabel: "Parsed" },
	{ id: "readClusterState", activeLabel: "Reading state", completeLabel: "Read state" },
	{ id: "guard", activeLabel: "Checking", completeLabel: "Checked" },
	{ id: "draftChange", activeLabel: "Drafting", completeLabel: "Drafted" },
	{ id: "reviewPlan", activeLabel: "Preparing review", completeLabel: "Prepared" },
	{ id: "openMr", activeLabel: "Opening MR", completeLabel: "MR opened" },
] as const;

// SIO-903: drift (SIO-882) + synthetics-drift (SIO-902) sub-flow. A drift run never executes
// the maker nodes (and vice versa), so the two lists are rendered exclusively -- pick whichever
// the live node events match, so a drift audit leads with "Detecting drift" rather than six grey
// maker pills that never light up.
const IAC_DRIFT_NODES = [
	{ id: "detectDrift", activeLabel: "Detecting drift", completeLabel: "Drift detected" },
	{ id: "reconcileGate", activeLabel: "Reviewing drift", completeLabel: "Reviewed" },
	{ id: "reconcileStack", activeLabel: "Reconciling", completeLabel: "Reconciled" },
	{ id: "advanceDrift", activeLabel: "Advancing", completeLabel: "Advanced" },
	{ id: "detectSyntheticsDrift", activeLabel: "Checking synthetics", completeLabel: "Synthetics checked" },
	{ id: "syntheticsPushGate", activeLabel: "Reviewing push", completeLabel: "Reviewed" },
	{ id: "pushSynthetics", activeLabel: "Pushing synthetics", completeLabel: "Pushed" },
] as const;

let {
	activeNodes,
	completedNodes,
	variant = "incident",
}: {
	activeNodes: Set<string>;
	completedNodes: Map<string, { duration: number }>;
	variant?: "incident" | "iac";
} = $props();

// For IaC, drift and maker flows are mutually exclusive within a run; render only the list
// that the live node events belong to. Default to maker until a drift node appears so we never
// show a half-grey row of irrelevant pills.
const iacNodes = $derived.by(() => {
	const seen = (id: string) => activeNodes.has(id) || completedNodes.has(id);
	const isDrift = IAC_DRIFT_NODES.some((n) => seen(n.id));
	return isDrift ? IAC_DRIFT_NODES : IAC_MAKER_NODES;
});

const NODES = $derived(variant === "iac" ? iacNodes : INCIDENT_NODES);

const currentActiveLabel = $derived.by(() => {
	for (const node of NODES) {
		if (activeNodes.has(node.id)) return `${node.activeLabel}...`;
	}
	if (activeNodes.size > 0) return "Processing...";
	return "Starting...";
});

function pillClass(nodeId: string): string {
	const completed = completedNodes.has(nodeId);
	const active = activeNodes.has(nodeId);
	const base =
		"inline-flex items-center gap-1 py-1 px-2 rounded-full text-[0.625rem] font-medium transition-all duration-200";
	if (completed) return `${base} bg-green-100 text-green-700`;
	if (active) return `${base} bg-tommy-offwhite text-tommy-accent-blue ring-2 ring-tommy-accent-blue`;
	return `${base} bg-gray-100 text-gray-400`;
}
</script>

{#if activeNodes.size > 0 || completedNodes.size > 0}
  <div class="bg-gradient-to-br from-tommy-offwhite/80 to-tommy-offwhite border border-tommy-offwhite rounded-xl p-3 mb-3 text-xs animate-fade-in">
    <div class="flex items-center gap-2 mb-2.5">
      <span class="relative flex h-2 w-2">
        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-tommy-accent-blue opacity-75"></span>
        <span class="relative inline-flex rounded-full h-2 w-2 bg-tommy-accent-blue"></span>
      </span>
      <span class="text-tommy-navy font-medium">{currentActiveLabel}</span>
    </div>

    <div class="flex flex-wrap items-center gap-1.5">
      {#each NODES as node, i}
        {@const completed = completedNodes.get(node.id)}
        {@const isActive = activeNodes.has(node.id)}

        {#if i > 0}
          <div class="w-3 h-px {completed ? 'bg-green-500' : 'bg-gray-300'}"></div>
        {/if}

        <span class={pillClass(node.id)}>
          {#if completed}
            <Icon name="check" class="w-2.5 h-2.5" />
            {node.completeLabel}
            <span class="text-green-500 text-[0.5rem]">{(completed.duration / 1000).toFixed(1)}s</span>
          {:else if isActive}
            <Icon name="spinner" class="w-2.5 h-2.5 animate-spin" />
            {node.activeLabel}...
          {:else}
            {node.activeLabel}
          {/if}
        </span>
      {/each}
    </div>
  </div>
{/if}
