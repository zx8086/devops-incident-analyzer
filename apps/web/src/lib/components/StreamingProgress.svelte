<script lang="ts">
// apps/web/src/lib/components/StreamingProgress.svelte
import {
	HIL_LEARNING_NODES,
	IAC_DRIFT_NODES,
	IAC_FLEET_NODES,
	IAC_MAKER_NODES,
	INCIDENT_MITIGATION_NODES,
	INCIDENT_NODES,
} from "$lib/node-labels";
import Icon from "./Icon.svelte";

let {
	activeNodes,
	completedNodes,
	subAgentProgress = new Map(),
	variant = "incident",
}: {
	activeNodes: Set<string>;
	completedNodes: Map<string, { duration: number }>;
	// Live per-sub-agent status during the queryDataSource fan-out (see
	// node-labels.ts / sse-pump.ts's "subagent_progress" event) -- fills the
	// multi-minute gap between the "Querying..." and "Aligning" pills with
	// visible per-datasource activity instead of a single static pill.
	subAgentProgress?: Map<string, { status: "running" | "done"; toolCallCount?: number; deploymentId?: string }>;
	variant?: "incident" | "iac";
} = $props();

// For IaC, drift and maker flows are mutually exclusive within a run; render only the list
// that the live node events belong to. Default to maker until a drift node appears so we never
// show a half-grey row of irrelevant pills.
const iacNodes = $derived.by(() => {
	const seen = (id: string) => activeNodes.has(id) || completedNodes.has(id);
	// SIO-935: fleet first -- a fleet run executes detect/gate/apply and never the drift or maker nodes.
	if (IAC_FLEET_NODES.some((n) => seen(n.id))) return IAC_FLEET_NODES;
	const isDrift = IAC_DRIFT_NODES.some((n) => seen(n.id));
	return isDrift ? IAC_DRIFT_NODES : IAC_MAKER_NODES;
});

// Incident flow: mitigationRouter picks exactly one of proposeInvestigate/
// proposeMonitor/proposeEscalate per turn -- show all three until one is seen,
// then collapse to just that one, same idiom as the IaC sub-flow selection.
// The HIL learning lane only runs on an explicit "learn from TICKET-123"
// command, so it's hidden entirely unless learnFetchTicket is seen.
const incidentNodes = $derived.by(() => {
	const seen = (id: string) => activeNodes.has(id) || completedNodes.has(id);
	const mitigationNode = INCIDENT_MITIGATION_NODES.find((n) => seen(n.id));
	const mitigation = mitigationNode ? [mitigationNode] : INCIDENT_MITIGATION_NODES;
	const learning = HIL_LEARNING_NODES.some((n) => seen(n.id)) ? HIL_LEARNING_NODES : [];
	return [...INCIDENT_NODES, ...mitigation, ...learning];
});

const NODES = $derived(variant === "iac" ? iacNodes : incidentNodes);

const currentActiveLabel = $derived.by(() => {
	for (const node of NODES) {
		if (activeNodes.has(node.id)) return `${node.activeLabel}...`;
	}
	if (activeNodes.size > 0) return "Processing...";
	return "Starting...";
});

// Sort running entries first (most relevant while queryDataSource is active),
// then by dataSourceId for stable ordering as entries arrive out of order.
const subAgentRows = $derived(
	[...subAgentProgress.entries()]
		.map(([key, v]) => ({ key, ...v }))
		.sort((a, b) => {
			if (a.status !== b.status) return a.status === "running" ? -1 : 1;
			return a.key.localeCompare(b.key);
		}),
);

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

    {#if activeNodes.has("queryDataSource") && subAgentRows.length > 0}
      <div class="flex flex-col gap-1 mt-2 pt-2 border-t border-gray-200/70">
        {#each subAgentRows as row (row.key)}
          <div class="flex items-center gap-1.5 text-[0.625rem] text-gray-500">
            {#if row.status === "running"}
              <Icon name="spinner" class="w-2.5 h-2.5 animate-spin text-tommy-accent-blue" />
            {:else}
              <Icon name="check" class="w-2.5 h-2.5 text-green-500" />
            {/if}
            <span class="font-medium text-gray-700">{row.key}</span>
            <span>{row.status === "running" ? "running" : "done"}</span>
            {#if row.toolCallCount}
              <span>&middot; {row.toolCallCount} tool{row.toolCallCount !== 1 ? "s" : ""}</span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
