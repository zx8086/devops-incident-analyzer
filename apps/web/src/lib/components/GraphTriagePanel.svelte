<script lang="ts">
// apps/web/src/lib/components/GraphTriagePanel.svelte
import { computeLayout, END_NODE, type GraphLayout, START_NODE, type Topology } from "$lib/graph-layout";
import { ALL_NODE_LABELS } from "$lib/node-labels";
import Icon from "./Icon.svelte";

let {
	agent,
	activeNodes,
	completedNodes,
	isStreaming,
	paused = false,
	outcome,
}: {
	agent: string;
	// nodeId -> live run count (parallel branches share a node name; see the
	// agent-reducer node_start/node_end cases).
	activeNodes: Map<string, number>;
	completedNodes: Map<string, { duration: number }>;
	isStreaming: boolean;
	// True while the graph is paused on a HITL gate (topic shift, HIL learning,
	// IaC clarify/review/reconcile/push/upgrade/renovate). A paused turn keeps
	// its completedNodes for the resume leg, so without this flag the panel
	// would read the pause as a finished run.
	paused?: boolean;
	// Terminal outcome of the displayed run ("completed"/"error"/"rejected"/...);
	// "error" keeps END unlit so a failed turn never reads as a clean finish.
	outcome?: string;
} = $props();

let topology = $state<Topology | null>(null);
let loadError = $state("");

// Refetch when the agent toggles; ignore stale responses from a superseded fetch.
$effect(() => {
	const requested = agent;
	topology = null;
	loadError = "";
	fetch(`/api/agent/topology?agent=${encodeURIComponent(requested)}`)
		.then(async (res) => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return (await res.json()) as Topology;
		})
		.then((data) => {
			if (agent === requested) topology = data;
		})
		.catch((error) => {
			if (agent === requested) loadError = error instanceof Error ? error.message : String(error);
		});
});

const layout = $derived<GraphLayout | null>(topology ? computeLayout(topology) : null);

const runStarted = $derived(activeNodes.size > 0 || completedNodes.size > 0);
// END lights only for a SUCCESSFUL finish: paused turns (HITL gates) and every
// non-completed terminal outcome (error/rejected/declined/blocked/unsupported/
// pipeline-failed) keep END unlit and get named in the status line instead.
// undefined outcome = the live path (mid-turn / paused), where the snapshot
// message that carries the outcome does not exist yet.
const runSucceeded = $derived(outcome === undefined || outcome === "completed");
const runFinished = $derived(
	!isStreaming && !paused && runSucceeded && activeNodes.size === 0 && completedNodes.size > 0,
);

type NodeVisual = "running" | "done" | "idle";
function nodeVisual(id: string): NodeVisual {
	if (id === START_NODE) return runStarted ? "done" : "idle";
	if (id === END_NODE) return runFinished ? "done" : "idle";
	if (activeNodes.has(id)) return "running";
	if (completedNodes.has(id)) return "done";
	return "idle";
}

// START counts as "completed" for edge inference the moment the run starts.
function sourceDone(id: string): boolean {
	if (id === START_NODE) return runStarted;
	return completedNodes.has(id);
}

type EdgeVisual = "flowing" | "taken" | "idle";
// Edge traversal is INFERRED client-side (source done + target running/done)
// rather than from dedicated route events. Back edges (retries) are never
// marked taken: completion order cannot prove a retry actually happened.
function edgeVisual(edge: GraphLayout["edges"][number]): EdgeVisual {
	if (edge.back) return "idle";
	if (!sourceDone(edge.source)) return "idle";
	if (activeNodes.has(edge.target)) return "flowing";
	if (edge.target === END_NODE) return runFinished ? "taken" : "idle";
	if (completedNodes.has(edge.target)) return "taken";
	return "idle";
}

function nodeLabel(id: string): string {
	if (id === START_NODE) return "START";
	if (id === END_NODE) return "END";
	return id;
}

function nodeSubtitle(id: string): string {
	const duration = completedNodes.get(id);
	if (duration) return `${(duration.duration / 1000).toFixed(1)}s`;
	if (activeNodes.has(id)) return `${ALL_NODE_LABELS[id]?.activeLabel ?? "Running"}...`;
	return "";
}

const statusLine = $derived.by(() => {
	const running = [...activeNodes.keys()];
	if (running.length > 0) return `${running.join(", ")} running`;
	if (paused) return "paused · awaiting your input";
	if (!isStreaming && outcome === "error") return "ended with error";
	if (!isStreaming && !runSucceeded && outcome) return `ended · ${outcome}`;
	if (runFinished) return `finished · ${completedNodes.size} nodes`;
	// Mid-turn with no active node: either the very start of the turn or the
	// output node token-streaming the answer after its node_end already fired.
	if (isStreaming) return completedNodes.size > 0 ? "streaming answer..." : "starting...";
	return "nodes light up as a turn flows through";
});
</script>

<div class="flex flex-col h-full">
  <div class="flex items-center gap-2 px-4 py-3 border-b border-gray-200 bg-white">
    <Icon name="graph" class="w-4 h-4 text-tommy-navy" />
    <div class="flex-1 min-w-0">
      <h2 class="text-xs font-semibold text-tommy-navy leading-tight">Live graph triage</h2>
      <p class="text-[0.625rem] text-gray-500 truncate">{agent} &middot; {statusLine}</p>
    </div>
    {#if isStreaming}
      <span class="relative flex h-2 w-2 shrink-0">
        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-tommy-accent-blue opacity-75"></span>
        <span class="relative inline-flex rounded-full h-2 w-2 bg-tommy-accent-blue"></span>
      </span>
    {/if}
  </div>

  <div class="flex-1 overflow-auto p-3">
    {#if loadError}
      <div class="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg p-3">
        Failed to load the graph topology: {loadError}
      </div>
    {:else if !layout}
      <div class="flex items-center gap-2 text-xs text-gray-500 p-3">
        <Icon name="spinner" class="w-3.5 h-3.5 animate-spin" />
        Loading topology...
      </div>
    {:else}
      <svg
        viewBox="0 0 {layout.width} {layout.height}"
        class="w-full h-auto"
        style="max-width: {layout.width}px"
        role="img"
        aria-label="Agent pipeline graph"
      >
        <defs>
          <marker
            id="triage-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" class="fill-gray-300" />
          </marker>
        </defs>

        {#each layout.edges as edge (`${edge.source}->${edge.target}`)}
          {@const visual = edgeVisual(edge)}
          <path
            d={edge.path}
            fill="none"
            marker-end="url(#triage-arrow)"
            stroke-dasharray={visual === "flowing" ? "6 6" : edge.conditional ? "4 4" : undefined}
            class={visual === "flowing"
              ? "stroke-tommy-accent-blue stroke-2 animate-edge-flow"
              : visual === "taken"
                ? "stroke-green-500 stroke-2"
                : "stroke-gray-300 stroke-1"}
          />
        {/each}

        {#each layout.nodes as node (node.id)}
          {@const visual = nodeVisual(node.id)}
          {#if node.id === START_NODE || node.id === END_NODE}
            <rect
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx={node.height / 2}
              class={visual === "done"
                ? "fill-green-100 stroke-green-500 stroke-1"
                : "fill-white stroke-gray-300 stroke-1"}
            />
            <text
              x={node.x + node.width / 2}
              y={node.y + node.height / 2 + 3.5}
              text-anchor="middle"
              class="text-[10px] font-semibold {visual === 'done' ? 'fill-green-700' : 'fill-gray-500'}"
            >
              {nodeLabel(node.id)}
            </text>
          {:else}
            <rect
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx="8"
              class={visual === "running"
                ? "fill-tommy-offwhite stroke-tommy-accent-blue stroke-2 animate-pulse"
                : visual === "done"
                  ? "fill-green-50 stroke-green-500 stroke-1"
                  : "fill-white stroke-gray-300 stroke-1"}
            />
            <text
              x={node.x + 10}
              y={node.y + 17}
              class="text-[10px] font-medium {visual === 'running'
                ? 'fill-tommy-accent-blue'
                : visual === 'done'
                  ? 'fill-green-700'
                  : 'fill-gray-600'}"
            >
              {nodeLabel(node.id)}
            </text>
            {#if nodeSubtitle(node.id)}
              <text
                x={node.x + 10}
                y={node.y + 31}
                class="text-[9px] {visual === 'running' ? 'fill-tommy-accent-blue' : 'fill-green-600'}"
              >
                {nodeSubtitle(node.id)}
              </text>
            {/if}
          {/if}
        {/each}
      </svg>
    {/if}
  </div>
</div>
