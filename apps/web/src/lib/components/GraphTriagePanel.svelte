<script lang="ts">
// apps/web/src/lib/components/GraphTriagePanel.svelte
import { untrack } from "svelte";
import { computeLayout, END_NODE, type GraphLayout, START_NODE, type Topology } from "$lib/graph-layout";
import { nodeLabelFor } from "$lib/node-labels";
import { runningFingerprint, shouldRevealRunning } from "./graph-triage-scroll";
import Icon from "./Icon.svelte";
import { isAtBottom } from "./pi-fleet-scroll";

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

// SIO-1812: follow the running node down the graph. The incident pipeline is 32 nodes
// tall, so without this the turn walks off the bottom of the pane and the operator has to
// scroll by hand to watch the thing this panel exists to show.
let scroller = $state<HTMLElement | null>(null);
let seenRunning = "";
// Explicit follow-state, not a bottom test: this pane CENTRES a node, so after the first
// reveal the scroller sits mid-content and any at-bottom check would read false and switch
// following off for the rest of the turn (Greptile, PR #843).
// $state because the header shows a Follow control while it is off: bottom-parking was the
// only way back, nothing on screen said so, and one wheel nudge ended following for the
// rest of a five-minute turn. Read untracked in the reveal effect -- a re-arm from the
// scroll handler must not replay a reveal on its own.
let following = $state(true);
// Who moved the scroller is decided by INPUT events, not by inspecting scroll events
// (Greptile, PR #843, three rounds on this). Scroll events cannot answer it: one smooth
// scrollTo emits ~31 of them, measured in this pane, and they are indistinguishable from
// the operator's. Guessing from them fails in one direction or the other -- consume one
// event and the animation's own frames look like the operator (following dies mid-turn);
// swallow them all and a wheel spin DURING the animation looks like the animation (the
// operator is dragged back to the node they just scrolled away from).
//
// wheel/touchmove/keydown fire independently of any animation -- verified live: a wheel
// spin mid-scroll arrives as exactly 1 wheel event alongside the 31 scroll events. So they
// are the operator, unambiguously, whatever else is in flight.
function onOperatorInput() {
	// They have taken the wheel. Stop following now; the scroll handler below decides
	// whether their final position counts as coming back.
	following = false;
}

function onScroll() {
	// Only meaningful once the operator has taken over: it re-arms following when they
	// park at the bottom. While `following` is true this is our own animation and the
	// position mid-flight means nothing.
	if (!following && scroller && isAtBottom(scroller)) following = true;
}

// Returns whether the node was brought into view; false while the topology is loading.
function revealNode(id: string): boolean {
	// A node's y is in viewBox units, and the SVG is scaled to fit the pane (w-full,
	// clamped by max-width), so convert with the ratio the browser ACTUALLY rendered
	// at rather than deriving it -- p-3 padding and that max-width clamp both make a
	// computed ratio wrong. Scrolling the container by number needs no per-node element ref.
	const node = layout?.nodes.find((n) => n.id === id);
	const svg = scroller?.querySelector("svg");
	if (!node || !scroller || !layout || !svg) return false;
	// Offset of the svg box within the scroller's content, padding included, read
	// from the live boxes instead of recomputed from the class list.
	const svgBox = svg.getBoundingClientRect();
	const scrollerBox = scroller.getBoundingClientRect();
	const svgTop = svgBox.top - scrollerBox.top + scroller.scrollTop;
	const scale = svgBox.width / layout.width;
	const centre = svgTop + (node.y + node.height / 2) * scale;
	scroller.scrollTo({ top: Math.max(0, centre - scroller.clientHeight / 2), behavior: "smooth" });
	return true;
}

function resumeFollowing() {
	following = true;
	const running = runningFingerprint(activeNodes);
	if (running !== "" && revealNode(running)) seenRunning = running;
}

$effect(() => {
	const running = runningFingerprint(activeNodes);
	// A blank graph is the start of a turn: whoever scrolled away during the LAST turn
	// has not asked to sit this one out. Without this, one wheel nudge switched
	// following off for every later turn too (measured: scrollTop 0 from classify to
	// aggregate on the turn after a single wheel event).
	if (activeNodes.size === 0 && completedNodes.size === 0) following = true;
	if (
		shouldRevealRunning({
			runningChanged: running !== seenRunning,
			hasRunning: running !== "",
			following: untrack(() => following),
		})
	) {
		// Only a node that was actually revealed is marked seen. Marking it while the
		// layout was still loading would leave the CURRENT node unrevealed forever,
		// because the fingerprint would never change again (Greptile, PR #843): opening
		// the pane mid-turn is exactly when topology has not arrived yet.
		if (revealNode(running)) seenRunning = running;
		return;
	}
	seenRunning = running;
});

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
	if (activeNodes.has(id)) return `${nodeLabelFor(id, agent)?.activeLabel ?? "Running"}...`;
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
      <h2 class="text-sm font-semibold text-tommy-navy leading-tight">Live graph triage</h2>
      <p class="text-[0.625rem] text-gray-500 truncate">{agent} &middot; {statusLine}</p>
    </div>
    {#if isStreaming && !following}
      <button
        type="button"
        onclick={resumeFollowing}
        class="shrink-0 rounded border border-tommy-navy px-2 py-0.5 text-[0.625rem] font-medium text-tommy-navy hover:bg-tommy-navy hover:text-white"
      >
        Follow
      </button>
    {/if}
    {#if isStreaming}
      <span class="relative flex h-2 w-2 shrink-0">
        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-tommy-accent-blue opacity-75"></span>
        <span class="relative inline-flex rounded-full h-2 w-2 bg-tommy-accent-blue"></span>
      </span>
    {/if}
  </div>

  <!-- SIO-1812: wheel/touch/key say the operator moved the view; onscroll only re-arms
       following when they park at the bottom. See the handlers for why scroll events alone
       cannot tell the two apart. -->
  <!-- SIO-1812: wheel/touch say the operator moved the view; onscroll only re-arms
       following when they park at the bottom. See the handlers for why scroll events alone
       cannot tell our animation from their input. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -- these handlers OBSERVE scrolling
       to decide whether to keep auto-following; they add no behaviour a keyboard user would
       otherwise miss. Keyboard scrolling still reaches onscroll, which re-arms following the
       same way. A role/tabindex here would announce an interactive widget that is not one. -->
  <div
    bind:this={scroller}
    onscroll={onScroll}
    onwheel={onOperatorInput}
    ontouchmove={onOperatorInput}
    class="flex-1 overflow-auto p-3"
  >
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
      <!-- SIO-1657: fit the graph to the pane width; never scroll horizontally.
           A natural-size render (tried first) made the labels bigger but the
           picture unusable: the elastic-iac graph is 1644px wide, so the pane
           opened on a near-empty region with the flow running off both edges.
           Whole-graph overview is the point of this panel -- it is a map of a
           turn in flight, and a map you have to scroll to read is not one.
           `w-full` keeps every graph fully visible; the max-width stops a
           narrow graph being stretched past its own size. -->
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

        <!-- SIO-1811: vector-effect="non-scaling-stroke" on both rects. A running
             node is stroke-2 while every other state is stroke-1, and an SVG
             stroke straddles the path -- so without this the running box paints
             ~1px proud of the geometry computeLayout gave it, and since the chart
             is scaled to fit the pane that lands on fractional device pixels and
             reads as a misaligned node. Both rects carry it, not just the running
             one, so the START/END pills do not scale their strokes differently
             from the nodes. -->
        {#each layout.nodes as node (node.id)}
          {@const visual = nodeVisual(node.id)}
          {#if node.id === START_NODE || node.id === END_NODE}
            <rect
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx="4"
              vector-effect="non-scaling-stroke"
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
              rx="4"
              vector-effect="non-scaling-stroke"
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
