<script lang="ts">
// apps/web/src/lib/components/NetworkTopologyCard.svelte
// SIO-1204: interactive ECharts force-graph of the turn's derived network map
// (DNS -> LB -> target group -> workload chains, VPC/subnet placement, service
// endpoints). The chart initializes behind an $effect keyed on the bound
// container + dynamic import: echarts needs the DOM (SvelteKit SSR must never
// touch it), the modular echarts/core bundle only loads when a map actually
// renders, and the {#if}-gated container can appear AFTER first render (a
// topology arriving on a later turn), which a one-shot onMount would miss.
import type { NetworkTopology } from "@devops-agent/shared";
import { tick } from "svelte";
import { buildNetworkChartOption, buildNetworkTextSummary } from "$lib/network-chart";
import Icon from "./Icon.svelte";

let { topology }: { topology: NetworkTopology } = $props();

// Minimal structural handle -- keeps this module free of a static echarts type
// dependency (echarts is only ever dynamic-imported, see the $effect below).
// getOption()'s return is cast at the read site (zoomBy): EChartsType's real
// getOption() returns the full option union, which has no structural overlap
// with a plain { zoom, center } shape even though graph series carry both.
interface EchartsHandle {
	setOption(option: object): void;
	getOption(): unknown;
	resize(): void;
	dispose(): void;
}

let container: HTMLDivElement | undefined = $state();
// Imperative echarts handle -- deliberately NOT $state (assignment must not
// retrigger effects; the `ready` flag below is the reactive signal).
let chart: EchartsHandle | null = null;
let ready = $state(false);
let expanded = $state(false);

// SIO-1212 focus management for the fullscreen dialog: the trigger element is
// captured at open time (not assumed to be the last-focused element, since a
// keyboard user could tab away before the dialog opens) so focus can return to
// it on close; dialogEl anchors both the open-time focus move and the Tab/
// Shift+Tab trap while expanded.
let dialogEl: HTMLDivElement | undefined = $state();
let expandTrigger: HTMLButtonElement | undefined = $state();
let lastFocused: HTMLElement | null = null;

const option = $derived(buildNetworkChartOption(topology));
// SIO-1459: accessible text representation -- the same node/edge data the canvas
// tooltips carry, reachable without a pointer via the details element below.
const textSummary = $derived(buildNetworkTextSummary(topology));

// SIO-1212: zoom bounds for the +/- toolbar. Graph-series roam has no native
// zoom-button UI (unlike toolbox dataZoom, which targets cartesian charts),
// so zoom level is tracked here and pushed to echarts imperatively.
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.2;

function zoomBy(factor: number) {
	if (!chart) return;
	const graphOption = chart.getOption() as { series?: Array<{ zoom?: number }> };
	const current = graphOption.series?.[0]?.zoom ?? 1;
	const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current * factor));
	chart.setOption({ series: [{ zoom: next }] });
}

function resetView() {
	// Not a toolbox `restore` action (that requires registering ToolboxComponent,
	// and re-runs the force simulation from scratch, shuffling node positions).
	// Instead, explicitly clear zoom/center back to defaults: setOption merges
	// by default, so an omitted `zoom` would leave any prior zoom untouched.
	chart?.setOption({ series: [{ zoom: 1, center: undefined }] });
}

function focusableToolbarButtons(): HTMLButtonElement[] {
	if (!dialogEl) return [];
	return Array.from(dialogEl.querySelectorAll("button"));
}

async function toggleExpanded() {
	const opening = !expanded;
	if (opening) lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	expanded = opening;
	// The container's Tailwind classes swap synchronously with this state
	// write, but layout/ResizeObserver firing is async -- resize explicitly
	// after the DOM settles so there's no stale-size flash on toggle.
	await tick();
	chart?.resize();
	if (opening) {
		dialogEl?.focus();
	} else {
		// Restore to the captured trigger, falling back to the expand button
		// (post-collapse re-render) if the original trigger no longer exists.
		(lastFocused ?? expandTrigger)?.focus();
		lastFocused = null;
	}
}

function onKeydown(event: KeyboardEvent) {
	if (!expanded) return;
	if (event.key === "Escape") {
		toggleExpanded();
		return;
	}
	if (event.key !== "Tab") return;
	// Focus trap: while expanded, Tab/Shift+Tab cycles only within the
	// toolbar's buttons instead of escaping to the rest of the page.
	const focusable = focusableToolbarButtons();
	if (focusable.length === 0) return;
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	const active = document.activeElement;
	if (event.shiftKey && active === first) {
		event.preventDefault();
		last?.focus();
	} else if (!event.shiftKey && active === last) {
		event.preventDefault();
		first?.focus();
	}
}

$effect(() => {
	// Reruns whenever the bound container element appears or changes (the {#if}
	// can mount it late when the topology transitions 0 -> N nodes). The teardown
	// disposes the previous chart first, so at most one chart exists per element.
	const el = container;
	if (!el) return;
	let disposed = false;
	let observer: ResizeObserver | undefined;
	(async () => {
		const [core, charts, components, renderers] = await Promise.all([
			import("echarts/core"),
			import("echarts/charts"),
			import("echarts/components"),
			import("echarts/renderers"),
		]);
		if (disposed) return;
		core.use([charts.GraphChart, components.TooltipComponent, components.LegendComponent, renderers.CanvasRenderer]);
		chart = core.init(el);
		observer = new ResizeObserver(() => chart?.resize());
		observer.observe(el);
		ready = true;
	})();
	return () => {
		disposed = true;
		observer?.disconnect();
		chart?.dispose();
		chart = null;
		ready = false;
	};
});

$effect(() => {
	// Re-runs when the topology prop changes AND once when `ready` flips true
	// (the initial render), so no option update is ever lost to load timing.
	const current = option;
	if (ready && chart) chart.setOption(current);
});
</script>

{#if topology.nodes.length > 0}
  {#if expanded}
    <div
      class="fixed inset-0 z-40 bg-black/30"
      onclick={toggleExpanded}
      role="presentation"
    ></div>
  {/if}
  <div
    bind:this={dialogEl}
    class={expanded
      ? "fixed inset-4 z-50 flex flex-col rounded-lg border border-sky-100 bg-white px-3 py-2.5 shadow-2xl md:inset-10"
      : "mt-2 rounded-lg border border-sky-100 bg-sky-50/40 px-3 py-2.5"}
    role={expanded ? "dialog" : undefined}
    aria-modal={expanded ? "true" : undefined}
    aria-label={expanded ? "Network map, expanded" : undefined}
    onkeydown={onKeydown}
    tabindex="-1"
  >
    <div class="flex items-center justify-between gap-2 mb-1">
      <span class="text-[0.5625rem] font-medium text-sky-800 uppercase tracking-wider">Network map</span>
      <span class="text-[0.5625rem] text-gray-500 tabular-nums truncate">
        {topology.nodes.length} nodes · {topology.edges.length} links · {topology.sources.join(", ")}
      </span>
    </div>
    <div class={expanded ? "relative min-h-0 flex-1" : "relative"}>
      <div
        bind:this={container}
        class={expanded ? "h-full w-full" : "h-[28rem] w-full"}
        role="img"
        aria-label="Network map graph with {topology.nodes.length} nodes and {topology.edges.length} links. An expandable text view listing every node and link follows this chart."
      ></div>
      {#if !ready}
        <div class="absolute inset-0 flex items-center justify-center text-[0.6875rem] text-gray-400">
          Rendering network map...
        </div>
      {/if}
      <div class="absolute left-2 top-2 flex flex-col overflow-hidden rounded-md border border-gray-200 bg-white/95 shadow-sm">
        <button
          type="button"
          onclick={() => zoomBy(ZOOM_STEP)}
          class="border-b border-gray-200 p-1.5 text-gray-600 hover:bg-gray-100"
          aria-label="Zoom in"
          title="Zoom in"
        >
          <Icon name="zoom-in" class="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onclick={() => zoomBy(1 / ZOOM_STEP)}
          class="border-b border-gray-200 p-1.5 text-gray-600 hover:bg-gray-100"
          aria-label="Zoom out"
          title="Zoom out"
        >
          <Icon name="zoom-out" class="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onclick={resetView}
          class="border-b border-gray-200 p-1.5 text-gray-600 hover:bg-gray-100"
          aria-label="Fit to view"
          title="Fit to view"
        >
          <Icon name="fit-view" class="h-3.5 w-3.5" />
        </button>
        <button
          bind:this={expandTrigger}
          type="button"
          onclick={toggleExpanded}
          class="p-1.5 text-gray-600 hover:bg-gray-100"
          aria-label={expanded ? "Collapse network map" : "Expand network map"}
          title={expanded ? "Collapse" : "Expand"}
        >
          <Icon name={expanded ? "collapse" : "expand"} class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
    <div class="mt-1 flex items-center justify-between text-[0.5625rem] text-gray-400">
      <span>Dashed links are CIDR-derived placements; drag, scroll, and hover for detail.</span>
      {#if topology.truncated}
        <span class="text-gray-500">Truncated to the first {topology.nodes.length} nodes.</span>
      {/if}
    </div>
    <!-- SIO-1459: keyboard/screen-reader-reachable equivalent of the canvas.
         Native details/summary is focusable and toggleable without ARIA wiring. -->
    <details class="mt-1">
      <summary class="cursor-pointer text-[0.5625rem] text-gray-500 hover:text-gray-700">
        Text view: {textSummary.nodes.length} nodes, {textSummary.edges.length} links
      </summary>
      <!-- tabindex makes the clipped list reachable and Arrow/PageDown-scrollable
           for keyboard users (scroll containers without focusable children are not
           reliably focusable cross-browser); role+label give it an accessible name. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -- scrollable region:
           the WCAG scrollable-region-focusable rule REQUIRES a nonnegative
           tabindex here precisely because the region has no focusable children. -->
      <div
        class="mt-1 max-h-48 overflow-y-auto rounded border border-gray-200 bg-white/70 px-2 py-1.5 text-[0.625rem] text-gray-600"
        tabindex="0"
        role="region"
        aria-label="Network map text view"
      >
        <p class="font-medium text-gray-700">Nodes</p>
        <ul class="mb-1.5 list-disc pl-4">
          <!-- Index-keyed: lines are a positional projection, and raw line text
               can collide when distinct node ids share a label. -->
          {#each textSummary.nodes as line, i (i)}
            <li>{line}</li>
          {/each}
        </ul>
        <p class="font-medium text-gray-700">Links</p>
        <ul class="list-disc pl-4">
          {#each textSummary.edges as line, i (i)}
            <li>{line}</li>
          {/each}
        </ul>
      </div>
    </details>
  </div>
{/if}
