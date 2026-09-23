<script lang="ts">
// apps/web/src/lib/components/LandingZoneTopologyCard.svelte
import type { LandingZoneTopologyEvent, TopologyVisualState } from "@devops-agent/shared";

let { event }: { event: LandingZoneTopologyEvent } = $props();

const titleId = $props.id();
const topology = $derived(event.topology);
const viewLabel = $derived(event.view === "network" ? "Network" : event.view === "dns" ? "DNS" : "DNS and route path");
const nodeById = $derived(new Map(topology.nodes.map((node) => [node.id, node])));

function stateClass(state: TopologyVisualState): string {
	switch (state) {
		case "confirmed":
			return "border-emerald-200 bg-emerald-50 text-emerald-800";
		case "proposed":
			return "border-sky-300 border-dashed bg-sky-50 text-sky-800";
		case "drift":
			return "border-red-300 bg-red-50 text-red-800";
		case "unverified":
			return "border-gray-300 border-dashed bg-gray-50 text-gray-700";
	}
}

function humanize(value: string): string {
	return value.replaceAll("-", " ");
}
</script>

{#if topology.nodes.length > 0}
  <section
    class="mx-4 mt-2 overflow-hidden rounded-xl border border-blue-100 bg-white shadow-sm"
    aria-labelledby={titleId}
  >
    <header class="border-b border-blue-100 bg-blue-50/60 px-4 py-3">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p class="text-[0.625rem] font-semibold uppercase tracking-wider text-blue-800">
            {viewLabel} evidence map
          </p>
          <h3 id={titleId} class="mt-0.5 text-sm font-semibold text-tommy-navy">
            {topology.title}
          </h3>
        </div>
        <p class="text-[0.625rem] tabular-nums text-gray-500">
          {topology.nodes.length} nodes · {topology.edges.length} links · {topology.sources.length} sources
        </p>
      </div>
      <p class="mt-2 text-xs leading-5 text-gray-700">{topology.summary}</p>
      <p class="mt-1 text-[0.625rem] leading-4 text-gray-500">
        This is a projection of desired, proposed, and observed evidence, not a source of truth.
      </p>
    </header>

    <div class="flex flex-wrap gap-1.5 border-b border-gray-100 px-4 py-2" aria-label="Evidence state legend">
      {#each topology.legend as item (item.state)}
        <span
          class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-medium ${stateClass(item.state)}`}
          title={item.description}
        >
          {item.label}
        </span>
      {/each}
    </div>

    <div class="grid gap-4 px-4 py-3 lg:grid-cols-2">
      <div>
        <h4 class="text-[0.6875rem] font-semibold uppercase tracking-wide text-gray-600">Nodes</h4>
        <ul class="mt-2 space-y-1.5">
          {#each topology.nodes as node (node.id)}
            <li class={`rounded-lg border px-2.5 py-2 ${stateClass(node.visualState)}`}>
              <div class="flex flex-wrap items-baseline justify-between gap-1">
                <span class="text-xs font-semibold">{node.label}</span>
                <span class="text-[0.625rem] uppercase tracking-wide">{humanize(node.kind)}</span>
              </div>
              {#if node.detail}
                <p class="mt-0.5 break-words text-[0.6875rem] leading-4 opacity-80">{node.detail}</p>
              {/if}
              <span class="sr-only">Evidence state: {node.visualState}</span>
            </li>
          {/each}
        </ul>
      </div>

      <div>
        <h4 class="text-[0.6875rem] font-semibold uppercase tracking-wide text-gray-600">Relationships</h4>
        {#if topology.edges.length > 0}
          <ul class="mt-2 space-y-1.5">
            {#each topology.edges as edge (edge.id)}
              <li class={`rounded-lg border px-2.5 py-2 ${stateClass(edge.visualState)}`}>
                <p class="break-words text-xs leading-5">
                  <span class="font-semibold">{nodeById.get(edge.from)?.label ?? edge.from}</span>
                  <span aria-hidden="true"> → </span>
                  <span class="sr-only">connects to</span>
                  <span class="font-semibold">{nodeById.get(edge.to)?.label ?? edge.to}</span>
                </p>
                <p class="text-[0.625rem] uppercase tracking-wide opacity-80">
                  {edge.label ?? humanize(edge.kind)} · {edge.visualState}
                </p>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="mt-2 text-xs text-gray-500">No relationships are present in this projection.</p>
        {/if}
      </div>
    </div>

    {#if topology.truncated}
      <p class="border-t border-amber-100 bg-amber-50 px-4 py-2 text-[0.6875rem] text-amber-900">
        This projection reached its display limit. Narrow the request by account, VPC, or hostname to inspect the omitted evidence.
      </p>
    {/if}

    <div class="border-t border-gray-100 px-4 py-2">
      <details>
        <summary class="cursor-pointer text-[0.6875rem] font-medium text-gray-600 hover:text-gray-900">
          Accessible text view ({topology.text.length} lines)
        </summary>
        <ol class="mt-2 list-decimal space-y-1 pl-5 text-[0.6875rem] leading-5 text-gray-700">
          {#each topology.text as line, index (`${index}:${line}`)}
            <li class="break-words">{line}</li>
          {/each}
        </ol>
      </details>
      <details class="mt-2">
        <summary class="cursor-pointer text-[0.6875rem] font-medium text-gray-600 hover:text-gray-900">
          Mermaid diagram source
        </summary>
        <pre class="mt-2 max-h-80 overflow-auto rounded-lg bg-gray-950 p-3 text-[0.625rem] leading-5 text-gray-100"><code>{topology.mermaid}</code></pre>
      </details>
    </div>

    {#if topology.sources.length > 0}
      <footer class="border-t border-gray-100 bg-gray-50/70 px-4 py-2.5">
        <h4 class="text-[0.625rem] font-semibold uppercase tracking-wide text-gray-600">Evidence sources</h4>
        <ul class="mt-1 space-y-1">
          {#each topology.sources as source (source.id)}
            <li class="break-words text-[0.6875rem] leading-4 text-gray-600">
              {#if source.url}
                <a
                  class="underline decoration-gray-300 underline-offset-2 hover:text-tommy-navy"
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                >{source.label}</a>
              {:else}
                <span>{source.label}</span>
              {/if}
              <span class="ml-1 text-[0.625rem] uppercase tracking-wide text-gray-400">{source.state}</span>
            </li>
          {/each}
        </ul>
      </footer>
    {/if}
  </section>
{/if}
