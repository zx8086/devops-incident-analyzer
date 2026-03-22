<script lang="ts">
  import Icon from "./Icon.svelte";

  let { nodes, dataSourceResults, responseTime, toolsUsed }: {
    nodes?: Map<string, { duration: number }>;
    dataSourceResults?: Map<string, { status: string; message?: string }>;
    responseTime?: number;
    toolsUsed?: string[];
  } = $props();

  let expanded = $state(false);
</script>

{#if nodes && nodes.size > 0}
  <button
    onclick={() => expanded = !expanded}
    class="flex items-center gap-2 mt-2 px-3 py-1.5 rounded-lg bg-green-50 border border-green-200 text-green-700 text-xs hover:bg-green-100 transition-colors w-full"
  >
    <Icon name="check" size={14} />
    <span>Completed in {responseTime ? `${(responseTime / 1000).toFixed(1)}s` : "..."}</span>
    <Icon name="chevron-down" size={14} />
  </button>

  {#if expanded}
    <div class="mt-2 p-3 rounded-lg bg-gray-50 border border-gray-200 text-xs space-y-2 animate-slide-up-fade">
      <div>
        <div class="font-medium text-gray-700 mb-1">Pipeline Steps</div>
        {#each [...nodes.entries()] as [node, { duration }]}
          <div class="flex items-center gap-2 text-gray-600">
            <Icon name="check" size={12} />
            <span>{node}</span>
            <span class="text-gray-400">{duration}ms</span>
          </div>
        {/each}
      </div>

      {#if dataSourceResults && dataSourceResults.size > 0}
        <div>
          <div class="font-medium text-gray-700 mb-1">Data Sources</div>
          {#each [...dataSourceResults.entries()] as [id, { status }]}
            <div class="flex items-center gap-2 text-gray-600">
              <span class="w-2 h-2 rounded-full {status === 'success' ? 'bg-green-500' : status === 'error' ? 'bg-red-500' : 'bg-gray-400'}"></span>
              <span>{id}</span>
              <span class="text-gray-400">{status}</span>
            </div>
          {/each}
        </div>
      {/if}

      {#if toolsUsed && toolsUsed.length > 0}
        <div>
          <div class="font-medium text-gray-700 mb-1">Tools Used</div>
          <div class="flex flex-wrap gap-1">
            {#each toolsUsed as tool}
              <span class="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px]">
                <Icon name="tool" size={10} /> {tool}
              </span>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}
{/if}
