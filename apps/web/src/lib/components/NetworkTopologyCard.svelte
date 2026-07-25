<script lang="ts">
// apps/web/src/lib/components/NetworkTopologyCard.svelte
// SIO-1204: interactive ECharts force-graph of the turn's derived network map
// (DNS -> LB -> target group -> workload chains, VPC/subnet placement, service
// endpoints). The chart initializes behind onMount + dynamic import: echarts
// needs the DOM (SvelteKit SSR must never touch it), and the modular
// echarts/core bundle only loads when a map actually renders.
import type { NetworkTopology } from "@devops-agent/shared";
import { onMount } from "svelte";
import { buildNetworkChartOption } from "$lib/network-chart";

let { topology }: { topology: NetworkTopology } = $props();

let container: HTMLDivElement | undefined = $state();
// Imperative echarts handle -- deliberately NOT $state (assignment must not
// retrigger effects; the `ready` flag below is the reactive signal).
let chart: { setOption(option: object): void; resize(): void; dispose(): void } | null = null;
let ready = $state(false);

const option = $derived(buildNetworkChartOption(topology));

onMount(() => {
	let disposed = false;
	let observer: ResizeObserver | undefined;
	(async () => {
		const [core, charts, components, renderers] = await Promise.all([
			import("echarts/core"),
			import("echarts/charts"),
			import("echarts/components"),
			import("echarts/renderers"),
		]);
		if (disposed || !container) return;
		core.use([charts.GraphChart, components.TooltipComponent, components.LegendComponent, renderers.CanvasRenderer]);
		chart = core.init(container);
		observer = new ResizeObserver(() => chart?.resize());
		observer.observe(container);
		ready = true;
	})();
	return () => {
		disposed = true;
		observer?.disconnect();
		chart?.dispose();
		chart = null;
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
  <div class="mt-2 rounded-lg border border-sky-100 bg-sky-50/40 px-3 py-2.5">
    <div class="flex items-center justify-between gap-2 mb-1">
      <span class="text-[0.5625rem] font-medium text-sky-800 uppercase tracking-wider">Network map</span>
      <span class="text-[0.5625rem] text-gray-500 tabular-nums truncate">
        {topology.nodes.length} nodes · {topology.edges.length} links · {topology.sources.join(", ")}
      </span>
    </div>
    <div class="relative">
      <div bind:this={container} class="h-80 w-full"></div>
      {#if !ready}
        <div class="absolute inset-0 flex items-center justify-center text-[0.6875rem] text-gray-400">
          Rendering network map...
        </div>
      {/if}
    </div>
    <div class="mt-1 flex items-center justify-between text-[0.5625rem] text-gray-400">
      <span>Dashed links are CIDR-derived placements; drag, scroll, and hover for detail.</span>
      {#if topology.truncated}
        <span class="text-gray-500">Truncated to the first {topology.nodes.length} nodes.</span>
      {/if}
    </div>
  </div>
{/if}
